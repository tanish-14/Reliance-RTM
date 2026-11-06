import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { gstFor, type ClaimInput, type SchemeInput } from '@rtm/shared';
import { PrismaService, type Tx } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { DomainError, notFound } from '../common/errors';
import { toJson } from '../common/json';
import { Accounts, COMPANY_BOOK, LedgerService } from '../core/ledger.service';
import { SequenceService } from '../core/sequence.service';
import { AuditService } from '../core/audit.service';
import { ScopeService } from '../core/scope.service';
import { ReviewService } from '../core/review.service';

const DAY = 86_400_000;

/**
 * Trade schemes: definition, budget, claims and ROI.
 *
 * The single source of truth for "how much did scheme X cost at distributor Y" is SchemeUsage —
 * append-only rows written when invoices are issued (and reversed on cancellation / correction).
 * Claims are validated against it, so a distributor can only be reimbursed for discounts that
 * actually reached retailers on real invoices.
 */
@Injectable()
export class SchemesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly seq: SequenceService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly review: ReviewService,
  ) {}

  private rules(s: z.output<typeof SchemeInput>, productIdOf: Map<string, string>) {
    switch (s.type) {
      case 'QTY_SLAB':
        return { slabs: s.qtySlabs!.map((x) => ({ minQty: x.minQty, discountBp: x.discountPct })) };
      case 'VALUE_SLAB':
        return { slabs: s.valueSlabs!.map((x) => ({ minValuePaise: x.minValueRupees, discountBp: x.discountPct })) };
      case 'FREE_GOODS':
        return { buyQty: s.buyQty, freeQty: s.freeQty };
      case 'TRADE_DISCOUNT':
        return { discountBp: s.discountPct };
      case 'COMBO':
        return { items: s.comboItems!.map((c) => ({ productId: productIdOf.get(c.productCode)!, minQty: c.minQty })), discountBp: s.discountPct };
      case 'CASHBACK':
        return { minValuePaise: s.minValueRupees, cashbackBp: s.cashbackPct, maxPaise: s.maxCashbackRupees };
    }
  }

  /** New schemes start as DRAFT and go live through approval. A scheme with usage can't be redefined. */
  async upsert(tx: Tx, user: AuthUser, s: z.output<typeof SchemeInput>) {
    const t = user.tenantId;
    const codes = [...s.productCodes, ...(s.comboItems ?? []).map((c) => c.productCode)];
    const products = await tx.product.findMany({ where: { tenantId: t, code: { in: codes } } });
    const brands = await tx.brand.findMany({ where: { tenantId: t, code: { in: s.brandCodes } } });
    const productIdOf = new Map(products.map((p) => [p.code, p.id]));
    const missing = codes.filter((c) => !productIdOf.has(c));
    if (missing.length || brands.length !== s.brandCodes.length) throw new DomainError('UNKNOWN_CODE', `Unknown product/brand: ${[...missing, ...s.brandCodes.filter((b) => !brands.some((x) => x.code === b))].join(', ')}`);
    const data = {
      name: s.name, description: s.description, type: s.type, validFrom: s.validFrom, validTo: s.validTo, channelCodes: s.channelCodes, stateCodes: s.stateCodes,
      productIds: s.productCodes.map((c) => productIdOf.get(c)!), brandIds: brands.map((b) => b.id), priority: s.priority,
      budgetPaise: s.budgetRupees === undefined ? null : BigInt(s.budgetRupees), rules: this.rules(s, productIdOf) as any,
    };
    const before = await tx.scheme.findUnique({ where: { tenantId_code: { tenantId: t, code: s.code } } });
    if (before && (await tx.schemeUsage.count({ where: { schemeId: before.id } }))) {
      throw new DomainError('SCHEME_IN_USE', 'This scheme has been applied on invoices — end it and create a new one instead', 409);
    }
    const row = before ? await tx.scheme.update({ where: { id: before.id }, data: { ...data, status: 'DRAFT' } }) : await tx.scheme.create({ data: { ...data, tenantId: t, code: s.code, status: 'DRAFT' } });
    await this.audit.record(tx, user, before ? 'SCHEME_UPDATED' : 'SCHEME_CREATED', 'Scheme', row.id, { before, after: row });
    return row;
  }

  async setStatus(tx: Tx, user: AuthUser, schemeId: string, status: 'ACTIVE' | 'PAUSED' | 'ENDED', via = 'direct') {
    const before = await tx.scheme.findFirst({ where: { id: schemeId, tenantId: user.tenantId } });
    if (!before) throw notFound('Scheme');
    const allowed: Record<string, string[]> = { DRAFT: ['ACTIVE', 'ENDED'], ACTIVE: ['PAUSED', 'ENDED'], PAUSED: ['ACTIVE', 'ENDED'], ENDED: [] };
    if (!allowed[before.status]?.includes(status)) throw new DomainError('ILLEGAL_TRANSITION', `Scheme is ${before.status}`, 409);
    const row = await tx.scheme.update({ where: { id: schemeId }, data: { status, ...(status === 'ENDED' && before.validTo > new Date() ? { validTo: new Date() } : {}) } });
    await this.audit.record(tx, user, `SCHEME_${status}`, 'Scheme', schemeId, { before: { status: before.status }, after: { status }, meta: { via } });
    return row;
  }

  async consumption(tx: Tx, tenantId: string): Promise<Map<string, bigint>> {
    const rows = await tx.schemeUsage.groupBy({ by: ['schemeId'], where: { tenantId }, _sum: { costPaise: true } });
    return new Map(rows.map((r) => [r.schemeId, r._sum.costPaise ?? 0n]));
  }

  async list(user: AuthUser) {
    const [schemes, used] = await Promise.all([this.prisma.scheme.findMany({ where: { tenantId: user.tenantId }, orderBy: { validFrom: 'desc' } }), this.consumption(this.prisma, user.tenantId)]);
    return schemes.map((s) => ({ ...s, consumedPaise: used.get(s.id) ?? 0n }));
  }

  // ------------------------------------------------------------------------------- claims

  async submitClaim(user: AuthUser, c: z.output<typeof ClaimInput>, onValidated?: (tx: Tx, claim: { id: string; claimNo: string; distributorId: string; validatedPaise: bigint }) => Promise<unknown>) {
    if (!user.distributorId) throw new DomainError('DISTRIBUTOR_ONLY', 'Claims are raised by distributors', 403);
    const distributorId = user.distributorId;
    const scheme = await this.prisma.scheme.findUnique({ where: { tenantId_code: { tenantId: user.tenantId, code: c.schemeCode } } });
    if (!scheme) throw notFound(`Scheme ${c.schemeCode}`);
    if (c.periodTo <= c.periodFrom) throw new DomainError('BAD_PERIOD', 'Period must end after it starts');
    return this.prisma.tx(async (tx) => {
      // Serialise claims per distributor+scheme so two overlapping submissions can't both pass.
      await tx.$executeRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`claim:${distributorId}:${scheme.id}`}))`;
      const overlapping = await tx.claim.findFirst({
        where: { distributorId, schemeId: scheme.id, status: { not: 'REJECTED' }, periodFrom: { lt: c.periodTo }, periodTo: { gt: c.periodFrom } },
      });
      if (overlapping) {
        throw new DomainError('DUPLICATE_CLAIM', `Overlaps claim ${overlapping.claimNo} (${overlapping.periodFrom.toISOString().slice(0, 10)} – ${overlapping.periodTo.toISOString().slice(0, 10)})`, 409);
      }
      const usage = await tx.schemeUsage.findMany({ where: { tenantId: user.tenantId, schemeId: scheme.id, distributorId, at: { gte: c.periodFrom, lt: c.periodTo } } });
      const validated = usage.reduce((a, u) => a + u.costPaise, 0n);
      const claimed = BigInt(c.claimedRupees);
      const flags = claimed > validated ? ['INFLATED'] : [];
      const status = validated === 0n ? 'REJECTED' : claimed > validated ? 'PARTIALLY_VALIDATED' : 'VALIDATED';
      const byKind = Object.fromEntries(['DISCOUNT', 'FREE_GOODS', 'CASHBACK'].map((k) => [k, usage.filter((u) => u.kind === k).reduce((a, u) => a + u.costPaise, 0n)]));
      const evidence = {
        byKind,
        invoices: new Set(usage.filter((u) => u.costPaise > 0n).map((u) => u.invoiceId)).size,
        outlets: new Set(usage.map((u) => u.outletId)).size,
        reversals: usage.filter((u) => u.costPaise < 0n).length,
        excessPaise: claimed > validated ? claimed - validated : 0n,
      };
      const claimNo = `CL-${await this.seq.opNo(tx, user.tenantId, 'RC')}`;
      const claim = await tx.claim.create({
        data: {
          tenantId: user.tenantId, claimNo, distributorId, schemeId: scheme.id, periodFrom: c.periodFrom, periodTo: c.periodTo, claimedPaise: claimed,
          validatedPaise: validated < claimed ? validated : claimed, status, flags, evidence: toJson(evidence),
          dedupeKey: `${distributorId}:${scheme.id}:${c.periodFrom.toISOString()}:${c.periodTo.toISOString()}`, submittedById: user.userId, notes: c.notes,
        },
      });
      if (flags.length || status === 'REJECTED') {
        await this.review.raise(tx, user.tenantId, {
          kind: 'CLAIM_DISCREPANCY', refType: 'Claim', refId: claim.id, distributorId,
          summary: `${claimNo} ${scheme.code}: claimed ₹${Number(claimed) / 100}, secondary sales support ₹${Number(validated) / 100}`, details: evidence,
        });
      }
      await this.audit.record(tx, user, 'CLAIM_SUBMITTED', 'Claim', claim.id, { after: claim });
      if (status !== 'REJECTED' && onValidated) await onValidated(tx, claim);
      return claim;
    });
  }

  async decideClaim(tx: Tx, user: AuthUser, claimId: string, decision: 'APPROVE' | 'REJECT', approveRupees?: number, note?: string) {
    const claim = await tx.claim.findFirst({ where: { id: claimId, tenantId: user.tenantId } });
    if (!claim) throw notFound('Claim');
    await this.scope.assertDistributor(tx, user, claim.distributorId);
    if (!['VALIDATED', 'PARTIALLY_VALIDATED'].includes(claim.status)) throw new DomainError('BAD_STATE', `Claim is ${claim.status}`, 409);
    const approved = decision === 'REJECT' ? 0n : approveRupees === undefined ? claim.validatedPaise : BigInt(Math.round(approveRupees * 100));
    if (approved > claim.validatedPaise) throw new DomainError('OVER_APPROVAL', 'Cannot approve more than secondary sales support');
    const row = await tx.claim.update({ where: { id: claim.id }, data: { status: decision === 'REJECT' ? 'REJECTED' : 'APPROVED', approvedPaise: approved, decidedById: user.userId, decidedAt: new Date(), notes: note ?? claim.notes } });
    await this.review.resolveFor(tx, user.tenantId, 'Claim', claim.id, user.userId, decision);
    await this.audit.record(tx, user, decision === 'REJECT' ? 'CLAIM_REJECTED' : 'CLAIM_APPROVED', 'Claim', claim.id, { before: { status: claim.status }, after: { status: row.status, approvedPaise: approved }, meta: { note } });
    return row;
  }

  /** Settlement books the liability in RCPL's books and the receivable in the distributor's. */
  async settleClaim(user: AuthUser, claimId: string) {
    return this.prisma.tx(async (tx) => {
      const claim = await tx.claim.findFirst({ where: { id: claimId, tenantId: user.tenantId } });
      if (!claim) throw notFound('Claim');
      if (claim.status !== 'APPROVED') throw new DomainError('BAD_STATE', `Claim is ${claim.status}`, 409);
      const dist = await tx.distributor.findUniqueOrThrow({ where: { id: claim.distributorId } });
      const amt = claim.approvedPaise;
      await this.ledger.post(tx, {
        tenantId: claim.tenantId, bookOwner: COMPANY_BOOK, docType: 'CLAIM', docId: claim.id, postedById: user.userId, narration: `Scheme claim ${claim.claimNo} — ${dist.name}`,
        lines: [{ account: Accounts.schemeExpense, debit: amt }, { account: Accounts.distributorPayable(dist.id, dist.name), credit: amt }],
      });
      const j = await this.ledger.post(tx, {
        tenantId: claim.tenantId, bookOwner: dist.id, docType: 'CLAIM', docId: claim.id, postedById: user.userId, narration: `Scheme claim ${claim.claimNo} accepted by RCPL`,
        lines: [{ account: Accounts.claimReceivable, debit: amt }, { account: Accounts.claimIncome, credit: amt }],
      });
      const row = await tx.claim.update({ where: { id: claim.id }, data: { status: 'SETTLED', settledAt: new Date(), journalId: j.id } });
      await this.audit.record(tx, user, 'CLAIM_SETTLED', 'Claim', claim.id, { after: { approvedPaise: amt } });
      return row;
    });
  }

  async claims(user: AuthUser) {
    const ids = await this.scope.distributorIds(this.prisma, user);
    const rows = await this.prisma.claim.findMany({ where: { tenantId: user.tenantId, ...(ids === 'ALL' ? {} : { distributorId: { in: ids } }) }, orderBy: { createdAt: 'desc' }, take: 100 });
    const [schemes, dists] = await Promise.all([
      this.prisma.scheme.findMany({ where: { id: { in: rows.map((r) => r.schemeId) } }, select: { id: true, code: true, name: true } }),
      this.prisma.distributor.findMany({ where: { id: { in: rows.map((r) => r.distributorId) } }, select: { id: true, code: true, name: true } }),
    ]);
    return rows.map((r) => ({ ...r, scheme: schemes.find((s) => s.id === r.schemeId), distributor: dists.find((d) => d.id === r.distributorId) }));
  }

  // ------------------------------------------------------------------------------- ROI

  /**
   * ROI = incremental net secondary sales of the scheme's products / scheme cost, where
   * incremental = (daily rate during the scheme − daily rate in an equal-length window before) × days.
   */
  async roi(user: AuthUser) {
    const ids = await this.scope.distributorIds(this.prisma, user);
    const schemes = await this.prisma.scheme.findMany({ where: { tenantId: user.tenantId, status: { in: ['ACTIVE', 'PAUSED', 'ENDED'] } } });
    const products = await this.prisma.product.findMany({ where: { tenantId: user.tenantId }, select: { id: true, brandId: true } });
    const out = [];
    for (const s of schemes) {
      const start = s.validFrom;
      const end = new Date(Math.min(Date.now(), s.validTo.getTime()));
      const days = Math.max(1, (end.getTime() - start.getTime()) / DAY);
      const baseStart = new Date(start.getTime() - days * DAY);
      const scoped = s.productIds.length || s.brandIds.length ? products.filter((p) => s.productIds.includes(p.id) || s.brandIds.includes(p.brandId)).map((p) => p.id) : products.map((p) => p.id);
      const where = (from: Date, to: Date) => ({
        tenantId: user.tenantId, productId: { in: scoped }, date: { gte: from, lt: to },
        ...(s.channelCodes.length ? { channelCode: { in: s.channelCodes } } : {}),
        ...(ids === 'ALL' ? {} : { distributorId: { in: ids } }),
      });
      const [during, before, cost] = await Promise.all([
        this.prisma.secondarySale.aggregate({ where: where(start, end), _sum: { netPaise: true } }),
        this.prisma.secondarySale.aggregate({ where: where(baseStart, start), _sum: { netPaise: true } }),
        this.prisma.schemeUsage.aggregate({ where: { tenantId: user.tenantId, schemeId: s.id, ...(ids === 'ALL' ? {} : { distributorId: { in: ids } }) }, _sum: { costPaise: true } }),
      ]);
      const d = Number(during._sum.netPaise ?? 0n);
      const b = Number(before._sum.netPaise ?? 0n);
      const c = Number(cost._sum.costPaise ?? 0n);
      const incremental = Math.round(d - b);
      out.push({
        schemeId: s.id, code: s.code, name: s.name, type: s.type, status: s.status, days: Math.round(days),
        salesDuringPaise: d, salesBaselinePaise: b, incrementalPaise: incremental, costPaise: c,
        roi: c > 0 ? Math.round((incremental / c) * 100) / 100 : null,
        budgetPaise: s.budgetPaise === null ? null : Number(s.budgetPaise), budgetUsedPct: s.budgetPaise ? Math.round((c / Number(s.budgetPaise)) * 1000) / 10 : null,
      });
    }
    return out;
  }

  // ------------------------------------------------------------------------------- corrections

  /**
   * A scheme applied in error is recovered with a debit note (taxable value + GST), posted as its
   * own journal, and the scheme usage is reversed so it can't be claimed. Nothing is edited.
   */
  async correct(user: AuthUser, invoiceId: string, schemeCode: string, reason: string) {
    return this.prisma.tx(async (tx) => {
      const inv = await tx.invoice.findFirst({ where: { id: invoiceId, tenantId: user.tenantId } });
      if (!inv) throw notFound('Invoice');
      await this.scope.assertDistributor(tx, user, inv.distributorId);
      if (inv.status !== 'ISSUED') throw new DomainError('BAD_STATE', 'Invoice is cancelled');
      const scheme = await tx.scheme.findUnique({ where: { tenantId_code: { tenantId: user.tenantId, code: schemeCode } } });
      if (!scheme) throw notFound(`Scheme ${schemeCode}`);
      const used = await tx.schemeUsage.groupBy({ by: ['productId', 'kind'], where: { invoiceId, schemeId: scheme.id }, _sum: { costPaise: true, qty: true } });
      const open = used.filter((u) => (u._sum.costPaise ?? 0n) > 0n && u.kind !== 'CASHBACK');
      if (!open.length) throw new DomainError('NOTHING_TO_CORRECT', `${schemeCode} has no outstanding benefit on ${inv.invoiceNo}`);
      const products = new Map((await tx.product.findMany({ where: { id: { in: open.map((u) => u.productId!) } } })).map((p) => [p.id, p]));
      let taxable = 0;
      let tax = 0;
      let cg = 0;
      let sg = 0;
      let ig = 0;
      for (const u of open) {
        const v = Number(u._sum.costPaise);
        const g = gstFor(v, products.get(u.productId!)!.gstRateBp, inv.isInterState);
        taxable += v;
        tax += g.taxPaise;
        cg += g.cgstPaise;
        sg += g.sgstPaise;
        ig += g.igstPaise;
      }
      const outlet = await tx.outlet.findUniqueOrThrow({ where: { id: inv.outletId } });
      const dist = await tx.distributor.findUniqueOrThrow({ where: { id: inv.distributorId } });
      const id = randomUUID();
      const debitNoteNo = await this.seq.debitNoteNo(tx, user.tenantId, dist.code);
      const total = BigInt(taxable + tax);
      const journal = await this.ledger.post(tx, {
        tenantId: user.tenantId, bookOwner: dist.id, docType: 'DEBIT_NOTE', docId: id, postedById: user.userId,
        narration: `Debit note ${debitNoteNo}: ${schemeCode} applied in error on ${inv.invoiceNo} — ${reason}`,
        lines: [
          { account: Accounts.receivable(outlet.id, outlet.name), debit: total },
          { account: Accounts.sales, credit: BigInt(taxable) },
          { account: Accounts.cgstOut, credit: BigInt(cg) },
          { account: Accounts.sgstOut, credit: BigInt(sg) },
          { account: Accounts.igstOut, credit: BigInt(ig) },
        ],
      });
      const dn = await tx.debitNote.create({ data: { id, tenantId: user.tenantId, debitNoteNo, reason: `SCHEME_CORRECTION: ${reason}`, distributorId: dist.id, outletId: outlet.id, invoiceId, taxablePaise: BigInt(taxable), taxPaise: BigInt(tax), totalPaise: total, journalId: journal.id, createdById: user.userId } });
      await tx.schemeUsage.createMany({
        data: open.map((u) => ({ tenantId: user.tenantId, schemeId: scheme.id, distributorId: dist.id, outletId: outlet.id, invoiceId, productId: u.productId, kind: u.kind, costPaise: -(u._sum.costPaise ?? 0n), qty: -(u._sum.qty ?? 0), docType: 'DEBIT_NOTE', docId: id })),
      });
      await this.audit.record(tx, user, 'SCHEME_CORRECTED', 'Invoice', invoiceId, { after: { debitNoteNo, totalPaise: total, scheme: schemeCode }, meta: { reason } });
      return dn;
    });
  }
}
