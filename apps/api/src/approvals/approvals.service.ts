import { Injectable } from '@nestjs/common';
import type { Approval } from '@prisma/client';
import { PrismaService, type Tx } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { DomainError, forbidden, notFound } from '../common/errors';
import { AuditService } from '../core/audit.service';
import { ScopeService } from '../core/scope.service';
import { SchemesService } from '../schemes/schemes.service';

/**
 * Approval levels follow the field hierarchy: ASM = 1, RSM = 2, National (HQ) = 3, admin = 3.
 * Thresholds (paise) decide the level an approval needs. Maker-checker: nobody approves their own request.
 */
export const LEVEL_RULES: Record<string, { upTo: number; level: number }[]> = {
  CREDIT_LIMIT: [{ upTo: 1_00_000_00, level: 1 }, { upTo: 5_00_000_00, level: 2 }, { upTo: Infinity, level: 3 }],
  SCHEME_ACTIVATION: [{ upTo: 10_00_000_00, level: 2 }, { upTo: Infinity, level: 3 }],
  CLAIM_APPROVAL: [{ upTo: 50_000_00, level: 1 }, { upTo: 5_00_000_00, level: 2 }, { upTo: Infinity, level: 3 }],
};

export function levelFor(kind: string, amountPaise: number): number {
  return (LEVEL_RULES[kind] ?? [{ upTo: Infinity, level: 3 }]).find((r) => amountPaise <= r.upTo)!.level;
}

export function userLevel(u: Pick<AuthUser, 'role' | 'hierarchyPath'>): number {
  if (u.role === 'ADMIN') return 3;
  if (u.role !== 'MANAGER') return 0;
  const depth = u.hierarchyPath.split('/').filter(Boolean).length;
  return Math.max(1, 4 - depth);
}

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly schemes: SchemesService,
  ) {}

  async request(
    tx: Tx,
    user: AuthUser,
    a: { kind: keyof typeof LEVEL_RULES; refType: string; refId: string; title: string; amountPaise: bigint | null; distributorId?: string | null; payload?: unknown },
  ) {
    const open = await tx.approval.findFirst({ where: { tenantId: user.tenantId, refType: a.refType, refId: a.refId, kind: a.kind, status: 'PENDING' } });
    if (open) throw new DomainError('ALREADY_PENDING', 'An approval is already pending for this', 409);
    const row = await tx.approval.create({
      data: {
        tenantId: user.tenantId, kind: a.kind, refType: a.refType, refId: a.refId, title: a.title, amountPaise: a.amountPaise, distributorId: a.distributorId ?? null,
        payload: (a.payload ?? {}) as any, requiredLevel: levelFor(a.kind, Number(a.amountPaise ?? 0n)), requestedById: user.userId,
      },
    });
    await this.audit.record(tx, user, 'APPROVAL_REQUESTED', 'Approval', row.id, { after: row });
    return row;
  }

  private async canDecide(tx: Tx, user: AuthUser, a: Approval) {
    if (a.requestedById === user.userId) return false;
    if (userLevel(user) < a.requiredLevel) return false;
    if (a.distributorId) {
      const ids = await this.scope.distributorIds(tx, user);
      if (ids !== 'ALL' && !ids.includes(a.distributorId)) return false;
    }
    return true;
  }

  async inbox(user: AuthUser) {
    const pending = await this.prisma.approval.findMany({ where: { tenantId: user.tenantId, status: 'PENDING' }, orderBy: { createdAt: 'asc' } });
    const mine = [];
    for (const a of pending) mine.push({ ...a, canDecide: await this.canDecide(this.prisma, user, a) });
    const recent = await this.prisma.approval.findMany({ where: { tenantId: user.tenantId, status: { not: 'PENDING' } }, orderBy: { decidedAt: 'desc' }, take: 20 });
    return { pending: mine, recent, myLevel: userLevel(user) };
  }

  /** Approve/reject and apply the effect in the same transaction. */
  async decide(user: AuthUser, id: string, decision: 'APPROVE' | 'REJECT', note?: string) {
    return this.prisma.tx(async (tx) => {
      const a = await tx.approval.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!a) throw notFound('Approval');
      if (a.status !== 'PENDING') throw new DomainError('ALREADY_DECIDED', `Already ${a.status}`, 409);
      if (a.requestedById === user.userId) throw forbidden('You cannot approve your own request');
      if (!(await this.canDecide(tx, user, a))) throw forbidden(`Needs a level-${a.requiredLevel} approver in this territory (you are level ${userLevel(user)})`);
      const r = await tx.approval.updateMany({ where: { id, status: 'PENDING' }, data: { status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', decidedById: user.userId, decidedAt: new Date(), note } });
      if (r.count !== 1) throw new DomainError('CONCURRENT_UPDATE', 'Decided by someone else just now', 409);
      if (decision === 'APPROVE') await this.apply(tx, user, a);
      else if (a.kind === 'CLAIM_APPROVAL') await this.schemes.decideClaim(tx, user, a.refId, 'REJECT', undefined, note);
      await this.audit.record(tx, user, decision === 'APPROVE' ? 'APPROVAL_GRANTED' : 'APPROVAL_REJECTED', 'Approval', a.id, { meta: { kind: a.kind, refId: a.refId, note } });
      return tx.approval.findUniqueOrThrow({ where: { id } });
    });
  }

  private async apply(tx: Tx, user: AuthUser, a: Approval) {
    const p = a.payload as Record<string, any>;
    switch (a.kind) {
      case 'SCHEME_ACTIVATION':
        await this.schemes.setStatus(tx, user, a.refId, 'ACTIVE', `approval ${a.id}`);
        return;
      case 'CREDIT_LIMIT': {
        const before = await tx.creditAccount.findUniqueOrThrow({ where: { id: a.refId } });
        await tx.creditAccount.update({ where: { id: a.refId }, data: { limitPaise: BigInt(p.newLimitPaise), ...(p.creditDays ? { creditDays: p.creditDays } : {}) } });
        await this.audit.record(tx, user, 'CREDIT_LIMIT_CHANGED', 'CreditAccount', a.refId, { before: { limitPaise: before.limitPaise }, after: { limitPaise: p.newLimitPaise }, meta: { approvalId: a.id } });
        return;
      }
      case 'CLAIM_APPROVAL':
        await this.schemes.decideClaim(tx, user, a.refId, 'APPROVE', p.approveRupees, a.note ?? undefined);
        return;
    }
  }

  // --- request helpers used by controllers

  async requestSchemeActivation(user: AuthUser, schemeId: string) {
    return this.prisma.tx(async (tx) => {
      const s = await tx.scheme.findFirst({ where: { id: schemeId, tenantId: user.tenantId } });
      if (!s) throw notFound('Scheme');
      if (s.status !== 'DRAFT' && s.status !== 'PAUSED') throw new DomainError('BAD_STATE', `Scheme is ${s.status}`, 409);
      return this.request(tx, user, { kind: 'SCHEME_ACTIVATION', refType: 'Scheme', refId: s.id, title: `Activate ${s.code} — ${s.name}`, amountPaise: s.budgetPaise ?? 0n });
    });
  }

  async requestCreditLimit(user: AuthUser, creditAccountId: string, newLimitPaise: number, reason: string) {
    return this.prisma.tx(async (tx) => {
      const acc = await tx.creditAccount.findFirst({ where: { id: creditAccountId, tenantId: user.tenantId } });
      if (!acc) throw notFound('Credit account');
      await this.scope.assertDistributor(tx, user, acc.distributorId);
      const outlet = await tx.outlet.findUniqueOrThrow({ where: { id: acc.outletId } });
      return this.request(tx, user, {
        kind: 'CREDIT_LIMIT', refType: 'CreditAccount', refId: acc.id, distributorId: acc.distributorId, amountPaise: BigInt(newLimitPaise),
        title: `Credit limit ${outlet.name}: ₹${Number(acc.limitPaise) / 100} → ₹${newLimitPaise / 100}`, payload: { newLimitPaise, reason },
      });
    });
  }

  /** Called when a claim is validated: it waits here for an approver of the right level. */
  async requestClaim(tx: Tx, user: AuthUser, claim: { id: string; claimNo: string; distributorId: string; validatedPaise: bigint }) {
    return this.request(tx, user, { kind: 'CLAIM_APPROVAL', refType: 'Claim', refId: claim.id, distributorId: claim.distributorId, amountPaise: claim.validatedPaise, title: `Scheme claim ${claim.claimNo}` });
  }
}
