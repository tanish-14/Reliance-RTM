import { describe, expect, it } from 'vitest';
import { priceOrder, resolvePrice, type PricingInput, type SchemeDef } from './pricing';
import { allocate } from './money';

const AT = '2026-11-03T10:00:00.000Z';
const products = {
  cola500: { id: 'cola500', code: 'CAMPA-COLA-500', name: 'Campa Cola 500ml', brandId: 'campa', hsnCode: '22021010', gstRateBp: 4000, mrpPaise: 4000, caseSize: 24 },
  atta5: { id: 'atta5', code: 'IND-ATTA-5KG', name: 'Independence Atta 5kg', brandId: 'ind', hsnCode: '11010000', gstRateBp: 500, mrpPaise: 26000, caseSize: 4 },
};
const base: PricingInput = {
  at: AT,
  outlet: { id: 'o1', channelCode: 'GT', stateCode: '27', tier: 'GOLD' },
  supplierStateCode: '27',
  products,
  priceLists: [
    { id: 'pl1', code: 'NATIONAL', channelCode: null, stateCode: null, priority: 0, validFrom: '2026-01-01T00:00:00Z', validTo: null, items: { cola500: 2500, atta5: 20000 } },
  ],
  marginRules: [],
  schemes: [],
  lines: [],
};
const scheme = (s: Partial<SchemeDef> & Pick<SchemeDef, 'type' | 'rules'>): SchemeDef =>
  ({ id: s.code ?? 'S', code: 'S', name: 'S', validFrom: '2026-10-01T00:00:00Z', validTo: '2026-12-31T23:59:59Z', channelCodes: [], stateCodes: [], productIds: [], brandIds: [], priority: 0, ...s }) as SchemeDef;

describe('price resolution', () => {
  it('prefers the most specific valid list, and respects effective dates', () => {
    const lists = [
      ...base.priceLists,
      { id: 'pl2', code: 'GT-MH', channelCode: 'GT', stateCode: '27', priority: 0, validFrom: '2026-01-01T00:00:00Z', validTo: '2026-11-01T00:00:00Z', items: { cola500: 2400 } },
      { id: 'pl3', code: 'GT-MH-NOV', channelCode: 'GT', stateCode: '27', priority: 0, validFrom: '2026-11-01T00:00:00Z', validTo: null, items: { cola500: 2450 } },
    ];
    expect(resolvePrice(lists, 'cola500', base.outlet, AT)?.list.code).toBe('GT-MH-NOV');
    expect(resolvePrice(lists, 'cola500', base.outlet, '2026-10-15T00:00:00Z')?.list.code).toBe('GT-MH');
    expect(resolvePrice(lists, 'atta5', base.outlet, AT)?.list.code).toBe('NATIONAL');
    expect(resolvePrice(lists, 'cola500', { ...base.outlet, channelCode: 'MT' }, AT)?.list.code).toBe('NATIONAL');
  });
});

describe('priceOrder', () => {
  it('computes intra-state CGST + SGST on taxable value', () => {
    const r = priceOrder({ ...base, lines: [{ productId: 'atta5', qty: 2 }] });
    expect(r.isInterState).toBe(false);
    expect(r.taxablePaise).toBe(40000);
    expect(r.cgstPaise).toBe(1000);
    expect(r.sgstPaise).toBe(1000);
    expect(r.igstPaise).toBe(0);
    expect(r.totalPaise).toBe(42000);
  });

  it('computes IGST when supplier and place of supply differ', () => {
    const r = priceOrder({ ...base, supplierStateCode: '24', lines: [{ productId: 'cola500', qty: 10 }] });
    expect(r.isInterState).toBe(true);
    expect(r.igstPaise).toBe(10000);
    expect(r.cgstPaise + r.sgstPaise).toBe(0);
  });

  it('applies the most specific margin rule only (no stacking)', () => {
    const r = priceOrder({
      ...base,
      marginRules: [
        { id: 'm1', productId: null, brandId: null, channelCode: 'GT', stateCode: null, tier: null, marginBp: 200, validFrom: '2026-01-01T00:00:00Z', validTo: null },
        { id: 'm2', productId: null, brandId: 'campa', channelCode: 'GT', stateCode: null, tier: null, marginBp: 500, validFrom: '2026-01-01T00:00:00Z', validTo: null },
      ],
      lines: [{ productId: 'cola500', qty: 10 }, { productId: 'atta5', qty: 1 }],
    });
    expect(r.lines[0].marginBp).toBe(500);
    expect(r.lines[0].marginDiscPaise).toBe(1250);
    expect(r.lines[1].marginBp).toBe(200);
  });

  it('picks the best quantity slab and ignores schemes outside their channel or dates', () => {
    const r = priceOrder({
      ...base,
      schemes: [
        scheme({ code: 'Q1', type: 'QTY_SLAB', brandIds: ['campa'], rules: { slabs: [{ minQty: 24, discountBp: 500 }, { minQty: 48, discountBp: 800 }] } }),
        scheme({ code: 'MT-ONLY', type: 'QTY_SLAB', channelCodes: ['MT'], rules: { slabs: [{ minQty: 1, discountBp: 5000 }] } }),
        scheme({ code: 'EXPIRED', type: 'QTY_SLAB', validTo: '2026-10-31T00:00:00Z', rules: { slabs: [{ minQty: 1, discountBp: 5000 }] } }),
      ],
      lines: [{ productId: 'cola500', qty: 48 }],
    });
    expect(r.lines[0].appliedSchemes.map((a) => a.code)).toEqual(['Q1']);
    expect(r.lines[0].schemeDiscPaise).toBe(Math.round(2500 * 48 * 0.08));
  });

  it('adds free goods in multiples of the buy quantity', () => {
    const r = priceOrder({
      ...base,
      schemes: [scheme({ code: 'F', type: 'FREE_GOODS', productIds: ['cola500'], rules: { buyQty: 24, freeQty: 2 } })],
      lines: [{ productId: 'cola500', qty: 50 }],
    });
    expect(r.lines[0].freeQty).toBe(4);
    expect(r.lines[0].taxablePaise).toBe(2500 * 50);
  });

  it('allocates value-slab discounts across eligible lines exactly', () => {
    const r = priceOrder({
      ...base,
      schemes: [scheme({ code: 'V', type: 'VALUE_SLAB', brandIds: ['ind'], rules: { slabs: [{ minValuePaise: 50000, discountBp: 300 }] } })],
      lines: [{ productId: 'atta5', qty: 3 }, { productId: 'cola500', qty: 5 }],
    });
    expect(r.lines[0].schemeDiscPaise).toBe(1800);
    expect(r.lines[1].schemeDiscPaise).toBe(0);
    expect(r.schemeDiscPaise).toBe(1800);
  });

  it('reports lines it cannot price instead of silently dropping them', () => {
    const r = priceOrder({ ...base, lines: [{ productId: 'nope', qty: 1 }, { productId: 'atta5', qty: 0 }] });
    expect(r.errors.map((e) => e.code)).toEqual(['UNKNOWN_PRODUCT', 'BAD_QTY']);
    expect(r.lines).toHaveLength(0);
  });

  it('is deterministic — the device and server get the same total', () => {
    const input = { ...base, lines: [{ productId: 'cola500', qty: 37 }, { productId: 'atta5', qty: 3 }] };
    expect(priceOrder(input).totalPaise).toBe(priceOrder(structuredClone(input)).totalPaise);
  });
});

describe('allocate', () => {
  it('splits so parts sum to the total', () => {
    const parts = allocate(1001, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1001);
  });
});
