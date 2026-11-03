import { Injectable } from '@nestjs/common';
import type { MarginRule, PriceList, PriceListItem, Product, Scheme } from '@prisma/client';
import {
  priceOrder,
  type MarginRuleDef,
  type PriceListDef,
  type PricedOrder,
  type PricingOutlet,
  type PricingProduct,
  type SchemeDef,
} from '@rtm/shared';
import type { Tx } from '../prisma.service';

// Row -> engine-input mappers. The device's masters bundle is built with these same
// functions, so device and server feed the engine identical data.
export const mapProduct = (p: Product): PricingProduct => ({
  id: p.id,
  code: p.code,
  name: p.name,
  brandId: p.brandId,
  hsnCode: p.hsnCode,
  gstRateBp: p.gstRateBp,
  mrpPaise: Number(p.mrpPaise),
  caseSize: p.caseSize,
});

export const mapPriceList = (l: PriceList & { items: PriceListItem[] }): PriceListDef => ({
  id: l.id,
  code: l.code,
  channelCode: l.channelCode,
  stateCode: l.stateCode,
  priority: l.priority,
  validFrom: l.validFrom.toISOString(),
  validTo: l.validTo?.toISOString() ?? null,
  items: Object.fromEntries(l.items.map((i) => [i.productId, Number(i.basePaise)])),
});

export const mapMargin = (m: MarginRule): MarginRuleDef => ({
  id: m.id,
  productId: m.productId,
  brandId: m.brandId,
  channelCode: m.channelCode,
  stateCode: m.stateCode,
  tier: m.tier,
  marginBp: m.marginBp,
  validFrom: m.validFrom.toISOString(),
  validTo: m.validTo?.toISOString() ?? null,
});

export const mapScheme = (s: Scheme): SchemeDef =>
  ({
    id: s.id,
    code: s.code,
    name: s.name,
    type: s.type,
    validFrom: s.validFrom.toISOString(),
    validTo: s.validTo.toISOString(),
    channelCodes: s.channelCodes,
    stateCodes: s.stateCodes,
    productIds: s.productIds,
    brandIds: s.brandIds,
    priority: s.priority,
    rules: s.rules,
  }) as SchemeDef;

/** Lookback so offline orders can be priced as of their capture time. */
export const PRICING_LOOKBACK_MS = 72 * 3600_000;

@Injectable()
export class PricingService {
  /** Masters relevant for pricing anything between `since` and the future. */
  async loadMasters(tx: Tx, tenantId: string, since: Date) {
    const [products, priceLists, marginRules, schemes] = await Promise.all([
      tx.product.findMany({ where: { tenantId, active: true }, include: { brand: true } }),
      tx.priceList.findMany({
        where: { tenantId, active: true, OR: [{ validTo: null }, { validTo: { gt: since } }] },
        include: { items: true },
      }),
      tx.marginRule.findMany({ where: { tenantId, active: true, OR: [{ validTo: null }, { validTo: { gt: since } }] } }),
      tx.scheme.findMany({ where: { tenantId, status: 'ACTIVE', validTo: { gt: since } } }),
    ]);
    return {
      products,
      priceLists: priceLists.map(mapPriceList),
      marginRules: marginRules.map(mapMargin),
      schemes: schemes.map(mapScheme),
    };
  }

  async price(
    tx: Tx,
    tenantId: string,
    args: { at: Date; outlet: PricingOutlet; supplierStateCode: string; lines: { productId: string; qty: number }[] },
  ): Promise<PricedOrder> {
    const m = await this.loadMasters(tx, tenantId, new Date(args.at.getTime() - 1));
    return priceOrder({
      at: args.at.toISOString(),
      outlet: args.outlet,
      supplierStateCode: args.supplierStateCode,
      products: Object.fromEntries(m.products.map((p) => [p.id, mapProduct(p)])),
      priceLists: m.priceLists,
      marginRules: m.marginRules,
      schemes: m.schemes,
      lines: args.lines,
    });
  }
}
