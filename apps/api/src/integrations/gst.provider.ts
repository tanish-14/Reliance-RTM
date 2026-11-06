import { createHash, randomInt } from 'node:crypto';
import { isValidGstin } from '@rtm/shared';

/** Document as sent to the e-invoice registry (IRP). Amounts in paise. */
export interface EInvoiceDoc {
  docType: 'INV' | 'CRN' | 'DBN';
  docNo: string;
  docDate: Date;
  supplierGstin: string;
  buyerGstin: string;
  placeOfSupply: string;
  items: { hsnCode: string; qty: number; freeQty: number; taxablePaise: number; gstRateBp: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number }[];
  totalPaise: number;
}

export interface IrnResult {
  irn: string;
  ackNo: string;
  ackDate: Date;
  signedQr: string;
}

export interface GstProvider {
  readonly name: string;
  generateIrn(doc: EInvoiceDoc): Promise<IrnResult>;
  cancelIrn(irn: string, reason: string): Promise<void>;
  generateEwayBill(input: { irn: string; distanceKm: number; vehicleNo?: string }): Promise<{ ewbNo: string; validUntil: Date }>;
  cancelEwayBill(ewbNo: string, reason: string): Promise<void>;
}

/** A rejection the registry will repeat on retry (bad data) — do not retry. */
export class GstValidationError extends Error {}

export const GST_PROVIDER = Symbol('GST_PROVIDER');

/**
 * Local stand-in for the NIC IRP / e-way bill APIs. Same contract, deterministic IRN
 * (SHA-256 of supplier GSTIN + FY + doc type + doc no, as the IRP computes it), same
 * validations that matter for us. Swap for a GSP-backed provider in production.
 */
export class MockGstProvider implements GstProvider {
  readonly name = 'mock-irp';

  async generateIrn(doc: EInvoiceDoc): Promise<IrnResult> {
    if (!isValidGstin(doc.supplierGstin)) throw new GstValidationError(`2117: invalid supplier GSTIN ${doc.supplierGstin}`);
    if (!isValidGstin(doc.buyerGstin)) throw new GstValidationError(`3028: invalid buyer GSTIN ${doc.buyerGstin}`);
    if (doc.supplierGstin === doc.buyerGstin) throw new GstValidationError('2211: supplier and buyer GSTIN cannot be the same');
    if (doc.docNo.length > 16) throw new GstValidationError('2194: document number longer than 16 characters');
    for (const it of doc.items) {
      if (!/^\d{4,8}$/.test(it.hsnCode)) throw new GstValidationError(`2233: invalid HSN ${it.hsnCode}`);
      if (it.taxablePaise + it.cgstPaise + it.sgstPaise + it.igstPaise !== it.totalPaise) throw new GstValidationError('2172: item total mismatch');
    }
    const sum = doc.items.reduce((a, i) => a + i.totalPaise, 0);
    if (Math.abs(sum - doc.totalPaise) > 100) throw new GstValidationError(`2189: document total ${doc.totalPaise} ≠ items ${sum}`);
    const fy = fyOf(doc.docDate);
    const irn = createHash('sha256').update(`${doc.supplierGstin}${fy}${doc.docType}${doc.docNo}`).digest('hex');
    const ackDate = new Date();
    const qr = { SellerGstin: doc.supplierGstin, BuyerGstin: doc.buyerGstin, DocNo: doc.docNo, DocTyp: doc.docType, DocDt: doc.docDate.toISOString().slice(0, 10), TotInvVal: doc.totalPaise / 100, ItemCnt: doc.items.length, MainHsnCode: doc.items[0]?.hsnCode, Irn: irn, IrnDt: ackDate.toISOString() };
    return { irn, ackNo: `${randomInt(1e7, 1e8)}${String(randomInt(0, 1e7)).padStart(7, '0')}`, ackDate, signedQr: Buffer.from(JSON.stringify(qr)).toString('base64url') };
  }

  async cancelIrn() {}

  async generateEwayBill(input: { irn: string; distanceKm: number }) {
    if (input.distanceKm <= 0 || input.distanceKm > 4000) throw new GstValidationError('721: invalid distance');
    // Validity: 1 day per 200 km (part thereof) for regular cargo.
    const days = Math.max(1, Math.ceil(input.distanceKm / 200));
    return { ewbNo: String(randomInt(1e11, 1e12 - 1)), validUntil: new Date(Date.now() + days * 86_400_000) };
  }

  async cancelEwayBill() {}
}

export function fyOf(d: Date): string {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}
