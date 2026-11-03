import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { gstFor, resolvePrice, routeLines } from '@rtm/shared';
import type { Tx } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { DomainError, notFound } from '../common/errors';
import { Accounts, LedgerService } from '../core/ledger.service';
import { SequenceService } from '../core/sequence.service';
import { AuditService } from '../core/audit.service';
import { ScopeService } from '../core/scope.service';
import { PricingService } from '../orders/pricing.service';

const DAY = 86_400_000;

/**
 * Market returns. Captured in the field as REQUESTED; the distributor inspects and accepts.
 * Acceptance issues a credit note, posts a balanced journal against the outlet's receivable,
 * books negative secondary sales and puts stock in the right bucket:
 * SALEABLE (known batch) back to sellable stock; DAMAGED / EXPIRED / unknown batch to quarantine.
 */
@Injectable()
export class ReturnsService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly seq: SequenceService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly pricing: PricingService,
  ) {}

  async capture(
    tx: Tx,
    user: AuthUser,
    m: {
      idempotencyKey: string;
      capturedAt: string;
      payload: { outletId: string; reason: string; lines: { productId: string; qty: number; condition: string; batchCode?: string }[] };
    },
  ) {
    const p = m.payload;
    await this.scope.assertOutlet(tx, user, p.outletId);
    const outlet = await tx.outlet.findFirst({
      where: { id: p.outletId, tenantId: user.tenantId },
      include: { services: { include: { rtmModel: true } } },
    });
    if (!outlet) throw notFound('Outlet');
    const products = await tx.product.findMany({ where: { tenantId: user.tenantId, id: { in: p.lines.map((l) => l.productId) } } });
    const brandOf = new Map(products.map((x) => [x.id, x.brandId]));
    const services = outlet.services.map((s) => ({ ...s, rtmModelCode: s.rtmModel.code }));
    const { groups, unroutable } = routeLines(p.lines, (id) => brandOf.get(id), services);
    if (unroutable.length) throw new DomainError('UNROUTABLE', 'Some products are not served to this outlet', 422, unroutable);

    const refs: string[] = [];
    for (const [i, g] of groups.entries()) {
      const returnNo = await this.seq.opNo(tx, user.tenantId, 'RT');
      const r = await tx.return.create({
        data: {
          tenantId: user.tenantId,
          returnNo,
          outletId: outlet.id,
          distributorId: g.service.distributorId,
          capturedById: user.userId,
          capturedAt: new Date(m.capturedAt),
          status: 'REQUESTED',
          reason: p.reason,
          sourceKey: `${m.idempotencyKey}#${i}`,
          lines: { create: g.lines.map((l) => ({ productId: l.productId, qty: l.qty, condition: l.condition, batchCode: l.batchCode })) },
        },
      });
      await this.audit.record(tx, user, 'RETURN_REQUESTED', 'Return', r.id, { after: { returnNo, lines: g.lines } });
      refs.push(returnNo);
    }
    return { refs, flags: [] };
  }

  async decide(tx: Tx, user: AuthUser, returnId: string, decision: 'ACCEPT' | 'REJECT', note?: string) {
    const ret = await tx.return.findFirst({ where: { id: returnId, tenantId: user.tenantId }, include: { lines: true } });
    if (!ret) throw notFound('Return');
    await this.scope.assertDistributor(tx, user, ret.distributorId);
    if (ret.status !== 'REQUESTED') throw new DomainError('ALREADY_DECIDED', `Return is ${ret.status}`, 409);

    if (decision === 'REJECT') {
      await tx.return.update({ where: { id: ret.id }, data: { status: 'REJECTED', decidedById: user.userId, decidedAt: new Date() } });
      await this.audit.record(tx, user, 'RETURN_REJECTED', 'Return', ret.id, { meta: { note } });
      return { creditNoteNo: null };
    }

    const [outlet, distributor] = await Promise.all([
      tx.outlet.findUniqueOrThrow({ where: { id: ret.outletId }, include: { channel: true } }),
      tx.distributor.findUniqueOrThrow({ where: { id: ret.distributorId } }),
    ]);
    const warehouse = await tx.stockLocation.findFirst({ where: { distributorId: distributor.id, type: 'WAREHOUSE' } });
    if (!warehouse) throw new DomainError('NO_STOCK_LOCATION', 'Distributor has no warehouse');
    const products = new Map((await tx.product.findMany({ where: { id: { in: ret.lines.map((l) => l.productId) } } })).map((p) => [p.id, p]));
    const interState = distributor.stateCode !== outlet.stateCode;
    const masters = await this.pricing.loadMasters(tx, user.tenantId, new Date());
    const cnId = randomUUID();

    let taxable = 0n;
    let cgst = 0n;
    let sgst = 0n;
    let igst = 0n;
    const movements: { batchId: string; qty: number; reason: string }[] = [];
    const sales: { productId: string; qty: number; net: bigint }[] = [];

    for (const line of ret.lines) {
      const product = products.get(line.productId)!;
      const unit = await this.unitCredit(tx, ret.outletId, ret.distributorId, line.productId, () => {
        const r = resolvePrice(masters.priceLists, line.productId, { id: outlet.id, channelCode: outlet.channel.code, stateCode: outlet.stateCode, tier: outlet.tier }, new Date().toISOString());
        return r ? BigInt(r.basePaise) : 0n;
      });
      const lineTaxable = unit * BigInt(line.qty);
      const g = gstFor(Number(lineTaxable), product.gstRateBp, interState);
      taxable += lineTaxable;
      cgst += BigInt(g.cgstPaise);
      sgst += BigInt(g.sgstPaise);
      igst += BigInt(g.igstPaise);
      await tx.returnLine.update({ where: { id: line.id }, data: { unitCreditPaise: unit } });
      const batchId = await this.receiveStock(tx, ret.tenantId, warehouse.id, product, line);
      movements.push({ batchId, qty: line.qty, reason: `RETURN_${line.condition}` });
      sales.push({ productId: line.productId, qty: line.qty, net: lineTaxable });
    }

    const total = taxable + cgst + sgst + igst;
    const creditNoteNo = await this.seq.creditNoteNo(tx, ret.tenantId, distributor.code);
    const journal = await this.ledger.post(tx, {
      tenantId: ret.tenantId,
      bookOwner: distributor.id,
      docType: 'CREDIT_NOTE',
      docId: cnId,
      narration: `Credit note ${creditNoteNo} for return ${ret.returnNo} — ${outlet.name}`,
      postedById: user.userId,
      lines: [
        { account: Accounts.salesReturns, debit: taxable },
        { account: Accounts.cgstOut, debit: cgst },
        { account: Accounts.sgstOut, debit: sgst },
        { account: Accounts.igstOut, debit: igst },
        { account: Accounts.receivable(outlet.id, outlet.name), credit: total },
      ],
    });
    await tx.creditNote.create({
      data: {
        id: cnId,
        tenantId: ret.tenantId,
        creditNoteNo,
        reason: 'RETURN',
        distributorId: distributor.id,
        outletId: outlet.id,
        returnId: ret.id,
        taxablePaise: taxable,
        taxPaise: cgst + sgst + igst,
        totalPaise: total,
        journalId: journal.id,
      },
    });
    for (const mv of movements) {
      await tx.stockMovement.create({ data: { tenantId: ret.tenantId, batchId: mv.batchId, qty: mv.qty, reason: mv.reason, refType: 'Return', refId: ret.id } });
    }
    await tx.secondarySale.createMany({
      data: sales.map((s) => ({
        tenantId: ret.tenantId,
        date: new Date(),
        kind: 'RETURN',
        distributorId: distributor.id,
        outletId: outlet.id,
        channelCode: outlet.channel.code,
        rtmModelCode: 'RETURN',
        productId: s.productId,
        brandId: products.get(s.productId)!.brandId,
        dsrId: ret.capturedById,
        qty: -s.qty,
        freeQty: 0,
        netPaise: -s.net,
        docType: 'CREDIT_NOTE',
        docId: cnId,
      })),
    });
    await tx.return.update({
      where: { id: ret.id },
      data: { status: 'ACCEPTED', decidedById: user.userId, decidedAt: new Date(), creditNoteId: cnId },
    });
    await this.audit.record(tx, user, 'RETURN_ACCEPTED', 'Return', ret.id, {
      after: { creditNoteNo, totalPaise: total },
      meta: { note },
    });
    return { creditNoteNo, totalPaise: total };
  }

  /** Credit at the outlet's last invoiced unit price for the SKU (what they actually paid), else list price. */
  private async unitCredit(tx: Tx, outletId: string, distributorId: string, productId: string, fallback: () => bigint) {
    const last = await tx.invoiceLine.findFirst({
      where: { productId, qty: { gt: 0 }, invoice: { outletId, distributorId, status: 'ISSUED' } },
      orderBy: { invoice: { issuedAt: 'desc' } },
    });
    if (last) return last.taxablePaise / BigInt(last.qty);
    return fallback();
  }

  private async receiveStock(
    tx: Tx,
    tenantId: string,
    locationId: string,
    product: { id: string; shelfLifeDays: number },
    line: { productId: string; qty: number; condition: string; batchCode: string | null },
  ): Promise<string> {
    const known = line.batchCode
      ? await tx.inventoryBatch.findFirst({ where: { locationId, productId: product.id, batchCode: line.batchCode, bucket: 'SALEABLE' } })
      : null;
    const saleable = line.condition === 'SALEABLE' && known && known.expiryDate.getTime() > Date.now();
    const bucket = saleable ? 'SALEABLE' : 'DAMAGED';
    const batchCode = line.batchCode ?? `RET-${new Date().toISOString().slice(0, 10)}`;
    const existing = await tx.inventoryBatch.findUnique({
      where: { locationId_productId_batchCode_bucket: { locationId, productId: product.id, batchCode, bucket } },
    });
    if (existing) {
      await tx.inventoryBatch.update({ where: { id: existing.id }, data: { qtyOnHand: { increment: line.qty } } });
      return existing.id;
    }
    const created = await tx.inventoryBatch.create({
      data: {
        tenantId,
        locationId,
        productId: product.id,
        batchCode,
        bucket,
        mfgDate: known?.mfgDate ?? new Date(),
        expiryDate: known?.expiryDate ?? new Date(Date.now() + DAY),
        qtyOnHand: line.qty,
      },
    });
    return created.id;
  }
}
