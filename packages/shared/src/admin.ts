import { z } from 'zod';
import { isValidGstin } from './gstin';
import { INVOICE_TIMINGS, ROLES, STOCK_SOURCES } from './enums';

/**
 * Master-data input schemas. The admin UI, the API and bulk CSV import all validate
 * through these, so a row that imports is exactly a row the form would accept.
 */
const code = z.string().trim().min(2).max(40).regex(/^[A-Z0-9][A-Z0-9_\-]*$/, 'Use A–Z, 0–9, - and _');
const state = z.string().regex(/^\d{2}$/, '2-digit GST state code');
const rupeesToPaise = z.coerce.number().nonnegative().transform((r) => Math.round(r * 100));
const optionalGstin = z
  .string()
  .trim()
  .toUpperCase()
  .optional()
  .transform((v) => (v ? v : undefined))
  .refine((v) => v === undefined || isValidGstin(v), 'Invalid GSTIN (format or check digit)');

const gstinMatchesState = <T extends { gstin?: string; stateCode: string }>(v: T, ctx: z.RefinementCtx) => {
  if (v.gstin && v.gstin.slice(0, 2) !== v.stateCode) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['gstin'], message: `GSTIN state ${v.gstin.slice(0, 2)} does not match state ${v.stateCode}` });
  }
};

export const ProductInput = z.object({
  code,
  name: z.string().trim().min(2).max(120),
  brandCode: code,
  category: z.string().trim().min(2).max(60),
  packSize: z.string().trim().min(1).max(30),
  caseSize: z.coerce.number().int().positive(),
  hsnCode: z.string().regex(/^\d{4,8}$/, 'HSN is 4–8 digits'),
  gstRatePct: z.coerce.number().refine((v) => [0, 0.25, 3, 5, 18, 40].includes(v), 'GST slab must be 0, 0.25, 3, 5, 18 or 40'),
  mrpRupees: rupeesToPaise,
  shelfLifeDays: z.coerce.number().int().positive(),
  active: z.coerce.boolean().default(true),
});
export type ProductInput = z.infer<typeof ProductInput>;

export const DistributorInput = z
  .object({
    code: code.max(6, 'Max 6 chars (used in GST invoice numbers)'),
    name: z.string().trim().min(2).max(120),
    gstin: z.string().trim().toUpperCase().refine(isValidGstin, 'Invalid GSTIN (format or check digit)'),
    stateCode: state,
    city: z.string().trim().min(2),
    address: z.string().trim().min(3),
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    tier: z.string().trim().optional(),
    managerEmail: z.string().email(),
    active: z.coerce.boolean().default(true),
  })
  .superRefine(gstinMatchesState);
export type DistributorInput = z.infer<typeof DistributorInput>;

export const OutletServiceInput = z.object({
  rtmModelCode: code,
  distributorCode: code,
  brandCodes: z.array(code).default([]),
  isPrimary: z.coerce.boolean().default(true),
});

export const OutletInput = z
  .object({
    code,
    name: z.string().trim().min(2).max(120),
    ownerName: z.string().trim().min(2).max(80),
    phone: z.string().regex(/^[6-9]\d{9}$/, '10-digit Indian mobile'),
    gstin: optionalGstin,
    channelCode: code,
    tier: z.string().trim().optional(),
    stateCode: state,
    city: z.string().trim().min(2),
    address: z.string().trim().min(3),
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    geofenceM: z.coerce.number().int().min(20).max(5000).default(150),
    creditLimitRupees: rupeesToPaise.optional(),
    creditDays: z.coerce.number().int().min(0).max(120).default(14),
    services: z.array(OutletServiceInput).min(1, 'At least one distributor / RTM model'),
    active: z.coerce.boolean().default(true),
  })
  .superRefine(gstinMatchesState)
  .superRefine((v, ctx) => {
    if (v.services.filter((s) => s.isPrimary).length !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['services'], message: 'Exactly one service mapping must be primary' });
    }
  });
export type OutletInput = z.infer<typeof OutletInput>;

export const UserInput = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(2).max(80),
  phone: z.string().optional(),
  role: z.enum(ROLES),
  title: z.string().trim().max(60).optional(),
  managerEmail: z.string().email().optional(),
  /** Path segment under the manager, e.g. "asm-pune". */
  pathSegment: z.string().regex(/^[a-z0-9.\-]+$/).optional(),
  distributorCode: code.optional(),
  outletCode: code.optional(),
  password: z.string().min(8).optional(),
  active: z.coerce.boolean().default(true),
});
export type UserInput = z.infer<typeof UserInput>;

export const BeatInput = z.object({
  code,
  name: z.string().trim().min(2),
  distributorCode: code,
  dsrEmail: z.string().email(),
  daysOfWeek: z.array(z.coerce.number().int().min(0).max(6)).min(1),
  anchorLat: z.coerce.number(),
  anchorLng: z.coerce.number(),
  geofenceM: z.coerce.number().int().min(50).max(20000).default(500),
  outletCodes: z.array(code).default([]),
});
export type BeatInput = z.infer<typeof BeatInput>;

export const ChannelInput = z.object({
  code,
  name: z.string().trim().min(2),
  minResidualShelfDays: z.coerce.number().int().min(0).max(365),
});

export const RtmModelInput = z.object({
  code,
  name: z.string().trim().min(2),
  stockSource: z.enum(STOCK_SOURCES),
  invoiceTiming: z.enum(INVOICE_TIMINGS),
  autoFulfil: z.coerce.boolean().default(false),
  requiresCreditCheck: z.coerce.boolean().default(true),
});

export const MarginRuleInput = z.object({
  productCode: code.optional(),
  brandCode: code.optional(),
  channelCode: code.optional(),
  stateCode: state.optional(),
  tier: z.string().optional(),
  marginPct: z.coerce.number().min(0).max(50),
  validFrom: z.coerce.date(),
  validTo: z.coerce.date().optional(),
});

/** A price change = a new effective-dated version. The previous version is closed at `validFrom`. */
export const PriceRevisionInput = z.object({
  validFrom: z.coerce.date(),
  items: z.array(z.object({ productCode: code, baseRupees: rupeesToPaise })).min(1),
});

export const PriceListInput = z.object({
  code,
  name: z.string().trim().min(2),
  channelCode: code.optional(),
  stateCode: state.optional(),
  priority: z.coerce.number().int().default(0),
  validFrom: z.coerce.date(),
  items: z.array(z.object({ productCode: code, baseRupees: rupeesToPaise })).min(1),
});

export const IMPORT_ENTITIES = ['products', 'distributors', 'outlets', 'prices'] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

export const ImportRequest = z.object({
  csv: z.string().min(1).max(2_000_000),
  dryRun: z.boolean().default(true),
  /** prices only: target price list + effective date for the new version. */
  priceListCode: z.string().optional(),
  validFrom: z.string().optional(),
});

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF). Returns header-keyed rows. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

/** CSV cells -> schema shape for import (lists are `;`-separated, services are `MODEL:DIST[:BRAND|BRAND][:primary]`). */
export function outletRowToInput(r: Record<string, string>) {
  const services = (r.services ?? '')
    .split(';')
    .filter(Boolean)
    .map((s, i) => {
      const [rtmModelCode, distributorCode, brands = '', primary] = s.split(':');
      return { rtmModelCode, distributorCode, brandCodes: brands ? brands.split('|') : [], isPrimary: primary ? primary === 'primary' : i === 0 };
    });
  return { ...r, gstin: r.gstin || undefined, tier: r.tier || undefined, creditLimitRupees: r.creditLimitRupees || undefined, services };
}

const pct = z.coerce.number().min(0).max(100).transform((p) => Math.round(p * 100));
/** Scheme definition from the admin UI. Rules are typed per scheme type; amounts in rupees/percent. */
export const SchemeInput = z
  .object({
    code,
    name: z.string().trim().min(3),
    description: z.string().max(500).optional(),
    type: z.enum(['QTY_SLAB', 'VALUE_SLAB', 'FREE_GOODS', 'TRADE_DISCOUNT', 'COMBO', 'CASHBACK']),
    validFrom: z.coerce.date(),
    validTo: z.coerce.date(),
    channelCodes: z.array(code).default([]),
    stateCodes: z.array(state).default([]),
    productCodes: z.array(code).default([]),
    brandCodes: z.array(code).default([]),
    priority: z.coerce.number().int().default(0),
    budgetRupees: rupeesToPaise.optional(),
    qtySlabs: z.array(z.object({ minQty: z.coerce.number().int().positive(), discountPct: pct })).optional(),
    valueSlabs: z.array(z.object({ minValueRupees: rupeesToPaise, discountPct: pct })).optional(),
    buyQty: z.coerce.number().int().positive().optional(),
    freeQty: z.coerce.number().int().positive().optional(),
    discountPct: pct.optional(),
    comboItems: z.array(z.object({ productCode: code, minQty: z.coerce.number().int().positive() })).optional(),
    cashbackPct: pct.optional(),
    minValueRupees: rupeesToPaise.optional(),
    maxCashbackRupees: rupeesToPaise.optional(),
  })
  .superRefine((v, ctx) => {
    const need = (ok: unknown, msg: string) => !ok && ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['type'], message: msg });
    if (v.validTo <= v.validFrom) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['validTo'], message: 'Must end after it starts' });
    if (v.type === 'QTY_SLAB') need(v.qtySlabs?.length, 'Quantity slabs required');
    if (v.type === 'VALUE_SLAB') need(v.valueSlabs?.length, 'Value slabs required');
    if (v.type === 'FREE_GOODS') need(v.buyQty && v.freeQty, 'Buy and free quantities required');
    if (v.type === 'TRADE_DISCOUNT') need(v.discountPct !== undefined, 'Discount % required');
    if (v.type === 'COMBO') need((v.comboItems?.length ?? 0) >= 2 && v.discountPct !== undefined, 'At least two combo items and a discount %');
    if (v.type === 'CASHBACK') need(v.cashbackPct !== undefined && v.minValueRupees !== undefined, 'Cashback % and minimum order value required');
  });
export type SchemeInput = z.output<typeof SchemeInput>;

export const ClaimInput = z.object({
  schemeCode: code,
  periodFrom: z.coerce.date(),
  periodTo: z.coerce.date(),
  claimedRupees: rupeesToPaise,
  notes: z.string().max(500).optional(),
});
