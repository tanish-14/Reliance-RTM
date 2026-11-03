import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Tx } from '../prisma.service';
import { DomainError } from '../common/errors';

export type AccountType = 'ASSET' | 'LIABILITY' | 'INCOME' | 'EXPENSE' | 'EQUITY';

export interface AccountSpec {
  code: string;
  name: string;
  type: AccountType;
  partyType?: string;
  partyId?: string;
}

/** Chart of accounts for a book (a distributor's books, or COMPANY). */
export const Accounts = {
  receivable: (outletId: string, outletName: string): AccountSpec => ({
    code: `AR:${outletId}`,
    name: `Receivable — ${outletName}`,
    type: 'ASSET',
    partyType: 'OUTLET',
    partyId: outletId,
  }),
  cashInTransit: (userId: string, userName: string): AccountSpec => ({
    code: `CIT:${userId}`,
    name: `Cash in transit — ${userName}`,
    type: 'ASSET',
    partyType: 'USER',
    partyId: userId,
  }),
  upiClearing: { code: 'UPI_CLEARING', name: 'UPI clearing (awaiting gateway confirmation)', type: 'ASSET' } as AccountSpec,
  sales: { code: 'SALES', name: 'Sales', type: 'INCOME' } as AccountSpec,
  salesReturns: { code: 'SALES_RETURNS', name: 'Sales returns', type: 'EXPENSE' } as AccountSpec,
  cgstOut: { code: 'GST_OUT_CGST', name: 'Output CGST', type: 'LIABILITY' } as AccountSpec,
  sgstOut: { code: 'GST_OUT_SGST', name: 'Output SGST', type: 'LIABILITY' } as AccountSpec,
  igstOut: { code: 'GST_OUT_IGST', name: 'Output IGST', type: 'LIABILITY' } as AccountSpec,
};

export interface PostLine {
  account: AccountSpec;
  debit?: bigint;
  credit?: bigint;
}

export interface PostJournal {
  tenantId: string;
  bookOwner: string;
  docType: string;
  docId: string;
  narration: string;
  postedById: string;
  lines: PostLine[];
}

/**
 * Double-entry ledger. Journals are append-only and must balance — checked here
 * and again by a deferred DB constraint at commit. Corrections are reversals.
 */
@Injectable()
export class LedgerService {
  async post(tx: Tx, j: PostJournal) {
    const lines = j.lines
      .map((l) => ({ ...l, debit: l.debit ?? 0n, credit: l.credit ?? 0n }))
      .filter((l) => l.debit !== 0n || l.credit !== 0n);
    for (const l of lines) {
      if (l.debit < 0n || l.credit < 0n || (l.debit !== 0n && l.credit !== 0n)) {
        throw new DomainError('LEDGER_BAD_LINE', `Ledger line on ${l.account.code} must be one-sided and non-negative`);
      }
    }
    const dr = lines.reduce((a, l) => a + l.debit, 0n);
    const cr = lines.reduce((a, l) => a + l.credit, 0n);
    if (lines.length < 2 || dr !== cr) {
      throw new DomainError('LEDGER_UNBALANCED', `Journal for ${j.docType} ${j.docId} does not balance (${dr} vs ${cr})`);
    }

    const entries = [];
    for (const l of lines) {
      const accountId = await this.ensureAccount(tx, j.tenantId, j.bookOwner, l.account);
      entries.push({ accountId, debitPaise: l.debit, creditPaise: l.credit });
    }
    return tx.journal.create({
      data: {
        tenantId: j.tenantId,
        bookOwner: j.bookOwner,
        docType: j.docType,
        docId: j.docId,
        narration: j.narration,
        postedById: j.postedById,
        entries: { create: entries },
      },
    });
  }

  /** Explicit reversing journal (swap every side). A journal can be reversed only once. */
  async reverse(tx: Tx, journalId: string, by: { postedById: string; docType: string; docId: string; narration: string }) {
    const original = await tx.journal.findUniqueOrThrow({ where: { id: journalId }, include: { entries: true } });
    if (original.reversalOfId) throw new DomainError('LEDGER_REVERSE_REVERSAL', 'Cannot reverse a reversal');
    return tx.journal.create({
      data: {
        tenantId: original.tenantId,
        bookOwner: original.bookOwner,
        docType: by.docType,
        docId: by.docId,
        narration: by.narration,
        postedById: by.postedById,
        reversalOfId: original.id,
        entries: {
          create: original.entries.map((e) => ({
            accountId: e.accountId,
            debitPaise: e.creditPaise,
            creditPaise: e.debitPaise,
          })),
        },
      },
    });
  }

  /** Debit-minus-credit balance of one account (positive = owed to the book owner for AR). */
  async balance(tx: Tx, tenantId: string, bookOwner: string, code: string): Promise<bigint> {
    const rows = await tx.$queryRaw<{ bal: bigint | null }[]>`
      SELECT SUM(e."debitPaise" - e."creditPaise")::bigint AS bal
      FROM "LedgerEntry" e JOIN "LedgerAccount" a ON a.id = e."accountId"
      WHERE a."tenantId" = ${tenantId} AND a."bookOwner" = ${bookOwner} AND a.code = ${code}`;
    return rows[0]?.bal ?? 0n;
  }

  /** Balances of all accounts for a party type across books (e.g. every outlet's AR). */
  async balancesByParty(tx: Tx, tenantId: string, partyType: string, books?: string[]) {
    const bookFilter = books ? Prisma.sql`AND a."bookOwner" = ANY(${books})` : Prisma.empty;
    return tx.$queryRaw<{ accountId: string; code: string; name: string; bookOwner: string; partyId: string; bal: bigint }[]>`
      SELECT a.id AS "accountId", a.code, a.name, a."bookOwner", a."partyId",
             SUM(e."debitPaise" - e."creditPaise")::bigint AS bal
      FROM "LedgerAccount" a JOIN "LedgerEntry" e ON e."accountId" = a.id
      WHERE a."tenantId" = ${tenantId} AND a."partyType" = ${partyType} ${bookFilter}
      GROUP BY a.id`;
  }

  private async ensureAccount(tx: Tx, tenantId: string, bookOwner: string, spec: AccountSpec): Promise<string> {
    // ON CONFLICT keeps concurrent first-postings to the same account safe.
    await tx.$executeRaw`
      INSERT INTO "LedgerAccount" (id, "tenantId", "bookOwner", code, name, type, "partyType", "partyId")
      VALUES (gen_random_uuid()::text, ${tenantId}, ${bookOwner}, ${spec.code}, ${spec.name}, ${spec.type},
              ${spec.partyType ?? null}, ${spec.partyId ?? null})
      ON CONFLICT ("tenantId", "bookOwner", code) DO NOTHING`;
    const acc = await tx.ledgerAccount.findUniqueOrThrow({
      where: { tenantId_bookOwner_code: { tenantId, bookOwner, code: spec.code } },
      select: { id: true },
    });
    return acc.id;
  }
}
