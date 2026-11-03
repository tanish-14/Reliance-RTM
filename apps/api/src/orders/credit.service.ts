import { Injectable } from '@nestjs/common';
import type { Tx } from '../prisma.service';
import { LedgerService } from '../core/ledger.service';

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

@Injectable()
export class CreditService {
  constructor(private readonly ledger: LedgerService) {}

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
