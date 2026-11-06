import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeGstin } from '@rtm/shared';
import { closeApp, get, login, post, prisma } from './helpers';

let admin: string;
beforeAll(async () => {
  admin = await login('admin@rcpl.test');
});
afterAll(closeApp);

const outlet = (over: Record<string, unknown> = {}) => ({
  code: 'OUT-T01', name: 'Test Kirana', ownerName: 'Test Owner', phone: '9876543210', channelCode: 'GT', stateCode: '27', city: 'Mumbai',
  address: 'Lane 1', lat: 19.13, lng: 72.83, creditLimitRupees: 15000, services: [{ rtmModelCode: 'DISTRIBUTOR_LED', distributorCode: 'MH01', isPrimary: true }], ...over,
});

describe('master data admin', () => {
  it('validates GSTIN checksum and state on write', async () => {
    expect((await post(admin, '/admin/outlets', outlet({ gstin: '27AAPFU0939F1ZX' }))).status).toBe(400);
    expect((await post(admin, '/admin/outlets', outlet({ gstin: makeGstin('07', 'ABCDE1234F') }))).status).toBe(400);
    const ok = await post(admin, '/admin/outlets', outlet({ gstin: makeGstin('27', 'ABCDE1234F') }));
    expect(ok.status).toBe(201);
    const credit = await prisma.creditAccount.findFirst({ where: { outletId: ok.body.id } });
    expect(Number(credit?.limitPaise)).toBe(1_500_000);
    expect(await prisma.auditLog.count({ where: { entityId: ok.body.id, action: 'OUTLET_CREATED' } })).toBe(1);
  });

  it('adds a channel and an RTM model as data, then uses them on an outlet', async () => {
    expect((await post(admin, '/admin/channels', { code: 'INSTITUTIONAL', name: 'Institutional / canteens', minResidualShelfDays: 30 })).status).toBe(201);
    expect((await post(admin, '/admin/rtm-models', { code: 'CANTEEN_DIRECT', name: 'Canteen direct', stockSource: 'DISTRIBUTOR_WAREHOUSE', invoiceTiming: 'ON_DISPATCH' })).status).toBe(201);
    const r = await post(admin, '/admin/outlets', outlet({ code: 'OUT-T02', channelCode: 'INSTITUTIONAL', services: [{ rtmModelCode: 'CANTEEN_DIRECT', distributorCode: 'MH01', isPrimary: true }] }));
    expect(r.status).toBe(201);
  });

  it('revises prices as a new effective-dated version and closes the old one', async () => {
    const list = await prisma.priceList.findFirstOrThrow({ where: { code: 'PL-NATIONAL-FY27' } });
    const from = new Date(Date.now() + 86_400_000);
    const r = await post(admin, `/admin/price-lists/${list.id}/revise`, { validFrom: from.toISOString(), items: [{ productCode: 'CAMPA-COLA-200', baseRupees: 6.5 }] });
    expect(r.status).toBe(201);
    const [old, next] = await Promise.all([prisma.priceList.findUniqueOrThrow({ where: { id: list.id } }), prisma.priceList.findUniqueOrThrow({ where: { id: r.body.id }, include: { items: true } })]);
    expect(old.validTo?.toISOString()).toBe(from.toISOString());
    expect(next.items).toHaveLength(8);
    const cola = await prisma.product.findFirstOrThrow({ where: { code: 'CAMPA-COLA-200' } });
    expect(Number(next.items.find((i) => i.productId === cola.id)!.basePaise)).toBe(650);
    expect(await prisma.auditLog.count({ where: { action: 'PRICE_REVISED', entityId: next.id } })).toBe(1);
  });

  it('bulk import reports row errors without applying anything, then applies a clean file', async () => {
    const bad = 'code,name,brandCode,category,packSize,caseSize,hsnCode,gstRatePct,mrpRupees,shelfLifeDays\nIND-RICE-5KG,Independence Rice 5 kg,INDEPENDENCE,Staples,5 kg,4,1006,5,450,365\nBAD-1,Broken,INDEPENDENCE,Staples,1 kg,0,12,7,10,30\n';
    const r1 = await post(admin, '/admin/import/products', { csv: bad, dryRun: false });
    expect(r1.body.status).toBe('INVALID');
    expect(r1.body.errors[0].row).toBe(3);
    expect(await prisma.product.count({ where: { code: 'IND-RICE-5KG' } })).toBe(0);

    const good = bad.split('\n').slice(0, 2).join('\n');
    expect((await post(admin, '/admin/import/products', { csv: good, dryRun: true })).body.status).toBe('VALID');
    expect(await prisma.product.count({ where: { code: 'IND-RICE-5KG' } })).toBe(0);
    expect((await post(admin, '/admin/import/products', { csv: good, dryRun: false })).body.status).toBe('APPLIED');
    expect(await prisma.product.count({ where: { code: 'IND-RICE-5KG' } })).toBe(1);
  });

  it('catches unknown references in an import (dry run) with the row number', async () => {
    const csv = 'code,name,ownerName,phone,channelCode,stateCode,city,address,lat,lng,services\nOUT-T09,Row Two,Owner,9876500000,GT,27,Mumbai,Road,19.1,72.8,DISTRIBUTOR_LED:ZZ99\n';
    const r = await post(admin, '/admin/import/outlets', { csv, dryRun: true });
    expect(r.body.status).toBe('INVALID');
    expect(r.body.errors[0]).toMatchObject({ row: 2 });
  });

  it('moving a manager moves their subtree paths', async () => {
    const r = await post(admin, '/admin/users', { email: 'asm.pune@rcpl.test', name: 'Pune ASM', role: 'MANAGER', title: 'ASM Pune', managerEmail: 'rsm.west@rcpl.test', password: 'Passw0rd!x' });
    expect(r.status).toBe(201);
    expect(r.body.hierarchyPath).toBe('/hq/west/asm.pune/');
    expect(r.body.passwordHash).toBeUndefined();
    await post(admin, '/admin/users', { email: 'dsr.pune1@rcpl.test', name: 'Pune DSR', role: 'DSR', managerEmail: 'asm.pune@rcpl.test', distributorCode: 'MH01', password: 'Passw0rd!x' });
    await post(admin, '/admin/users', { email: 'asm.pune@rcpl.test', name: 'Pune ASM', role: 'MANAGER', managerEmail: 'rsm.south@rcpl.test' });
    const dsr = await prisma.user.findFirstOrThrow({ where: { email: 'dsr.pune1@rcpl.test' } });
    expect(dsr.hierarchyPath).toBe('/hq/south/asm.pune/dsr.pune1/');
  });

  it('is admin-only', async () => {
    const hq = await login('hq@rcpl.test');
    expect((await post(hq, '/admin/channels', { code: 'X1', name: 'x', minResidualShelfDays: 0 })).status).toBe(403);
    expect((await get(hq, '/admin/imports')).status).toBe(403);
  });
});
