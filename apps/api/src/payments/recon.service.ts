import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { parseCsv } from '@rtm/shared';
import { PrismaService, type Tx } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { DomainError, notFound } from '../common/errors';
import { Accounts, LedgerService } from '../core/ledger.service';
import { SequenceService } from '../core/sequence.service';
import { AuditService } from '../core/audit.service';
import { ReviewService } from '../core/review.service';
import { ScopeService } from '../core/scope.service';
import { PaymentsService } from './payments.service';

/**
 * Cash day-end and bank reconciliation.
 *
 * Deposit: Dr Bank clearing (declared) / Cr Cash-in-transit (expected); any difference is posted
 * explicitly — shortage as a receivable from the agent, excess to suspense — and queued for review.
 * Statement import: each credit line is matched to exactly one expected receipt (deposit, cheque,
 * bank transfer, field UPI) by reference + amount. Same reference with a different amount, or no
 * match at all, goes to the exception queue.
 */
@Injectable()
export class ReconService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly seq: SequenceService,
    private readonly audit: AuditService,
    private readonly review: ReviewService,
    private readonly scope: ScopeService,
    private readonly payments: PaymentsService,
  ) {}

  async cashPosition(user: AuthUser, distributorId: string, agentId: string) {
    await this.scope.assertDistributor(this.prisma, user, distributorId);
    return this.ledger.balance(this.prisma, user.tenantId, distributorId, `CIT:${agentId}`);
  }

  async deposit(user: AuthUser, i: { agentId?: string; distributorId?: string; declaredPaise: number; bankRef: string; slipDate: string }) {
    const agentId = user.role === 'DSR' ? user.userId : i.agentId;
    if (!agentId) throw new DomainError('AGENT_REQUIRED', 'Whose cash is being deposited?');
    const distributorId = i.distributorId ?? user.distributorId;
    if (!distributorId) throw new DomainError('DISTRIBUTOR_REQUIRED', 'Which distributor account is the cash deposited to?');
    return this.prisma.tx(async (tx) => {
      if (user.role !== 'DSR') await this.scope.assertDistributor(tx, user, distributorId);
      await tx.$executeRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`cit:${distributorId}:${agentId}`}))`;
      const agent = await tx.user.findFirstOrThrow({ where: { id: agentId, tenantId: user.tenantId } });
      const expected = await this.ledger.balance(tx, user.tenantId, distributorId, `CIT:${agentId}`);
      if (expected <= 0n) throw new DomainError('NOTHING_TO_DEPOSIT', `${agent.name} holds no cash for this distributor`);
      if (await tx.cashDeposit.findFirst({ where: { tenantId: user.tenantId, bankRef: i.bankRef } })) throw new DomainError('DUPLICATE_SLIP', `Deposit slip ${i.bankRef} already used`, 409);
      const declared = BigInt(i.declaredPaise);
      const variance = declared - expected;
      const id = randomUUID();
      const depositNo = `DP-${await this.seq.opNo(tx, user.tenantId, 'RC')}`;
      const lines = [
        { account: Accounts.bankClearing, debit: declared },
        { account: Accounts.cashInTransit(agent.id, agent.name), credit: expected },
        ...(variance < 0n ? [{ account: Accounts.cashShortage(agent.id, agent.name), debit: -variance }] : []),
        ...(variance > 0n ? [{ account: Accounts.cashExcess, credit: variance }] : []),
      ];
      const journal = await this.ledger.post(tx, {
        tenantId: user.tenantId, bookOwner: distributorId, docType: 'CASH_DEPOSIT', docId: id, postedById: user.userId,
        narration: `Cash deposit ${depositNo} by ${agent.name}, slip ${i.bankRef}${variance ? ` (variance ₹${Number(variance) / 100})` : ''}`,
        lines,
      });
      const status = variance < 0n ? 'SHORT' : variance > 0n ? 'EXCESS' : 'SUBMITTED';
      const dep = await tx.cashDeposit.create({
        data: { id, tenantId: user.tenantId, depositNo, distributorId, agentId: agent.id, expectedPaise: expected, declaredPaise: declared, variancePaise: variance, bankRef: i.bankRef, slipDate: new Date(i.slipDate), status, journalId: journal.id, createdById: user.userId },
      });
      if (variance !== 0n) {
        await this.review.raise(tx, user.tenantId, {
          kind: variance < 0n ? 'CASH_SHORT' : 'CASH_EXCESS', refType: 'CashDeposit', refId: id, distributorId,
          summary: `${agent.name} deposited ₹${Number(declared) / 100} against ₹${Number(expected) / 100} collected (${variance < 0n ? 'short' : 'excess'} ₹${Math.abs(Number(variance)) / 100})`,
          details: { expectedPaise: expected, declaredPaise: declared },
        });
      }
      await this.audit.record(tx, user, 'CASH_DEPOSITED', 'CashDeposit', id, { after: dep });
      return dep;
    });
  }

  /** Manager writes off an agent's shortage (otherwise it stays recoverable from the agent). */
  async writeOffShortage(user: AuthUser, depositId: string, note: string) {
    return this.prisma.tx(async (tx) => {
      const dep = await tx.cashDeposit.findFirst({ where: { id: depositId, tenantId: user.tenantId } });
      if (!dep) throw notFound('Deposit');
      await this.scope.assertDistributor(tx, user, dep.distributorId);
      if (dep.variancePaise >= 0n) throw new DomainError('NOT_SHORT', 'No shortage on this deposit');
      if (await tx.journal.findFirst({ where: { docType: 'SHORTAGE_WRITEOFF', docId: dep.id } })) throw new DomainError('ALREADY_WRITTEN_OFF', 'Already written off', 409);
      const agent = await tx.user.findUniqueOrThrow({ where: { id: dep.agentId } });
      await this.ledger.post(tx, {
        tenantId: dep.tenantId, bookOwner: dep.distributorId, docType: 'SHORTAGE_WRITEOFF', docId: dep.id, postedById: user.userId,
        narration: `Shortage on ${dep.depositNo} written off: ${note}`,
        lines: [{ account: Accounts.shortageWriteOff, debit: -dep.variancePaise }, { account: Accounts.cashShortage(agent.id, agent.name), credit: -dep.variancePaise }],
      });
      await this.review.resolveFor(tx, dep.tenantId, 'CashDeposit', dep.id, user.userId, `Written off: ${note}`);
      await this.audit.record(tx, user, 'CASH_SHORTAGE_WRITTEN_OFF', 'CashDeposit', dep.id, { meta: { note, amountPaise: -dep.variancePaise } });
    });
  }

  /** CSV columns: date,amount,reference,narration (amount in rupees; credits positive). */
  async importStatement(user: AuthUser, distributorId: string, csv: string) {
    await this.scope.assertDistributor(this.prisma, user, distributorId);
    const rows = parseCsv(csv);
    if (!rows.length) throw new DomainError('EMPTY_CSV', 'No statement lines');
    const batch = `BS-${Date.now()}`;
    let inserted = 0;
    for (const [i, r] of rows.entries()) {
      const amount = Math.round(Number(r.amount) * 100);
      const date = new Date(r.date);
      if (!r.reference || !Number.isFinite(amount) || Number.isNaN(date.getTime())) throw new DomainError('BAD_ROW', `Row ${i + 2}: date, amount and reference are required`);
      const res = await this.prisma.bankStatementLine.createMany({
        data: [{ tenantId: user.tenantId, bookOwner: distributorId, valueDate: date, amountPaise: BigInt(amount), reference: r.reference.trim(), narration: r.narration ?? '', importBatch: batch }],
        skipDuplicates: true,
      });
      inserted += res.count;
    }
    const result = await this.autoMatch(user, distributorId);
    return { batch, lines: rows.length, inserted, duplicatesSkipped: rows.length - inserted, ...result };
  }

  async autoMatch(user: AuthUser, distributorId: string) {
    const lines = await this.prisma.bankStatementLine.findMany({ where: { tenantId: user.tenantId, bookOwner: distributorId, status: 'UNMATCHED', amountPaise: { gt: 0n } } });
    let matched = 0;
    let exceptions = 0;
    for (const line of lines) {
      const outcome = await this.prisma.tx((tx) => this.matchLine(tx, user, line.id));
      if (outcome === 'MATCHED') matched++;
      else exceptions++;
    }
    return { matched, exceptions };
  }

  private async matchLine(tx: Tx, user: AuthUser, lineId: string): Promise<'MATCHED' | 'EXCEPTION'> {
    const line = await tx.bankStatementLine.findUniqueOrThrow({ where: { id: lineId } });
    if (line.status !== 'UNMATCHED') return line.status === 'MATCHED' ? 'MATCHED' : 'EXCEPTION';
    const ref = line.reference;
    const book = line.bookOwner;
    const done = async (type: string, id: string) => {
      await tx.bankStatementLine.update({ where: { id: line.id }, data: { status: 'MATCHED', matchedType: type, matchedId: id } });
      await this.audit.record(tx, user, 'BANK_LINE_MATCHED', 'BankStatementLine', line.id, { meta: { type, id, reference: ref, amountPaise: line.amountPaise } });
      return 'MATCHED' as const;
    };
    const mismatch = async (what: string, expected: bigint) => {
      await tx.bankStatementLine.update({ where: { id: line.id }, data: { status: 'EXCEPTION' } });
      await this.review.raise(tx, user.tenantId, { kind: 'RECON_AMOUNT_MISMATCH', refType: 'BankStatementLine', refId: line.id, distributorId: book, summary: `Bank credit ${ref} ₹${Number(line.amountPaise) / 100} vs ${what} ₹${Number(expected) / 100}`, details: { expectedPaise: expected } });
      return 'EXCEPTION' as const;
    };

    const dep = await tx.cashDeposit.findFirst({ where: { tenantId: user.tenantId, distributorId: book, bankRef: ref, bankLineId: null } });
    if (dep) {
      if (dep.declaredPaise !== line.amountPaise) return mismatch(`deposit ${dep.depositNo}`, dep.declaredPaise);
      await this.ledger.post(tx, {
        tenantId: user.tenantId, bookOwner: book, docType: 'BANK_MATCH', docId: line.id, postedById: user.userId,
        narration: `Bank confirms deposit ${dep.depositNo} (${ref})`,
        lines: [{ account: Accounts.bank, debit: line.amountPaise }, { account: Accounts.bankClearing, credit: line.amountPaise }],
      });
      await tx.cashDeposit.update({ where: { id: dep.id }, data: { bankLineId: line.id, status: dep.status === 'SUBMITTED' ? 'BANK_MATCHED' : dep.status } });
      return done('CashDeposit', dep.id);
    }
    const cheque = await tx.payment.findFirst({ where: { tenantId: user.tenantId, distributorId: book, mode: 'CHEQUE', chequeNo: ref, status: { in: ['RECEIVED', 'DEPOSITED'] } } });
    if (cheque) {
      if (cheque.amountPaise !== line.amountPaise) return mismatch(`cheque ${cheque.chequeNo}`, cheque.amountPaise);
      await this.payments.chequeClear(tx, user, cheque);
      return done('Payment', cheque.id);
    }
    const transfer = await tx.payment.findFirst({ where: { tenantId: user.tenantId, distributorId: book, mode: { in: ['BANK_TRANSFER', 'UPI'] }, reference: ref, status: 'PENDING_VERIFICATION' } });
    if (transfer) {
      if (transfer.amountPaise !== line.amountPaise) return mismatch(`${transfer.mode} ${transfer.receiptNo}`, transfer.amountPaise);
      await this.ledger.post(tx, {
        tenantId: user.tenantId, bookOwner: book, docType: 'BANK_MATCH', docId: line.id, postedById: user.userId,
        narration: `Bank confirms ${transfer.mode} ${ref} (${transfer.receiptNo})`,
        lines: [{ account: Accounts.bank, debit: line.amountPaise }, { account: transfer.mode === 'UPI' ? Accounts.upiClearing : Accounts.bankClearing, credit: line.amountPaise }],
      });
      await tx.payment.update({ where: { id: transfer.id }, data: { status: 'VERIFIED', verifiedAt: new Date() } });
      return done('Payment', transfer.id);
    }
    await tx.bankStatementLine.update({ where: { id: line.id }, data: { status: 'EXCEPTION' } });
    await this.review.raise(tx, user.tenantId, { kind: 'RECON_UNMATCHED', refType: 'BankStatementLine', refId: line.id, distributorId: book, summary: `Unidentified bank credit ${ref} ₹${Number(line.amountPaise) / 100} on ${line.valueDate.toISOString().slice(0, 10)}`, details: { narration: line.narration } });
    return 'EXCEPTION';
  }

  async lines(user: AuthUser, distributorId: string) {
    await this.scope.assertDistributor(this.prisma, user, distributorId);
    return this.prisma.bankStatementLine.findMany({ where: { tenantId: user.tenantId, bookOwner: distributorId }, orderBy: { valueDate: 'desc' }, take: 200 });
  }

  async deposits(user: AuthUser) {
    const ids = await this.scope.distributorIds(this.prisma, user);
    const rows = await this.prisma.cashDeposit.findMany({
      where: { tenantId: user.tenantId, ...(user.role === 'DSR' ? { agentId: user.userId } : ids === 'ALL' ? {} : { distributorId: { in: ids } }) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.agentId) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return rows.map((r) => ({ ...r, agent: users.get(r.agentId) }));
  }
}
