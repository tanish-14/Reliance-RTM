import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MastersBundle } from '@rtm/shared';
import { closeApp, Device, deviceTotal, get, getApp, login, outletNamed, post, prisma, product } from './helpers';
import { JobsService } from '../src/jobs/jobs.service';
import { MockGateway, PAYMENT_GATEWAY } from '../src/integrations/payment-gateway';

let dsr: string;
let sunil: string;
let dist: string;
let retailer: string;
let hq: string;
let admin: string;
let ravi: MastersBundle;

const drain = async () => (await getApp()).get(JobsService).drain();
const ar = async (outletId: string) => (await get(dist, `/ledger/statement?outletId=${outletId}`)).body.balancePaise as number;
const bal = async (code: string, book?: string) => {
  const d = book ?? (await prisma.distributor.findFirstOrThrow({ where: { code: 'MH01' } })).id;
  const r = await prisma.$queryRaw<{ b: bigint | null }[]>`SELECT SUM(e."debitPaise" - e."creditPaise")::bigint AS b FROM "LedgerEntry" e JOIN "LedgerAccount" a ON a.id = e."accountId" WHERE a.code = ${code} AND a."bookOwner" = ${d}`;
  return Number(r[0].b ?? 0n);
};

beforeAll(async () => {
  [dsr, sunil, dist, retailer, hq, admin] = await Promise.all(['dsr.ravi', 'dsr.sunil', 'dist.mh01', 'retailer.gt', 'hq', 'admin'].map((u) => login(`${u}@rcpl.test`)));
  ravi = (await get(dsr, '/sync/pull')).body;
  await post(retailer, '/privacy/consents', { items: [{ purpose: 'ORDER_PROCESSING', granted: true }] });
});
afterAll(closeApp);

async function order(token: string, bundle: MastersBundle, outletId: string, lines: [string, number][], paymentMode = 'CREDIT') {
  const l = await Promise.all(lines.map(async ([c, q]) => ({ productId: (await product(c)).id, qty: q })));
  const dev = new Device(token);
  const [r] = await dev.push([dev.mutation('ORDER', { outletId, lines: l, clientTotalPaise: deviceTotal(bundle, outletId, l), paymentMode })]);
  expect(r.status).toBe('APPLIED');
  return prisma.order.findFirstOrThrow({ where: { orderNo: r.refs![0] } });
}
async function invoiceFor(o: { id: string }) {
  const r = await post(dist, `/orders/${o.id}/fulfil`);
  expect(r.status).toBe(201);
  return r.body;
}

describe('online payments (gateway webhooks are the source of truth)', () => {
  it('captures via signed webhook, posts the ledger, and ignores redelivery', async () => {
    const laxmi = await outletNamed('Laxmi Kirana Stores');
    const before = await ar(laxmi.id);
    const intent = await post(retailer, '/payments/intents', { outletId: laxmi.id, purpose: 'OUTSTANDING', amountPaise: 25_000 });
    expect(intent.status).toBe(201);
    expect(intent.body.checkout.mode).toBe('mock');
    const fail = await post(retailer, `/payments/intents/${intent.body.id}/mock-complete`, { outcome: 'failure' });
    expect(fail.body).toMatchObject({ status: 'CREATED', attempts: 1 });
    const ok = await post(retailer, `/payments/intents/${intent.body.id}/mock-complete`, { outcome: 'success' });
    expect(ok.body.status).toBe('PAID');
    expect(await ar(laxmi.id)).toBe(before - 25_000);

    // Redeliver the exact same event: no second payment.
    const gw = (await getApp()).get(PAYMENT_GATEWAY) as MockGateway;
    const payment = await prisma.payment.findFirstOrThrow({ where: { intentId: intent.body.id } });
    const ev = { id: 'evt_fixed_1', event: 'payment.captured', payload: { payment: { entity: { id: payment.gatewayPaymentId, order_id: intent.body.gatewayOrderId, amount: 25_000, method: 'upi' } } } };
    const d = gw.sign(ev);
    const http = (await import('supertest')).default((await getApp()).getHttpServer());
    const first = await http.post('/api/payments/webhook').set('content-type', 'application/json').set('x-razorpay-signature', d.signature).send(d.raw.toString());
    const again = await http.post('/api/payments/webhook').set('content-type', 'application/json').set('x-razorpay-signature', d.signature).send(d.raw.toString());
    expect(first.status).toBe(200);
    expect(again.body.status).toBe('duplicate');
    expect(await prisma.payment.count({ where: { intentId: intent.body.id } })).toBe(1);
    const forged = await http.post('/api/payments/webhook').set('content-type', 'application/json').set('x-razorpay-signature', 'deadbeef').send(d.raw.toString());
    expect(forged.status).toBe(401);
  });

  it('prepaid eB2B order waits for payment, then confirms', async () => {
    const rb: MastersBundle = (await get(retailer, '/sync/pull')).body;
    expect(rb.outlets).toHaveLength(1);
    const o = await order(retailer, rb, rb.outlets[0].id, [['IND-ATTA-5KG', 20]], 'ONLINE');
    expect(o).toMatchObject({ status: 'ON_HOLD', source: 'EB2B', paymentMode: 'ONLINE' });
    expect(o.flags).toContain('AWAITING_PAYMENT');
    expect(o.flags).not.toContain('CREDIT_BREACH');
    const intent = await post(retailer, '/payments/intents', { outletId: o.outletId, purpose: 'ORDER', orderId: o.id });
    expect(Number(intent.body.amountPaise)).toBe(Number(o.totalPaise));
    await post(retailer, `/payments/intents/${intent.body.id}/mock-complete`, { outcome: 'success' });
    const after = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.status).toBe('CONFIRMED');
    expect(after.flags).toContain('PREPAID');
  });

  it('a timed-out payment cancels the order; a late capture is kept and flagged', async () => {
    const rb: MastersBundle = (await get(retailer, '/sync/pull')).body;
    const o = await order(retailer, rb, rb.outlets[0].id, [['IND-SOYA-1L', 12]], 'ONLINE');
    const intent = await post(retailer, '/payments/intents', { outletId: o.outletId, purpose: 'ORDER', orderId: o.id });
    await prisma.paymentIntent.update({ where: { id: intent.body.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await drain();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('CANCELLED');
    await post(retailer, `/payments/intents/${intent.body.id}/mock-complete`, { outcome: 'success' });
    const p = await prisma.payment.findFirstOrThrow({ where: { intentId: intent.body.id } });
    expect(await prisma.exceptionItem.count({ where: { refId: p.id, kind: 'LATE_PAYMENT' } })).toBe(1);
  });

  it('refunds go through the gateway and restore the receivable', async () => {
    const p = await prisma.payment.findFirstOrThrow({ where: { mode: 'ONLINE', status: 'RECEIVED' } });
    const before = await ar(p.outletId);
    const r = await post(dist, `/payments/${p.id}/refund`, { amountPaise: 5_000, reason: 'Short supply' });
    expect(r.body.status).toBe('PROCESSED');
    expect(await ar(p.outletId)).toBe(before + 5_000);
    expect((await post(dist, `/payments/${p.id}/refund`, { amountPaise: Number(p.amountPaise), reason: 'Too much' })).status).toBe(422);
  });

  it('gateway settlement moves clearing to bank net of fees', async () => {
    const clearing = await bal('GATEWAY_CLEARING');
    const r = await post(admin, '/payments/mock/settle');
    expect(r.body.settled).toBeGreaterThan(0);
    expect(await bal('GATEWAY_CLEARING')).toBeLessThan(clearing);
    expect(await bal('GATEWAY_FEES')).toBeGreaterThan(0);
  });
});

describe('cash, COD, cheques, UPI', () => {
  it('COD skips the credit check and requires collection at the door', async () => {
    const laxmi = await outletNamed('Laxmi Kirana Stores');
    const o = await order(dsr, ravi, laxmi.id, [['IND-ATTA-10KG', 4]], 'COD');
    expect(o.status).toBe('CONFIRMED');
    expect(o.flags).toContain('COD');
    const inv = await invoiceFor(o);
    const delivery = await prisma.delivery.findFirstOrThrow({ where: { invoiceId: inv.id } });
    expect((await post(dist, `/deliveries/${delivery.id}/deliver`, {})).body.code).toBe('COD_REQUIRED');
    const before = await ar(laxmi.id);
    expect((await post(dist, `/deliveries/${delivery.id}/deliver`, { cod: { mode: 'CASH', amountPaise: inv.totalPaise } })).status).toBe(201);
    expect(await ar(laxmi.id)).toBe(before - inv.totalPaise);
  });

  it('a short cash deposit posts the variance explicitly and reconciles to the bank line', async () => {
    const outlet = await outletNamed('Gupta Super Mart', 'dsr.sunil@rcpl.test');
    const dev = new Device(sunil);
    await dev.push([dev.mutation('COLLECTION', { outletId: outlet.id, mode: 'CASH', amountPaise: 50_000 })]);
    const dep = await post(sunil, '/cash/deposits', { declaredPaise: 49_000, bankRef: 'SLIP-77001', slipDate: new Date().toISOString(), distributorId: outlet ? (await prisma.distributor.findFirstOrThrow({ where: { code: 'MH01' } })).id : '' });
    expect(dep.status).toBe(201);
    expect(dep.body).toMatchObject({ status: 'SHORT', variancePaise: -1000 });
    const sunilUser = await prisma.user.findFirstOrThrow({ where: { email: 'dsr.sunil@rcpl.test' } });
    expect(await bal(`CIT:${sunilUser.id}`)).toBe(0);
    expect(await bal(`CASH_SHORT:${sunilUser.id}`)).toBe(1000);
    expect(await prisma.exceptionItem.count({ where: { refId: dep.body.id, kind: 'CASH_SHORT' } })).toBe(1);

    const mh01 = await prisma.distributor.findFirstOrThrow({ where: { code: 'MH01' } });
    const csv = `date,amount,reference,narration\n${new Date().toISOString().slice(0, 10)},490.00,SLIP-77001,CASH DEP\n${new Date().toISOString().slice(0, 10)},1234.00,UNKNOWN-1,NEFT ?\n`;
    const r = await post(dist, '/recon/statements', { distributorId: mh01.id, csv });
    expect(r.body).toMatchObject({ matched: 1, exceptions: 1 });
    expect((await prisma.cashDeposit.findUniqueOrThrow({ where: { id: dep.body.id } })).bankLineId).not.toBeNull();
    const again = await post(dist, '/recon/statements', { distributorId: mh01.id, csv });
    expect(again.body.duplicatesSkipped).toBe(2);
  });

  it('two bounced cheques reverse the receipts and auto-block credit', async () => {
    const outlet = await outletNamed('Balaji Provision', 'dsr.sunil@rcpl.test');
    const before = await ar(outlet.id);
    const dev = new Device(sunil);
    const res = await dev.push([
      dev.mutation('COLLECTION', { outletId: outlet.id, mode: 'CHEQUE', amountPaise: 30_000, chequeNo: '100201', chequeBank: 'SBI' }),
      dev.mutation('COLLECTION', { outletId: outlet.id, mode: 'CHEQUE', amountPaise: 20_000, chequeNo: '100202', chequeBank: 'SBI' }),
    ]);
    expect(res.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED']);
    expect(await ar(outlet.id)).toBe(before - 50_000);
    for (const no of ['100201', '100202']) {
      const p = await prisma.payment.findFirstOrThrow({ where: { chequeNo: no } });
      expect((await post(dist, `/payments/${p.id}/cheque/bounce`, { reason: 'Insufficient funds' })).status).toBe(201);
    }
    expect(await ar(outlet.id)).toBe(before);
    const acc = await prisma.creditAccount.findFirstOrThrow({ where: { outletId: outlet.id } });
    expect(acc).toMatchObject({ blocked: true, autoBlocked: true, bounceCount: 2 });
    const sb: MastersBundle = (await get(sunil, '/sync/pull')).body;
    const o = await order(sunil, sb, outlet.id, [['IND-ATTA-5KG', 1]]);
    expect(o.flags).toContain('CREDIT_BLOCKED');
  });

  it('field UPI is confirmed or reversed by verification', async () => {
    const outlet = await outletNamed('New Bharat Stores');
    const before = await ar(outlet.id);
    const dev = new Device(dsr);
    await dev.push([
      dev.mutation('COLLECTION', { outletId: outlet.id, mode: 'UPI', amountPaise: 7_000, reference: '431298765432' }),
      dev.mutation('COLLECTION', { outletId: outlet.id, mode: 'UPI', amountPaise: 3_000, reference: '431298760000' }),
    ]);
    await drain();
    const [good, bad] = await Promise.all(['431298765432', '431298760000'].map((r) => prisma.payment.findFirstOrThrow({ where: { reference: r } })));
    expect(good.status).toBe('VERIFIED');
    expect(bad.status).toBe('FAILED');
    expect(await ar(outlet.id)).toBe(before - 7_000);
  });
});

describe('GST e-invoice and e-way bill (mock IRP)', () => {
  it('B2B invoice gets an IRN; over ₹50k also an e-way bill; B2C gets none; cancel within 24h cancels the IRN', async () => {
    const gst = await outletNamed('Gupta Super Mart');
    expect(gst.gstin).not.toBeNull();
    const big = await invoiceFor(await order(dsr, ravi, gst.id, [['IND-SOYA-1L', 480]]));
    const b2c = await outletNamed('Om Sai General Store');
    expect(b2c.gstin).toBeNull();
    const small = await invoiceFor(await order(dsr, ravi, b2c.id, [['IND-MUSTARD-1L', 12]]));
    await drain();
    const [i1, i2] = await Promise.all([prisma.invoice.findUniqueOrThrow({ where: { id: big.id } }), prisma.invoice.findUniqueOrThrow({ where: { id: small.id } })]);
    expect(i1.irnStatus).toBe('GENERATED');
    expect(i1.irn).toMatch(/^[0-9a-f]{64}$/);
    expect(i1.ewbStatus).toBe('GENERATED');
    expect(i1.ewbNo).toMatch(/^\d{12}$/);
    expect(i2.irnStatus).toBe('NOT_APPLICABLE');
    await post(dist, `/orders/${i1.orderId}/cancel`, { reason: 'Wrong outlet' });
    await drain();
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: big.id } })).irnStatus).toBe('CANCELLED');
    const cn = await prisma.creditNote.findFirstOrThrow({ where: { invoiceId: big.id } });
    expect(cn.irnStatus).toBe('GENERATED');
  });
});

describe('scheme engine: claims, budget, corrections, cashback', () => {
  const period = () => ({ periodFrom: new Date(Date.now() - 3600_000).toISOString(), periodTo: new Date(Date.now() + 3600_000).toISOString() });

  it('validates a claim against secondary sales, rejects duplicates, trims inflated claims', async () => {
    const gupta = await outletNamed('Gupta Super Mart');
    await invoiceFor(await order(dsr, ravi, gupta.id, [['CAMPA-COLA-200', 48]]));
    const mh01 = await prisma.distributor.findFirstOrThrow({ where: { code: 'MH01' } });
    const scheme = await prisma.scheme.findFirstOrThrow({ where: { code: 'CAMPA-WINTER-QTY' } });
    const used = await prisma.schemeUsage.aggregate({ where: { schemeId: scheme.id, distributorId: mh01.id }, _sum: { costPaise: true } });
    const supported = Number(used._sum.costPaise);
    expect(supported).toBeGreaterThan(0);

    const p = { periodFrom: new Date(Date.now() - 86_400_000).toISOString(), periodTo: new Date(Date.now() + 86_400_000).toISOString() };
    const c1 = await post(dist, '/claims', { schemeCode: 'CAMPA-WINTER-QTY', ...p, claimedRupees: supported / 100 });
    expect(c1.body).toMatchObject({ status: 'VALIDATED', validatedPaise: supported });
    const dup = await post(dist, '/claims', { schemeCode: 'CAMPA-WINTER-QTY', ...period(), claimedRupees: 1 });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE_CLAIM');

    const free = await post(dist, '/claims', { schemeCode: 'CAMPA200-FREE', ...p, claimedRupees: 99_999 });
    expect(free.body.status).toBe('PARTIALLY_VALIDATED');
    expect(free.body.flags).toContain('INFLATED');
    expect(Number(free.body.validatedPaise)).toBeLessThan(9_999_900);

    const approve = await post(hq, `/claims/${c1.body.id}/decide`, { decision: 'APPROVE' });
    expect(approve.body.status).toBe('APPROVED');
    expect((await post(hq, `/claims/${c1.body.id}/decide`, { decision: 'APPROVE', approveRupees: 1e9 })).status).toBe(409);
    const settled = await post(admin, `/claims/${c1.body.id}/settle`);
    expect(settled.body.status).toBe('SETTLED');
    expect(await bal(`DIST_PAYABLE:${mh01.id}`, 'COMPANY')).toBe(-supported);
    expect(await bal('CLAIM_RECEIVABLE')).toBeGreaterThanOrEqual(supported);
  });

  it('a scheme applied in error is recovered by debit note and its usage reversed', async () => {
    const gupta = await outletNamed('Gupta Super Mart');
    const inv = await invoiceFor(await order(dsr, ravi, gupta.id, [['IND-ATTA-5KG', 32]]));
    const scheme = await prisma.scheme.findFirstOrThrow({ where: { code: 'IND-VALUE-SLAB' } });
    const before = await ar(gupta.id);
    const used = Number((await prisma.schemeUsage.aggregate({ where: { invoiceId: inv.id, schemeId: scheme.id }, _sum: { costPaise: true } }))._sum.costPaise);
    expect(used).toBeGreaterThan(0);
    const dn = await post(dist, `/invoices/${inv.id}/scheme-correction`, { schemeCode: 'IND-VALUE-SLAB', reason: 'Outlet not eligible' });
    expect(dn.status).toBe(201);
    expect(dn.body.debitNoteNo).toMatch(/^MH01\/DN\d{4}\/\d{4}$/);
    expect(await ar(gupta.id)).toBe(before + Number(dn.body.totalPaise));
    expect(Number((await prisma.schemeUsage.aggregate({ where: { invoiceId: inv.id, schemeId: scheme.id }, _sum: { costPaise: true } }))._sum.costPaise)).toBe(0);
    expect((await post(dist, `/invoices/${inv.id}/scheme-correction`, { schemeCode: 'IND-VALUE-SLAB', reason: 'again' })).status).toBe(422);
  });

  it('stops applying a scheme once its budget is consumed', async () => {
    const t = await prisma.tenant.findFirstOrThrow();
    const mustard = await product('IND-MUSTARD-1L');
    await prisma.scheme.create({ data: { tenantId: t.id, code: 'TINY-BUDGET', name: 'Tiny', type: 'TRADE_DISCOUNT', status: 'ACTIVE', validFrom: new Date(Date.now() - 86_400_000), validTo: new Date(Date.now() + 86_400_000), channelCodes: [], stateCodes: [], productIds: [mustard.id], brandIds: [], rules: { discountBp: 1000 }, budgetPaise: 100n, priority: 9 } });
    const fresh: MastersBundle = (await get(dsr, '/sync/pull')).body;
    const gupta = await outletNamed('Gupta Super Mart');
    const o1 = await order(dsr, fresh, gupta.id, [['IND-MUSTARD-1L', 12]]);
    expect(JSON.stringify((await prisma.orderLine.findMany({ where: { orderId: o1.id } }))[0].appliedSchemes)).toContain('TINY-BUDGET');
    await invoiceFor(o1);
    const after: MastersBundle = (await get(dsr, '/sync/pull')).body;
    expect(after.schemes.map((s) => s.code)).not.toContain('TINY-BUDGET');
  });

  it('cashback is credited to the retailer when the order closes', async () => {
    const t = await prisma.tenant.findFirstOrThrow();
    await prisma.scheme.create({ data: { tenantId: t.id, code: 'CB-TEST', name: 'Cashback', type: 'CASHBACK', status: 'ACTIVE', validFrom: new Date(Date.now() - 86_400_000), validTo: new Date(Date.now() + 86_400_000), channelCodes: ['GT'], stateCodes: [], productIds: [], brandIds: [], rules: { minValuePaise: 100_000, cashbackBp: 100, maxPaise: 50_000 } } });
    const fresh: MastersBundle = (await get(dsr, '/sync/pull')).body;
    const gupta = await outletNamed('Gupta Super Mart');
    const o = await order(dsr, fresh, gupta.id, [['IND-ATTA-5KG', 8]]);
    expect(Number(o.cashbackPaise)).toBeGreaterThan(0);
    const inv = await invoiceFor(o);
    const before = await ar(gupta.id);
    const delivery = await prisma.delivery.findFirstOrThrow({ where: { invoiceId: inv.id } });
    await post(dist, `/deliveries/${delivery.id}/deliver`, {});
    expect(await ar(gupta.id)).toBe(before - Number(o.cashbackPaise));
  });
});
