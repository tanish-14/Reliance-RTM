import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import type { z } from 'zod';
import {
  BeatInput,
  ChannelInput,
  DistributorInput,
  MarginRuleInput,
  OutletInput,
  outletRowToInput,
  parseCsv,
  PriceListInput,
  PriceRevisionInput,
  ProductInput,
  RtmModelInput,
  UserInput,
  type ImportEntity,
} from '@rtm/shared';
import { PrismaService, type Tx } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { DomainError, notFound } from '../common/errors';
import { AuditService } from '../core/audit.service';


/**
 * Master-data writes. Every write is validated by the shared schema, resolves codes to ids
 * (so CSV import and forms share one path), and is audited with before/after.
 * Prices are never edited in place: a revision is a new effective-dated version.
 */
@Injectable()
export class MastersAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async byCode<T>(find: Promise<T | null>, what: string, code: string): Promise<T> {
    const row = await find;
    if (!row) throw new DomainError('UNKNOWN_CODE', `${what} "${code}" not found`, 422);
    return row;
  }

  async upsertProduct(tx: Tx, user: AuthUser, p: z.output<typeof ProductInput>) {
    const t = user.tenantId;
    const brand =
      (await tx.brand.findUnique({ where: { tenantId_code: { tenantId: t, code: p.brandCode } } })) ??
      (await tx.brand.create({ data: { tenantId: t, code: p.brandCode, name: p.brandCode.charAt(0) + p.brandCode.slice(1).toLowerCase() } }));
    const data = {
      brandId: brand.id,
      name: p.name,
      category: p.category,
      packSize: p.packSize,
      caseSize: p.caseSize,
      hsnCode: p.hsnCode,
      gstRateBp: Math.round(p.gstRatePct * 100),
      mrpPaise: BigInt(p.mrpRupees),
      shelfLifeDays: p.shelfLifeDays,
      active: p.active,
    };
    const before = await tx.product.findUnique({ where: { tenantId_code: { tenantId: t, code: p.code } } });
    const row = before
      ? await tx.product.update({ where: { id: before.id }, data })
      : await tx.product.create({ data: { ...data, tenantId: t, code: p.code } });
    await this.audit.record(tx, user, before ? 'PRODUCT_UPDATED' : 'PRODUCT_CREATED', 'Product', row.id, { before, after: row });
    return row;
  }

  async upsertDistributor(tx: Tx, user: AuthUser, d: z.output<typeof DistributorInput>) {
    const t = user.tenantId;
    const manager = await this.byCode(tx.user.findUnique({ where: { tenantId_email: { tenantId: t, email: d.managerEmail.toLowerCase() } } }), 'Manager', d.managerEmail);
    if (manager.role !== 'MANAGER') throw new DomainError('NOT_A_MANAGER', `${d.managerEmail} is not a manager`);
    const data = { name: d.name, gstin: d.gstin, stateCode: d.stateCode, city: d.city, address: d.address, lat: d.lat, lng: d.lng, tier: d.tier ?? null, hierarchyPath: manager.hierarchyPath, active: d.active };
    const before = await tx.distributor.findUnique({ where: { tenantId_code: { tenantId: t, code: d.code } } });
    if (before && before.gstin !== d.gstin && (await tx.invoice.count({ where: { distributorId: before.id } }))) {
      throw new DomainError('GSTIN_LOCKED', 'GSTIN cannot change once invoices exist — register a new distributor code');
    }
    const row = before ? await tx.distributor.update({ where: { id: before.id }, data }) : await tx.distributor.create({ data: { ...data, tenantId: t, code: d.code } });
    if (!before) {
      await tx.stockLocation.create({ data: { tenantId: t, distributorId: row.id, code: `${d.code}-WH`, name: `${d.name} warehouse`, type: 'WAREHOUSE' } });
    }
    await this.audit.record(tx, user, before ? 'DISTRIBUTOR_UPDATED' : 'DISTRIBUTOR_CREATED', 'Distributor', row.id, { before, after: row });
    return row;
  }

  async upsertOutlet(tx: Tx, user: AuthUser, o: z.output<typeof OutletInput>) {
    const t = user.tenantId;
    const channel = await this.byCode(tx.channel.findUnique({ where: { tenantId_code: { tenantId: t, code: o.channelCode } } }), 'Channel', o.channelCode);
    const services = [];
    for (const s of o.services) {
      const model = await this.byCode(tx.rtmModel.findUnique({ where: { tenantId_code: { tenantId: t, code: s.rtmModelCode } } }), 'RTM model', s.rtmModelCode);
      const dist = await this.byCode(tx.distributor.findUnique({ where: { tenantId_code: { tenantId: t, code: s.distributorCode } } }), 'Distributor', s.distributorCode);
      const brands = await tx.brand.findMany({ where: { tenantId: t, code: { in: s.brandCodes } } });
      if (brands.length !== s.brandCodes.length) throw new DomainError('UNKNOWN_CODE', `Unknown brand in ${s.brandCodes.join(', ')}`);
      services.push({ rtmModelId: model.id, distributorId: dist.id, brandIds: brands.map((b) => b.id), isPrimary: s.isPrimary });
    }
    const data = {
      name: o.name, ownerName: o.ownerName, phone: o.phone, gstin: o.gstin ?? null, channelId: channel.id, tier: o.tier ?? null,
      stateCode: o.stateCode, city: o.city, address: o.address, lat: o.lat, lng: o.lng, geofenceM: o.geofenceM, active: o.active,
    };
    const before = await tx.outlet.findUnique({ where: { tenantId_code: { tenantId: t, code: o.code } }, include: { services: true } });
    const row = before ? await tx.outlet.update({ where: { id: before.id }, data }) : await tx.outlet.create({ data: { ...data, tenantId: t, code: o.code } });
    await tx.outletService.deleteMany({ where: { outletId: row.id } });
    await tx.outletService.createMany({ data: services.map((s) => ({ ...s, tenantId: t, outletId: row.id })) });
    if (o.creditLimitRupees !== undefined) {
      const primary = services.find((s) => s.isPrimary)!;
      await tx.creditAccount.upsert({
        where: { outletId_distributorId: { outletId: row.id, distributorId: primary.distributorId } },
        create: { tenantId: t, outletId: row.id, distributorId: primary.distributorId, limitPaise: BigInt(o.creditLimitRupees), creditDays: o.creditDays },
        update: { limitPaise: BigInt(o.creditLimitRupees), creditDays: o.creditDays },
      });
    }
    await this.audit.record(tx, user, before ? 'OUTLET_UPDATED' : 'OUTLET_CREATED', 'Outlet', row.id, { before, after: { ...row, services } });
    return row;
  }

  async upsertUser(tx: Tx, user: AuthUser, u: z.output<typeof UserInput>) {
    const t = user.tenantId;
    const before = await tx.user.findUnique({ where: { tenantId_email: { tenantId: t, email: u.email } } });
    let managerId: string | null = null;
    let hierarchyPath = u.role === 'ADMIN' ? '/' : u.role === 'RETAILER' ? '/retail/' : '';
    if (u.role !== 'ADMIN' && u.role !== 'RETAILER') {
      if (!u.managerEmail) throw new DomainError('MANAGER_REQUIRED', 'Field users need a manager');
      const m = await this.byCode(tx.user.findUnique({ where: { tenantId_email: { tenantId: t, email: u.managerEmail.toLowerCase() } } }), 'Manager', u.managerEmail);
      if (m.role !== 'MANAGER') throw new DomainError('NOT_A_MANAGER', `${u.managerEmail} is not a manager`);
      if (before && m.hierarchyPath.startsWith(before.hierarchyPath)) throw new DomainError('CYCLE', 'A user cannot report to someone under them');
      managerId = m.id;
      hierarchyPath = `${m.hierarchyPath}${u.pathSegment ?? u.email.split('@')[0]}/`;
    }
    const distributorId = u.distributorCode
      ? (await this.byCode(tx.distributor.findUnique({ where: { tenantId_code: { tenantId: t, code: u.distributorCode } } }), 'Distributor', u.distributorCode)).id
      : null;
    const outletId = u.outletCode ? (await this.byCode(tx.outlet.findUnique({ where: { tenantId_code: { tenantId: t, code: u.outletCode } } }), 'Outlet', u.outletCode)).id : null;
    if (u.role === 'DISTRIBUTOR' && !distributorId) throw new DomainError('DISTRIBUTOR_REQUIRED', 'Distributor users need a distributor code');
    if (u.role === 'RETAILER' && !outletId) throw new DomainError('OUTLET_REQUIRED', 'Retailer users need an outlet code');
    if (!before && !u.password) throw new DomainError('PASSWORD_REQUIRED', 'New users need an initial password');
    const data = {
      name: u.name, phone: u.phone, role: u.role, title: u.title, managerId, hierarchyPath, distributorId, outletId, active: u.active,
      ...(u.password ? { passwordHash: await bcrypt.hash(u.password, 10) } : {}),
    };
    const row = before
      ? await tx.user.update({ where: { id: before.id }, data })
      : await tx.user.create({ data: { ...data, tenantId: t, email: u.email, passwordHash: data.passwordHash! } });
    // Moving a manager moves their whole subtree (and the distributors under them).
    if (before && before.hierarchyPath !== hierarchyPath) {
      await tx.$executeRaw`UPDATE "User" SET "hierarchyPath" = ${hierarchyPath}::text || substr("hierarchyPath", ${before.hierarchyPath.length + 1}::int)
        WHERE "tenantId" = ${t} AND id <> ${row.id} AND "hierarchyPath" LIKE ${before.hierarchyPath + '%'}`;
      await tx.$executeRaw`UPDATE "Distributor" SET "hierarchyPath" = ${hierarchyPath}::text || substr("hierarchyPath", ${before.hierarchyPath.length + 1}::int)
        WHERE "tenantId" = ${t} AND "hierarchyPath" LIKE ${before.hierarchyPath + '%'}`;
    }
    const { passwordHash: _a, mfaSecret: _b, ...safeAfter } = row as typeof row & { mfaSecret?: string };
    const safeBefore = before ? { ...before, passwordHash: undefined, mfaSecret: undefined } : null;
    await this.audit.record(tx, user, before ? 'USER_UPDATED' : 'USER_CREATED', 'User', row.id, { before: safeBefore, after: safeAfter });
    return safeAfter;
  }

  async upsertBeat(tx: Tx, user: AuthUser, b: z.output<typeof BeatInput>) {
    const t = user.tenantId;
    const dist = await this.byCode(tx.distributor.findUnique({ where: { tenantId_code: { tenantId: t, code: b.distributorCode } } }), 'Distributor', b.distributorCode);
    const dsr = await this.byCode(tx.user.findUnique({ where: { tenantId_email: { tenantId: t, email: b.dsrEmail.toLowerCase() } } }), 'DSR', b.dsrEmail);
    if (dsr.role !== 'DSR') throw new DomainError('NOT_A_DSR', `${b.dsrEmail} is not a DSR`);
    const outlets = await tx.outlet.findMany({ where: { tenantId: t, code: { in: b.outletCodes } } });
    if (outlets.length !== b.outletCodes.length) throw new DomainError('UNKNOWN_CODE', 'Unknown outlet code on beat');
    const data = { name: b.name, distributorId: dist.id, dsrId: dsr.id, daysOfWeek: b.daysOfWeek, anchorLat: b.anchorLat, anchorLng: b.anchorLng, geofenceM: b.geofenceM };
    const before = await tx.beat.findUnique({ where: { tenantId_code: { tenantId: t, code: b.code } }, include: { outlets: true } });
    const row = before ? await tx.beat.update({ where: { id: before.id }, data }) : await tx.beat.create({ data: { ...data, tenantId: t, code: b.code } });
    await tx.beatOutlet.deleteMany({ where: { beatId: row.id } });
    const byCode = new Map(outlets.map((o) => [o.code, o.id]));
    await tx.beatOutlet.createMany({ data: b.outletCodes.map((c, i) => ({ beatId: row.id, outletId: byCode.get(c)!, sequence: i + 1 })) });
    await this.audit.record(tx, user, before ? 'BEAT_UPDATED' : 'BEAT_CREATED', 'Beat', row.id, { before, after: { ...row, outletCodes: b.outletCodes } });
    return row;
  }

  async upsertChannel(tx: Tx, user: AuthUser, c: z.output<typeof ChannelInput>) {
    const before = await tx.channel.findUnique({ where: { tenantId_code: { tenantId: user.tenantId, code: c.code } } });
    const row = before
      ? await tx.channel.update({ where: { id: before.id }, data: { name: c.name, minResidualShelfDays: c.minResidualShelfDays } })
      : await tx.channel.create({ data: { tenantId: user.tenantId, ...c } });
    await this.audit.record(tx, user, before ? 'CHANNEL_UPDATED' : 'CHANNEL_CREATED', 'Channel', row.id, { before, after: row });
    return row;
  }

  async upsertRtmModel(tx: Tx, user: AuthUser, m: z.output<typeof RtmModelInput>) {
    const before = await tx.rtmModel.findUnique({ where: { tenantId_code: { tenantId: user.tenantId, code: m.code } } });
    const { code, ...data } = m;
    const row = before ? await tx.rtmModel.update({ where: { id: before.id }, data }) : await tx.rtmModel.create({ data: { tenantId: user.tenantId, code, ...data } });
    await this.audit.record(tx, user, before ? 'RTM_MODEL_UPDATED' : 'RTM_MODEL_CREATED', 'RtmModel', row.id, { before, after: row });
    return row;
  }

  async createMarginRule(tx: Tx, user: AuthUser, m: z.output<typeof MarginRuleInput>) {
    const t = user.tenantId;
    const productId = m.productCode ? (await this.byCode(tx.product.findUnique({ where: { tenantId_code: { tenantId: t, code: m.productCode } } }), 'Product', m.productCode)).id : null;
    const brandId = m.brandCode ? (await this.byCode(tx.brand.findUnique({ where: { tenantId_code: { tenantId: t, code: m.brandCode } } }), 'Brand', m.brandCode)).id : null;
    const row = await tx.marginRule.create({
      data: { tenantId: t, productId, brandId, channelCode: m.channelCode ?? null, stateCode: m.stateCode ?? null, tier: m.tier ?? null, marginBp: Math.round(m.marginPct * 100), validFrom: m.validFrom, validTo: m.validTo ?? null },
    });
    await this.audit.record(tx, user, 'MARGIN_RULE_CREATED', 'MarginRule', row.id, { after: row });
    return row;
  }

  /** Margin rules are ended, not edited: set validTo. */
  async endMarginRule(tx: Tx, user: AuthUser, id: string, at: Date) {
    const before = await tx.marginRule.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!before) throw notFound('Margin rule');
    const row = await tx.marginRule.update({ where: { id }, data: { validTo: at } });
    await this.audit.record(tx, user, 'MARGIN_RULE_ENDED', 'MarginRule', id, { before, after: row });
    return row;
  }

  private async priceItems(tx: Tx, tenantId: string, items: { productCode: string; baseRupees: number }[]) {
    const products = await tx.product.findMany({ where: { tenantId, code: { in: items.map((i) => i.productCode) } } });
    const byCode = new Map(products.map((p) => [p.code, p.id]));
    const missing = items.filter((i) => !byCode.has(i.productCode)).map((i) => i.productCode);
    if (missing.length) throw new DomainError('UNKNOWN_CODE', `Unknown product(s): ${missing.join(', ')}`);
    return items.map((i) => ({ productId: byCode.get(i.productCode)!, basePaise: BigInt(i.baseRupees) }));
  }

  async createPriceList(tx: Tx, user: AuthUser, p: z.output<typeof PriceListInput>) {
    if (await tx.priceList.findUnique({ where: { tenantId_code: { tenantId: user.tenantId, code: p.code } } })) {
      throw new DomainError('DUPLICATE_CODE', `Price list ${p.code} exists — revise it instead`, 409);
    }
    const row = await tx.priceList.create({
      data: {
        tenantId: user.tenantId, code: p.code, name: p.name, channelCode: p.channelCode ?? null, stateCode: p.stateCode ?? null, priority: p.priority, validFrom: p.validFrom,
        items: { create: await this.priceItems(tx, user.tenantId, p.items) },
      },
      include: { items: true },
    });
    await this.audit.record(tx, user, 'PRICE_LIST_CREATED', 'PriceList', row.id, { after: row });
    return row;
  }

  /**
   * New version of a price list from `validFrom`: copies the current items, applies the changes,
   * and closes the current version at `validFrom`. Orders captured before stay at old prices.
   */
  async revisePriceList(tx: Tx, user: AuthUser, listId: string, r: z.output<typeof PriceRevisionInput>) {
    const cur = await tx.priceList.findFirst({ where: { id: listId, tenantId: user.tenantId }, include: { items: true } });
    if (!cur) throw notFound('Price list');
    if (cur.validTo && cur.validTo <= r.validFrom) throw new DomainError('ALREADY_CLOSED', 'That version is already closed; revise the latest version');
    if (r.validFrom <= cur.validFrom) throw new DomainError('BAD_DATE', 'New version must start after the current one');
    const changes = await this.priceItems(tx, user.tenantId, r.items);
    const merged = new Map(cur.items.map((i) => [i.productId, i.basePaise]));
    for (const c of changes) merged.set(c.productId, c.basePaise);
    const versions = await tx.priceList.count({ where: { tenantId: user.tenantId, code: { startsWith: cur.code.replace(/~v\d+$/, '') } } });
    const next = await tx.priceList.create({
      data: {
        tenantId: user.tenantId,
        code: `${cur.code.replace(/~v\d+$/, '')}~v${versions + 1}`,
        name: cur.name,
        channelCode: cur.channelCode,
        stateCode: cur.stateCode,
        priority: cur.priority,
        validFrom: r.validFrom,
        validTo: cur.validTo,
        items: { create: [...merged].map(([productId, basePaise]) => ({ productId, basePaise })) },
      },
    });
    await tx.priceList.update({ where: { id: cur.id }, data: { validTo: r.validFrom } });
    const changed = changes.map((c) => ({ productId: c.productId, from: cur.items.find((i) => i.productId === c.productId)?.basePaise ?? null, to: c.basePaise }));
    await this.audit.record(tx, user, 'PRICE_REVISED', 'PriceList', next.id, { before: { listId: cur.id, code: cur.code }, after: { listId: next.id, code: next.code, validFrom: r.validFrom }, meta: { changed } });
    return next;
  }

  /** CSV import: every row validated by the same schema as the form; applied only if all rows pass. */
  async import(user: AuthUser, entity: ImportEntity, req: { csv: string; dryRun: boolean; priceListCode?: string; validFrom?: string }) {
    const rows = parseCsv(req.csv);
    if (rows.length === 0) throw new DomainError('EMPTY_CSV', 'No data rows found');
    if (rows.length > 5000) throw new DomainError('TOO_MANY_ROWS', 'Import at most 5,000 rows at a time');
    const schema = { products: ProductInput, distributors: DistributorInput, outlets: OutletInput, prices: null }[entity];
    const errors: { row: number; errors: string[] }[] = [];
    const parsed: unknown[] = [];

    rows.forEach((r, i) => {
      if (entity === 'prices') {
        const v = Number(r.baseRupees);
        if (!r.productCode || !(v >= 0)) errors.push({ row: i + 2, errors: ['productCode and baseRupees (≥ 0) are required'] });
        else parsed.push({ productCode: r.productCode, baseRupees: Math.round(v * 100) });
        return;
      }
      const input = entity === 'outlets' ? outletRowToInput(r) : { ...r, tier: r.tier || undefined };
      const res = schema!.safeParse(input);
      if (res.success) parsed.push(res.data);
      else errors.push({ row: i + 2, errors: res.error.issues.map((x) => `${x.path.join('.') || 'row'}: ${x.message}`) });
    });
    const dupes = entity === 'prices' ? [] : rows.map((r) => r.code).filter((c, i, a) => c && a.indexOf(c) !== i);
    if (dupes.length) errors.push({ row: 0, errors: [`Duplicate codes in file: ${[...new Set(dupes)].join(', ')}`] });

    const finish = async (status: string, errs: typeof errors) => {
      const job = await this.prisma.importJob.create({
        data: { tenantId: user.tenantId, entity, dryRun: req.dryRun, status, totalRows: rows.length, okRows: rows.length - errs.filter((e) => e.row > 0).length, errors: errs as any, createdById: user.userId },
      });
      return { jobId: job.id, status, totalRows: rows.length, okRows: job.okRows, errors: errs };
    };
    if (errors.length) return finish('INVALID', errors);

    // Apply inside one transaction even for a dry run (rolled back), so reference errors surface too.
    const DRY = Symbol('dry-run');
    try {
      await this.prisma.$transaction(
        async (tx) => {
          for (const [i, p] of parsed.entries()) {
            try {
              if (entity === 'products') await this.upsertProduct(tx, user, p as z.output<typeof ProductInput>);
              if (entity === 'distributors') await this.upsertDistributor(tx, user, p as z.output<typeof DistributorInput>);
              if (entity === 'outlets') await this.upsertOutlet(tx, user, p as z.output<typeof OutletInput>);
            } catch (e) {
              if (e instanceof DomainError) throw Object.assign(e, { row: i + 2 });
              throw e;
            }
          }
          if (entity === 'prices') {
            if (!req.priceListCode || !req.validFrom) throw new DomainError('PRICE_LIST_REQUIRED', 'Choose a price list and an effective date');
            const list = await tx.priceList.findFirst({ where: { tenantId: user.tenantId, code: { startsWith: req.priceListCode }, validTo: null }, orderBy: { validFrom: 'desc' } });
            if (!list) throw notFound(`Open price list ${req.priceListCode}`);
            await this.revisePriceList(tx, user, list.id, PriceRevisionInput.parse({ validFrom: req.validFrom, items: (parsed as { productCode: string; baseRupees: number }[]).map((x) => ({ ...x, baseRupees: x.baseRupees / 100 })) }));
          }
          if (req.dryRun) throw DRY;
        },
        { timeout: 120_000 },
      );
    } catch (e) {
      if (e === DRY) return finish('VALID', []);
      if (e instanceof DomainError) return finish('INVALID', [{ row: (e as DomainError & { row?: number }).row ?? 0, errors: [e.message] }]);
      throw e;
    }
    return finish('APPLIED', []);
  }
}
