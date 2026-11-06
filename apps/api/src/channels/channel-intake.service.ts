import { Inject, Injectable } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { PartnerIntegration } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { DomainError, isUniqueViolation, notFound } from '../common/errors';
import { toJson } from '../common/json';
import { AuditService } from '../core/audit.service';
import { OrdersService } from '../orders/orders.service';
import { MARKETPLACE, type MarketplaceConnector } from '../integrations/connectors';

/** Where to find things in a partner's payload. Paths are dot/bracket paths: "ShipTo.StoreCode", "items[0].sku". */
export interface GenericJsonConfig {
  refPath: string;
  storePath: string;
  linesPath: string;
  skuPath: string;
  qtyPath: string;
  qtyUnit: 'EACH' | 'CASE';
  totalPath?: string;
  totalUnit?: 'RUPEES' | 'PAISE';
}

export function pick(obj: unknown, path: string): unknown {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Inbound orders from modern trade, e-commerce and quick-commerce partners. One generic adapter
 * driven by per-partner configuration maps any JSON PO onto the *same* order lifecycle as field
 * and eB2B orders (pricing, schemes, credit, invoicing). Intake is idempotent per partner order ref.
 */
@Injectable()
export class ChannelIntakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly audit: AuditService,
    @Inject(MARKETPLACE) private readonly marketplace: MarketplaceConnector,
  ) {}

  /** Public endpoint path: authenticate the partner by API key + HMAC of the raw body. */
  async intake(partnerCode: string, rawBody: Buffer, apiKey: string | undefined, signature: string | undefined) {
    const partner = await this.prisma.partnerIntegration.findFirst({ where: { code: partnerCode, active: true } });
    if (!partner || !apiKey || !safeEq(sha256(apiKey), partner.apiKeyHash)) throw new DomainError('UNAUTHENTICATED', 'Unknown partner or bad API key', 401);
    const expected = createHmac('sha256', partner.signingSecret).update(rawBody).digest('hex');
    if (!signature || !safeEq(expected, signature)) throw new DomainError('BAD_SIGNATURE', 'X-Partner-Signature does not match the body', 401);
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new DomainError('BAD_JSON', 'Body is not JSON', 400);
    }
    return this.process(partner, body);
  }

  async process(partner: PartnerIntegration, body: unknown): Promise<{ status: string; externalRef: string; orderNos?: string[]; flags?: string[]; error?: unknown; previously?: string }> {
    const cfg = partner.config as unknown as GenericJsonConfig;
    const externalRef = String(pick(body, cfg.refPath) ?? '').trim();
    if (!externalRef) throw new DomainError('MISSING_REF', `No order reference at "${cfg.refPath}"`, 400);
    const seen = await this.prisma.externalOrder.findUnique({ where: { partnerId_externalRef: { partnerId: partner.id, externalRef } } });
    if (seen) return { status: 'DUPLICATE', externalRef, orderNos: seen.orderNos, previously: seen.status, error: seen.error };

    const reject = async (code: string, message: string) => {
      try {
        await this.prisma.externalOrder.create({ data: { tenantId: partner.tenantId, partnerId: partner.id, externalRef, payload: toJson(body), status: 'REJECTED', orderNos: [], error: `${code}: ${message}` } });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
      await this.marketplace.ackOrder(externalRef, 'REJECTED', message).catch(() => undefined);
      return { status: 'REJECTED', externalRef, error: { code, message } };
    };

    const store = String(pick(body, cfg.storePath) ?? '');
    const map = await this.prisma.partnerOutlet.findUnique({ where: { partnerId_externalStoreId: { partnerId: partner.id, externalStoreId: store } } });
    if (!map) return reject('UNKNOWN_STORE', `Store "${store}" is not mapped to an outlet`);
    const rawLines = pick(body, cfg.linesPath);
    if (!Array.isArray(rawLines) || rawLines.length === 0) return reject('NO_LINES', `No lines at "${cfg.linesPath}"`);

    const skuMaps = await this.prisma.partnerSku.findMany({ where: { partnerId: partner.id } });
    const products = await this.prisma.product.findMany({ where: { tenantId: partner.tenantId, active: true } });
    const lines: { productId: string; qty: number }[] = [];
    for (const [i, l] of rawLines.entries()) {
      const sku = String(pick(l, cfg.skuPath) ?? '');
      const product = products.find((p) => p.id === skuMaps.find((m) => m.externalSku === sku)?.productId) ?? products.find((p) => p.code === sku);
      const qty = Number(pick(l, cfg.qtyPath));
      if (!product) return reject('UNKNOWN_SKU', `Line ${i + 1}: SKU "${sku}" is not mapped`);
      if (!Number.isInteger(qty) || qty <= 0) return reject('BAD_QTY', `Line ${i + 1}: quantity "${pick(l, cfg.qtyPath)}"`);
      lines.push({ productId: product.id, qty: cfg.qtyUnit === 'CASE' ? qty * product.caseSize : qty });
    }
    const totalRaw = cfg.totalPath ? Number(pick(body, cfg.totalPath)) : NaN;
    const poTotal = Number.isFinite(totalRaw) ? Math.round(cfg.totalUnit === 'PAISE' ? totalRaw : totalRaw * 100) : null;

    const actor: AuthUser = { userId: partner.systemUserId, tenantId: partner.tenantId, role: 'ADMIN', name: `partner:${partner.code}`, hierarchyPath: '/', distributorId: null, outletId: null };
    try {
      const result = await this.prisma.tx(async (tx) => {
        const ext = await tx.externalOrder.create({ data: { tenantId: partner.tenantId, partnerId: partner.id, externalRef, payload: toJson(body), status: 'ACCEPTED', orderNos: [] } });
        // No PO value → accept our price; a PO value lower than ours is held as PRICE_MISMATCH.
        const priced = await this.orders.createFieldOrder(
          tx,
          actor,
          { idempotencyKey: `${partner.code}:${externalRef}`, capturedAt: new Date().toISOString(), payload: { outletId: map.outletId, lines, clientTotalPaise: poTotal ?? -1, paymentMode: 'CREDIT' } },
          new Date(),
          `${partner.channelCode}_FEED`,
        );
        await tx.externalOrder.update({ where: { id: ext.id }, data: { orderNos: priced.refs } });
        await this.audit.record(tx, actor, 'PARTNER_ORDER_ACCEPTED', 'ExternalOrder', ext.id, { after: { externalRef, orderNos: priced.refs, flags: priced.flags } });
        return priced;
      });
      await this.marketplace.ackOrder(externalRef, 'ACCEPTED').catch(() => undefined);
      return { status: 'ACCEPTED', externalRef, orderNos: result.refs, flags: result.flags };
    } catch (e) {
      if (isUniqueViolation(e, 'externalRef')) return this.process(partner, body);
      if (e instanceof DomainError) return reject(e.code, e.message);
      throw e;
    }
  }

  async simulate(user: AuthUser, code: string, payload: unknown) {
    const partner = await this.prisma.partnerIntegration.findFirst({ where: { tenantId: user.tenantId, code } });
    if (!partner) throw notFound(`Partner ${code}`);
    return this.process(partner, payload);
  }

  async list(user: AuthUser) {
    const partners = await this.prisma.partnerIntegration.findMany({ where: { tenantId: user.tenantId } });
    const [stores, skus, recent] = await Promise.all([
      this.prisma.partnerOutlet.findMany({ where: { partnerId: { in: partners.map((p) => p.id) } } }),
      this.prisma.partnerSku.findMany({ where: { partnerId: { in: partners.map((p) => p.id) } } }),
      this.prisma.externalOrder.findMany({ where: { tenantId: user.tenantId }, orderBy: { receivedAt: 'desc' }, take: 30 }),
    ]);
    return partners.map(({ apiKeyHash: _k, signingSecret: _s, ...p }) => ({
      ...p,
      stores: stores.filter((s) => s.partnerId === p.id),
      skus: skus.filter((s) => s.partnerId === p.id),
      recent: recent.filter((r) => r.partnerId === p.id),
    }));
  }
}
