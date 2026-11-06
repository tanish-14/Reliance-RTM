import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Tx } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { DomainError, notFound } from '../common/errors';
import { Accounts, LedgerService } from '../core/ledger.service';
import { SequenceService } from '../core/sequence.service';
import { AuditService } from '../core/audit.service';
import { ScopeService } from '../core/scope.service';

/**
 * Field collections. Cash moves the debt from the outlet to the DSR (cash-in-transit until
 * deposited — deposit reconciliation is Phase 4). Field UPI sits in a clearing account
 * until the gateway confirms it.
 */
@Injectable()
export class CollectionsService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly seq: SequenceService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
  ) {}

  async collect(
    tx: Tx,
    user: AuthUser,
    m: {
      idempotencyKey: string;
      capturedAt: string;
      payload: { outletId: string; distributorId?: string; mode: 'CASH' | 'UPI' | 'CHEQUE'; amountPaise: number; reference?: string; chequeNo?: string; chequeBank?: string; chequeDate?: string };
    },
  ) {
    const p = m.payload;
    await this.scope.assertOutlet(tx, user, p.outletId);
    if (p.mode === 'UPI' && !p.reference) throw new DomainError('UPI_REFERENCE_REQUIRED', 'UPI collections need the UTR / reference');
    if (p.mode === 'CHEQUE' && (!p.chequeNo || !p.chequeBank)) throw new DomainError('CHEQUE_DETAILS_REQUIRED', 'Cheque number and bank are required');
    const outlet = await tx.outlet.findFirst({ where: { id: p.outletId, tenantId: user.tenantId }, include: { services: true } });
    if (!outlet) throw notFound('Outlet');
    const svc = p.distributorId
      ? outlet.services.find((s) => s.distributorId === p.distributorId)
      : (outlet.services.find((s) => s.isPrimary) ?? outlet.services[0]);
    if (!svc) throw new DomainError('NO_DISTRIBUTOR', 'Outlet has no distributor for this collection');

    const amount = BigInt(p.amountPaise);
    const ar = await this.ledger.balance(tx, user.tenantId, svc.distributorId, `AR:${outlet.id}`);
    const flags = amount > ar ? ['ADVANCE'] : [];
    const id = randomUUID();
    const receiptNo = await this.seq.opNo(tx, user.tenantId, 'RC');
    const journal = await this.ledger.post(tx, {
      tenantId: user.tenantId,
      bookOwner: svc.distributorId,
      docType: 'PAYMENT',
      docId: id,
      narration: `${p.mode} ${receiptNo} from ${outlet.name}${p.reference ? ` ref ${p.reference}` : ''}${p.chequeNo ? ` chq ${p.chequeNo} ${p.chequeBank}` : ''}`,
      postedById: user.userId,
      lines: [
        { account: p.mode === 'CASH' ? Accounts.cashInTransit(user.userId, user.name) : p.mode === 'CHEQUE' ? Accounts.chequesInHand : Accounts.upiClearing, debit: amount },
        { account: Accounts.receivable(outlet.id, outlet.name), credit: amount },
      ],
    });
    await tx.payment.create({
      data: {
        id,
        tenantId: user.tenantId,
        receiptNo,
        distributorId: svc.distributorId,
        outletId: outlet.id,
        mode: p.mode,
        amountPaise: amount,
        status: p.mode === 'UPI' ? 'PENDING_VERIFICATION' : 'RECEIVED',
        reference: p.reference,
        chequeNo: p.chequeNo,
        chequeBank: p.chequeBank,
        chequeDate: p.chequeDate ? new Date(p.chequeDate) : undefined,
        collectedById: user.userId,
        capturedAt: new Date(m.capturedAt),
        sourceKey: m.idempotencyKey,
        journalId: journal.id,
      },
    });
    await this.audit.record(tx, user, 'PAYMENT_COLLECTED', 'Payment', id, {
      after: { receiptNo, mode: p.mode, amountPaise: amount, outletId: outlet.id, flags },
    });
    return { refs: [receiptNo], flags };
  }
}
