import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { closeApp, getApp, login, post, prisma } from './helpers';

let admin: string;
beforeAll(async () => {
  admin = await login('admin@rcpl.test');
});
afterAll(closeApp);

async function send(partner: string, body: unknown, key = `${partner.toLowerCase()}-demo-key`, secret = `${partner.toLowerCase()}-demo-secret`) {
  const raw = JSON.stringify(body);
  const sig = createHmac('sha256', secret).update(raw).digest('hex');
  return request((await getApp()).getHttpServer())
    .post(`/api/integrations/orders/${partner}`)
    .set('content-type', 'application/json')
    .set('x-partner-key', key)
    .set('x-partner-signature', sig)
    .send(raw);
}

describe('omni-channel intake (one adapter, partner formats as configuration)', () => {
  it('takes a modern-trade PO in cases onto the same order lifecycle, idempotently', async () => {
    const po = { PONumber: `PO-${Date.now()}`, ShipTo: { StoreCode: 'STAR-AND-01' }, Lines: [{ EAN: '8909000000010', Cases: 2 }, { EAN: '8909000000014', Cases: 5 }] };
    const r = await send('STAR-HYPER', po);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ACCEPTED');
    const order = await prisma.order.findFirstOrThrow({ where: { orderNo: r.body.orderNos[0] }, include: { lines: true } });
    expect(order).toMatchObject({ source: 'MT_FEED', channelCode: 'MT', status: 'CONFIRMED' });
    expect(order.lines.map((l) => l.qty).sort((a, b) => a - b)).toEqual([10, 48]);
    const again = await send('STAR-HYPER', po);
    expect(again.body.status).toBe('DUPLICATE');
    expect(again.body.orderNos).toEqual(r.body.orderNos);
  });

  it('holds a PO whose value is below our price', async () => {
    const r = await send('STAR-HYPER', { PONumber: `PO-LOW-${Date.now()}`, ShipTo: { StoreCode: 'STAR-AND-01' }, Lines: [{ EAN: '8909000000010', Cases: 1 }], POValue: 1 });
    expect(r.body.flags).toContain('PRICE_MISMATCH');
    expect((await prisma.order.findFirstOrThrow({ where: { orderNo: r.body.orderNos[0] } })).status).toBe('ON_HOLD');
  });

  it('maps e-commerce and quick-commerce payloads with different shapes', async () => {
    const ecom = await send('SHOPKART', { order_id: `SK-${Date.now()}`, fc_code: 'BHI-FC1', items: [{ sku: 'CAMPA-COLA-500', qty: 96 }] });
    expect(ecom.body.status).toBe('ACCEPTED');
    expect((await prisma.order.findFirstOrThrow({ where: { orderNo: ecom.body.orderNos[0] } })).source).toBe('ECOM_FEED');
    const qcom = await send('ZIPMART', { replenishment_id: `ZM-${Date.now()}`, dark_store: 'KRM-DS', lines: [{ item_code: 'ZM-COLA-200', units: 48 }] });
    expect(qcom.body.status).toBe('ACCEPTED');
    const o = await prisma.order.findFirstOrThrow({ where: { orderNo: qcom.body.orderNos[0] } });
    expect(o.channelCode).toBe('QCOM');
  });

  it('rejects unknown stores / SKUs and records the rejection', async () => {
    const ref = `SK-BAD-${Date.now()}`;
    const r = await send('SHOPKART', { order_id: ref, fc_code: 'NOPE', items: [{ sku: 'CAMPA-COLA-500', qty: 1 }] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('UNKNOWN_STORE');
    expect((await prisma.externalOrder.findFirstOrThrow({ where: { externalRef: ref } })).status).toBe('REJECTED');
  });

  it('authenticates partners by key and body signature', async () => {
    const body = { order_id: `SK-${Date.now()}`, fc_code: 'BHI-FC1', items: [{ sku: 'CAMPA-COLA-500', qty: 1 }] };
    expect((await send('SHOPKART', body, 'wrong-key')).status).toBe(401);
    expect((await send('SHOPKART', body, undefined, 'wrong-secret')).status).toBe(401);
  });

  it('lets admins dry-run a partner format through the same adapter', async () => {
    const r = await post(admin, '/admin/partners/ZIPMART/simulate', { replenishment_id: `SIM-${Date.now()}`, dark_store: 'PWI-DS', lines: [{ item_code: 'ZM-ATTA-5KG', units: 4 }] });
    expect(r.body.status).toBe('ACCEPTED');
  });
});
