import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma.service';
import { LedgerService } from '../core/ledger.service';
import { JobsService } from '../jobs/jobs.service';
import { ReviewService } from '../core/review.service';
import { AuditService } from '../core/audit.service';

export interface CreditPosition {
  hasAccount: boolean;
  limitPaise: bigint;
  /** Ledger receivable balance (invoiced minus collected/credited). */
  arPaise: bigint;
  /** Confirmed orders not yet invoiced. */
  openOrdersPaise: bigint;
  exposurePaise: bigint;
  blocked: boolean;
}

export const AGE_BUCKETS = ['NOT_DUE', '1-15', '16-30', '31-60', '60+'] as const;
const DAY = 86_400_000;

@Injectable()
export class CreditService implements OnModuleInit {
  constructor(
    private readonly ledger: LedgerService,
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly reviews: ReviewService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.jobs.register('credit.review', () => this.reviewAll());
    this.jobs.every('credit.review', 3600_000);
  }

  /**
   * Open-item ageing by FIFO: payments and credit notes settle the oldest invoices first, so the
   * outstanding ledger balance sits on the newest invoices. Ages by days past each invoice's due date.
   */
  async ageing(tx: Tx, tenantId: string, outletId: string, distributorId: string) {
    const outstanding = await this.ledger.balance(tx, tenantId, distributorId, `AR:${outletId}`);
    const invoices = await tx.invoice.findMany({ where: { tenantId, outletId, distributorId, status: 'ISSUED' }, orderBy: { issuedAt: 'desc' } });
    const buckets: Record<(typeof AGE_BUCKETS)[number], bigint> = { NOT_DUE: 0n, '1-15': 0n, '16-30': 0n, '31-60': 0n, '60+': 0n };
    const open: { invoiceNo: string; dueDate: Date; openPaise: bigint; daysPastDue: number }[] = [];
    let remaining = outstanding > 0n ? outstanding : 0n;
    for (const inv of invoices) {
      if (remaining <= 0n) break;
      const openPaise = remaining < inv.totalPaise ? remaining : inv.totalPaise;
      remaining -= openPaise;
      const dpd = Math.floor((Date.now() - inv.dueDate.getTime()) / DAY);
      const b = dpd <= 0 ? 'NOT_DUE' : dpd <= 15 ? '1-15' : dpd <= 30 ? '16-30' : dpd <= 60 ? '31-60' : '60+';
      buckets[b] += openPaise;
      open.push({ invoiceNo: inv.invoiceNo, dueDate: inv.dueDate, openPaise, daysPastDue: Math.max(0, dpd) });
    }
    // Balance not explained by invoices (opening balances, debit notes) is treated as oldest.
    if (remaining > 0n) buckets['60+'] += remaining;
    return { outstandingPaise: outstanding, buckets, open, maxDaysPastDue: Math.max(0, ...open.map((o) => o.daysPastDue)) };
  }

  /** Auto-block on overdue beyond grace or repeated bounces; auto-unblock when cured. Manual blocks stay. */
  async review(tx: Tx, creditAccountId: string) {
    const acc = await tx.creditAccount.findUniqueOrThrow({ where: { id: creditAccountId } });
    const age = await this.ageing(tx, acc.tenantId, acc.outletId, acc.distributorId);
    const reasons = [
      age.maxDaysPastDue > acc.overdueGraceDays ? `${age.maxDaysPastDue} days past due` : null,
      acc.bounceCount >= 2 ? `${acc.bounceCount} bounced cheques` : null,
    ].filter(Boolean) as string[];
    const actor = { userId: 'system:credit', tenantId: acc.tenantId, role: 'ADMIN' as const };
    if (reasons.length && !acc.blocked) {
      await tx.creditAccount.update({ where: { id: acc.id }, data: { blocked: true, autoBlocked: true, blockReason: reasons.join('; ') } });
      const outlet = await tx.outlet.findUniqueOrThrow({ where: { id: acc.outletId } });
      await this.reviews.raise(tx, acc.tenantId, { kind: 'CREDIT_AUTO_BLOCKED', refType: 'CreditAccount', refId: acc.id, distributorId: acc.distributorId, summary: `Credit blocked for ${outlet.name}: ${reasons.join('; ')}`, details: { buckets: age.buckets } });
      await this.audit.record(tx, actor, 'CREDIT_AUTO_BLOCKED', 'CreditAccount', acc.id, { before: { blocked: false }, after: { blocked: true, reasons } });
    } else if (!reasons.length && acc.blocked && acc.autoBlocked) {
      await tx.creditAccount.update({ where: { id: acc.id }, data: { blocked: false, autoBlocked: false, blockReason: null } });
      await this.audit.record(tx, actor, 'CREDIT_AUTO_UNBLOCKED', 'CreditAccount', acc.id, { before: { blocked: true }, after: { blocked: false } });
    }
  }

  async reviewAll() {
    const accounts = await this.prisma.creditAccount.findMany({ select: { id: true } });
    for (const a of accounts) await this.prisma.tx((tx) => this.review(tx, a.id));
  }

  /**
   * Exposure = AR balance from the ledger + uninvoiced confirmed orders. Never a stored balance.
   * With `lock`, the credit account row is locked so concurrent orders for the same outlet
   * are checked one after another (no double-spend of the limit).
   */
  async position(tx: Tx, tenantId: string, outletId: string, distributorId: string, lock = false): Promise<CreditPosition> {
    if (lock) {
      await tx.$queryRaw`SELECT id FROM "CreditAccount" WHERE "outletId" = ${outletId} AND "distributorId" = ${distributorId} FOR UPDATE`;
    }
    const account = await tx.creditAccount.findUnique({ where: { outletId_distributorId: { outletId, distributorId } } });
    const arPaise = await this.ledger.balance(tx, tenantId, distributorId, `AR:${outletId}`);
    const open = await tx.$queryRaw<{ v: bigint | null }[]>`
      SELECT SUM(o."totalPaise" - COALESCE(i.inv, 0))::bigint AS v
      FROM "Order" o
      LEFT JOIN (SELECT "orderId", SUM("totalPaise") AS inv FROM "Invoice" WHERE status = 'ISSUED' GROUP BY "orderId") i
        ON i."orderId" = o.id
      WHERE o."tenantId" = ${tenantId} AND o."outletId" = ${outletId} AND o."distributorId" = ${distributorId}
        AND o.status IN ('CONFIRMED', 'PARTIALLY_FULFILLED')`;
    const openOrdersPaise = open[0]?.v ?? 0n;
    return {
      hasAccount: !!account,
      limitPaise: account?.limitPaise ?? 0n,
      arPaise,
      openOrdersPaise,
      exposurePaise: arPaise + openOrdersPaise,
      blocked: account?.blocked ?? false,
    };
  }

  /** Flags for a prospective order. Outlets without a credit account are cash/COD — no check. */
  async check(tx: Tx, tenantId: string, outletId: string, distributorId: string, orderTotal: bigint) {
    const pos = await this.position(tx, tenantId, outletId, distributorId, true);
    const flags: string[] = [];
    if (pos.hasAccount) {
      if (pos.blocked) flags.push('CREDIT_BLOCKED');
      else if (pos.exposurePaise + orderTotal > pos.limitPaise) flags.push('CREDIT_BREACH');
    }
    return { flags, position: pos };
  }
}
