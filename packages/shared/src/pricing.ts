import { allocate, applyBp, sum, type Paise } from './money';

/**
 * Pricing pipeline (identical on device and server):
 *   base price (effective-dated price list, most specific scope wins)
 *   - trade margin (most specific margin rule wins: SKU > brand > tier > channel > state)
 *   - line schemes (best QTY_SLAB per line; best FREE_GOODS per line)
 *   - order schemes (VALUE_SLAB, allocated back onto eligible lines)
 *   = taxable value, then GST (CGST+SGST intra-state, IGST inter-state).
 * The server re-runs this as of the capture time on sync; a different total
 * than the device computed means masters changed while offline.
 */

export interface PricingProduct {
  id: string;
  code: string;
  name: string;
  brandId: string;
  hsnCode: string;
  gstRateBp: number;
  mrpPaise: Paise;
  caseSize: number;
}

export interface PriceListDef {
  id: string;
  code: string;
  channelCode: string | null;
  stateCode: string | null;
  priority: number;
  validFrom: string;
  validTo: string | null;
  /** productId -> base price per unit (ex-GST) in paise */
  items: Record<string, Paise>;
}

export interface MarginRuleDef {
  id: string;
  productId: string | null;
  brandId: string | null;
  channelCode: string | null;
  stateCode: string | null;
  tier: string | null;
  marginBp: number;
  validFrom: string;
  validTo: string | null;
}

interface SchemeBase {
  id: string;
  code: string;
  name: string;
  validFrom: string;
  validTo: string;
  channelCodes: string[];
  stateCodes: string[];
  productIds: string[];
  brandIds: string[];
  priority: number;
}
export type SchemeDef =
  | (SchemeBase & { type: 'QTY_SLAB'; rules: { slabs: { minQty: number; discountBp: number }[] } })
  | (SchemeBase & { type: 'VALUE_SLAB'; rules: { slabs: { minValuePaise: Paise; discountBp: number }[] } })
  | (SchemeBase & { type: 'FREE_GOODS'; rules: { buyQty: number; freeQty: number } });
export type SchemeType = SchemeDef['type'];

export interface PricingOutlet {
  id: string;
  channelCode: string;
  stateCode: string;
  tier: string | null;
}

export interface PricingInput {
  at: string;
  outlet: PricingOutlet;
  supplierStateCode: string;
  products: Record<string, PricingProduct>;
  priceLists: PriceListDef[];
  marginRules: MarginRuleDef[];
  schemes: SchemeDef[];
  lines: { productId: string; qty: number }[];
}

export interface AppliedScheme {
  schemeId: string;
  code: string;
  type: SchemeType;
  discountPaise: Paise;
  freeQty: number;
}

export interface PricedLine {
  productId: string;
  qty: number;
  freeQty: number;
  priceListCode: string;
  unitPricePaise: Paise;
  grossPaise: Paise;
  marginBp: number;
  marginDiscPaise: Paise;
  schemeDiscPaise: Paise;
  taxablePaise: Paise;
  gstRateBp: number;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  taxPaise: Paise;
  totalPaise: Paise;
  appliedSchemes: AppliedScheme[];
}

export interface PricingError {
  productId: string;
  code: 'UNKNOWN_PRODUCT' | 'NO_PRICE' | 'BAD_QTY';
}

export interface PricedOrder {
  at: string;
  isInterState: boolean;
  lines: PricedLine[];
  errors: PricingError[];
  grossPaise: Paise;
  marginDiscPaise: Paise;
  schemeDiscPaise: Paise;
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  taxPaise: Paise;
  totalPaise: Paise;
}

const t = (iso: string) => Date.parse(iso);

function validAt(from: string, to: string | null, at: number): boolean {
  return t(from) <= at && (to === null || at < t(to));
}

export function resolvePrice(
  lists: PriceListDef[],
  productId: string,
  outlet: PricingOutlet,
  at: string,
): { list: PriceListDef; basePaise: Paise } | null {
  const now = t(at);
  const candidates = lists.filter(
    (l) =>
      productId in l.items &&
      validAt(l.validFrom, l.validTo, now) &&
      (l.channelCode === null || l.channelCode === outlet.channelCode) &&
      (l.stateCode === null || l.stateCode === outlet.stateCode),
  );
  if (candidates.length === 0) return null;
  const score = (l: PriceListDef) => (l.channelCode ? 2 : 0) + (l.stateCode ? 1 : 0);
  candidates.sort(
    (a, b) => score(b) - score(a) || b.priority - a.priority || t(b.validFrom) - t(a.validFrom),
  );
  const list = candidates[0];
  return { list, basePaise: list.items[productId] };
}

export function resolveMargin(
  rules: MarginRuleDef[],
  product: PricingProduct,
  outlet: PricingOutlet,
  at: string,
): MarginRuleDef | null {
  const now = t(at);
  const matches = rules.filter(
    (r) =>
      validAt(r.validFrom, r.validTo, now) &&
      (r.productId === null || r.productId === product.id) &&
      (r.brandId === null || r.brandId === product.brandId) &&
      (r.channelCode === null || r.channelCode === outlet.channelCode) &&
      (r.stateCode === null || r.stateCode === outlet.stateCode) &&
      (r.tier === null || r.tier === outlet.tier),
  );
  if (matches.length === 0) return null;
  const score = (r: MarginRuleDef) =>
    (r.productId ? 16 : 0) + (r.brandId ? 8 : 0) + (r.tier ? 4 : 0) + (r.channelCode ? 2 : 0) + (r.stateCode ? 1 : 0);
  matches.sort((a, b) => score(b) - score(a) || t(b.validFrom) - t(a.validFrom));
  return matches[0];
}

export function schemeEligible(s: SchemeDef, product: PricingProduct, outlet: PricingOutlet, at: string): boolean {
  const now = t(at);
  if (!(t(s.validFrom) <= now && now <= t(s.validTo))) return false;
  if (s.channelCodes.length && !s.channelCodes.includes(outlet.channelCode)) return false;
  if (s.stateCodes.length && !s.stateCodes.includes(outlet.stateCode)) return false;
  const scoped = s.productIds.length > 0 || s.brandIds.length > 0;
  if (!scoped) return true;
  return s.productIds.includes(product.id) || s.brandIds.includes(product.brandId);
}

function bestSlab<T extends { discountBp: number }>(slabs: T[], ok: (s: T) => boolean): T | null {
  return slabs.filter(ok).sort((a, b) => b.discountBp - a.discountBp)[0] ?? null;
}

export function priceOrder(input: PricingInput): PricedOrder {
  const { outlet, at } = input;
  const isInterState = input.supplierStateCode !== outlet.stateCode;
  const errors: PricingError[] = [];
  const lines: PricedLine[] = [];

  for (const { productId, qty } of input.lines) {
    const product = input.products[productId];
    if (!product) {
      errors.push({ productId, code: 'UNKNOWN_PRODUCT' });
      continue;
    }
    if (!Number.isInteger(qty) || qty <= 0) {
      errors.push({ productId, code: 'BAD_QTY' });
      continue;
    }
    const price = resolvePrice(input.priceLists, productId, outlet, at);
    if (!price) {
      errors.push({ productId, code: 'NO_PRICE' });
      continue;
    }
    const gross = price.basePaise * qty;
    const margin = resolveMargin(input.marginRules, product, outlet, at);
    const marginBp = margin?.marginBp ?? 0;
    const marginDisc = applyBp(gross, marginBp);
    const afterMargin = gross - marginDisc;

    const eligible = input.schemes.filter((s) => schemeEligible(s, product, outlet, at));
    const applied: AppliedScheme[] = [];

    // Best quantity slab across eligible QTY_SLAB schemes (they do not stack with each other).
    let schemeDisc = 0;
    let bestQty: AppliedScheme | null = null;
    for (const s of eligible) {
      if (s.type !== 'QTY_SLAB') continue;
      const slab = bestSlab(s.rules.slabs, (sl) => qty >= sl.minQty);
      if (!slab) continue;
      const d = applyBp(afterMargin, slab.discountBp);
      if (!bestQty || d > bestQty.discountPaise) {
        bestQty = { schemeId: s.id, code: s.code, type: s.type, discountPaise: d, freeQty: 0 };
      }
    }
    if (bestQty) {
      applied.push(bestQty);
      schemeDisc += bestQty.discountPaise;
    }

    // Free goods (same SKU) — best eligible scheme.
    let freeQty = 0;
    let bestFree: AppliedScheme | null = null;
    for (const s of eligible) {
      if (s.type !== 'FREE_GOODS' || s.rules.buyQty <= 0) continue;
      const f = Math.floor(qty / s.rules.buyQty) * s.rules.freeQty;
      if (f > 0 && (!bestFree || f > bestFree.freeQty)) {
        bestFree = { schemeId: s.id, code: s.code, type: s.type, discountPaise: 0, freeQty: f };
      }
    }
    if (bestFree) {
      applied.push(bestFree);
      freeQty = bestFree.freeQty;
    }

    lines.push({
      productId,
      qty,
      freeQty,
      priceListCode: price.list.code,
      unitPricePaise: price.basePaise,
      grossPaise: gross,
      marginBp,
      marginDiscPaise: marginDisc,
      schemeDiscPaise: schemeDisc,
      taxablePaise: afterMargin - schemeDisc,
      gstRateBp: product.gstRateBp,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 0,
      taxPaise: 0,
      totalPaise: 0,
      appliedSchemes: applied,
    });
  }

  // Order-level value slabs, greedily by size; each line gets at most one.
  const covered = new Set<number>();
  const valueSchemes = input.schemes
    .filter((s): s is Extract<SchemeDef, { type: 'VALUE_SLAB' }> => s.type === 'VALUE_SLAB')
    .map((s) => {
      const idx = lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => schemeEligible(s, input.products[l.productId], outlet, at))
        .map(({ i }) => i);
      const base = sum(idx.map((i) => lines[i].taxablePaise));
      const slab = bestSlab(s.rules.slabs, (sl) => base >= sl.minValuePaise);
      return { s, idx, discount: slab ? applyBp(base, slab.discountBp) : 0 };
    })
    .filter((v) => v.discount > 0)
    .sort((a, b) => b.discount - a.discount || b.s.priority - a.s.priority);

  for (const v of valueSchemes) {
    const idx = v.idx.filter((i) => !covered.has(i));
    if (idx.length === 0) continue;
    const base = sum(idx.map((i) => lines[i].taxablePaise));
    const slab = bestSlab(v.s.rules.slabs, (sl) => base >= sl.minValuePaise);
    if (!slab) continue;
    const discount = applyBp(base, slab.discountBp);
    const parts = allocate(discount, idx.map((i) => lines[i].taxablePaise));
    idx.forEach((i, k) => {
      const l = lines[i];
      l.schemeDiscPaise += parts[k];
      l.taxablePaise -= parts[k];
      l.appliedSchemes.push({ schemeId: v.s.id, code: v.s.code, type: 'VALUE_SLAB', discountPaise: parts[k], freeQty: 0 });
      covered.add(i);
    });
  }

  for (const l of lines) {
    Object.assign(l, gstFor(l.taxablePaise, l.gstRateBp, isInterState));
    l.totalPaise = l.taxablePaise + l.taxPaise;
  }

  return {
    at,
    isInterState,
    lines,
    errors,
    grossPaise: sum(lines.map((l) => l.grossPaise)),
    marginDiscPaise: sum(lines.map((l) => l.marginDiscPaise)),
    schemeDiscPaise: sum(lines.map((l) => l.schemeDiscPaise)),
    taxablePaise: sum(lines.map((l) => l.taxablePaise)),
    cgstPaise: sum(lines.map((l) => l.cgstPaise)),
    sgstPaise: sum(lines.map((l) => l.sgstPaise)),
    igstPaise: sum(lines.map((l) => l.igstPaise)),
    taxPaise: sum(lines.map((l) => l.taxPaise)),
    totalPaise: sum(lines.map((l) => l.totalPaise)),
  };
}

/** GST split by place of supply. Intra-state: CGST + SGST at half rate each; inter-state: IGST. */
export function gstFor(taxable: Paise, rateBp: number, interState: boolean) {
  if (interState) {
    const igst = applyBp(taxable, rateBp);
    return { cgstPaise: 0, sgstPaise: 0, igstPaise: igst, taxPaise: igst };
  }
  const half = applyBp(taxable, rateBp / 2);
  return { cgstPaise: half, sgstPaise: half, igstPaise: 0, taxPaise: half * 2 };
}
