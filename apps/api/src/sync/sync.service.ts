import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { SyncInbox } from '@prisma/client';
import type { SyncMutation, SyncPushInput, SyncPushResponse, SyncResult } from '@rtm/shared';
import { PrismaService, type Tx } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { DomainError, isUniqueViolation } from '../common/errors';
import { toJson } from '../common/json';
import { OrdersService } from '../orders/orders.service';
import { AttendanceService } from '../field/attendance.service';
import { CollectionsService } from '../field/collections.service';
import { ReturnsService } from '../field/returns.service';

const FIELD_ROLES = new Set(['DSR']);

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Exactly-once application of device mutations.
 *
 * Each mutation runs in its own transaction that *first* inserts its SyncInbox row
 * (unique on tenant + idempotency key) and then applies the business change. So:
 *  - a retry after success finds the row and replays the stored result (DUPLICATE);
 *  - two concurrent retries race on the unique index — one commits, the other gets a
 *    unique violation, waits for nothing, and replays;
 *  - a crash mid-way rolls back both the inbox row and the change, so the retry re-applies.
 * Business rejections are stored too, so a retry gets the same answer.
 */
@Injectable()
export class SyncService {
  private readonly log = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly attendance: AttendanceService,
    private readonly collections: CollectionsService,
    private readonly returns: ReturnsService,
  ) {}

  async push(user: AuthUser, req: SyncPushInput): Promise<SyncPushResponse> {
    const results: SyncResult[] = [];
    // Sequential on purpose: device order is preserved (e.g. attendance before the first order).
    for (const m of req.mutations) results.push(await this.applyOne(user, req.deviceId, m));
    return { serverTime: new Date().toISOString(), results };
  }

  private async applyOne(user: AuthUser, deviceId: string, m: SyncMutation): Promise<SyncResult> {
    const key = m.idempotencyKey;
    const hash = createHash('sha256').update(stable({ type: m.type, capturedAt: m.capturedAt, payload: m.payload })).digest('hex');

    if (!FIELD_ROLES.has(user.role)) {
      return { idempotencyKey: key, status: 'REJECTED', error: { code: 'FORBIDDEN', message: 'Only field users sync transactions' } };
    }
    if (!key.startsWith(`${deviceId}:`)) {
      return { idempotencyKey: key, status: 'REJECTED', error: { code: 'BAD_KEY', message: 'Idempotency key must be deviceId:localId' } };
    }

    const existing = await this.prisma.syncInbox.findUnique({ where: { tenantId_idempotencyKey: { tenantId: user.tenantId, idempotencyKey: key } } });
    if (existing) return this.replay(existing, hash, user);

    try {
      return await this.prisma.tx(async (tx) => {
        const inbox = await tx.syncInbox.create({
          data: { tenantId: user.tenantId, idempotencyKey: key, userId: user.userId, deviceId, type: m.type, requestHash: hash, status: 'PROCESSING', result: {} },
        });
        const out = await this.dispatch(tx, user, m);
        const result: SyncResult = { idempotencyKey: key, status: 'APPLIED', refs: out.refs, flags: out.flags };
        await tx.syncInbox.update({ where: { id: inbox.id }, data: { status: 'APPLIED', result: toJson(result) } });
        return result;
      });
    } catch (e) {
      if (isUniqueViolation(e, 'idempotencyKey')) {
        const row = await this.prisma.syncInbox.findUnique({ where: { tenantId_idempotencyKey: { tenantId: user.tenantId, idempotencyKey: key } } });
        if (row) return this.replay(row, hash, user);
      }
      if (e instanceof DomainError) {
        const result: SyncResult = { idempotencyKey: key, status: 'REJECTED', error: { code: e.code, message: e.message } };
        try {
          await this.prisma.syncInbox.create({
            data: { tenantId: user.tenantId, idempotencyKey: key, userId: user.userId, deviceId, type: m.type, requestHash: hash, status: 'REJECTED', result: toJson(result) },
          });
        } catch (e2) {
          if (!isUniqueViolation(e2)) throw e2;
        }
        return result;
      }
      this.log.error({ err: e, key }, 'sync mutation failed; device will retry');
      return { idempotencyKey: key, status: 'RETRY', error: { code: 'TRANSIENT', message: 'Temporary server problem' } };
    }
  }

  private replay(row: SyncInbox, hash: string, user: AuthUser): SyncResult {
    if (row.userId !== user.userId || row.requestHash !== hash) {
      return {
        idempotencyKey: row.idempotencyKey,
        status: 'REJECTED',
        error: { code: 'IDEMPOTENCY_KEY_REUSED', message: 'This key was already used for a different transaction' },
      };
    }
    const stored = row.result as unknown as SyncResult;
    return stored.status === 'APPLIED' ? { ...stored, status: 'DUPLICATE' } : stored;
  }

  private dispatch(tx: Tx, user: AuthUser, m: SyncMutation): Promise<{ refs: string[]; flags: string[] }> {
    switch (m.type) {
      case 'ATTENDANCE':
        return this.attendance.attendance(tx, user, m);
      case 'VISIT':
        return this.attendance.visit(tx, user, m);
      case 'ORDER':
        return this.orders.createFieldOrder(tx, user, m, new Date());
      case 'COLLECTION':
        return this.collections.collect(tx, user, m);
      case 'RETURN':
        return this.returns.capture(tx, user, m);
    }
  }
}
