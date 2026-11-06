import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MastersBundle } from '@rtm/shared';
import { closeApp, Device, deviceTotal, get, login, outletNamed, post, prisma, product } from './helpers';

let dsr: string;
let dist: string;
let bundle: MastersBundle;

beforeAll(async () => {
  dsr = await login('dsr.ravi@rcpl.test');
  dist = await login('dist.mh01@rcpl.test');
  bundle = (await get(dsr, '/sync/pull')).body;
});
afterAll(closeApp);

async function placeAndFulfil(outletName: string, lines: [string, number][]) {
  const outlet = await outletNamed(outletName);
  const l = await Promise.all(lines.map(async ([c, q]) => ({ productId: (await product(c)).id, qty: q })));
  const dev = new Device(dsr);
  const [r] = await dev.push([dev.mutation('ORDER', { outletId: outlet.id, lines: l, clientTotalPaise: deviceTotal(bundle, outlet.id, l) })]);
  const order = await prisma.order.findFirstOrThrow({ where: { orderNo: r.refs![0] } });
  const inv = await post(dist, `/orders/${order.id}/fulfil`);
  expect(inv.status).toBe(201);
  return { outlet, order, invoice: inv.body };
}

const ar = async (outletId: string) => (await get(dist, `/ledger/statement?outletId=${outletId}`)).body.balancePaise as number;

describe('double-entry ledger', () => {
  it('every journal balances and AR moves by the invoice total', async () => {
    const outlet = await outletNamed('Om Sai General Store');
    const before = await ar(outlet.id);
    const { invoice } = await placeAndFulfil('Om Sai General Store', [['IND-ATTA-5KG', 4]]);
    expect(await ar(outlet.id)).toBe(before + invoice.totalPaise);
    const unbalanced = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM (
        SELECT "journalId" FROM "LedgerEntry" GROUP BY "journalId" HAVING SUM("debitPaise") <> SUM("creditPaise")
      ) x`;
    expect(Number(unbalanced[0].n)).toBe(0);
  });

  it('invoices split GST by place of supply and keep line totals exact', async () => {
    const { invoice } = await placeAndFulfil('Gupta Super Mart', [['CAMPA-COLA-500', 48], ['IND-SOYA-1L', 12]]);
    expect(invoice.igstPaise).toBe(0);
    expect(invoice.cgstPaise).toBe(invoice.sgstPaise);
    expect(invoice.taxablePaise + invoice.cgstPaise + invoice.sgstPaise).toBe(invoice.totalPaise);
  });

  it('rejects UPDATE / DELETE on ledger and audit rows at the database', async () => {
    await expect(prisma.$executeRaw`UPDATE "LedgerEntry" SET "debitPaise" = "debitPaise" + 1`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM "AuditLog"`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM "Journal"`).rejects.toThrow(/append-only/);
  });

  it('rejects an unbalanced journal at commit even if application code is bypassed', async () => {
    const acc = await prisma.ledgerAccount.findFirstOrThrow({ where: { code: 'SALES' } });
    await expect(
      prisma.$transaction(async (tx) => {
        const j = await tx.journal.create({ data: { tenantId: acc.tenantId, bookOwner: acc.bookOwner, docType: 'TEST', docId: 'x', narration: 'bad', postedById: 'test' } });
        await tx.ledgerEntry.create({ data: { journalId: j.id, accountId: acc.id, debitPaise: 100n } });
        await tx.ledgerEntry.create({ data: { journalId: j.id, accountId: acc.id, creditPaise: 99n } });
      }),
    ).rejects.toThrow(/does not balance/);
  });

  it('cancelling after invoice posts an explicit reversal and restores AR and stock', async () => {
    const outlet = await outletNamed('Balaji Provision');
    const before = await ar(outlet.id);
    const { order, invoice } = await placeAndFulfil('Balaji Provision', [['IND-MUSTARD-1L', 12]]);
    const stockAfterInvoice = await prisma.inventoryBatch.aggregate({ where: { productId: (await product('IND-MUSTARD-1L')).id, location: { type: 'WAREHOUSE', distributor: { code: 'MH01' } } }, _sum: { qtyOnHand: true } });
    expect((await post(dist, `/orders/${order.id}/cancel`, { reason: 'Retailer refused' })).status).toBe(201);
    expect(await ar(outlet.id)).toBe(before);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(inv.status).toBe('CANCELLED');
    expect(await prisma.journal.count({ where: { reversalOfId: inv.journalId } })).toBe(1);
    const stockNow = await prisma.inventoryBatch.aggregate({ where: { productId: (await product('IND-MUSTARD-1L')).id, location: { type: 'WAREHOUSE', distributor: { code: 'MH01' } } }, _sum: { qtyOnHand: true } });
    expect(stockNow._sum.qtyOnHand).toBe((stockAfterInvoice._sum.qtyOnHand ?? 0) + 12);
  });

  it('a damaged return issues a credit note, reduces AR and quarantines stock', async () => {
    const { outlet } = await placeAndFulfil('New Bharat Stores', [['CAMPA-COLA-200', 24]]);
    const before = await ar(outlet.id);
    const dev = new Device(dsr);
    const [r] = await dev.push([dev.mutation('RETURN', { outletId: outlet.id, reason: 'Crushed crate', lines: [{ productId: (await product('CAMPA-COLA-200')).id, qty: 6, condition: 'DAMAGED' }] })]);
    const ret = await prisma.return.findFirstOrThrow({ where: { returnNo: r.refs![0] } });
    const d = await post(dist, `/returns/${ret.id}/decide`, { decision: 'ACCEPT' });
    expect(d.body.creditNoteNo).toMatch(/^MH01\/CN\d{4}\/\d{4}$/);
    expect(await ar(outlet.id)).toBe(before - d.body.totalPaise);
    expect(await prisma.inventoryBatch.count({ where: { bucket: 'DAMAGED', productId: (await product('CAMPA-COLA-200')).id } })).toBeGreaterThan(0);
  });

  it('FEFO skips batches inside the channel residual shelf life and backorders the shortfall', async () => {
    const { order, invoice } = await placeAndFulfil('Gupta Super Mart', [['IND-ATTA-10KG', 10]]);
    const lines = await prisma.invoiceLine.findMany({ where: { invoiceId: invoice.id } });
    const batches = await prisma.inventoryBatch.findMany({ where: { id: { in: lines.map((l) => l.batchId) } } });
    expect(batches.every((b) => b.expiryDate.getTime() > Date.now() + 15 * 86_400_000)).toBe(true);
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(o.status).toBe('PARTIALLY_FULFILLED');
    expect(o.flags).toContain('BACKORDER');
  });
});

describe('RBAC and scoping', () => {
  it('blocks role and scope violations', async () => {
    const { order } = await placeAndFulfil('Om Sai General Store', [['IND-SOYA-1L', 12]]);
    expect((await post(dsr, `/orders/${order.id}/fulfil`)).status).toBe(403);
    const dl = await login('dist.dl01@rcpl.test');
    expect((await get(dl, `/orders/${order.id}`)).status).toBe(404);
    const asmDelhi = await login('asm.delhi@rcpl.test');
    expect((await get(asmDelhi, `/orders/${order.id}`)).status).toBe(404);
    const asmMumbai = await login('asm.mumbai@rcpl.test');
    expect((await get(asmMumbai, `/orders/${order.id}`)).status).toBe(200);
    expect((await get(dsr, '/reports/summary')).status).toBe(403);
  });
});
