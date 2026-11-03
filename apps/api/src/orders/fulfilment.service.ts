import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Invoice, InvoiceLine, Order } from '@prisma/client';
import { allocate, gstFor } from '@rtm/shared';
import type { Tx } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { DomainError, notFound } from '../common/errors';
import { Accounts, LedgerService } from '../core/ledger.service';
import { SequenceService } from '../core/sequence.service';
import { AuditService } from '../core/audit.service';
import { ScopeService } from '../core/scope.service';
import { OrderStateService } from './order-state.service';

interface BatchRow {
  id: string;
  batchCode: string;
  expiryDate: Date;
  qtyOnHand: number;
}

const DAY = 86_400_000;

/** Taxable value of the first `n` of `qty` units, rounded so cumulative invoices sum exactly to the line. */
const cumulative = (lineTaxable: bigint, n: number, qty: number) =>
  qty === 0 ? 0 : Math.round((Number(lineTaxable) * n) / qty);

/** Take up to `want` units from batches in FEFO order, mutating their remaining `left`. */
function take(batches: (BatchRow & { left: number })[], want: number) {
  const out: { batch: BatchRow; qty: number }[] = [];
  for (const b of batches) {
    if (want <= 0) break;
    const q = Math.min(b.left, want);
    if (q > 0) {
      out.push({ batch: b, qty: q });
      b.left -= q;
      want -= q;
    }
  }
  return out;
}

@Injectable()
export class FulfilmentService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly seq: SequenceService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly state: OrderStateService,
  ) {}

  /** Where this order's stock comes from — decided by the RTM model row, not by code paths. */
  private async sourceLocation(tx: Tx, order: Order & { rtmModel: { stockSource: string } }) {
    const where =
      order.rtmModel.stockSource === 'VAN'
        ? { tenantId: order.tenantId, distributorId: order.distributorId, type: 'VAN', userId: order.placedById }
        : { tenantId: order.tenantId, distributorId: order.distributorId, type: 'WAREHOUSE' };
    const loc = await tx.stockLocation.findFirst({ where });
    if (!loc) throw new DomainError('NO_STOCK_LOCATION', `No ${order.rtmModel.stockSource} stock location for this order`);
    return loc;
  }

  /**
   * Allocate FEFO (skipping batches inside the channel's minimum residual shelf life),
   * invoice what can be shipped, post the ledger and secondary sales. Anything short
   * stays open as a backorder.
   */
  async fulfil(
    tx: Tx,
    actor: AuthUser,
    orderId: string,
    opts: { caps?: Record<string, number>; internal?: boolean; autoDeliver?: boolean } = {},
  ): Promise<Invoice> {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const order = await tx.order.findFirst({
      where: { id: orderId, tenantId: actor.tenantId },
      include: { lines: true, rtmModel: true },
    });
    if (!order) throw notFound('Order');
    if (!opts.internal) await this.scope.assertDistributor(tx, actor, order.distributorId);
    if (!['CONFIRMED', 'PARTIALLY_FULFILLED'].includes(order.status)) {
      throw new DomainError('NOT_FULFILLABLE', `Order is ${order.status}`, 409);
    }

    const [distributor, outlet, channel] = await Promise.all([
      tx.distributor.findUniqueOrThrow({ where: { id: order.distributorId } }),
      tx.outlet.findUniqueOrThrow({ where: { id: order.outletId } }),
      tx.channel.findFirstOrThrow({ where: { tenantId: order.tenantId, code: order.channelCode } }),
    ]);
    const products = new Map(
      (await tx.product.findMany({ where: { id: { in: order.lines.map((l) => l.productId) } } })).map((p) => [p.id, p]),
    );
    const location = await this.sourceLocation(tx, order);
    const today = new Date(new Date().toISOString().slice(0, 10));
    const cutoff = new Date(today.getTime() + channel.minResidualShelfDays * DAY);

    const invLines: Omit<InvoiceLine, 'id' | 'invoiceId'>[] = [];
    const lineUpdates: { id: string; paid: number; free: number }[] = [];

    for (const line of order.lines) {
      const paidLeft = line.qty - line.qtyInvoiced;
      const cap = opts.caps?.[line.id];
      const paidWanted = cap === undefined ? paidLeft : Math.min(paidLeft, cap);
      const batches = (
        await tx.$queryRaw<BatchRow[]>`
          SELECT id, "batchCode", "expiryDate", "qtyOnHand" FROM "InventoryBatch"
          WHERE "locationId" = ${location.id} AND "productId" = ${line.productId}
            AND bucket = 'SALEABLE' AND "qtyOnHand" > 0 AND "expiryDate" > ${cutoff}
          ORDER BY "expiryDate" ASC, "batchCode" ASC
          FOR UPDATE`
      ).map((b) => ({ ...b, left: b.qtyOnHand }));

      const paid = take(batches, paidWanted);
      const paidTaken = paid.reduce((a, p) => a + p.qty, 0);
      // Free goods ship in proportion to paid units invoiced so far.
      const entitledFree = line.qty ? Math.floor((line.freeQty * (line.qtyInvoiced + paidTaken)) / line.qty) : 0;
      const free = take(batches, entitledFree - line.freeInvoiced);
      const freeTaken = free.reduce((a, p) => a + p.qty, 0);
      if (paidTaken + freeTaken === 0) continue;

      const thisTaxable =
        cumulative(line.taxablePaise, line.qtyInvoiced + paidTaken, line.qty) -
        cumulative(line.taxablePaise, line.qtyInvoiced, line.qty);

      const perBatch = new Map<string, { batch: BatchRow; paid: number; free: number }>();
      for (const p of paid) perBatch.set(p.batch.id, { batch: p.batch, paid: p.qty, free: 0 });
      for (const f of free) {
        const e = perBatch.get(f.batch.id) ?? { batch: f.batch, paid: 0, free: 0 };
        e.free += f.qty;
        perBatch.set(f.batch.id, e);
      }
      const rows = [...perBatch.values()];
      const parts = allocate(thisTaxable, rows.map((r) => r.paid));
      rows.forEach((r, k) => {
        const g = gstFor(parts[k], line.gstRateBp, order.isInterState);
        invLines.push({
          orderLineId: line.id,
          productId: line.productId,
          batchId: r.batch.id,
          qty: r.paid,
          freeQty: r.free,
          hsnCode: products.get(line.productId)!.hsnCode,
          unitPricePaise: line.unitPricePaise,
          taxablePaise: BigInt(parts[k]),
          gstRateBp: line.gstRateBp,
          cgstPaise: BigInt(g.cgstPaise),
          sgstPaise: BigInt(g.sgstPaise),
          igstPaise: BigInt(g.igstPaise),
          totalPaise: BigInt(parts[k] + g.taxPaise),
        });
      });
      lineUpdates.push({ id: line.id, paid: paidTaken, free: freeTaken });
    }

    if (invLines.length === 0) {
      throw new DomainError('NO_STOCK', 'No saleable stock within shelf-life rules to fulfil this order', 409);
    }

    const tot = (k: 'taxablePaise' | 'cgstPaise' | 'sgstPaise' | 'igstPaise' | 'totalPaise') =>
      invLines.reduce((a, l) => a + l[k], 0n);
    const invoiceId = randomUUID();
    const invoiceNo = await this.seq.invoiceNo(tx, order.tenantId, distributor.code);
    const credit = await tx.creditAccount.findUnique({
      where: { outletId_distributorId: { outletId: outlet.id, distributorId: distributor.id } },
    });

    const journal = await this.ledger.post(tx, {
      tenantId: order.tenantId,
      bookOwner: distributor.id,
      docType: 'INVOICE',
      docId: invoiceId,
      narration: `Invoice ${invoiceNo} — ${outlet.name}`,
      postedById: actor.userId,
      lines: [
        { account: Accounts.receivable(outlet.id, outlet.name), debit: tot('totalPaise') },
        { account: Accounts.sales, credit: tot('taxablePaise') },
        { account: Accounts.cgstOut, credit: tot('cgstPaise') },
        { account: Accounts.sgstOut, credit: tot('sgstPaise') },
        { account: Accounts.igstOut, credit: tot('igstPaise') },
      ],
    });

    const now = new Date();
    const invoice = await tx.invoice.create({
      data: {
        id: invoiceId,
        tenantId: order.tenantId,
        invoiceNo,
        orderId: order.id,
        distributorId: distributor.id,
        outletId: outlet.id,
        supplierGstin: distributor.gstin,
        buyerGstin: outlet.gstin,
        placeOfSupply: outlet.stateCode,
        isInterState: order.isInterState,
        taxablePaise: tot('taxablePaise'),
        cgstPaise: tot('cgstPaise'),
        sgstPaise: tot('sgstPaise'),
        igstPaise: tot('igstPaise'),
        totalPaise: tot('totalPaise'),
        dueDate: new Date(now.getTime() + (credit?.creditDays ?? 0) * DAY),
        journalId: journal.id,
        lines: { create: invLines },
        deliveries: {
          create: {
            tenantId: order.tenantId,
            status: opts.autoDeliver ? 'DELIVERED' : 'DISPATCHED',
            deliveredAt: opts.autoDeliver ? now : null,
            deliveredById: opts.autoDeliver ? actor.userId : null,
          },
        },
      },
    });

    for (const l of invLines) {
      const n = l.qty + l.freeQty;
      await tx.inventoryBatch.update({ where: { id: l.batchId }, data: { qtyOnHand: { decrement: n } } });
      await tx.stockMovement.create({
        data: { tenantId: order.tenantId, batchId: l.batchId, qty: -n, reason: 'SALE', refType: 'Invoice', refId: invoiceId },
      });
    }
    for (const u of lineUpdates) {
      await tx.orderLine.update({
        where: { id: u.id },
        data: { qtyInvoiced: { increment: u.paid }, freeInvoiced: { increment: u.free } },
      });
    }
    await tx.secondarySale.createMany({
      data: invLines.map((l) => ({
        tenantId: order.tenantId,
        date: now,
        kind: 'SALE',
        distributorId: distributor.id,
        outletId: outlet.id,
        channelCode: order.channelCode,
        rtmModelCode: order.rtmModel.code,
        productId: l.productId,
        brandId: products.get(l.productId)!.brandId,
        dsrId: order.source === 'DSR' ? order.placedById : null,
        qty: l.qty,
        freeQty: l.freeQty,
        netPaise: l.taxablePaise,
        docType: 'INVOICE',
        docId: invoiceId,
      })),
    });

    const lines = await tx.orderLine.findMany({ where: { orderId } });
    const complete = lines.every((l) => l.qtyInvoiced >= l.qty && l.freeInvoiced >= l.freeQty);
    await this.state.transition(
      tx,
      order.id,
      order.status,
      complete ? 'FULFILLED' : 'PARTIALLY_FULFILLED',
      actor.userId,
      `Invoice ${invoiceNo}${complete ? '' : ' (partial — remainder backordered)'}`,
    );
    if (!complete && !order.flags.includes('BACKORDER')) {
      await tx.order.update({ where: { id: order.id }, data: { flags: { push: 'BACKORDER' } } });
    }
    if (complete && opts.autoDeliver) {
      await this.state.transition(tx, order.id, 'FULFILLED', 'CLOSED', actor.userId, 'Delivered on the spot');
    }
    await this.audit.record(tx, actor, 'INVOICE_ISSUED', 'Invoice', invoiceId, {
      after: { invoiceNo, orderNo: order.orderNo, total: invoice.totalPaise, lines: invLines.length, complete },
    });
    return invoice;
  }

  async deliver(tx: Tx, actor: AuthUser, deliveryId: string, podNote?: string) {
    const d = await tx.delivery.findFirst({
      where: { id: deliveryId, tenantId: actor.tenantId },
      include: { invoice: { include: { order: true } } },
    });
    if (!d) throw notFound('Delivery');
    await this.scope.assertDistributor(tx, actor, d.invoice.distributorId);
    if (d.status !== 'DISPATCHED') throw new DomainError('NOT_DELIVERABLE', `Delivery is ${d.status}`, 409);
    await tx.delivery.update({
      where: { id: d.id },
      data: { status: 'DELIVERED', deliveredAt: new Date(), deliveredById: actor.userId, podNote },
    });
    const order = d.invoice.order;
    if (order.status === 'FULFILLED') {
      const pending = await tx.delivery.count({ where: { invoice: { orderId: order.id }, status: 'DISPATCHED' } });
      if (pending === 0) await this.state.transition(tx, order.id, 'FULFILLED', 'CLOSED', actor.userId, 'All deliveries completed');
    }
    await this.audit.record(tx, actor, 'DELIVERY_COMPLETED', 'Delivery', d.id, { meta: { invoiceNo: d.invoice.invoiceNo, podNote } });
  }

  /**
   * Cancel an undelivered invoice: credit note + explicit reversing journal + stock back +
   * negative secondary sales. Nothing is edited in place.
   */
  async cancelInvoice(tx: Tx, actor: AuthUser, invoiceId: string, reason: string) {
    const inv = await tx.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { lines: true, deliveries: true, order: { include: { rtmModel: true } } },
    });
    if (inv.status !== 'ISSUED') return;
    if (inv.deliveries.some((d) => d.status === 'DELIVERED')) {
      throw new DomainError('ALREADY_DELIVERED', `Invoice ${inv.invoiceNo} is delivered — take the goods back as a return`, 409);
    }
    const distributor = await tx.distributor.findUniqueOrThrow({ where: { id: inv.distributorId } });
    const cnId = randomUUID();
    const creditNoteNo = await this.seq.creditNoteNo(tx, inv.tenantId, distributor.code);
    const journal = await this.ledger.reverse(tx, inv.journalId, {
      postedById: actor.userId,
      docType: 'CREDIT_NOTE',
      docId: cnId,
      narration: `Credit note ${creditNoteNo} cancelling ${inv.invoiceNo}: ${reason}`,
    });
    await tx.creditNote.create({
      data: {
        id: cnId,
        tenantId: inv.tenantId,
        creditNoteNo,
        reason: 'CANCELLATION',
        distributorId: inv.distributorId,
        outletId: inv.outletId,
        invoiceId: inv.id,
        taxablePaise: inv.taxablePaise,
        taxPaise: inv.cgstPaise + inv.sgstPaise + inv.igstPaise,
        totalPaise: inv.totalPaise,
        journalId: journal.id,
      },
    });
    const products = new Map(
      (await tx.product.findMany({ where: { id: { in: inv.lines.map((l) => l.productId) } } })).map((p) => [p.id, p]),
    );
    for (const l of inv.lines) {
      const n = l.qty + l.freeQty;
      await tx.inventoryBatch.update({ where: { id: l.batchId }, data: { qtyOnHand: { increment: n } } });
      await tx.stockMovement.create({
        data: { tenantId: inv.tenantId, batchId: l.batchId, qty: n, reason: 'CANCELLATION', refType: 'CreditNote', refId: cnId },
      });
      await tx.orderLine.update({
        where: { id: l.orderLineId },
        data: { qtyInvoiced: { decrement: l.qty }, freeInvoiced: { decrement: l.freeQty } },
      });
    }
    await tx.secondarySale.createMany({
      data: inv.lines.map((l) => ({
        tenantId: inv.tenantId,
        date: new Date(),
        kind: 'CANCELLATION',
        distributorId: inv.distributorId,
        outletId: inv.outletId,
        channelCode: inv.order.channelCode,
        rtmModelCode: inv.order.rtmModel.code,
        productId: l.productId,
        brandId: products.get(l.productId)!.brandId,
        dsrId: inv.order.source === 'DSR' ? inv.order.placedById : null,
        qty: -l.qty,
        freeQty: -l.freeQty,
        netPaise: -l.taxablePaise,
        docType: 'CREDIT_NOTE',
        docId: cnId,
      })),
    });
    await tx.invoice.update({ where: { id: inv.id }, data: { status: 'CANCELLED' } });
    await tx.delivery.updateMany({ where: { invoiceId: inv.id }, data: { status: 'CANCELLED' } });
    await this.audit.record(tx, actor, 'INVOICE_CANCELLED', 'Invoice', inv.id, {
      before: { status: 'ISSUED' },
      after: { status: 'CANCELLED', creditNoteNo },
      meta: { reason },
    });
  }
}
