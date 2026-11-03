import { Injectable } from '@nestjs/common';
import type { Tx } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { toJson } from '../common/json';

export type Actor = Pick<AuthUser, 'userId' | 'tenantId' | 'role'>;

/**
 * Immutable audit trail. Always written inside the same transaction as the change,
 * so there is no change without its audit row (and the table rejects UPDATE/DELETE).
 */
@Injectable()
export class AuditService {
  async record(
    tx: Tx,
    actor: Actor,
    action: string,
    entityType: string,
    entityId: string,
    data: { before?: unknown; after?: unknown; meta?: unknown } = {},
  ) {
    await tx.auditLog.create({
      data: {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        actorRole: actor.role,
        action,
        entityType,
        entityId,
        before: data.before === undefined ? undefined : toJson(data.before),
        after: data.after === undefined ? undefined : toJson(data.after),
        meta: data.meta === undefined ? undefined : toJson(data.meta),
      },
    });
  }
}
