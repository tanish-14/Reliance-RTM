import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { closeApp, Device, deviceTotal, get, getApp, http, login, PASSWORD, post, prisma, product } from './helpers';
import { JobsService } from '../src/jobs/jobs.service';

afterAll(closeApp);

describe('MFA for HQ / admin', () => {
  it('forces enrolment, rejects bad codes, then issues a session', async () => {
    const r = await (await http()).post('/api/auth/login').send({ tenant: 'rcpl', email: 'rsm.south@rcpl.test', password: PASSWORD });
    expect(r.body).toMatchObject({ mfaRequired: true, enroll: true });
    expect(r.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(r.body.token).toBeUndefined();
    const bad = await (await http()).post('/api/auth/mfa/verify').send({ mfaToken: r.body.mfaToken, code: '000000' });
    expect(bad.status).toBe(401);
    const ok = await (await http()).post('/api/auth/mfa/verify').send({ mfaToken: r.body.mfaToken, code: r.body.demoCode });
    expect(ok.body.token).toBeTruthy();
    const again = await (await http()).post('/api/auth/login').send({ tenant: 'rcpl', email: 'rsm.south@rcpl.test', password: PASSWORD });
    expect(again.body).toMatchObject({ mfaRequired: true, enroll: false });
    const dsr = await (await http()).post('/api/auth/login').send({ tenant: 'rcpl', email: 'dsr.ravi@rcpl.test', password: PASSWORD });
    expect(dsr.body.token).toBeTruthy();
  });
});

describe('approval workflows (maker-checker, level by amount, scoped by territory)', () => {
  let admin: string, hq: string, asm: string, rsmWest: string, rsmNorth: string, dist: string;
  beforeAll(async () => {
    [admin, hq, asm, rsmWest, rsmNorth, dist] = await Promise.all(['admin', 'hq', 'asm.mumbai', 'rsm.west', 'rsm.north', 'dist.mh01'].map((u) => login(`${u}@rcpl.test`)));
  });

  it('scheme activation needs a senior approver who is not the requester', async () => {
    const s = await post(admin, '/schemes', {
      code: 'ATTA-COMBO', name: 'Atta + oil combo', type: 'COMBO', validFrom: new Date(Date.now() - 3600_000).toISOString(), validTo: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      comboItems: [{ productCode: 'IND-ATTA-5KG', minQty: 4 }, { productCode: 'IND-SOYA-1L', minQty: 12 }], discountPct: 3, budgetRupees: 2_000_000,
    });
    expect(s.status).toBe(201);
    expect(s.body.status).toBe('DRAFT');
    expect((await post(admin, `/schemes/${s.body.id}/status`, { status: 'ACTIVE' })).body.code).toBe('APPROVAL_REQUIRED');
    const a = await post(admin, `/schemes/${s.body.id}/request-activation`);
    expect(a.body.requiredLevel).toBe(3);
    expect((await post(admin, `/approvals/${a.body.id}/decide`, { decision: 'APPROVE' })).status).toBe(403);
    expect((await post(asm, `/approvals/${a.body.id}/decide`, { decision: 'APPROVE' })).status).toBe(403);
    expect((await post(hq, `/approvals/${a.body.id}/decide`, { decision: 'APPROVE' })).body.status).toBe('APPROVED');
    expect((await prisma.scheme.findUniqueOrThrow({ where: { id: s.body.id } })).status).toBe('ACTIVE');
    const bundle = (await get(await login('dsr.ravi@rcpl.test'), '/sync/pull')).body;
    expect(bundle.schemes.map((x: { code: string }) => x.code)).toContain('ATTA-COMBO');
  });

  it('a credit-limit increase is routed by amount and territory', async () => {
    const acc = await prisma.creditAccount.findFirstOrThrow({ where: { distributorId: (await prisma.distributor.findFirstOrThrow({ where: { code: 'MH01' } })).id, outletId: (await prisma.outlet.findFirstOrThrow({ where: { code: 'OUT-003' } })).id } });
    const r = await post(dist, `/credit/accounts/${acc.id}/limit-request`, { newLimitRupees: 300_000, reason: 'Festive stocking' });
    expect(r.body.requiredLevel).toBe(2);
    expect((await post(asm, `/approvals/${r.body.id}/decide`, { decision: 'APPROVE' })).status).toBe(403);
    expect((await post(rsmNorth, `/approvals/${r.body.id}/decide`, { decision: 'APPROVE' })).status).toBe(403);
    expect((await post(rsmWest, `/approvals/${r.body.id}/decide`, { decision: 'APPROVE' })).status).toBe(201);
    expect(Number((await prisma.creditAccount.findUniqueOrThrow({ where: { id: acc.id } })).limitPaise)).toBe(30_000_000);
    expect(await prisma.auditLog.count({ where: { entityId: acc.id, action: 'CREDIT_LIMIT_CHANGED' } })).toBe(1);
  });
});

describe('DPDP: consent, access and erasure', () => {
  it('blocks eB2B ordering until consent, exports data, and erases on request', async () => {
    const retailer = await login('retailer.horeca@rcpl.test');
    const bundle = (await get(retailer, '/sync/pull')).body;
    const dev = new Device(retailer);
    const order = () => dev.mutation('ORDER', { outletId: bundle.outlets[0].id, lines: [{ productId: bundle.products[0].id, qty: 24 }], clientTotalPaise: 0, paymentMode: 'COD' });
    expect((await dev.push([order()]))[0].error?.code).toBe('CONSENT_REQUIRED');
    const c = await post(retailer, '/privacy/consents', { items: [{ purpose: 'ORDER_PROCESSING', granted: true }, { purpose: 'MARKETING', granted: false }] });
    expect(c.body.complete).toBe(true);
    expect((await dev.push([order()]))[0].status).toBe('APPLIED');
    const exp = await get(retailer, '/privacy/export');
    expect(exp.body.profile.email).toBe('retailer.horeca@rcpl.test');
    expect(exp.body.orders.length).toBeGreaterThan(0);

    const req = await post(retailer, '/privacy/requests', { type: 'ERASURE', details: 'Closing my shop' });
    const admin = await login('admin@rcpl.test');
    const done = await post(admin, `/admin/privacy/requests/${req.body.id}/complete`, { decision: 'COMPLETE' });
    expect(done.body.status).toBe('COMPLETED');
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.body.subjectId } });
    expect(u).toMatchObject({ name: 'Erased user', active: false, phone: null });
    expect((await (await http()).post('/api/auth/login').send({ tenant: 'rcpl', email: 'retailer.horeca@rcpl.test', password: PASSWORD })).status).toBe(401);
    expect(await prisma.order.count({ where: { outletId: bundle.outlets[0].id } })).toBeGreaterThan(0);
    await expect(prisma.$executeRaw`DELETE FROM "Consent"`).rejects.toThrow(/append-only/);
  });
});

describe('HQ KPIs and integrations', () => {
  it('reports distribution, strike rate, pipeline, credit and scheme ROI', async () => {
    const hq = await login('hq@rcpl.test');
    const dsr = await login('dsr.kavya@rcpl.test');
    const b = (await get(dsr, '/sync/pull')).body;
    const outlet = b.outlets[0];
    const dev = new Device(dsr);
    const atta = await product('IND-ATTA-5KG');
    await dev.push([
      dev.mutation('VISIT', { outletId: outlet.id, outcome: 'ORDER', lat: outlet.lat, lng: outlet.lng }),
      dev.mutation('VISIT', { outletId: b.outlets[1].id, outcome: 'NO_ORDER', noOrderReason: 'Owner away', lat: b.outlets[1].lat, lng: b.outlets[1].lng }),
      dev.mutation('ORDER', { outletId: outlet.id, lines: [{ productId: atta.id, qty: 4 }], clientTotalPaise: deviceTotal(b, outlet.id, [{ productId: atta.id, qty: 4 }]) }),
    ]);
    // Invoice it so there is a secondary sale to measure, whatever ran before this test.
    const order = await prisma.order.findFirstOrThrow({ where: { outletId: outlet.id, source: 'DSR' }, orderBy: { receivedAt: 'desc' } });
    expect((await post(await login('dist.ka01@rcpl.test'), `/orders/${order.id}/fulfil`)).status).toBe(201);
    const k = await get(hq, '/reports/kpis');
    expect(k.status).toBe(200);
    expect(k.body.universe.outlets).toBeGreaterThan(20);
    const ind = k.body.distribution.byBrand.find((x: { brand: string }) => x.brand === 'Independence');
    expect(ind.numericPct).toBeGreaterThan(0);
    expect(k.body.strikeRate.byDsr.find((d: { dsr: string }) => d.dsr === 'Kavya Reddy')).toMatchObject({ visits: 2, productive: 1, pct: 50 });
    expect(Array.isArray(k.body.pipeline)).toBe(true);
    expect(k.body.credit.ageing).toHaveProperty('NOT_DUE');
    expect(Array.isArray(k.body.schemeRoi)).toBe(true);
  });

  it('ships key-account invoices through the logistics connector and logs to ERP', async () => {
    const raw = JSON.stringify({ order_id: `SK-SHIP-${Date.now()}`, fc_code: 'BHI-FC1', items: [{ sku: 'IND-ATTA-5KG', qty: 8 }] });
    const intake = await request((await getApp()).getHttpServer())
      .post('/api/integrations/orders/SHOPKART')
      .set('content-type', 'application/json')
      .set('x-partner-key', 'shopkart-demo-key')
      .set('x-partner-signature', createHmac('sha256', 'shopkart-demo-secret').update(raw).digest('hex'))
      .send(raw);
    const order = await prisma.order.findFirstOrThrow({ where: { orderNo: intake.body.orderNos[0] } });
    const inv = await post(await login('dist.mh01@rcpl.test'), `/orders/${order.id}/fulfil`);
    await (await getApp()).get(JobsService).drain();
    expect(await prisma.integrationLog.count({ where: { refId: inv.body.id, event: 'SHIPMENT_CREATED', externalRef: { startsWith: 'AWB' } } })).toBe(1);
    expect(await prisma.integrationLog.count({ where: { refId: inv.body.id, event: 'INVOICE_ISSUED' } })).toBe(1);
    expect(await prisma.job.count({ where: { status: 'FAILED' } })).toBe(0);
  });
});
