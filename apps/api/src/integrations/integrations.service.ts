import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { JobsService } from '../jobs/jobs.service';
import { ERP, LOGISTICS, MARKETPLACE, type ErpConnector, type LogisticsConnector, type MarketplaceConnector } from './connectors';

/**
 * Event-driven integration publishing. Business transactions enqueue `integrations.*` jobs in their
 * own transaction (outbox); these handlers deliver them with retries and record the outcome.
 */
@Injectable()
export class IntegrationsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    @Inject(ERP) readonly erp: ErpConnector,
    @Inject(LOGISTICS) readonly logistics: LogisticsConnector,
    @Inject(MARKETPLACE) readonly marketplace: MarketplaceConnector,
  ) {}

  onModuleInit() {
    this.jobs.register('integrations.erp', (p) => this.toErp(p));
    this.jobs.register('integrations.catalogue', () => this.publishCatalogue());
    this.jobs.register('integrations.shipment', (p) => this.ship(p.invoiceId));
    this.jobs.every('integrations.catalogue', 6 * 3600_000);
  }

  private async log(target: string, event: string, refId: string, status: string, externalRef: string | null, detail: unknown) {
    await this.prisma.integrationLog.create({ data: { target, event, refId, status, externalRef, detail: detail as any } });
  }

  async toErp(p: { event: string; invoiceId?: string }) {
    if (p.event === 'INVOICE_ISSUED' && p.invoiceId) {
      const inv = await this.prisma.invoice.findUniqueOrThrow({ where: { id: p.invoiceId } });
      const dist = await this.prisma.distributor.findUniqueOrThrow({ where: { id: inv.distributorId } });
      const r = await this.erp.pushDocument({ type: 'INVOICE', number: inv.invoiceNo, distributorCode: dist.code, totalPaise: Number(inv.totalPaise), payload: { irn: inv.irn } });
      await this.log(this.erp.name, p.event, inv.id, 'SENT', r.externalRef, { invoiceNo: inv.invoiceNo });
    }
  }

  async ship(invoiceId: string) {
    const inv = await this.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: true } });
    const [d, o] = await Promise.all([this.prisma.distributor.findUniqueOrThrow({ where: { id: inv.distributorId } }), this.prisma.outlet.findUniqueOrThrow({ where: { id: inv.outletId } })]);
    const r = await this.logistics.createShipment({
      invoiceNo: inv.invoiceNo,
      from: { lat: d.lat, lng: d.lng, address: d.address },
      to: { lat: o.lat, lng: o.lng, address: o.address, phone: o.phone },
      weightKg: inv.lines.reduce((a, l) => a + l.qty + l.freeQty, 0) * 0.6,
    });
    await this.log(this.logistics.name, 'SHIPMENT_CREATED', inv.id, 'SENT', r.awb, { invoiceNo: inv.invoiceNo, eta: r.eta });
  }

  /** JioMart Partner: price = the e-com channel's list price, stock = what distributors hold. */
  async publishCatalogue() {
    const tenant = await this.prisma.tenant.findFirst();
    if (!tenant) return { accepted: 0, rejected: [] };
    const [products, lists, stock] = await Promise.all([
      this.prisma.product.findMany({ where: { tenantId: tenant.id, active: true } }),
      this.prisma.priceList.findMany({ where: { tenantId: tenant.id, active: true, validFrom: { lte: new Date() }, OR: [{ validTo: null }, { validTo: { gt: new Date() } }] }, include: { items: true }, orderBy: { priority: 'desc' } }),
      this.prisma.inventoryBatch.groupBy({ by: ['productId'], where: { tenantId: tenant.id, bucket: 'SALEABLE', expiryDate: { gt: new Date() } }, _sum: { qtyOnHand: true } }),
    ]);
    const preferred = [...lists].sort((a, b) => Number(b.channelCode === 'ECOM') - Number(a.channelCode === 'ECOM'));
    const items = products.map((p) => {
      const base = preferred.flatMap((l) => l.items).find((i) => i.productId === p.id)?.basePaise ?? 0n;
      const withGst = (Number(base) * (10_000 + p.gstRateBp)) / 10_000;
      return { sku: p.code, name: p.name, mrpPaise: Number(p.mrpPaise), pricePaise: Math.round(withGst), stock: stock.find((s) => s.productId === p.id)?._sum.qtyOnHand ?? 0 };
    });
    const r = await this.marketplace.publishCatalogue(items);
    await this.log(this.marketplace.name, 'CATALOGUE_PUBLISHED', tenant.id, r.rejected.length ? 'PARTIAL' : 'SENT', null, r);
    return r;
  }

  async recent() {
    return this.prisma.integrationLog.findMany({ orderBy: { at: 'desc' }, take: 50 });
  }
}
