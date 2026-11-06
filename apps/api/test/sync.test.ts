import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MastersBundle } from '@rtm/shared';
import { closeApp, Device, deviceTotal, get, login, outletNamed, prisma, product } from './helpers';

let dsr: string;
let bundle: MastersBundle;

beforeAll(async () => {
  dsr = await login('dsr.ravi@rcpl.test');
  bundle = (await get(dsr, '/sync/pull')).body;
});
afterAll(closeApp);

const orderFor = async (outletName: string, lines: [string, number][]) => {
  const outlet = await outletNamed(outletName);
  const l = await Promise.all(lines.map(async ([code, qty]) => ({ productId: (await product(code)).id, qty })));
  return { outletId: outlet.id, lines: l, clientTotalPaise: deviceTotal(bundle, outlet.id, l) };
};

describe('sync idempotency', () => {
  it('applies a retried push exactly once', async () => {
    const dev = new Device(dsr);
    const m = [dev.mutation('ORDER', await orderFor('Balaji Provision', [['IND-ATTA-5KG', 4]])), dev.mutation('COLLECTION', { outletId: (await outletNamed('Balaji Provision')).id, mode: 'CASH', amountPaise: 10_000 })];
    const first = await dev.push(m);
    const second = await dev.push(m);
    expect(first.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED']);
    expect(second.map((r) => r.status)).toEqual(['DUPLICATE', 'DUPLICATE']);
    expect(second[0].refs).toEqual(first[0].refs);
    const key = (m[0] as { idempotencyKey: string }).idempotencyKey;
    expect(await prisma.order.count({ where: { sourceKey: { startsWith: key } } })).toBe(1);
    expect(await prisma.payment.count({ where: { sourceKey: (m[1] as { idempotencyKey: string }).idempotencyKey } })).toBe(1);
  });

  it('survives concurrent retries of the same key (one winner, the rest DUPLICATE)', async () => {
    const dev = new Device(dsr);
    const m = [dev.mutation('ORDER', await orderFor('New Bharat Stores', [['IND-SOYA-1L', 12]]))];
    const results = (await Promise.all([dev.push(m), dev.push(m), dev.push(m)])).map((r) => r[0].status).sort();
    expect(results).toEqual(['APPLIED', 'DUPLICATE', 'DUPLICATE']);
    expect(await prisma.order.count({ where: { sourceKey: { startsWith: (m[0] as { idempotencyKey: string }).idempotencyKey } } })).toBe(1);
  });

  it('rejects a reused key carrying a different transaction', async () => {
    const dev = new Device(dsr);
    const a = dev.mutation('ORDER', await orderFor('Balaji Provision', [['IND-ATTA-5KG', 1]]));
    await dev.push([a]);
    const tampered = { ...a, payload: await orderFor('Balaji Provision', [['IND-ATTA-5KG', 9]]) };
    const [r] = await dev.push([tampered]);
    expect(r.status).toBe('REJECTED');
    expect(r.error?.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('rejects keys not bound to the pushing device', async () => {
    const dev = new Device(dsr);
    const m = { ...dev.mutation('ATTENDANCE', { kind: 'CHECK_IN', lat: 19.13, lng: 72.83 }), idempotencyKey: 'other-device:1' };
    expect((await dev.push([m]))[0].error?.code).toBe('BAD_KEY');
  });

  it('rejects outlets that are not on the DSR beats', async () => {
    const dev = new Device(dsr);
    const delhiOutlet = await outletNamed('Balaji Provision', 'dsr.aman@rcpl.test');
    const [r] = await dev.push([dev.mutation('ORDER', { outletId: delhiOutlet.id, lines: [{ productId: (await product('IND-ATTA-5KG')).id, qty: 1 }], clientTotalPaise: 1 })]);
    expect(r.status).toBe('REJECTED');
    expect(r.error?.code).toBe('FORBIDDEN');
  });
});

describe('re-validation on sync', () => {
  it('holds an offline order that breaches credit instead of dropping it', async () => {
    // Independent of balances other tests leave behind: squeeze the limit to ₹1.
    const laxmi = await outletNamed('Laxmi Kirana Stores');
    await prisma.creditAccount.updateMany({ where: { outletId: laxmi.id }, data: { limitPaise: 100n } });
    const dev = new Device(dsr);
    const [r] = await dev.push([dev.mutation('ORDER', await orderFor('Laxmi Kirana Stores', [['IND-ATTA-10KG', 6]]))]);
    await prisma.creditAccount.updateMany({ where: { outletId: laxmi.id }, data: { limitPaise: 200_000n } });
    expect(r.status).toBe('APPLIED');
    expect(r.flags).toContain('CREDIT_BREACH');
    const order = await prisma.order.findFirstOrThrow({ where: { orderNo: r.refs![0] } });
    expect(order.status).toBe('ON_HOLD');
    expect(await prisma.exceptionItem.count({ where: { refId: order.id, kind: 'ORDER_HOLD', status: 'OPEN' } })).toBe(1);
  });

  it('prices as of capture time when the price changed while the device was offline', async () => {
    const capturedAt = new Date(Date.now() - 2 * 3600_000);
    const body = await orderFor('Gupta Super Mart', [['IND-MUSTARD-1L', 12]]);
    // HQ raises the price *after* the order was captured.
    const mustard = await product('IND-MUSTARD-1L');
    const t = await prisma.tenant.findFirstOrThrow();
    await prisma.priceList.create({
      data: { tenantId: t.id, code: `PL-HIKE-${Date.now()}`, name: 'Price hike', validFrom: new Date(Date.now() - 3600_000), priority: 5, items: { create: [{ productId: mustard.id, basePaise: 99_900n }] } },
    });
    const dev = new Device(dsr);
    const [r] = await dev.push([dev.mutation('ORDER', body, capturedAt)]);
    expect(r.flags ?? []).not.toContain('PRICE_MISMATCH');
    const order = await prisma.order.findFirstOrThrow({ where: { orderNo: r.refs![0] }, include: { lines: true } });
    expect(Number(order.totalPaise)).toBe(body.clientTotalPaise);
    expect(order.status).toBe('CONFIRMED');
  });

  it('holds an order whose device total is lower than the server price', async () => {
    const body = await orderFor('Gupta Super Mart', [['IND-ATTA-5KG', 4]]);
    const dev = new Device(dsr);
    const [r] = await dev.push([dev.mutation('ORDER', { ...body, clientTotalPaise: body.clientTotalPaise - 500 })]);
    expect(r.flags).toContain('PRICE_MISMATCH');
    expect((await prisma.order.findFirstOrThrow({ where: { orderNo: r.refs![0] } })).status).toBe('ON_HOLD');
  });

  it('flags captures older than the pricing window as stale and prices them now', async () => {
    const body = await orderFor('Gupta Super Mart', [['IND-ATTA-5KG', 1]]);
    const dev = new Device(dsr);
    const [r] = await dev.push([dev.mutation('ORDER', body, new Date(Date.now() - 5 * 86_400_000))]);
    expect(r.flags).toContain('STALE_CAPTURE');
  });
});
