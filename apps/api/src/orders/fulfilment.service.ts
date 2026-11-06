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
import { JobsService } from '../jobs/jobs.service';
import { CollectionsService } from '../field/collections.service';

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
    private readonly jobs: JobsService,
    private readonly collections: CollectionsService,
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
    const usages: { schemeId: string; productId: string; kind: string; costPaise: bigint; qty: number }[] = [];

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

      const portion = (amount: bigint | number) =>
        cumulative(BigInt(amount), line.qtyInvoiced + paidTaken, line.qty) - cumulative(BigInt(amount), line.qtyInvoiced, line.qty);
      const thisTaxable = portion(line.taxablePaise);
      const thisMargin = portion(line.marginDiscPaise);
      const thisScheme = portion(line.schemeDiscPaise);
      // Scheme cost evidence for budgets and claims: discounts in proportion to invoiced units, free goods at base price.
      for (const a of line.appliedSchemes as unknown as { schemeId: string; type: string; discountPaise: number }[]) {
        if (a.discountPaise > 0 && paidTaken > 0) usages.push({ schemeId: a.schemeId, productId: line.productId, kind: 'DISCOUNT', costPaise: BigInt(portion(a.discountPaise)), qty: paidTaken });
        if (a.type === 'FREE_GOODS' && freeTaken > 0) usages.push({ schemeId: a.schemeId, productId: line.productId, kind: 'FREE_GOODS', costPaise: line.unitPricePaise * BigInt(freeTaken), qty: freeTaken });
      }

      const perBatch = new Map<string, { batch: BatchRow; paid: number; free: number }>();
      for (const p of paid) perBatch.set(p.batch.id, { batch: p.batch, paid: p.qty, free: 0 });
      for (const f of free) {
        const e = perBatch.get(f.batch.id) ?? { batch: f.batch, paid: 0, free: 0 };
        e.free += f.qty;
        perBatch.set(f.batch.id, e);
      }
      const rows = [...perBatch.values()];
      const parts = allocate(thisTaxable, rows.map((r) => r.paid));
      const marginParts = allocate(thisMargin, rows.map((r) => r.paid));
      const schemeParts = allocate(thisScheme, rows.map((r) => r.paid));
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
          marginDiscPaise: BigInt(marginParts[k]),
          schemeDiscPaise: BigInt(schemeParts[k]),
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

    if (usages.length) {
      await tx.schemeUsage.createMany({
        data: usages.map((u) => ({ ...u, tenantId: order.tenantId, distributorId: distributor.id, outletId: outlet.id, invoiceId, docType: 'INVOICE', docId: invoiceId, at: now })),
      });
    }
    await this.jobs.enqueue(tx, 'gst.einvoice', { invoiceId }, { key: `gst.einvoice:${invoiceId}`, tenantId: order.tenantId });
    await this.jobs.enqueue(tx, 'integrations.erp', { event: 'INVOICE_ISSUED', invoiceId }, { key: `erp:INVOICE_ISSUED:${invoiceId}`, tenantId: order.tenantId });
    // Key accounts (MT / e-com / q-com) ship through a 3PL; GT goes on the distributor's own vehicles.
    if (['MT', 'ECOM', 'QCOM'].includes(order.channelCode) && !opts.autoDeliver) {
      await this.jobs.enqueue(tx, 'integrations.shipment', { invoiceId }, { key: `shipment:${invoiceId}`, tenantId: order.tenantId });
    }

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
      await this.creditCashback(tx, actor, order.id);
    }
    await this.audit.record(tx, actor, 'INVOICE_ISSUED', 'Invoice', invoiceId, {
      after: { invoiceNo, orderNo: order.orderNo, total: invoice.totalPaise, lines: invLines.length, complete },
    });
    return invoice;
  }

  /**
   * Cashback earned on an order is credited when it closes, pro rata to what was actually invoiced
   * (a short-closed order earns less). Financial credit, no GST adjustment; recorded as scheme cost.
   */
  async creditCashback(tx: Tx, actor: AuthUser, orderId: string) {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true, invoices: { where: { status: 'ISSUED' } } } });
    if (order.cashbackPaise <= 0n || order.invoices.length === 0) return;
    if (await tx.journal.findFirst({ where: { docType: 'CASHBACK', docId: order.id } })) return;
    const invoiced = order.invoices.reduce((a, i) => a + i.taxablePaise, 0n);
    const amount = order.taxablePaise > 0n ? (order.cashbackPaise * invoiced) / order.taxablePaise : 0n;
    if (amount <= 0n) return;
    const outlet = await tx.outlet.findUniqueOrThrow({ where: { id: order.outletId } });
    await this.ledger.post(tx, {
      tenantId: order.tenantId, bookOwner: order.distributorId, docType: 'CASHBACK', docId: order.id, postedById: actor.userId,
      narration: `Cashback on ${order.orderNo} credited to ${outlet.name}`,
      lines: [{ account: Accounts.cashbackExpense, debit: amount }, { account: Accounts.receivable(outlet.id, outlet.name), credit: amount }],
    });
    const scheme = order.lines.flatMap((l) => l.appliedSchemes as unknown as { schemeId: string; type: string }[]).find((a) => a.type === 'CASHBACK');
    if (scheme) {
      await tx.schemeUsage.create({
        data: { tenantId: order.tenantId, schemeId: scheme.schemeId, distributorId: order.distributorId, outletId: outlet.id, invoiceId: order.invoices[0].id, kind: 'CASHBACK', costPaise: amount, docType: 'CASHBACK', docId: order.id },
      });
    }
    await this.audit.record(tx, actor, 'CASHBACK_CREDITED', 'Order', order.id, { after: { amountPaise: amount } });
  }

  async deliver(tx: Tx, actor: AuthUser, deliveryId: string, podNote?: string, cod?: { mode: 'CASH' | 'UPI'; amountPaise: number; reference?: string }) {
    const d = await tx.delivery.findFirst({
      where: { id: deliveryId, tenantId: actor.tenantId },
      include: { invoice: { include: { order: true } } },
    });
    if (!d) throw notFound('Delivery');
    await this.scope.assertDistributor(tx, actor, d.invoice.distributorId);
    if (d.status !== 'DISPATCHED') throw new DomainError('NOT_DELIVERABLE', `Delivery is ${d.status}`, 409);
    if (d.invoice.order.paymentMode === 'COD' && !cod) throw new DomainError('COD_REQUIRED', 'Cash-on-delivery order: record what was collected at the door');
    if (cod) {
      // Collected by whoever delivered; idempotent per delivery.
      await this.collections.collect(tx, actor, { idempotencyKey: `cod:${d.id}`, capturedAt: new Date().toISOString(), payload: { outletId: d.invoice.outletId, distributorId: d.invoice.distributorId, ...cod } });
    }
    await tx.delivery.update({
      where: { id: d.id },
      data: { status: 'DELIVERED', deliveredAt: new Date(), deliveredById: actor.userId, podNote },
    });
    const order = d.invoice.order;
    if (order.status === 'FULFILLED') {
      const pending = await tx.delivery.count({ where: { invoice: { orderId: order.id }, status: 'DISPATCHED' } });
      if (pending === 0) {
        await this.state.transition(tx, order.id, 'FULFILLED', 'CLOSED', actor.userId, 'All deliveries completed');
        await this.creditCashback(tx, actor, order.id);
      }
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
    // Scheme cost for a cancelled invoice is reversed, so claims can't count it.
    const used = await tx.schemeUsage.groupBy({ by: ['schemeId', 'productId', 'kind'], where: { invoiceId: inv.id }, _sum: { costPaise: true, qty: true } });
    const reversals = used.filter((u) => (u._sum.costPaise ?? 0n) !== 0n);
    if (reversals.length) {
      await tx.schemeUsage.createMany({
        data: reversals.map((u) => ({
          tenantId: inv.tenantId, schemeId: u.schemeId, distributorId: inv.distributorId, outletId: inv.outletId, invoiceId: inv.id, productId: u.productId,
          kind: u.kind, costPaise: -(u._sum.costPaise ?? 0n), qty: -(u._sum.qty ?? 0), docType: 'CREDIT_NOTE', docId: cnId,
        })),
      });
    }
    await this.jobs.enqueue(tx, 'gst.cancel', { invoiceId: inv.id, reason }, { key: `gst.cancel:${inv.id}`, tenantId: inv.tenantId });
    await this.jobs.enqueue(tx, 'gst.creditnote', { creditNoteId: cnId }, { key: `gst.creditnote:${cnId}`, tenantId: inv.tenantId });
    await this.audit.record(tx, actor, 'INVOICE_CANCELLED', 'Invoice', inv.id, {
      before: { status: 'ISSUED' },
      after: { status: 'CANCELLED', creditNoteNo },
      meta: { reason },
    });
  }
}
