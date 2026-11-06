import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { distanceM } from '@rtm/shared';
import { PrismaService } from '../prisma.service';
import { JobsService, PermanentJobError } from '../jobs/jobs.service';
import { ReviewService } from '../core/review.service';
import { GST_PROVIDER, GstValidationError, type GstProvider } from './gst.provider';

/** Invoice value above which an e-way bill is required (₹50,000 by default). */
const EWB_THRESHOLD_PAISE = BigInt(process.env.EWB_THRESHOLD_PAISE ?? 50_000_00);
/** IRN can be cancelled only within 24 hours of generation; afterwards a credit note is the route. */
const IRN_CANCEL_WINDOW_MS = 24 * 3600_000;

/**
 * GST e-invoicing as background jobs (enqueued in the invoice's own transaction):
 *   gst.einvoice  → IRN for B2B invoices (B2C has no IRN), then e-way bill if over threshold
 *   gst.ewaybill  → e-way bill against the IRN (distance from distributor to outlet)
 *   gst.cancel    → cancel IRN/EWB if still inside the 24h window
 *   gst.creditnote→ IRN for B2B credit notes
 * Registry validation failures are permanent: the document goes to FAILED + exception queue.
 */
@Injectable()
export class EInvoiceService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly review: ReviewService,
    @Inject(GST_PROVIDER) private readonly gst: GstProvider,
  ) {}

  onModuleInit() {
    this.jobs.register('gst.einvoice', (p) => this.einvoice(p.invoiceId));
    this.jobs.register('gst.ewaybill', (p) => this.ewaybill(p.invoiceId));
    this.jobs.register('gst.cancel', (p) => this.cancel(p.invoiceId, p.reason));
    this.jobs.register('gst.creditnote', (p) => this.creditNote(p.creditNoteId));
  }

  private async fail(tenantId: string, refType: string, refId: string, distributorId: string, summary: string, err: GstValidationError) {
    await this.prisma.tx((tx) => this.review.raise(tx, tenantId, { kind: 'GST_REJECTED', refType, refId, distributorId, summary: `${summary}: ${err.message}`, details: { error: err.message } }));
  }

  async einvoice(invoiceId: string) {
    const inv = await this.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: true } });
    if (inv.irnStatus !== 'PENDING') return;
    if (!inv.buyerGstin) {
      await this.prisma.invoice.update({ where: { id: inv.id }, data: { irnStatus: 'NOT_APPLICABLE' } });
    } else {
      try {
        const r = await this.gst.generateIrn({
          docType: 'INV',
          docNo: inv.invoiceNo,
          docDate: inv.issuedAt,
          supplierGstin: inv.supplierGstin,
          buyerGstin: inv.buyerGstin,
          placeOfSupply: inv.placeOfSupply,
          totalPaise: Number(inv.totalPaise),
          items: inv.lines.map((l) => ({ hsnCode: l.hsnCode, qty: l.qty, freeQty: l.freeQty, taxablePaise: Number(l.taxablePaise), gstRateBp: l.gstRateBp, cgstPaise: Number(l.cgstPaise), sgstPaise: Number(l.sgstPaise), igstPaise: Number(l.igstPaise), totalPaise: Number(l.totalPaise) })),
        });
        await this.prisma.invoice.update({ where: { id: inv.id }, data: { irn: r.irn, ackNo: r.ackNo, ackDate: r.ackDate, signedQr: r.signedQr, irnStatus: 'GENERATED' } });
      } catch (e) {
        if (!(e instanceof GstValidationError)) throw e;
        await this.prisma.invoice.update({ where: { id: inv.id }, data: { irnStatus: 'FAILED' } });
        await this.fail(inv.tenantId, 'Invoice', inv.id, inv.distributorId, `IRN rejected for ${inv.invoiceNo}`, e);
        throw new PermanentJobError(e.message);
      }
    }
    if (inv.totalPaise > EWB_THRESHOLD_PAISE && inv.buyerGstin) {
      await this.prisma.$transaction(async (tx) => {
        await tx.invoice.update({ where: { id: inv.id }, data: { ewbStatus: 'PENDING' } });
        await this.jobs.enqueue(tx, 'gst.ewaybill', { invoiceId: inv.id }, { key: `gst.ewaybill:${inv.id}`, tenantId: inv.tenantId });
      });
    }
  }

  async ewaybill(invoiceId: string) {
    const inv = await this.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (inv.ewbStatus !== 'PENDING' || !inv.irn) return;
    const [d, o] = await Promise.all([
      this.prisma.distributor.findUniqueOrThrow({ where: { id: inv.distributorId } }),
      this.prisma.outlet.findUniqueOrThrow({ where: { id: inv.outletId } }),
    ]);
    // Road distance approximated as 1.3 × straight line (min 1 km).
    const distanceKm = Math.max(1, Math.round((distanceM(d.lat, d.lng, o.lat, o.lng) * 1.3) / 1000));
    try {
      const r = await this.gst.generateEwayBill({ irn: inv.irn, distanceKm });
      await this.prisma.invoice.update({ where: { id: inv.id }, data: { ewbNo: r.ewbNo, ewbValidUntil: r.validUntil, ewbStatus: 'GENERATED' } });
    } catch (e) {
      if (!(e instanceof GstValidationError)) throw e;
      await this.prisma.invoice.update({ where: { id: inv.id }, data: { ewbStatus: 'FAILED' } });
      await this.fail(inv.tenantId, 'Invoice', inv.id, inv.distributorId, `E-way bill rejected for ${inv.invoiceNo}`, e);
      throw new PermanentJobError(e.message);
    }
  }

  async cancel(invoiceId: string, reason: string) {
    const inv = await this.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (inv.ewbNo && inv.ewbStatus === 'GENERATED') {
      await this.gst.cancelEwayBill(inv.ewbNo, reason);
      await this.prisma.invoice.update({ where: { id: inv.id }, data: { ewbStatus: 'CANCELLED' } });
    }
    if (inv.irn && inv.irnStatus === 'GENERATED' && inv.ackDate && Date.now() - inv.ackDate.getTime() < IRN_CANCEL_WINDOW_MS) {
      await this.gst.cancelIrn(inv.irn, reason);
      await this.prisma.invoice.update({ where: { id: inv.id }, data: { irnStatus: 'CANCELLED' } });
    } else if (inv.irnStatus === 'PENDING') {
      await this.prisma.invoice.update({ where: { id: inv.id }, data: { irnStatus: 'CANCELLED' } });
    }
    // Outside the window the IRN stands; the credit note (with its own IRN) reverses it.
  }

  async creditNote(creditNoteId: string) {
    const cn = await this.prisma.creditNote.findUniqueOrThrow({ where: { id: creditNoteId } });
    if (cn.irnStatus !== 'PENDING') return;
    const [d, o] = await Promise.all([
      this.prisma.distributor.findUniqueOrThrow({ where: { id: cn.distributorId } }),
      this.prisma.outlet.findUniqueOrThrow({ where: { id: cn.outletId } }),
    ]);
    if (!o.gstin) {
      await this.prisma.creditNote.update({ where: { id: cn.id }, data: { irnStatus: 'NOT_APPLICABLE' } });
      return;
    }
    const tax = Number(cn.taxPaise);
    const inter = d.stateCode !== o.stateCode;
    const half = Math.round(tax / 2);
    try {
      const r = await this.gst.generateIrn({
        docType: 'CRN',
        docNo: cn.creditNoteNo,
        docDate: cn.issuedAt,
        supplierGstin: d.gstin,
        buyerGstin: o.gstin,
        placeOfSupply: o.stateCode,
        totalPaise: Number(cn.totalPaise),
        items: [{ hsnCode: '9999', qty: 1, freeQty: 0, taxablePaise: Number(cn.taxablePaise), gstRateBp: 0, cgstPaise: inter ? 0 : half, sgstPaise: inter ? 0 : tax - half, igstPaise: inter ? tax : 0, totalPaise: Number(cn.totalPaise) }],
      });
      await this.prisma.creditNote.update({ where: { id: cn.id }, data: { irn: r.irn, ackNo: r.ackNo, irnStatus: 'GENERATED' } });
    } catch (e) {
      if (!(e instanceof GstValidationError)) throw e;
      await this.prisma.creditNote.update({ where: { id: cn.id }, data: { irnStatus: 'FAILED' } });
      await this.fail(cn.tenantId, 'CreditNote', cn.id, cn.distributorId, `IRN rejected for ${cn.creditNoteNo}`, e);
      throw new PermanentJobError(e.message);
    }
  }
}
