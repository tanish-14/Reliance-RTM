import { priceOrder, routeLines, type PricedOrder } from '@rtm/shared';
import type { RtmDb, BundleOutlet } from './db';

export interface DeviceQuote {
  groups: { distributorId: string; distributorName: string; rtmModelCode: string; priced: PricedOrder; creditWarning: string | null }[];
  totalPaise: number;
  unroutable: string[];
}

/**
 * Price an order on the device with the same engine and the same masters the server uses.
 * Splits by RTM model like the server, and warns (does not block) on credit.
 */
export async function quote(db: RtmDb, outlet: BundleOutlet, lines: { productId: string; qty: number }[]): Promise<DeviceQuote> {
  const [products, priceLists, marginRules, schemes] = await Promise.all([
    db.products.toArray(),
    db.priceLists.toArray(),
    db.marginRules.toArray(),
    db.schemes.toArray(),
  ]);
  const byId = Object.fromEntries(products.map((p) => [p.id, p]));
  const { groups, unroutable } = routeLines(lines, (id) => byId[id]?.brandId, outlet.services);
  const at = new Date().toISOString();
  const out: DeviceQuote['groups'] = [];
  for (const g of groups) {
    const priced = priceOrder({
      at,
      outlet: { id: outlet.id, channelCode: outlet.channelCode, stateCode: outlet.stateCode, tier: outlet.tier },
      supplierStateCode: g.service.distributorStateCode,
      products: byId,
      priceLists,
      marginRules,
      schemes,
      lines: g.lines,
    });
    out.push({
      distributorId: g.service.distributorId,
      distributorName: g.service.distributorName,
      rtmModelCode: g.service.rtmModelCode,
      priced,
      creditWarning: await creditWarning(db, outlet.id, g.service.distributorId, priced.totalPaise),
    });
  }
  return { groups: out, totalPaise: out.reduce((a, g) => a + g.priced.totalPaise, 0), unroutable: unroutable.map((l) => l.productId) };
}

/** Snapshot available credit minus orders still waiting in the outbox. */
async function creditWarning(db: RtmDb, outletId: string, distributorId: string, total: number): Promise<string | null> {
  const c = await db.credit.get([outletId, distributorId]);
  if (!c) return null;
  if (c.blocked) return 'Credit is blocked for this outlet — the order will be held for approval.';
  const pending = await db.outbox.where('outletId').equals(outletId).filter((o) => o.status === 'PENDING' && o.type === 'ORDER').toArray();
  const queued = pending.reduce((a, o) => a + (o.payload.clientTotalPaise ?? 0), 0);
  const available = c.limitPaise - c.exposurePaise - queued;
  return total > available ? `Exceeds available credit (₹${Math.max(0, Math.floor(available / 100)).toLocaleString('en-IN')}) — it will be held for manager approval.` : null;
}
