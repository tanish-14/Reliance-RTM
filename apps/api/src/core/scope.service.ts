import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Tx } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { forbidden } from '../common/errors';

/**
 * Hierarchy-based data scoping. Roles say *what* you may do (RolesGuard);
 * scope says *which rows* you may do it to:
 *   ADMIN       whole tenant
 *   MANAGER     distributors whose hierarchyPath is under the manager's path
 *   DISTRIBUTOR own distributor
 *   DSR         outlets on own beats; orders they placed
 *   RETAILER    own outlet
 */
@Injectable()
export class ScopeService {
  async distributorIds(tx: Tx, user: AuthUser): Promise<string[] | 'ALL'> {
    switch (user.role) {
      case 'ADMIN':
        return 'ALL';
      case 'MANAGER': {
        const rows = await tx.distributor.findMany({
          where: { tenantId: user.tenantId, hierarchyPath: { startsWith: user.hierarchyPath } },
          select: { id: true },
        });
        return rows.map((r) => r.id);
      }
      case 'DISTRIBUTOR':
        return user.distributorId ? [user.distributorId] : [];
      case 'DSR': {
        const beats = await tx.beat.findMany({ where: { tenantId: user.tenantId, dsrId: user.userId }, select: { distributorId: true } });
        return [...new Set(beats.map((b) => b.distributorId))];
      }
      case 'RETAILER':
        return [];
      default:
        return [];
    }
  }

  async orderWhere(tx: Tx, user: AuthUser): Promise<Prisma.OrderWhereInput> {
    const base = { tenantId: user.tenantId };
    if (user.role === 'DSR') return { ...base, placedById: user.userId };
    if (user.role === 'RETAILER') return { ...base, outletId: user.outletId ?? '__none__' };
    const ids = await this.distributorIds(tx, user);
    return ids === 'ALL' ? base : { ...base, distributorId: { in: ids } };
  }

  async assertDistributor(tx: Tx, user: AuthUser, distributorId: string) {
    const ids = await this.distributorIds(tx, user);
    if (ids !== 'ALL' && !ids.includes(distributorId)) throw forbidden('Outside your distributor scope');
  }

  async dsrOutletIds(tx: Tx, user: AuthUser): Promise<Set<string>> {
    const rows = await tx.beatOutlet.findMany({
      where: { beat: { tenantId: user.tenantId, dsrId: user.userId } },
      select: { outletId: true },
    });
    return new Set(rows.map((r) => r.outletId));
  }

  /** Field users may only transact on outlets on their beats. */
  async assertOutlet(tx: Tx, user: AuthUser, outletId: string) {
    if (user.role === 'DSR') {
      if (!(await this.dsrOutletIds(tx, user)).has(outletId)) throw forbidden('Outlet is not on your beats');
    } else if (user.role === 'RETAILER') {
      if (user.outletId !== outletId) throw forbidden('Not your outlet');
    } else if (user.role !== 'ADMIN') {
      const ids = await this.distributorIds(tx, user);
      const svc = await tx.outletService.findFirst({ where: { outletId, distributorId: ids === 'ALL' ? undefined : { in: ids } } });
      if (!svc) throw forbidden('Outlet is outside your scope');
    }
  }
}
