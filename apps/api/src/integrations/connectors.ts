import { createHash, randomInt } from 'node:crypto';

/**
 * Outbound integrations. RTM does not replace the ERP, WMS/TMS or marketplaces — it publishes
 * events to them through these interfaces. Each has a mock so the platform runs fully locally;
 * real connectors are a drop-in (same interface, chosen by env).
 */

export interface ErpConnector {
  readonly name: string;
  /** Secondary-sales invoice / credit note for the distributor's books & RCPL analytics. */
  pushDocument(doc: { type: 'INVOICE' | 'CREDIT_NOTE' | 'CLAIM'; number: string; distributorCode: string; totalPaise: number; payload: unknown }): Promise<{ externalRef: string }>;
  /** Primary sales (RCPL -> distributor) for pipeline / stock visibility. */
  pullPrimaryInvoices(distributorCode: string, since: Date): Promise<{ invoiceNo: string; date: string; lines: { sku: string; qty: number }[] }[]>;
}

export interface LogisticsConnector {
  readonly name: string;
  createShipment(s: { invoiceNo: string; from: { lat: number; lng: number; address: string }; to: { lat: number; lng: number; address: string; phone: string }; weightKg: number }): Promise<{ awb: string; eta: string }>;
  track(awb: string): Promise<{ status: 'CREATED' | 'PICKED' | 'IN_TRANSIT' | 'DELIVERED' | 'FAILED'; at: string }>;
}

export interface MarketplaceConnector {
  readonly name: string;
  /** Publish catalogue + price + stock to the marketplace (e.g. JioMart Partner). */
  publishCatalogue(items: { sku: string; name: string; mrpPaise: number; pricePaise: number; stock: number }[]): Promise<{ accepted: number; rejected: { sku: string; reason: string }[] }>;
  /** Acknowledge an inbound marketplace order. */
  ackOrder(externalRef: string, status: 'ACCEPTED' | 'REJECTED', reason?: string): Promise<void>;
}

export const ERP = Symbol('ERP');
export const LOGISTICS = Symbol('LOGISTICS');
export const MARKETPLACE = Symbol('MARKETPLACE');

export class MockErp implements ErpConnector {
  readonly name = 'mock-sap';
  async pushDocument(doc: { type: string; number: string }) {
    return { externalRef: `SAP-${doc.type.slice(0, 3)}-${createHash('sha1').update(doc.number).digest('hex').slice(0, 10).toUpperCase()}` };
  }
  async pullPrimaryInvoices() {
    return [];
  }
}

export class MockLogistics implements LogisticsConnector {
  readonly name = 'mock-3pl';
  private readonly created = new Map<string, number>();
  async createShipment() {
    const awb = `AWB${randomInt(1e9, 1e10 - 1)}`;
    this.created.set(awb, Date.now());
    return { awb, eta: new Date(Date.now() + 86_400_000).toISOString() };
  }
  async track(awb: string) {
    const age = Date.now() - (this.created.get(awb) ?? Date.now());
    const status = age > 120_000 ? 'DELIVERED' : age > 30_000 ? 'IN_TRANSIT' : 'PICKED';
    return { status: status as 'DELIVERED' | 'IN_TRANSIT' | 'PICKED', at: new Date().toISOString() };
  }
}

export class MockJioMartPartner implements MarketplaceConnector {
  readonly name = 'mock-jiomart-partner';
  async publishCatalogue(items: { sku: string; mrpPaise: number; pricePaise: number; stock: number }[]) {
    const rejected = items.filter((i) => i.pricePaise > i.mrpPaise).map((i) => ({ sku: i.sku, reason: 'Selling price above MRP' }));
    return { accepted: items.length - rejected.length, rejected };
  }
  async ackOrder() {}
}
