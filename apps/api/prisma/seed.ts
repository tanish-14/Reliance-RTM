/* RCPL demo seed: brands/SKUs, 4 distributors in 4 states, ~30 outlets across every channel and
 * RTM model, 3 schemes, a field hierarchy with beats, stock with near-expiry batches, and one
 * login per role (plus one retailer per channel). Runs on an empty database (`npm run db:reset`). */
import 'dotenv/config';
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { makeGstin } from '@rtm/shared';

const prisma = new PrismaClient();
const DAY = 86_400_000;
const now = new Date();
const days = (n: number) => new Date(now.getTime() + n * DAY);
export const DEMO_PASSWORD = 'Rcpl@1234';

async function main() {
  if (await prisma.tenant.findUnique({ where: { code: 'rcpl' } })) {
    console.log('Tenant "rcpl" already seeded — run `npm run db:reset` for a fresh database.');
    return;
  }
  const tenant = await prisma.tenant.create({ data: { code: 'rcpl', name: 'Reliance Consumer Products Ltd' } });
  const tenantId = tenant.id;
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  // ---- Channels & RTM models (data, not code) -------------------------------------------------
  const channels = Object.fromEntries(
    await Promise.all(
      [
        ['GT', 'General trade', 15],
        ['MT', 'Modern trade', 60],
        ['ECOM', 'E-commerce', 45],
        ['QCOM', 'Quick commerce', 30],
        ['HORECA', 'Hotels, restaurants & cafés', 15],
      ].map(async ([code, name, minResidualShelfDays]) => [
        code,
        await prisma.channel.create({ data: { tenantId, code: code as string, name: name as string, minResidualShelfDays: minResidualShelfDays as number } }),
      ]),
    ),
  );
  const models = Object.fromEntries(
    await Promise.all(
      [
        ['DISTRIBUTOR_LED', 'Distributor-led', 'DISTRIBUTOR_WAREHOUSE', 'ON_DISPATCH', false],
        ['PRE_SELL', 'Pre-sell (order today, deliver tomorrow)', 'DISTRIBUTOR_WAREHOUSE', 'ON_DISPATCH', false],
        ['VAN_SALES', 'Van sales (sell from the van)', 'VAN', 'ON_ORDER', true],
        ['DSD', 'Direct store delivery', 'COMPANY_DEPOT', 'ON_DISPATCH', false],
        ['WHOLESALE', 'Wholesale', 'DISTRIBUTOR_WAREHOUSE', 'ON_DISPATCH', false],
        ['EB2B', 'eB2B (retailer app)', 'DISTRIBUTOR_WAREHOUSE', 'ON_DISPATCH', false],
      ].map(async ([code, name, stockSource, invoiceTiming, autoFulfil]) => [
        code,
        await prisma.rtmModel.create({
          data: { tenantId, code: code as string, name: name as string, stockSource: stockSource as string, invoiceTiming: invoiceTiming as string, autoFulfil: autoFulfil as boolean },
        }),
      ]),
    ),
  );

  // ---- Brands & SKUs ---------------------------------------------------------------------------
  const campa = await prisma.brand.create({ data: { tenantId, code: 'CAMPA', name: 'Campa' } });
  const ind = await prisma.brand.create({ data: { tenantId, code: 'INDEPENDENCE', name: 'Independence' } });
  // GST rates are seed data (aerated beverages 40%, packaged atta & edible oil 5%) — configurable per SKU.
  const skuDefs = [
    { code: 'CAMPA-COLA-200', name: 'Campa Cola 200 ml', brand: campa, category: 'Beverages', packSize: '200 ml', caseSize: 24, hsn: '22021010', gst: 4000, mrp: 1000, base: 625, shelf: 180 },
    { code: 'CAMPA-COLA-500', name: 'Campa Cola 500 ml', brand: campa, category: 'Beverages', packSize: '500 ml', caseSize: 24, hsn: '22021010', gst: 4000, mrp: 2000, base: 1250, shelf: 180 },
    { code: 'CAMPA-ORANGE-200', name: 'Campa Orange 200 ml', brand: campa, category: 'Beverages', packSize: '200 ml', caseSize: 24, hsn: '22021010', gst: 4000, mrp: 1000, base: 625, shelf: 180 },
    { code: 'CAMPA-ORANGE-500', name: 'Campa Orange 500 ml', brand: campa, category: 'Beverages', packSize: '500 ml', caseSize: 24, hsn: '22021010', gst: 4000, mrp: 2000, base: 1250, shelf: 180 },
    { code: 'IND-ATTA-5KG', name: 'Independence Chakki Atta 5 kg', brand: ind, category: 'Staples', packSize: '5 kg', caseSize: 4, hsn: '11010000', gst: 500, mrp: 26000, base: 21000, shelf: 90 },
    { code: 'IND-ATTA-10KG', name: 'Independence Chakki Atta 10 kg', brand: ind, category: 'Staples', packSize: '10 kg', caseSize: 2, hsn: '11010000', gst: 500, mrp: 50000, base: 41000, shelf: 90 },
    { code: 'IND-SOYA-1L', name: 'Independence Soyabean Oil 1 L', brand: ind, category: 'Edible oil', packSize: '1 L', caseSize: 12, hsn: '15079010', gst: 500, mrp: 16000, base: 13500, shelf: 270 },
    { code: 'IND-MUSTARD-1L', name: 'Independence Kachi Ghani Mustard Oil 1 L', brand: ind, category: 'Edible oil', packSize: '1 L', caseSize: 12, hsn: '15149120', gst: 500, mrp: 18000, base: 15000, shelf: 270 },
  ];
  const products: Record<string, { id: string; base: number; shelf: number; brandId: string }> = {};
  for (const s of skuDefs) {
    const p = await prisma.product.create({
      data: { tenantId, brandId: s.brand.id, code: s.code, name: s.name, category: s.category, packSize: s.packSize, caseSize: s.caseSize, hsnCode: s.hsn, gstRateBp: s.gst, mrpPaise: BigInt(s.mrp), shelfLifeDays: s.shelf },
    });
    products[s.code] = { id: p.id, base: s.base, shelf: s.shelf, brandId: s.brand.id };
  }

  // ---- Price lists (effective-dated), margins, schemes -----------------------------------------
  const plFrom = new Date('2026-04-01T00:00:00+05:30');
  await prisma.priceList.create({
    data: {
      tenantId, code: 'PL-NATIONAL-FY27', name: 'National base price FY27', validFrom: plFrom,
      items: { create: Object.values(products).map((p) => ({ productId: p.id, basePaise: BigInt(p.base) })) },
    },
  });
  await prisma.priceList.create({
    data: {
      tenantId, code: 'PL-MT-FY27', name: 'Modern trade price FY27', channelCode: 'MT', validFrom: plFrom,
      items: { create: Object.values(products).map((p) => ({ productId: p.id, basePaise: BigInt(Math.round(p.base * 0.97)) })) },
    },
  });
  await prisma.marginRule.createMany({
    data: [
      { tenantId, channelCode: 'GT', marginBp: 0, validFrom: plFrom },
      { tenantId, tier: 'GOLD', channelCode: 'GT', marginBp: 150, validFrom: plFrom },
      { tenantId, channelCode: 'HORECA', marginBp: 200, validFrom: plFrom },
      { tenantId, channelCode: 'QCOM', brandId: campa.id, marginBp: 250, validFrom: plFrom },
    ],
  });
  const sFrom = new Date('2026-10-01T00:00:00+05:30');
  const sTo = new Date('2027-03-31T23:59:59+05:30');
  await prisma.scheme.createMany({
    data: [
      {
        tenantId, code: 'CAMPA-WINTER-QTY', name: 'Campa winter push — quantity slab', type: 'QTY_SLAB', validFrom: sFrom, validTo: sTo,
        channelCodes: ['GT', 'HORECA'], stateCodes: [], productIds: [], brandIds: [campa.id],
        rules: { slabs: [{ minQty: 48, discountBp: 400 }, { minQty: 96, discountBp: 700 }] }, budgetPaise: BigInt(50_00_000_00),
      },
      {
        tenantId, code: 'CAMPA200-FREE', name: 'Campa 200 ml: buy 24 get 2 free', type: 'FREE_GOODS', validFrom: sFrom, validTo: sTo,
        channelCodes: ['GT'], stateCodes: [], productIds: [products['CAMPA-COLA-200'].id, products['CAMPA-ORANGE-200'].id], brandIds: [],
        rules: { buyQty: 24, freeQty: 2 }, budgetPaise: BigInt(10_00_000_00),
      },
      {
        tenantId, code: 'IND-VALUE-SLAB', name: 'Independence staples — order value slab', type: 'VALUE_SLAB', validFrom: sFrom, validTo: sTo,
        channelCodes: [], stateCodes: [], productIds: [], brandIds: [ind.id],
        rules: { slabs: [{ minValuePaise: 5_000_00, discountBp: 200 }, { minValuePaise: 10_000_00, discountBp: 300 }] }, budgetPaise: BigInt(25_00_000_00),
      },
    ],
  });

  // ---- Field hierarchy ---------------------------------------------------------------------------
  const user = (email: string, name: string, role: Role, hierarchyPath: string, extra: Record<string, unknown> = {}) =>
    prisma.user.create({ data: { tenantId, email, name, role, hierarchyPath, passwordHash, ...extra } });
  await user('admin@rcpl.test', 'Asha Admin', 'ADMIN', '/', { title: 'Platform admin' });
  const hq = await user('hq@rcpl.test', 'Vikram Mehta', 'MANAGER', '/hq/', { title: 'National Sales Head' });
  const rsmW = await user('rsm.west@rcpl.test', 'Neha Joshi', 'MANAGER', '/hq/west/', { title: 'RSM West', managerId: hq.id });
  const rsmN = await user('rsm.north@rcpl.test', 'Arjun Kapoor', 'MANAGER', '/hq/north/', { title: 'RSM North', managerId: hq.id });
  const rsmS = await user('rsm.south@rcpl.test', 'Lakshmi Iyer', 'MANAGER', '/hq/south/', { title: 'RSM South', managerId: hq.id });
  const asm = {
    MUM: await user('asm.mumbai@rcpl.test', 'Rohit Patil', 'MANAGER', '/hq/west/mum/', { title: 'ASM Mumbai', managerId: rsmW.id }),
    AHD: await user('asm.ahmedabad@rcpl.test', 'Kinjal Shah', 'MANAGER', '/hq/west/ahd/', { title: 'ASM Ahmedabad', managerId: rsmW.id }),
    DEL: await user('asm.delhi@rcpl.test', 'Sameer Khan', 'MANAGER', '/hq/north/del/', { title: 'ASM Delhi', managerId: rsmN.id }),
    BLR: await user('asm.bengaluru@rcpl.test', 'Prakash Gowda', 'MANAGER', '/hq/south/blr/', { title: 'ASM Bengaluru', managerId: rsmS.id }),
  };

  // ---- Distributors, warehouses, stock --------------------------------------------------------
  const distDefs = [
    { key: 'MUM', code: 'MH01', name: 'Shree Ganesh Distributors', state: '27', city: 'Mumbai', address: 'Plot 14, MIDC Andheri East', lat: 19.1136, lng: 72.8697, pan: 'AAKFS4821M', tier: 'PLATINUM' },
    { key: 'AHD', code: 'GJ01', name: 'Sabarmati Agencies', state: '24', city: 'Ahmedabad', address: '22 Narol Industrial Estate', lat: 22.9734, lng: 72.6031, pan: 'ABDFS7712Q', tier: 'GOLD' },
    { key: 'DEL', code: 'DL01', name: 'Capital Trade Links', state: '07', city: 'New Delhi', address: 'B-41 Naraina Industrial Area', lat: 28.6289, lng: 77.1383, pan: 'AAGFC3390H', tier: 'GOLD' },
    { key: 'BLR', code: 'KA01', name: 'Namma Distributors', state: '29', city: 'Bengaluru', address: '9 Peenya 2nd Stage', lat: 13.0285, lng: 77.5197, pan: 'AAJFN5521L', tier: 'SILVER' },
  ] as const;
  const dist: Record<string, { id: string; code: string; warehouseId: string }> = {};
  for (const d of distDefs) {
    const row = await prisma.distributor.create({
      data: { tenantId, code: d.code, name: d.name, gstin: makeGstin(d.state, d.pan), stateCode: d.state, city: d.city, address: d.address, lat: d.lat, lng: d.lng, tier: d.tier, hierarchyPath: asm[d.key].hierarchyPath },
    });
    const wh = await prisma.stockLocation.create({ data: { tenantId, distributorId: row.id, code: `${d.code}-WH`, name: `${d.name} warehouse`, type: 'WAREHOUSE' } });
    dist[d.key] = { id: row.id, code: d.code, warehouseId: wh.id };
    await user(`dist.${d.code.toLowerCase()}@rcpl.test`, `${d.name} (owner)`, 'DISTRIBUTOR', asm[d.key].hierarchyPath, { title: 'Distributor', distributorId: row.id });

    // Stock: a near-expiry batch (inside GT's 15-day residual-shelf rule → not allocated),
    // an older batch that FEFO ships first, and a fresh one. Atta 10 kg is deliberately short
    // in Mumbai so partial fulfilment / backorder is demoable.
    for (const [code, p] of Object.entries(products)) {
      const short = d.key === 'MUM' && code === 'IND-ATTA-10KG';
      const batches = [
        { tag: 'A', expiry: 10, qty: short ? 0 : 24 },
        { tag: 'B', expiry: 45, qty: short ? 6 : 120 },
        { tag: 'C', expiry: p.shelf - 5, qty: short ? 0 : 600 },
      ];
      for (const b of batches) {
        if (b.qty === 0) continue;
        const batch = await prisma.inventoryBatch.create({
          data: { tenantId, locationId: wh.id, productId: p.id, batchCode: `${code.split('-').slice(1).join('')}-${d.code}-${b.tag}`, mfgDate: days(b.expiry - p.shelf), expiryDate: days(b.expiry), qtyOnHand: b.qty },
        });
        await prisma.stockMovement.create({ data: { tenantId, batchId: batch.id, qty: b.qty, reason: 'OPENING', refType: 'Seed', refId: 'seed' } });
      }
    }
  }

  // ---- DSRs, a van, beats and outlets -------------------------------------------------------------
  const dsrDefs = [
    { key: 'MUM', email: 'dsr.ravi@rcpl.test', name: 'Ravi Shinde', beat: 'Andheri West', lat: 19.1364, lng: 72.8296, van: true },
    { key: 'MUM', email: 'dsr.sunil@rcpl.test', name: 'Sunil Pawar', beat: 'Bandra–Khar', lat: 19.0596, lng: 72.8295, van: false },
    { key: 'AHD', email: 'dsr.hetal@rcpl.test', name: 'Hetal Patel', beat: 'Maninagar', lat: 22.9962, lng: 72.6020, van: false },
    { key: 'DEL', email: 'dsr.aman@rcpl.test', name: 'Aman Verma', beat: 'Karol Bagh', lat: 28.6519, lng: 77.1909, van: false },
    { key: 'BLR', email: 'dsr.kavya@rcpl.test', name: 'Kavya Reddy', beat: 'Jayanagar', lat: 12.9299, lng: 77.5826, van: false },
  ] as const;
  const shopNames = ['Laxmi Kirana Stores', 'Om Sai General Store', 'Balaji Provision', 'New Bharat Stores', 'Gupta Super Mart'];
  const owners = ['Ramesh Gupta', 'Suresh Yadav', 'Meena Shah', 'Imran Shaikh', 'Pooja Nair'];
  const stateOf: Record<string, string> = { MUM: '27', AHD: '24', DEL: '07', BLR: '29' };
  const cityOf: Record<string, string> = { MUM: 'Mumbai', AHD: 'Ahmedabad', DEL: 'New Delhi', BLR: 'Bengaluru' };
  let outletSeq = 0;
  const gtOutlets: { id: string; key: string }[] = [];

  for (const [bi, d] of dsrDefs.entries()) {
    const dsr = await user(d.email, d.name, 'DSR', `${asm[d.key].hierarchyPath}${d.email.split('@')[0]}/`, {
      title: 'DSR', managerId: asm[d.key].id, distributorId: dist[d.key].id,
    });
    const beat = await prisma.beat.create({
      data: {
        tenantId, code: `BEAT-${d.key}-${bi + 1}`, name: d.beat, distributorId: dist[d.key].id, dsrId: dsr.id,
        // Every day so the demo always has "today's beat"; real beats carry 1–3 days.
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6], anchorLat: d.lat, anchorLng: d.lng, geofenceM: 1500,
      },
    });
    let vanId: string | null = null;
    if (d.van) {
      const van = await prisma.stockLocation.create({ data: { tenantId, distributorId: dist[d.key].id, code: `${dist[d.key].code}-VAN-1`, name: `Van MH-02-AB-1234 (${d.name})`, type: 'VAN', userId: dsr.id } });
      vanId = van.id;
      for (const code of ['CAMPA-COLA-200', 'CAMPA-COLA-500', 'CAMPA-ORANGE-200', 'CAMPA-ORANGE-500']) {
        const p = products[code];
        const b = await prisma.inventoryBatch.create({ data: { tenantId, locationId: van.id, productId: p.id, batchCode: `${code.split('-').slice(1).join('')}-VAN-1`, mfgDate: days(-20), expiryDate: days(p.shelf - 20), qtyOnHand: 240 } });
        await prisma.stockMovement.create({ data: { tenantId, batchId: b.id, qty: 240, reason: 'VAN_LOAD', refType: 'Seed', refId: 'seed' } });
      }
    }

    for (let i = 0; i < 5; i++) {
      outletSeq++;
      const lat = d.lat + (i - 2) * 0.0021;
      const lng = d.lng + ((i % 2) - 0.5) * 0.0024;
      const registered = i % 2 === 0;
      const outlet = await prisma.outlet.create({
        data: {
          tenantId, code: `OUT-${String(outletSeq).padStart(3, '0')}`, name: `${shopNames[i]}${bi ? '' : ''}`, ownerName: owners[i],
          phone: `98${String(20000000 + outletSeq * 7919).slice(0, 8)}`, gstin: registered ? makeGstin(stateOf[d.key], `ABCPG${String(1000 + outletSeq)}K`) : null,
          channelId: channels.GT.id, tier: i === 4 ? 'GOLD' : 'SILVER', stateCode: stateOf[d.key], city: cityOf[d.key],
          address: `Shop ${i + 3}, ${d.beat} Market Road`, lat, lng, geofenceM: 200,
        },
      });
      gtOutlets.push({ id: outlet.id, key: d.key });
      await prisma.beatOutlet.create({ data: { beatId: beat.id, outletId: outlet.id, sequence: i + 1 } });
      // Outlet served by two models: Ravi's second outlet buys Campa off his van, staples via the distributor.
      if (vanId && i === 1) {
        await prisma.outletService.create({ data: { tenantId, outletId: outlet.id, rtmModelId: models.VAN_SALES.id, distributorId: dist[d.key].id, brandIds: [campa.id], isPrimary: false } });
      }
      await prisma.outletService.create({ data: { tenantId, outletId: outlet.id, rtmModelId: (bi === 1 ? models.PRE_SELL : models.DISTRIBUTOR_LED).id, distributorId: dist[d.key].id, brandIds: [], isPrimary: true } });
      // Laxmi Kirana in each beat has a tiny limit (credit-breach demo); Om Sai in Delhi is blocked.
      await prisma.creditAccount.create({
        data: {
          tenantId, outletId: outlet.id, distributorId: dist[d.key].id,
          limitPaise: BigInt(i === 0 ? 2_000_00 : 50_000_00 + i * 10_000_00), creditDays: 14,
          blocked: d.key === 'DEL' && i === 1, blockReason: d.key === 'DEL' && i === 1 ? 'Cheque bounced twice (seed)' : null,
        },
      });
    }
  }

  // ---- Non-GT outlets: MT, e-com, q-com, HoReCa ----------------------------------------------
  const keyAcc = [
    { code: 'MT-001', name: 'Star Hypermart Andheri', ch: 'MT', model: 'DSD', key: 'MUM', lat: 19.1197, lng: 72.8468, owner: 'Store manager' },
    { code: 'MT-002', name: 'Metro Wholesale Naraina', ch: 'MT', model: 'WHOLESALE', key: 'DEL', lat: 28.6311, lng: 77.1405, owner: 'Category manager' },
    { code: 'MT-003', name: 'Fresh Basket Supermarket', ch: 'MT', model: 'DSD', key: 'BLR', lat: 12.9352, lng: 77.6245, owner: 'Store manager' },
    { code: 'EC-001', name: 'ShopKart Fulfilment Centre Bhiwandi', ch: 'ECOM', model: 'WHOLESALE', key: 'MUM', lat: 19.2813, lng: 73.0483, owner: 'Inbound lead' },
    { code: 'QC-001', name: 'ZipMart Dark Store Powai', ch: 'QCOM', model: 'DSD', key: 'MUM', lat: 19.1176, lng: 72.906, owner: 'Dark store lead' },
    { code: 'QC-002', name: 'ZipMart Dark Store Koramangala', ch: 'QCOM', model: 'DSD', key: 'BLR', lat: 12.9352, lng: 77.6146, owner: 'Dark store lead' },
    { code: 'HR-001', name: 'Hotel Sea Breeze Juhu', ch: 'HORECA', model: 'PRE_SELL', key: 'MUM', lat: 19.0988, lng: 72.8267, owner: 'F&B manager' },
    { code: 'HR-002', name: 'Café Mocha Connaught Place', ch: 'HORECA', model: 'PRE_SELL', key: 'DEL', lat: 28.6315, lng: 77.2167, owner: 'Owner' },
  ] as const;
  const keyOutlet: Record<string, string> = {};
  for (const [i, o] of keyAcc.entries()) {
    const row = await prisma.outlet.create({
      data: {
        tenantId, code: o.code, name: o.name, ownerName: o.owner, phone: `99${String(30000000 + i * 104729).slice(0, 8)}`,
        gstin: makeGstin(stateOf[o.key], `AAECZ${String(2000 + i)}P`), channelId: channels[o.ch].id, tier: 'KEY', stateCode: stateOf[o.key],
        city: cityOf[o.key], address: o.name, lat: o.lat, lng: o.lng, geofenceM: 300,
      },
    });
    keyOutlet[o.ch] ??= row.id;
    await prisma.outletService.create({ data: { tenantId, outletId: row.id, rtmModelId: models[o.model].id, distributorId: dist[o.key].id, brandIds: [], isPrimary: true } });
    await prisma.creditAccount.create({ data: { tenantId, outletId: row.id, distributorId: dist[o.key].id, limitPaise: BigInt(5_00_000_00), creditDays: 30 } });
  }

  // ---- One retailer login per channel ---------------------------------------------------------
  const retailerOutlets: [string, string, string][] = [
    ['retailer.gt@rcpl.test', 'Ramesh Gupta (Laxmi Kirana)', gtOutlets[0].id],
    ['retailer.mt@rcpl.test', 'Star Hypermart Andheri', keyOutlet.MT],
    ['retailer.ecom@rcpl.test', 'ShopKart Bhiwandi', keyOutlet.ECOM],
    ['retailer.qcom@rcpl.test', 'ZipMart Powai', keyOutlet.QCOM],
    ['retailer.horeca@rcpl.test', 'Hotel Sea Breeze', keyOutlet.HORECA],
  ];
  for (const [email, name, outletId] of retailerOutlets) {
    await user(email, name, 'RETAILER', '/retail/', { title: 'Retailer', outletId });
  }

  await prisma.auditLog.create({
    data: { tenantId, actorId: 'seed', actorRole: 'SYSTEM', action: 'SEED', entityType: 'Tenant', entityId: tenantId, meta: { outlets: outletSeq + keyAcc.length, products: skuDefs.length } },
  });
  console.log(`Seeded tenant rcpl: ${skuDefs.length} SKUs, ${distDefs.length} distributors, ${outletSeq + keyAcc.length} outlets, 3 schemes, ${dsrDefs.length} DSRs.`);
  console.log(`All demo logins use password ${DEMO_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
