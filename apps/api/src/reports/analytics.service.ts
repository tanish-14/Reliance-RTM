import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { ScopeService } from '../core/scope.service';
import { CreditService } from '../orders/credit.service';
import { SchemesService } from '../schemes/schemes.service';

const DAY = 86_400_000;
const TARGET_COVER_DAYS = Number(process.env.TARGET_COVER_DAYS ?? 10);

/**
 * HQ KPIs, all derived from facts (secondary sales, visits, stock, ledger):
 *  - Numeric distribution: % of the outlet universe that bought the brand/SKU in the period.
 *  - Weighted distribution: those outlets' share of *total* sales across the universe.
 *  - Strike rate: visits that produced an order (same DSR, outlet, day) / all visits.
 *  - Pipeline gap: per distributor × SKU, units needed to reach target days of cover at the
 *    last-30-day secondary run-rate.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly credit: CreditService,
    private readonly schemes: SchemesService,
  ) {}

  async kpis(user: AuthUser, fromIso?: string, toIso?: string) {
    const to = toIso ? new Date(toIso) : new Date();
    const from = fromIso ? new Date(fromIso) : new Date(to.getFullYear(), to.getMonth(), 1);
    const ids = await this.scope.distributorIds(this.prisma, user);
    const distWhere = ids === 'ALL' ? {} : { distributorId: { in: ids } };
    const distSql = ids === 'ALL' ? Prisma.empty : Prisma.sql`AND "distributorId" = ANY(${ids})`;

    const universe = await this.prisma.outlet.findMany({ where: { tenantId: user.tenantId, active: true, services: { some: distWhere } }, select: { id: true, channel: { select: { code: true } } } });
    const universeIds = universe.map((o) => o.id);
    const [brands, products] = await Promise.all([
      this.prisma.brand.findMany({ where: { tenantId: user.tenantId } }),
      this.prisma.product.findMany({ where: { tenantId: user.tenantId }, select: { id: true, code: true, name: true, brandId: true } }),
    ]);

    // Net sales per outlet × product in period (sales minus returns/cancellations).
    const facts = await this.prisma.$queryRaw<{ outletId: string; productId: string; brandId: string; net: bigint; qty: bigint }[]>`
      SELECT "outletId", "productId", "brandId", SUM("netPaise")::bigint AS net, SUM(qty)::bigint AS qty
      FROM "SecondarySale" WHERE "tenantId" = ${user.tenantId} AND date >= ${from} AND date < ${to} ${distSql}
      GROUP BY 1, 2, 3`;
    const outletTotal = new Map<string, number>();
    for (const f of facts) outletTotal.set(f.outletId, (outletTotal.get(f.outletId) ?? 0) + Number(f.net));
    const universeSales = [...outletTotal.entries()].filter(([o]) => universeIds.includes(o)).reduce((a, [, v]) => a + v, 0);
    const dist = (match: (f: (typeof facts)[number]) => boolean) => {
      const buyers = new Set(facts.filter((f) => match(f) && f.qty > 0n && universeIds.includes(f.outletId)).map((f) => f.outletId));
      const weight = [...buyers].reduce((a, o) => a + (outletTotal.get(o) ?? 0), 0);
      return {
        buyingOutlets: buyers.size,
        numericPct: universe.length ? Math.round((buyers.size / universe.length) * 1000) / 10 : 0,
        weightedPct: universeSales > 0 ? Math.round((weight / universeSales) * 1000) / 10 : 0,
      };
    };

    // Strike rate.
    const visits = await this.prisma.visit.findMany({ where: { tenantId: user.tenantId, capturedAt: { gte: from, lt: to }, outletId: { in: universeIds } }, select: { userId: true, outletId: true, capturedAt: true } });
    const orders = await this.prisma.order.findMany({ where: { tenantId: user.tenantId, capturedAt: { gte: from, lt: to }, source: 'DSR', ...distWhere, status: { notIn: ['REJECTED'] } }, select: { placedById: true, outletId: true, capturedAt: true } });
    const key = (u: string, o: string, d: Date) => `${u}|${o}|${d.toISOString().slice(0, 10)}`;
    const ordered = new Set(orders.map((o) => key(o.placedById, o.outletId, o.capturedAt)));
    const productive = visits.filter((v) => ordered.has(key(v.userId, v.outletId, v.capturedAt))).length;
    const visitsByDsr = new Map<string, { visits: number; productive: number }>();
    for (const v of visits) {
      const e = visitsByDsr.get(v.userId) ?? { visits: 0, productive: 0 };
      e.visits++;
      if (ordered.has(key(v.userId, v.outletId, v.capturedAt))) e.productive++;
      visitsByDsr.set(v.userId, e);
    }
    const dsrNames = new Map((await this.prisma.user.findMany({ where: { id: { in: [...visitsByDsr.keys()] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));

    // Pipeline gap: stock cover vs run-rate.
    const since30 = new Date(to.getTime() - 30 * DAY);
    const [rate, stock, distributors] = await Promise.all([
      this.prisma.secondarySale.groupBy({ by: ['distributorId', 'productId'], where: { tenantId: user.tenantId, date: { gte: since30, lt: to }, kind: 'SALE', ...distWhere }, _sum: { qty: true, freeQty: true } }),
      this.prisma.inventoryBatch.groupBy({ by: ['locationId', 'productId'], where: { tenantId: user.tenantId, bucket: 'SALEABLE', expiryDate: { gt: to }, location: { type: 'WAREHOUSE', ...distWhere } }, _sum: { qtyOnHand: true } }),
      this.prisma.distributor.findMany({ where: { tenantId: user.tenantId, ...(ids === 'ALL' ? {} : { id: { in: ids } }) }, include: { locations: { where: { type: 'WAREHOUSE' } } } }),
    ]);
    const pipeline = [];
    for (const d of distributors) {
      for (const p of products) {
        const daily = ((rate.find((r) => r.distributorId === d.id && r.productId === p.id)?._sum.qty ?? 0) + (rate.find((r) => r.distributorId === d.id && r.productId === p.id)?._sum.freeQty ?? 0)) / 30;
        const onHand = stock.filter((s) => d.locations.some((l) => l.id === s.locationId) && s.productId === p.id).reduce((a, s) => a + (s._sum.qtyOnHand ?? 0), 0);
        const cover = daily > 0 ? Math.round((onHand / daily) * 10) / 10 : null;
        const gap = Math.max(0, Math.ceil(TARGET_COVER_DAYS * daily - onHand));
        if (daily > 0 || onHand === 0) pipeline.push({ distributor: d.code, sku: p.code, dailyRate: Math.round(daily * 10) / 10, onHand, coverDays: cover, gapUnits: gap });
      }
    }

    // Credit exposure with ageing, cash in transit.
    const accounts = await this.prisma.creditAccount.findMany({ where: { tenantId: user.tenantId, ...distWhere } });
    const ageing = { NOT_DUE: 0, '1-15': 0, '16-30': 0, '31-60': 0, '60+': 0 } as Record<string, number>;
    let exposure = 0;
    let limits = 0;
    let blocked = 0;
    for (const a of accounts) {
      const age = await this.credit.ageing(this.prisma, user.tenantId, a.outletId, a.distributorId);
      for (const [k, v] of Object.entries(age.buckets)) ageing[k] += Number(v);
      exposure += Math.max(0, Number(age.outstandingPaise));
      limits += Number(a.limitPaise);
      if (a.blocked) blocked++;
    }
    const cit = await this.prisma.$queryRaw<{ bal: bigint | null }[]>`
      SELECT SUM(e."debitPaise" - e."creditPaise")::bigint AS bal FROM "LedgerEntry" e JOIN "LedgerAccount" a ON a.id = e."accountId"
      WHERE a."tenantId" = ${user.tenantId} AND a.code LIKE 'CIT:%' ${ids === 'ALL' ? Prisma.empty : Prisma.sql`AND a."bookOwner" = ANY(${ids})`}`;

    return {
      period: { from, to },
      universe: { outlets: universe.length, byChannel: Object.entries(universe.reduce<Record<string, number>>((a, o) => ({ ...a, [o.channel.code]: (a[o.channel.code] ?? 0) + 1 }), {})).map(([channel, outlets]) => ({ channel, outlets })) },
      distribution: {
        byBrand: brands.map((b) => ({ brand: b.name, ...dist((f) => f.brandId === b.id) })),
        bySku: products.map((p) => ({ sku: p.code, name: p.name, ...dist((f) => f.productId === p.id) })),
      },
      strikeRate: {
        visits: visits.length,
        productive,
        pct: visits.length ? Math.round((productive / visits.length) * 1000) / 10 : null,
        byDsr: [...visitsByDsr.entries()].map(([id, v]) => ({ dsr: dsrNames.get(id) ?? id, ...v, pct: Math.round((v.productive / v.visits) * 1000) / 10 })),
      },
      pipeline: pipeline.sort((a, b) => b.gapUnits - a.gapUnits),
      targetCoverDays: TARGET_COVER_DAYS,
      credit: { exposurePaise: exposure, limitsPaise: limits, utilisationPct: limits ? Math.round((exposure / limits) * 1000) / 10 : 0, ageing, blockedAccounts: blocked, accounts: accounts.length },
      cashInTransitPaise: Number(cit[0]?.bal ?? 0n),
      schemeRoi: await this.schemes.roi(user),
    };
  }
}
