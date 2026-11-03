import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { LedgerService } from '../core/ledger.service';
import { ScopeService } from '../core/scope.service';

/** HQ / manager read models. Everything here is derived from facts (secondary sales, ledger). */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly scope: ScopeService,
  ) {}

  async summary(user: AuthUser) {
    const db = this.prisma;
    const ids = await this.scope.distributorIds(db, user);
    const distFilter = ids === 'ALL' ? Prisma.empty : Prisma.sql`AND "distributorId" = ANY(${ids})`;
    const books = ids === 'ALL' ? undefined : ids;
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const dayStart = new Date(new Date().toISOString().slice(0, 10));

    const [byChannel, byBrand, byDay, statusCounts, holds, exceptions, ar, cit, distributors, outlets, users, brands, attendance] = await Promise.all([
      db.$queryRaw<{ channelCode: string; net: bigint; qty: bigint }[]>`
        SELECT "channelCode", SUM("netPaise")::bigint AS net, SUM(qty)::bigint AS qty FROM "SecondarySale"
        WHERE "tenantId" = ${user.tenantId} AND date >= ${monthStart} ${distFilter} GROUP BY 1 ORDER BY 2 DESC`,
      db.$queryRaw<{ brandId: string; net: bigint; qty: bigint }[]>`
        SELECT "brandId", SUM("netPaise")::bigint AS net, SUM(qty)::bigint AS qty FROM "SecondarySale"
        WHERE "tenantId" = ${user.tenantId} AND date >= ${monthStart} ${distFilter} GROUP BY 1 ORDER BY 2 DESC`,
      db.$queryRaw<{ day: string; net: bigint }[]>`
        SELECT to_char(date, 'YYYY-MM-DD') AS day, SUM("netPaise")::bigint AS net FROM "SecondarySale"
        WHERE "tenantId" = ${user.tenantId} AND date >= ${monthStart} ${distFilter} GROUP BY 1 ORDER BY 1`,
      db.order.groupBy({
        by: ['status'],
        where: await this.scope.orderWhere(db, user),
        _count: { _all: true },
        _sum: { totalPaise: true },
      }),
      db.order.findMany({ where: { ...(await this.scope.orderWhere(db, user)), status: 'ON_HOLD' }, orderBy: { receivedAt: 'asc' } }),
      db.exceptionItem.findMany({
        where: { tenantId: user.tenantId, status: 'OPEN', ...(ids === 'ALL' ? {} : { OR: [{ distributorId: { in: ids } }, { distributorId: null }] }) },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.ledger.balancesByParty(db, user.tenantId, 'OUTLET', books),
      this.ledger.balancesByParty(db, user.tenantId, 'USER', books),
      db.distributor.findMany({ where: { tenantId: user.tenantId }, select: { id: true, name: true, code: true } }),
      db.outlet.findMany({ where: { tenantId: user.tenantId }, select: { id: true, name: true, code: true } }),
      db.user.findMany({ where: { tenantId: user.tenantId }, select: { id: true, name: true } }),
      db.brand.findMany({ where: { tenantId: user.tenantId }, select: { id: true, name: true } }),
      db.attendance.findMany({ where: { tenantId: user.tenantId, capturedAt: { gte: dayStart } }, orderBy: { capturedAt: 'desc' }, take: 50 }),
    ]);
    const name = <T extends { id: string; name: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r.name]));
    const outletName = name(outlets);
    const userName = name(users);
    const distName = name(distributors);
    const brandName = name(brands);
    const limits = await db.creditAccount.findMany({ where: { tenantId: user.tenantId } });
    const limitOf = new Map(limits.map((l) => [`${l.outletId}:${l.distributorId}`, l.limitPaise]));

    const mtd = byChannel.reduce((a, r) => a + Number(r.net), 0);
    return {
      secondarySales: {
        mtdNetPaise: mtd,
        todayNetPaise: Number(byDay.find((d) => d.day === dayStart.toISOString().slice(0, 10))?.net ?? 0),
        byChannel: byChannel.map((r) => ({ channelCode: r.channelCode, netPaise: Number(r.net), qty: Number(r.qty) })),
        byBrand: byBrand.map((r) => ({ brand: brandName.get(r.brandId) ?? r.brandId, netPaise: Number(r.net), qty: Number(r.qty) })),
        byDay: byDay.map((r) => ({ day: r.day, netPaise: Number(r.net) })),
      },
      orders: statusCounts.map((s) => ({ status: s.status, count: s._count._all, totalPaise: Number(s._sum.totalPaise ?? 0) })),
      holds: holds.map((o) => ({ id: o.id, orderNo: o.orderNo, outlet: outletName.get(o.outletId), distributor: distName.get(o.distributorId), totalPaise: o.totalPaise, flags: o.flags, receivedAt: o.receivedAt })),
      exceptions,
      creditExposure: ar
        .map((r) => ({
          outlet: outletName.get(r.partyId) ?? r.partyId,
          distributor: distName.get(r.bookOwner) ?? r.bookOwner,
          outstandingPaise: Number(r.bal),
          limitPaise: Number(limitOf.get(`${r.partyId}:${r.bookOwner}`) ?? 0),
        }))
        .filter((r) => r.outstandingPaise !== 0)
        .sort((a, b) => b.outstandingPaise - a.outstandingPaise),
      cashInTransit: cit
        .map((r) => ({ agent: userName.get(r.partyId) ?? r.partyId, distributor: distName.get(r.bookOwner), amountPaise: Number(r.bal) }))
        .filter((r) => r.amountPaise !== 0),
      attendance: attendance.map((a) => ({ ...a, user: userName.get(a.userId) })),
    };
  }
}
