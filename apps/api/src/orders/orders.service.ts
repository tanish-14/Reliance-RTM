import { Injectable } from '@nestjs/common';
import type { Channel, Distributor, Outlet, OutletService, RtmModel } from '@prisma/client';
import { routeLines, type PricedOrder, type PricingOutlet } from '@rtm/shared';
import type { Tx } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { DomainError, notFound } from '../common/errors';
import { SequenceService } from '../core/sequence.service';
import { AuditService } from '../core/audit.service';
import { ReviewService } from '../core/review.service';
import { ScopeService } from '../core/scope.service';
import { PricingService, PRICING_LOOKBACK_MS } from './pricing.service';
import { CreditService } from './credit.service';
import { FulfilmentService } from './fulfilment.service';
import { OrderStateService } from './order-state.service';

type Service = OutletService & { distributor: Distributor; rtmModel: RtmModel; rtmModelCode: string };
type FullOutlet = Outlet & { channel: Channel; services: (OutletService & { distributor: Distributor; rtmModel: RtmModel })[] };

const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Which instant to price an offline order at. Orders are honoured at the prices valid when
 * they were captured, within a bounded window — beyond it the device clock is not trusted.
 */
export function pricingInstant(capturedAt: Date, now: Date): { at: Date; flags: string[] } {
  if (capturedAt.getTime() > now.getTime() + CLOCK_SKEW_MS) return { at: now, flags: ['CLOCK_SKEW'] };
  if (capturedAt.getTime() < now.getTime() - PRICING_LOOKBACK_MS) return { at: now, flags: ['STALE_CAPTURE'] };
  return { at: capturedAt, flags: [] };
}

const pricingOutlet = (o: FullOutlet): PricingOutlet => ({
  id: o.id,
  channelCode: o.channel.code,
  stateCode: o.stateCode,
  tier: o.tier,
});

@Injectable()
export class OrdersService {
  constructor(
    private readonly pricing: PricingService,
    private readonly credit: CreditService,
    private readonly seq: SequenceService,
    private readonly audit: AuditService,
    private readonly reviews: ReviewService,
    private readonly scope: ScopeService,
    private readonly fulfilment: FulfilmentService,
    private readonly state: OrderStateService,
  ) {}

  private async loadOutlet(tx: Tx, tenantId: string, outletId: string): Promise<FullOutlet> {
    const outlet = await tx.outlet.findFirst({
      where: { id: outletId, tenantId },
      include: { channel: true, services: { include: { distributor: true, rtmModel: true } } },
    });
    if (!outlet) throw notFound('Outlet');
    if (!outlet.active) throw new DomainError('OUTLET_INACTIVE', `${outlet.name} is inactive`);
    return outlet;
  }

  /**
   * An order captured in the field (usually offline). Re-priced as of capture time, split
   * across the outlet's RTM models by brand, credit-checked. Breaches are held, never dropped.
   */
  async createFieldOrder(
    tx: Tx,
    user: AuthUser,
    m: { idempotencyKey: string; capturedAt: string; payload: { outletId: string; lines: { productId: string; qty: number }[]; clientTotalPaise: number; notes?: string } },
    now: Date,
  ) {
    const p = m.payload;
    await this.scope.assertOutlet(tx, user, p.outletId);
    const outlet = await this.loadOutlet(tx, user.tenantId, p.outletId);
    const capturedAt = new Date(m.capturedAt);
    const { at, flags } = pricingInstant(capturedAt, now);

    const products = await tx.product.findMany({
      where: { tenantId: user.tenantId, id: { in: p.lines.map((l) => l.productId) }, active: true },
    });
    const brandOf = new Map(products.map((x) => [x.id, x.brandId]));
    const services: Service[] = outlet.services.map((s) => ({ ...s, rtmModelCode: s.rtmModel.code }));
    const { groups, unroutable } = routeLines(p.lines, (id) => brandOf.get(id), services);
    if (unroutable.length) {
      throw new DomainError('UNROUTABLE', 'Some products are not served to this outlet by any distributor', 422, unroutable);
    }

    const priced: { service: Service; priced: PricedOrder }[] = [];
    for (const g of groups) {
      const r = await this.pricing.price(tx, user.tenantId, {
        at,
        outlet: pricingOutlet(outlet),
        supplierStateCode: g.service.distributor.stateCode,
        lines: g.lines,
      });
      if (r.errors.length) throw new DomainError('PRICING_FAILED', 'Some lines could not be priced', 422, r.errors);
      priced.push({ service: g.service, priced: r });
    }

    const serverTotal = priced.reduce((a, x) => a + x.priced.totalPaise, 0);
    const delta = serverTotal - p.clientTotalPaise;
    if (delta !== 0) flags.push('PRICE_MISMATCH');

    const refs: string[] = [];
    const allFlags = new Set<string>();
    for (const [i, g] of priced.entries()) {
      const order = await this.place(tx, user, {
        outlet,
        service: g.service,
        priced: g.priced,
        source: 'DSR',
        capturedAt,
        pricedAt: at,
        flags,
        priceDeltaPaise: delta,
        clientTotalPaise: priced.length === 1 ? p.clientTotalPaise : null,
        sourceKey: `${m.idempotencyKey}#${i}`,
        notes: p.notes,
      });
      refs.push(order.orderNo);
      order.flags.forEach((f) => allFlags.add(f));
    }
    return { refs, flags: [...allFlags] };
  }

  /** Common placement path for every channel/source: credit check -> confirm or hold -> auto-fulfil if the model says so. */
  async place(
    tx: Tx,
    user: AuthUser,
    a: {
      outlet: FullOutlet;
      service: Service;
      priced: PricedOrder;
      source: string;
      capturedAt: Date;
      pricedAt: Date;
      flags: string[];
      priceDeltaPaise: number;
      clientTotalPaise: number | null;
      sourceKey: string | null;
      notes?: string;
    },
  ) {
    const flags = [...a.flags];
    const total = BigInt(a.priced.totalPaise);
    let creditPosition = null;
    if (a.service.rtmModel.requiresCreditCheck) {
      const c = await this.credit.check(tx, user.tenantId, a.outlet.id, a.service.distributorId, total);
      flags.push(...c.flags);
      creditPosition = c.position;
    }
    // Hold when credit is breached/blocked, or the retailer would pay more than the device showed.
    const holdReasons = flags.filter(
      (f) => f === 'CREDIT_BREACH' || f === 'CREDIT_BLOCKED' || (f === 'PRICE_MISMATCH' && a.priceDeltaPaise > 0),
    );

    const orderNo = await this.seq.opNo(tx, user.tenantId, 'SO');
    const order = await tx.order.create({
      data: {
        tenantId: user.tenantId,
        orderNo,
        source: a.source,
        outletId: a.outlet.id,
        distributorId: a.service.distributorId,
        rtmModelId: a.service.rtmModelId,
        channelCode: a.outlet.channel.code,
        placedById: user.userId,
        status: 'PLACED',
        flags,
        capturedAt: a.capturedAt,
        pricedAt: a.pricedAt,
        grossPaise: BigInt(a.priced.grossPaise),
        marginDiscPaise: BigInt(a.priced.marginDiscPaise),
        schemeDiscPaise: BigInt(a.priced.schemeDiscPaise),
        taxablePaise: BigInt(a.priced.taxablePaise),
        taxPaise: BigInt(a.priced.taxPaise),
        totalPaise: total,
        clientTotalPaise: a.clientTotalPaise === null ? null : BigInt(a.clientTotalPaise),
        isInterState: a.priced.isInterState,
        sourceKey: a.sourceKey,
        notes: a.notes,
        lines: {
          create: a.priced.lines.map((l) => ({
            productId: l.productId,
            qty: l.qty,
            freeQty: l.freeQty,
            unitPricePaise: BigInt(l.unitPricePaise),
            grossPaise: BigInt(l.grossPaise),
            marginBp: l.marginBp,
            marginDiscPaise: BigInt(l.marginDiscPaise),
            schemeDiscPaise: BigInt(l.schemeDiscPaise),
            taxablePaise: BigInt(l.taxablePaise),
            gstRateBp: l.gstRateBp,
            taxPaise: BigInt(l.taxPaise),
            totalPaise: BigInt(l.totalPaise),
            appliedSchemes: l.appliedSchemes as any,
          })),
        },
        events: { create: { toStatus: 'PLACED', actorId: user.userId, note: `Captured via ${a.source}` } },
      },
    });

    const hold = holdReasons.length > 0;
    await this.state.transition(
      tx,
      order.id,
      'PLACED',
      hold ? 'ON_HOLD' : 'CONFIRMED',
      user.userId,
      hold ? `Held for review: ${holdReasons.join(', ')}` : 'Auto-confirmed',
    );
    if (hold || flags.includes('PRICE_MISMATCH') || flags.includes('STALE_CAPTURE') || flags.includes('CLOCK_SKEW')) {
      await this.reviews.raise(tx, user.tenantId, {
        kind: hold ? 'ORDER_HOLD' : 'ORDER_FLAGGED',
        refType: 'Order',
        refId: order.id,
        distributorId: order.distributorId,
        summary: `${orderNo} ${a.outlet.name}: ${flags.join(', ')}`,
        details: { flags, priceDeltaPaise: a.priceDeltaPaise, credit: creditPosition, totalPaise: total },
      });
    }
    await this.audit.record(tx, user, 'ORDER_PLACED', 'Order', order.id, {
      after: { orderNo, status: hold ? 'ON_HOLD' : 'CONFIRMED', totalPaise: total, flags, rtmModel: a.service.rtmModel.code },
    });

    if (!hold && a.service.rtmModel.autoFulfil) {
      await this.fulfilment.fulfil(tx, user, order.id, { internal: true, autoDeliver: true });
    }
    return order;
  }

  /** Manager decision on a held order. Approving a credit breach is an explicit, audited override. */
  async review(tx: Tx, user: AuthUser, orderId: string, decision: 'APPROVE' | 'REJECT', note?: string) {
    const order = await tx.order.findFirst({ where: { id: orderId, tenantId: user.tenantId }, include: { rtmModel: true } });
    if (!order) throw notFound('Order');
    await this.scope.assertDistributor(tx, user, order.distributorId);
    if (order.status !== 'ON_HOLD') throw new DomainError('NOT_ON_HOLD', `Order is ${order.status}`, 409);
    const to = decision === 'APPROVE' ? 'CONFIRMED' : 'REJECTED';
    await this.state.transition(tx, order.id, 'ON_HOLD', to, user.userId, note ?? `${decision} by ${user.name}`);
    await this.reviews.resolveFor(tx, user.tenantId, 'Order', order.id, user.userId, decision);
    await this.audit.record(tx, user, decision === 'APPROVE' ? 'ORDER_HOLD_APPROVED' : 'ORDER_HOLD_REJECTED', 'Order', order.id, {
      before: { status: 'ON_HOLD', flags: order.flags },
      after: { status: to },
      meta: { note },
    });
    if (to === 'CONFIRMED' && order.rtmModel.autoFulfil) {
      await this.fulfilment.fulfil(tx, user, order.id, { internal: true, autoDeliver: true });
    }
  }

  /** Cancel at any open stage. Undelivered invoices are reversed via credit notes; delivered goods need a return. */
  async cancel(tx: Tx, user: AuthUser, orderId: string, reason: string) {
    const order = await tx.order.findFirst({ where: { id: orderId, tenantId: user.tenantId }, include: { invoices: true } });
    if (!order) throw notFound('Order');
    await this.scope.assertDistributor(tx, user, order.distributorId);
    for (const inv of order.invoices.filter((i) => i.status === 'ISSUED')) {
      await this.fulfilment.cancelInvoice(tx, user, inv.id, reason);
    }
    await this.state.transition(tx, order.id, order.status, 'CANCELLED', user.userId, reason);
    await this.audit.record(tx, user, 'ORDER_CANCELLED', 'Order', order.id, {
      before: { status: order.status },
      after: { status: 'CANCELLED' },
      meta: { reason, invoicesCancelled: order.invoices.filter((i) => i.status === 'ISSUED').map((i) => i.invoiceNo) },
    });
  }

  /** Stop waiting for a backorder: close what was shipped, release the rest. */
  async closeShort(tx: Tx, user: AuthUser, orderId: string, reason: string) {
    const order = await tx.order.findFirst({ where: { id: orderId, tenantId: user.tenantId } });
    if (!order) throw notFound('Order');
    await this.scope.assertDistributor(tx, user, order.distributorId);
    await this.state.transition(tx, order.id, order.status, 'CLOSED', user.userId, `Short-closed: ${reason}`);
    await this.audit.record(tx, user, 'ORDER_SHORT_CLOSED', 'Order', order.id, { meta: { reason } });
  }

  async list(tx: Tx, user: AuthUser, status?: string) {
    const where = await this.scope.orderWhere(tx, user);
    const orders = await tx.order.findMany({
      where: { ...where, ...(status ? { status: { in: status.split(',') } } : {}) },
      orderBy: { receivedAt: 'desc' },
      take: 200,
      include: { rtmModel: { select: { code: true, name: true } } },
    });
    const outlets = new Map(
      (await tx.outlet.findMany({ where: { id: { in: orders.map((o) => o.outletId) } }, select: { id: true, name: true, code: true } })).map(
        (o) => [o.id, o],
      ),
    );
    return orders.map((o) => ({ ...o, outlet: outlets.get(o.outletId) }));
  }

  async detail(tx: Tx, user: AuthUser, orderId: string) {
    const where = await this.scope.orderWhere(tx, user);
    const order = await tx.order.findFirst({
      where: { ...where, id: orderId },
      include: {
        lines: true,
        events: { orderBy: { at: 'asc' } },
        invoices: { include: { lines: true, deliveries: true } },
        rtmModel: true,
      },
    });
    if (!order) throw notFound('Order');
    const [outlet, distributor, products] = await Promise.all([
      tx.outlet.findUnique({ where: { id: order.outletId } }),
      tx.distributor.findUnique({ where: { id: order.distributorId } }),
      tx.product.findMany({ where: { id: { in: order.lines.map((l) => l.productId) } }, select: { id: true, code: true, name: true } }),
    ]);
    const stock = await tx.inventoryBatch.groupBy({
      by: ['productId'],
      where: { location: { distributorId: order.distributorId, type: 'WAREHOUSE' }, bucket: 'SALEABLE', productId: { in: order.lines.map((l) => l.productId) } },
      _sum: { qtyOnHand: true },
    });
    return {
      ...order,
      outlet,
      distributor,
      products: Object.fromEntries(products.map((p) => [p.id, p])),
      stock: Object.fromEntries(stock.map((s) => [s.productId, s._sum.qtyOnHand ?? 0])),
    };
  }
}
