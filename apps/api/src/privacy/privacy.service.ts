import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { DomainError, notFound } from '../common/errors';
import { toJson } from '../common/json';
import { AuditService } from '../core/audit.service';

export const NOTICE_VERSION = '2026-11-v1';
export const PURPOSES = {
  ORDER_PROCESSING: 'Processing your orders, invoices, payments and deliveries (required to use the service).',
  CREDIT_ASSESSMENT: 'Assessing and managing your credit limit with your distributor.',
  MARKETING: 'Offers and scheme announcements by SMS / WhatsApp (optional).',
  ANALYTICS: 'Aggregated sales analytics to improve product availability (optional).',
} as const;
export type Purpose = keyof typeof PURPOSES;
const REQUIRED: Purpose[] = ['ORDER_PROCESSING'];

/**
 * DPDP Act 2023 support: purpose-wise consent with an append-only trail, and data-principal
 * requests. Erasure anonymises personal data but keeps tax/financial records the law requires
 * (GST: 8 years) — those rows keep IDs and amounts, not names or phone numbers.
 */
@Injectable()
export class PrivacyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  notice() {
    return {
      version: NOTICE_VERSION,
      controller: 'Reliance Consumer Products Ltd',
      grievanceOfficer: 'privacy@rcpl.example (Data Protection Officer)',
      residency: 'All personal data is stored and processed in India.',
      purposes: Object.entries(PURPOSES).map(([code, text]) => ({ code, text, required: REQUIRED.includes(code as Purpose) })),
      rights: ['Access a copy of your data', 'Correct inaccurate data', 'Erase data no longer required by law', 'Withdraw optional consents at any time', 'Nominate another person', 'Grievance redressal'],
    };
  }

  async consents(user: AuthUser) {
    const rows = await this.prisma.consent.findMany({ where: { tenantId: user.tenantId, subjectId: user.userId }, orderBy: { at: 'desc' } });
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!latest.has(r.purpose)) latest.set(r.purpose, r);
    const state = Object.keys(PURPOSES).map((p) => ({ purpose: p, granted: latest.get(p)?.granted ?? false, at: latest.get(p)?.at ?? null, noticeVersion: latest.get(p)?.noticeVersion ?? null }));
    return { noticeVersion: NOTICE_VERSION, complete: REQUIRED.every((p) => state.find((s) => s.purpose === p)?.granted && latest.get(p)?.noticeVersion === NOTICE_VERSION), state, history: rows.slice(0, 50) };
  }

  async setConsents(user: AuthUser, items: { purpose: string; granted: boolean }[], source: string) {
    for (const i of items) if (!(i.purpose in PURPOSES)) throw new DomainError('UNKNOWN_PURPOSE', i.purpose);
    await this.prisma.tx(async (tx) => {
      await tx.consent.createMany({ data: items.map((i) => ({ tenantId: user.tenantId, subjectId: user.userId, purpose: i.purpose, granted: i.granted, noticeVersion: NOTICE_VERSION, source })) });
      await this.audit.record(tx, user, 'CONSENT_RECORDED', 'User', user.userId, { after: items, meta: { noticeVersion: NOTICE_VERSION, source } });
    });
    return this.consents(user);
  }

  /** Right of access: a machine-readable copy of what we hold about the requester. */
  async export(user: AuthUser) {
    const me = await this.prisma.user.findUniqueOrThrow({ where: { id: user.userId }, select: { id: true, email: true, name: true, phone: true, role: true, title: true, createdAt: true } });
    const outlet = user.outletId ? await this.prisma.outlet.findUnique({ where: { id: user.outletId } }) : null;
    const [orders, payments, consents, requests] = await Promise.all([
      outlet ? this.prisma.order.findMany({ where: { outletId: outlet.id }, include: { lines: true } }) : [],
      outlet ? this.prisma.payment.findMany({ where: { outletId: outlet.id } }) : [],
      this.prisma.consent.findMany({ where: { subjectId: user.userId } }),
      this.prisma.dataRequest.findMany({ where: { subjectId: user.userId } }),
    ]);
    await this.prisma.tx((tx) => this.audit.record(tx, user, 'DATA_EXPORTED', 'User', user.userId));
    return toJson({ generatedAt: new Date(), noticeVersion: NOTICE_VERSION, profile: me, outlet, orders, payments, consents, requests });
  }

  async request(user: AuthUser, type: 'ACCESS' | 'CORRECTION' | 'ERASURE', details?: string) {
    const open = await this.prisma.dataRequest.findFirst({ where: { subjectId: user.userId, type, status: 'OPEN' } });
    if (open) throw new DomainError('ALREADY_OPEN', `You already have an open ${type.toLowerCase()} request`, 409);
    return this.prisma.tx(async (tx) => {
      const r = await tx.dataRequest.create({ data: { tenantId: user.tenantId, subjectId: user.userId, type, details } });
      await this.audit.record(tx, user, 'DATA_REQUEST_RAISED', 'DataRequest', r.id, { after: { type } });
      return r;
    });
  }

  async myRequests(user: AuthUser) {
    return this.prisma.dataRequest.findMany({ where: { subjectId: user.userId }, orderBy: { createdAt: 'desc' } });
  }

  async allRequests(user: AuthUser) {
    const rows = await this.prisma.dataRequest.findMany({ where: { tenantId: user.tenantId }, orderBy: { createdAt: 'desc' }, take: 100 });
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.subjectId) } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u]));
    return rows.map((r) => ({ ...r, subject: users.get(r.subjectId) }));
  }

  /** Admin completes a request. Erasure anonymises personal fields; ledger/tax rows remain (legal retention). */
  async complete(admin: AuthUser, id: string, decision: 'COMPLETE' | 'REJECT', note?: string) {
    return this.prisma.tx(async (tx) => {
      const r = await tx.dataRequest.findFirst({ where: { id, tenantId: admin.tenantId } });
      if (!r) throw notFound('Request');
      if (r.status !== 'OPEN') throw new DomainError('ALREADY_DONE', `Request is ${r.status}`, 409);
      let result: Record<string, unknown> = { note };
      if (decision === 'COMPLETE' && r.type === 'ERASURE') {
        const subject = await tx.user.findUniqueOrThrow({ where: { id: r.subjectId } });
        await tx.user.update({ where: { id: subject.id }, data: { name: 'Erased user', email: `erased+${subject.id}@invalid`, phone: null, active: false, mfaSecret: null } });
        if (subject.outletId) {
          // The shop stays (it is a trading entity with tax records); the person's details go.
          await tx.outlet.update({ where: { id: subject.outletId }, data: { ownerName: 'Erased', phone: '0000000000' } });
        }
        result = { ...result, anonymised: ['user.name', 'user.email', 'user.phone', 'outlet.ownerName', 'outlet.phone'], retained: 'Invoices, credit notes, payments and ledger entries (GST / statutory retention).' };
      }
      const row = await tx.dataRequest.update({ where: { id }, data: { status: decision === 'COMPLETE' ? 'COMPLETED' : 'REJECTED', result: toJson(result), handledById: admin.userId, completedAt: new Date() } });
      await this.audit.record(tx, admin, `DATA_REQUEST_${row.status}`, 'DataRequest', id, { meta: result });
      return row;
    });
  }
}
