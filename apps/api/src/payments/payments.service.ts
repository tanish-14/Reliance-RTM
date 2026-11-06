import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Payment } from '@prisma/client';
import { PrismaService, type Tx } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { DomainError, isUniqueViolation, notFound } from '../common/errors';
import { toJson } from '../common/json';
import { Accounts, LedgerService } from '../core/ledger.service';
import { SequenceService } from '../core/sequence.service';
import { AuditService } from '../core/audit.service';
import { ReviewService } from '../core/review.service';
import { ScopeService } from '../core/scope.service';
import { JobsService } from '../jobs/jobs.service';
import { OrderStateService } from '../orders/order-state.service';
import { CreditService } from '../orders/credit.service';
import { MockGateway, PAYMENT_GATEWAY, type GatewayEventNorm, type PaymentGateway } from '../integrations/payment-gateway';

const INTENT_TTL_MS = Number(process.env.PAYMENT_INTENT_TTL_MS ?? 15 * 60_000);

/** Actor used for audit rows written by webhooks and jobs. */
export const systemActor = (tenantId: string, who = 'system') => ({ userId: who, tenantId, role: 'ADMIN' as const, name: who, hierarchyPath: '/', distributorId: null, outletId: null });

/**
 * Money in. Online payments: intent -> gateway order -> (browser checkout) -> signed webhook
 * is the only thing that marks money received. Every receipt and reversal is a journal.
 */
@Injectable()
export class PaymentsService implements OnModuleInit {
  private readonly log = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly seq: SequenceService,
    private readonly audit: AuditService,
    private readonly review: ReviewService,
    private readonly scope: ScopeService,
    private readonly jobs: JobsService,
    private readonly state: OrderStateService,
    private readonly credit: CreditService,
    @Inject(PAYMENT_GATEWAY) readonly gateway: PaymentGateway,
  ) {}

  onModuleInit() {
    this.jobs.register('payments.expire-intents', () => this.expireIntents());
    this.jobs.register('payments.verify-upi', () => this.verifyPendingUpi());
    this.jobs.every('payments.expire-intents', 60_000);
    this.jobs.every('payments.verify-upi', 5 * 60_000);
  }

  // ---------------------------------------------------------------- online: intents + webhooks

  async createIntent(user: AuthUser, i: { outletId: string; amountPaise: number; purpose: 'ORDER' | 'OUTSTANDING'; orderId?: string; distributorId?: string }) {
    return this.prisma.tx(async (tx) => {
      await this.scope.assertOutlet(tx, user, i.outletId);
      let distributorId = i.distributorId;
      let amount = i.amountPaise;
      if (i.orderId) {
        const order = await tx.order.findFirst({ where: { id: i.orderId, tenantId: user.tenantId, outletId: i.outletId } });
        if (!order) throw notFound('Order');
        if (!order.flags.includes('AWAITING_PAYMENT')) throw new DomainError('NOT_PREPAID', 'This order is not waiting for an online payment', 409);
        const paid = await tx.paymentIntent.findFirst({ where: { orderId: order.id, status: 'PAID' } });
        if (paid) throw new DomainError('ALREADY_PAID', 'This order is already paid', 409);
        distributorId = order.distributorId;
        amount = Number(order.totalPaise);
      }
      if (!distributorId) {
        const svc = await tx.outletService.findFirst({ where: { outletId: i.outletId, isPrimary: true } });
        if (!svc) throw new DomainError('NO_DISTRIBUTOR', 'Outlet has no primary distributor');
        distributorId = svc.distributorId;
      }
      if (amount <= 0) throw new DomainError('BAD_AMOUNT', 'Amount must be positive');
      const intentNo = await this.seq.opNo(tx, user.tenantId, 'RC');
      const g = await this.gateway.createOrder({ amountPaise: amount, receipt: intentNo, notes: { outletId: i.outletId, purpose: i.purpose, orderId: i.orderId ?? '' } });
      const intent = await tx.paymentIntent.create({
        data: {
          tenantId: user.tenantId, intentNo: `PI-${intentNo}`, outletId: i.outletId, distributorId, orderId: i.orderId, purpose: i.purpose, amountPaise: BigInt(amount),
          gateway: this.gateway.name, gatewayOrderId: g.gatewayOrderId, paymentLinkUrl: g.paymentLinkUrl, expiresAt: new Date(Date.now() + INTENT_TTL_MS), createdById: user.userId,
        },
      });
      await this.audit.record(tx, user, 'PAYMENT_INTENT_CREATED', 'PaymentIntent', intent.id, { after: { intentNo: intent.intentNo, amountPaise: amount, gatewayOrderId: g.gatewayOrderId } });
      return { ...intent, checkout: this.gateway.checkout() };
    });
  }

  async intentStatus(user: AuthUser, id: string) {
    const intent = await this.prisma.paymentIntent.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!intent) throw notFound('Payment');
    await this.scope.assertOutlet(this.prisma, user, intent.outletId);
    return { ...intent, checkout: this.gateway.checkout() };
  }

  /**
   * Webhook entry point. Order matters: verify signature over the raw bytes, then claim the event
   * id (unique) so redeliveries are no-ops, then apply in one transaction.
   */
  async webhook(rawBody: Buffer, signature: string | undefined): Promise<{ status: string }> {
    const valid = this.gateway.verifySignature(rawBody, signature);
    let body: any;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new DomainError('BAD_WEBHOOK', 'Malformed webhook body', 400);
    }
    const ev = this.gateway.parse(body);
    if (!valid) {
      await this.prisma.gatewayEvent.create({ data: { gateway: this.gateway.name, eventId: `rejected:${randomUUID()}`, type: String(body?.event), signatureValid: false, payload: body, status: 'REJECTED' } });
      throw new DomainError('BAD_SIGNATURE', 'Webhook signature invalid', 401);
    }
    try {
      await this.prisma.gatewayEvent.create({ data: { gateway: this.gateway.name, eventId: ev.id, type: ev.type, signatureValid: true, payload: body, status: 'PROCESSING' } });
    } catch (e) {
      if (isUniqueViolation(e)) return { status: 'duplicate' };
      throw e;
    }
    try {
      const status = await this.prisma.tx((tx) => this.apply(tx, ev));
      await this.prisma.gatewayEvent.update({ where: { eventId: ev.id }, data: { status } });
      return { status };
    } catch (e) {
      // Let the gateway redeliver: drop the claim so the retry is processed.
      await this.prisma.gatewayEvent.update({ where: { eventId: ev.id }, data: { eventId: `failed:${ev.id}:${Date.now()}`, status: 'FAILED', error: String((e as Error).message).slice(0, 500) } });
      throw e;
    }
  }

  private async apply(tx: Tx, ev: GatewayEventNorm): Promise<string> {
    switch (ev.type) {
      case 'payment.captured':
        return this.onCaptured(tx, ev);
      case 'payment.failed': {
        const r = await tx.paymentIntent.updateMany({ where: { gatewayOrderId: ev.gatewayOrderId, status: 'CREATED' }, data: { attempts: { increment: 1 }, lastFailure: ev.reason } });
        return r.count ? 'PROCESSED' : 'IGNORED';
      }
      case 'refund.processed':
      case 'refund.failed':
        return this.onRefund(tx, ev);
      case 'settlement.processed':
        return this.onSettlement(tx, ev);
      default:
        return 'IGNORED';
    }
  }

  private async onCaptured(tx: Tx, ev: Extract<GatewayEventNorm, { type: 'payment.captured' }>) {
    const intent = await tx.paymentIntent.findUnique({ where: { gatewayOrderId: ev.gatewayOrderId } });
    if (!intent) return 'IGNORED';
    if (await tx.payment.findUnique({ where: { gatewayPaymentId: ev.gatewayPaymentId } })) return 'IGNORED';
    const actor = systemActor(intent.tenantId, `gateway:${this.gateway.name}`);
    const outlet = await tx.outlet.findUniqueOrThrow({ where: { id: intent.outletId } });
    const amount = BigInt(ev.amountPaise);
    const paymentId = randomUUID();
    const receiptNo = await this.seq.opNo(tx, intent.tenantId, 'RC');
    const journal = await this.ledger.post(tx, {
      tenantId: intent.tenantId, bookOwner: intent.distributorId, docType: 'PAYMENT', docId: paymentId, postedById: actor.userId,
      narration: `Online ${ev.method} ${receiptNo} from ${outlet.name} (${ev.gatewayPaymentId})`,
      lines: [{ account: Accounts.gatewayClearing, debit: amount }, { account: Accounts.receivable(outlet.id, outlet.name), credit: amount }],
    });
    await tx.payment.create({
      data: {
        id: paymentId, tenantId: intent.tenantId, receiptNo, distributorId: intent.distributorId, outletId: outlet.id, mode: 'ONLINE', amountPaise: amount, status: 'RECEIVED',
        reference: ev.method, collectedById: actor.userId, capturedAt: new Date(), journalId: journal.id, gateway: this.gateway.name, gatewayPaymentId: ev.gatewayPaymentId, intentId: intent.id,
      },
    });
    const late = intent.status !== 'CREATED';
    await tx.paymentIntent.update({ where: { id: intent.id }, data: { status: 'PAID', paidAt: new Date(), paymentId } });
    if (late) {
      // Money arrived after we gave up waiting (expired / order cancelled): keep it, flag for refund or re-use.
      await this.review.raise(tx, intent.tenantId, {
        kind: 'LATE_PAYMENT', refType: 'Payment', refId: paymentId, distributorId: intent.distributorId,
        summary: `${receiptNo}: ₹${Number(amount) / 100} captured after intent ${intent.intentNo} was ${intent.status}`, details: { intentStatus: intent.status },
      });
    } else if (intent.orderId) {
      await this.confirmPrepaidOrder(tx, intent.orderId, actor.userId, receiptNo);
    }
    await this.audit.record(tx, actor, 'PAYMENT_CAPTURED', 'Payment', paymentId, { after: { receiptNo, amountPaise: amount, gatewayPaymentId: ev.gatewayPaymentId, late } });
    return 'PROCESSED';
  }

  private async confirmPrepaidOrder(tx: Tx, orderId: string, actorId: string, receiptNo: string) {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (order.status !== 'ON_HOLD' || !order.flags.includes('AWAITING_PAYMENT')) return;
    await tx.order.update({ where: { id: order.id }, data: { flags: order.flags.filter((f) => f !== 'AWAITING_PAYMENT').concat('PREPAID') } });
    await this.state.transition(tx, order.id, 'ON_HOLD', 'CONFIRMED', actorId, `Paid online (${receiptNo})`);
    await this.review.resolveFor(tx, order.tenantId, 'Order', order.id, actorId, 'Paid online');
  }

  private async onRefund(tx: Tx, ev: Extract<GatewayEventNorm, { type: 'refund.processed' | 'refund.failed' }>) {
    const refund = await tx.refund.findUnique({ where: { gatewayRefundId: ev.gatewayRefundId } });
    if (!refund || refund.status !== 'PENDING') return 'IGNORED';
    if (ev.type === 'refund.failed') {
      await tx.refund.update({ where: { id: refund.id }, data: { status: 'FAILED' } });
      return 'PROCESSED';
    }
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: refund.paymentId } });
    const outlet = await tx.outlet.findUniqueOrThrow({ where: { id: payment.outletId } });
    const journal = await this.ledger.post(tx, {
      tenantId: refund.tenantId, bookOwner: payment.distributorId, docType: 'REFUND', docId: refund.id, postedById: `gateway:${this.gateway.name}`,
      narration: `Refund ${refund.refundNo} of ${payment.receiptNo} to ${outlet.name}`,
      lines: [{ account: Accounts.receivable(outlet.id, outlet.name), debit: refund.amountPaise }, { account: Accounts.gatewayClearing, credit: refund.amountPaise }],
    });
    await tx.refund.update({ where: { id: refund.id }, data: { status: 'PROCESSED', journalId: journal.id } });
    await this.audit.record(tx, systemActor(refund.tenantId, 'gateway'), 'REFUND_PROCESSED', 'Refund', refund.id, { after: { amountPaise: refund.amountPaise } });
    return 'PROCESSED';
  }

  /** Gateway settles captured payments to each distributor's bank, net of fees. */
  private async onSettlement(tx: Tx, ev: Extract<GatewayEventNorm, { type: 'settlement.processed' }>) {
    const payments = await tx.payment.findMany({ where: { gatewayPaymentId: { in: ev.gatewayPaymentIds }, verifiedAt: null } });
    if (payments.length === 0) return 'IGNORED';
    const gross = payments.reduce((a, p) => a + p.amountPaise, 0n);
    const fees = BigInt(ev.feesPaise);
    const byBook = new Map<string, Payment[]>();
    payments.forEach((p) => byBook.set(p.distributorId, [...(byBook.get(p.distributorId) ?? []), p]));
    for (const [book, list] of byBook) {
      const g = list.reduce((a, p) => a + p.amountPaise, 0n);
      const f = (fees * g) / gross;
      await this.ledger.post(tx, {
        tenantId: list[0].tenantId, bookOwner: book, docType: 'SETTLEMENT', docId: ev.settlementId, postedById: 'gateway',
        narration: `Gateway settlement ${ev.settlementId}: ${list.length} payments`,
        lines: [{ account: Accounts.bank, debit: g - f }, { account: Accounts.gatewayFees, debit: f }, { account: Accounts.gatewayClearing, credit: g }],
      });
    }
    await tx.payment.updateMany({ where: { id: { in: payments.map((p) => p.id) } }, data: { status: 'VERIFIED', verifiedAt: new Date() } });
    return 'PROCESSED';
  }

  /** Mock gateway only: finish a checkout the way the real gateway would — by webhook. */
  async mockComplete(user: AuthUser, intentId: string, outcome: 'success' | 'failure') {
    if (!(this.gateway instanceof MockGateway)) throw new DomainError('NOT_MOCK', 'Mock checkout is disabled with a real gateway', 404);
    const intent = await this.intentStatus(user, intentId);
    const paymentId = `pay_mock_${randomUUID().slice(0, 14).replace(/-/g, '')}`;
    const entity = { id: paymentId, order_id: intent.gatewayOrderId, amount: Number(intent.amountPaise), method: 'upi', error_code: outcome === 'failure' ? 'BAD_REQUEST_ERROR' : undefined, error_description: outcome === 'failure' ? 'Payment declined by bank (mock)' : undefined };
    const delivery = this.gateway.sign(MockGateway.event(outcome === 'success' ? 'payment.captured' : 'payment.failed', { payment: { entity } }));
    await this.webhook(delivery.raw, delivery.signature);
    return this.intentStatus(user, intentId);
  }

  /** Mock gateway only: settle all unsettled online payments (normally T+1 by the gateway). */
  async mockSettle() {
    if (!(this.gateway instanceof MockGateway)) throw new DomainError('NOT_MOCK', 'Settlements come from the real gateway', 404);
    const pending = await this.prisma.payment.findMany({ where: { mode: 'ONLINE', verifiedAt: null, gatewayPaymentId: { not: null } } });
    if (!pending.length) return { settled: 0 };
    const gross = pending.reduce((a, p) => a + Number(p.amountPaise), 0);
    const fees = Math.round(gross * 0.02);
    const d = this.gateway.sign(MockGateway.event('settlement.processed', { settlement: { entity: { id: `setl_mock_${Date.now()}`, amount: gross - fees, fees, payment_ids: pending.map((p) => p.gatewayPaymentId) } } }));
    await this.webhook(d.raw, d.signature);
    return { settled: pending.length, grossPaise: gross, feesPaise: fees };
  }

  async expireIntents() {
    const stale = await this.prisma.paymentIntent.findMany({ where: { status: 'CREATED', expiresAt: { lt: new Date() } } });
    for (const intent of stale) {
      await this.prisma.tx(async (tx) => {
        const r = await tx.paymentIntent.updateMany({ where: { id: intent.id, status: 'CREATED' }, data: { status: 'EXPIRED' } });
        if (!r.count || !intent.orderId) return;
        const order = await tx.order.findUniqueOrThrow({ where: { id: intent.orderId } });
        if (order.status === 'ON_HOLD' && order.flags.includes('AWAITING_PAYMENT')) {
          await this.state.transition(tx, order.id, 'ON_HOLD', 'CANCELLED', 'system:payments', 'Online payment not completed in time');
          await this.review.resolveFor(tx, order.tenantId, 'Order', order.id, 'system', 'Payment timed out');
          await this.audit.record(tx, systemActor(order.tenantId), 'ORDER_CANCELLED', 'Order', order.id, { meta: { reason: 'payment timeout', intentNo: intent.intentNo } });
        }
      });
    }
    return stale.length;
  }

  async refund(user: AuthUser, paymentId: string, amountPaise: number, reason: string) {
    return this.prisma.tx(async (tx) => {
      const p = await tx.payment.findFirst({ where: { id: paymentId, tenantId: user.tenantId } });
      if (!p) throw notFound('Payment');
      await this.scope.assertDistributor(tx, user, p.distributorId);
      if (p.mode !== 'ONLINE' || !p.gatewayPaymentId) throw new DomainError('NOT_REFUNDABLE', 'Only online payments are refunded through the gateway');
      const refunded = await tx.refund.aggregate({ where: { paymentId, status: { in: ['PENDING', 'PROCESSED'] } }, _sum: { amountPaise: true } });
      if (BigInt(amountPaise) + (refunded._sum.amountPaise ?? 0n) > p.amountPaise) throw new DomainError('OVER_REFUND', 'Refund exceeds the captured amount');
      const g = await this.gateway.refund({ gatewayPaymentId: p.gatewayPaymentId, amountPaise, notes: { reason } });
      const refundNo = `RF-${await this.seq.opNo(tx, user.tenantId, 'RC')}`;
      const refund = await tx.refund.create({ data: { tenantId: user.tenantId, refundNo, paymentId, amountPaise: BigInt(amountPaise), status: 'PENDING', gatewayRefundId: g.gatewayRefundId, reason, createdById: user.userId } });
      await this.audit.record(tx, user, 'REFUND_REQUESTED', 'Refund', refund.id, { after: { refundNo, amountPaise, reason } });
      return refund;
    }).then(async (refund) => {
      // The mock gateway confirms immediately (by webhook, like the real one does later).
      if (this.gateway instanceof MockGateway) {
        const d = this.gateway.sign(MockGateway.event('refund.processed', { refund: { entity: { id: refund.gatewayRefundId, payment_id: (await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).gatewayPaymentId, amount: Number(refund.amountPaise) } } }));
        await this.webhook(d.raw, d.signature);
      }
      return this.prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    });
  }

  // ---------------------------------------------------------------- field UPI verification

  async verifyPendingUpi() {
    const pending = await this.prisma.payment.findMany({ where: { mode: 'UPI', status: 'PENDING_VERIFICATION' }, take: 100 });
    for (const p of pending) {
      const r = await this.gateway.verifyUpi(p.reference ?? '', Number(p.amountPaise));
      if (r === 'PENDING') continue;
      await this.prisma.tx(async (tx) => {
        const fresh = await tx.payment.findUniqueOrThrow({ where: { id: p.id } });
        if (fresh.status !== 'PENDING_VERIFICATION') return;
        const outlet = await tx.outlet.findUniqueOrThrow({ where: { id: p.outletId } });
        if (r === 'SUCCESS') {
          await this.ledger.post(tx, {
            tenantId: p.tenantId, bookOwner: p.distributorId, docType: 'UPI_VERIFIED', docId: p.id, postedById: 'system:upi',
            narration: `UPI ${p.reference} confirmed (${p.receiptNo})`,
            lines: [{ account: Accounts.bank, debit: p.amountPaise }, { account: Accounts.upiClearing, credit: p.amountPaise }],
          });
          await tx.payment.update({ where: { id: p.id }, data: { status: 'VERIFIED', verifiedAt: new Date() } });
        } else {
          await this.ledger.reverse(tx, p.journalId, { postedById: 'system:upi', docType: 'PAYMENT_FAILED', docId: p.id, narration: `UPI ${p.reference} not received — ${p.receiptNo} reversed` });
          await tx.payment.update({ where: { id: p.id }, data: { status: 'FAILED', failureReason: 'UTR not found at bank' } });
          await this.review.raise(tx, p.tenantId, { kind: 'UPI_FAILED', refType: 'Payment', refId: p.id, distributorId: p.distributorId, summary: `UPI ${p.reference} (${p.receiptNo}, ${outlet.name}) not received — receivable restored`, details: { amountPaise: p.amountPaise } });
        }
        await this.audit.record(tx, systemActor(p.tenantId, 'system:upi'), r === 'SUCCESS' ? 'UPI_VERIFIED' : 'UPI_FAILED', 'Payment', p.id, {});
      });
    }
  }

  // ---------------------------------------------------------------- cheques & bank transfers

  private async loadForDistributor(tx: Tx, user: AuthUser, paymentId: string) {
    const p = await tx.payment.findFirst({ where: { id: paymentId, tenantId: user.tenantId } });
    if (!p) throw notFound('Payment');
    await this.scope.assertDistributor(tx, user, p.distributorId);
    return p;
  }

  async chequeDeposit(user: AuthUser, paymentId: string) {
    return this.prisma.tx(async (tx) => {
      const p = await this.loadForDistributor(tx, user, paymentId);
      if (p.mode !== 'CHEQUE' || p.status !== 'RECEIVED') throw new DomainError('BAD_STATE', `Cheque is ${p.status}`, 409);
      await tx.payment.update({ where: { id: p.id }, data: { status: 'DEPOSITED', depositedAt: new Date() } });
      await this.audit.record(tx, user, 'CHEQUE_DEPOSITED', 'Payment', p.id, { meta: { chequeNo: p.chequeNo } });
    });
  }

  /** Clearing posts Bank ← cheques-in-hand. Usually triggered by the bank statement match. */
  async chequeClear(tx: Tx, actor: { userId: string; tenantId: string; role: AuthUser['role'] }, p: Payment) {
    if (p.mode !== 'CHEQUE' || !['RECEIVED', 'DEPOSITED'].includes(p.status)) throw new DomainError('BAD_STATE', `Cheque is ${p.status}`, 409);
    await this.ledger.post(tx, {
      tenantId: p.tenantId, bookOwner: p.distributorId, docType: 'CHEQUE_CLEARED', docId: p.id, postedById: actor.userId,
      narration: `Cheque ${p.chequeNo} (${p.chequeBank}) cleared — ${p.receiptNo}`,
      lines: [{ account: Accounts.bank, debit: p.amountPaise }, { account: Accounts.chequesInHand, credit: p.amountPaise }],
    });
    await tx.payment.update({ where: { id: p.id }, data: { status: 'CLEARED', clearedAt: new Date() } });
    await this.audit.record(tx, actor, 'CHEQUE_CLEARED', 'Payment', p.id, { meta: { chequeNo: p.chequeNo } });
  }

  /** Bounce = explicit reversal (receivable restored), bounce counted; 2 bounces auto-block credit. */
  async chequeBounce(user: AuthUser, paymentId: string, reason: string) {
    return this.prisma.tx(async (tx) => {
      const p = await this.loadForDistributor(tx, user, paymentId);
      if (p.mode !== 'CHEQUE' || !['RECEIVED', 'DEPOSITED'].includes(p.status)) throw new DomainError('BAD_STATE', `Cheque is ${p.status}`, 409);
      await this.ledger.reverse(tx, p.journalId, { postedById: user.userId, docType: 'CHEQUE_BOUNCED', docId: p.id, narration: `Cheque ${p.chequeNo} bounced: ${reason}` });
      await tx.payment.update({ where: { id: p.id }, data: { status: 'BOUNCED', bouncedAt: new Date(), failureReason: reason } });
      const acc = await tx.creditAccount.update({
        where: { outletId_distributorId: { outletId: p.outletId, distributorId: p.distributorId } },
        data: { bounceCount: { increment: 1 } },
      }).catch(() => null);
      const outlet = await tx.outlet.findUniqueOrThrow({ where: { id: p.outletId } });
      await this.review.raise(tx, p.tenantId, { kind: 'CHEQUE_BOUNCED', refType: 'Payment', refId: p.id, distributorId: p.distributorId, summary: `Cheque ${p.chequeNo} from ${outlet.name} bounced (${reason}) — ₹${Number(p.amountPaise) / 100} back on account`, details: { bounceCount: acc?.bounceCount } });
      await this.audit.record(tx, user, 'CHEQUE_BOUNCED', 'Payment', p.id, { meta: { reason, bounceCount: acc?.bounceCount } });
      if (acc) await this.credit.review(tx, acc.id);
    });
  }

  /** NEFT/RTGS/IMPS reported by the retailer: posted to bank clearing until seen on the statement. */
  async recordBankTransfer(user: AuthUser, i: { outletId: string; amountPaise: number; utr: string; distributorId?: string }) {
    return this.prisma.tx(async (tx) => {
      await this.scope.assertOutlet(tx, user, i.outletId);
      const svc = i.distributorId ? { distributorId: i.distributorId } : await tx.outletService.findFirst({ where: { outletId: i.outletId, isPrimary: true } });
      if (!svc) throw new DomainError('NO_DISTRIBUTOR', 'Outlet has no distributor');
      if (await tx.payment.findFirst({ where: { tenantId: user.tenantId, mode: 'BANK_TRANSFER', reference: i.utr } })) throw new DomainError('DUPLICATE_UTR', `UTR ${i.utr} already recorded`, 409);
      const outlet = await tx.outlet.findUniqueOrThrow({ where: { id: i.outletId } });
      const id = randomUUID();
      const receiptNo = await this.seq.opNo(tx, user.tenantId, 'RC');
      const amount = BigInt(i.amountPaise);
      const journal = await this.ledger.post(tx, {
        tenantId: user.tenantId, bookOwner: svc.distributorId, docType: 'PAYMENT', docId: id, postedById: user.userId,
        narration: `Bank transfer ${i.utr} from ${outlet.name} (${receiptNo})`,
        lines: [{ account: Accounts.bankClearing, debit: amount }, { account: Accounts.receivable(outlet.id, outlet.name), credit: amount }],
      });
      const p = await tx.payment.create({
        data: { id, tenantId: user.tenantId, receiptNo, distributorId: svc.distributorId, outletId: outlet.id, mode: 'BANK_TRANSFER', amountPaise: amount, status: 'PENDING_VERIFICATION', reference: i.utr, collectedById: user.userId, capturedAt: new Date(), journalId: journal.id },
      });
      await this.audit.record(tx, user, 'PAYMENT_RECORDED', 'Payment', id, { after: toJson(p) });
      return p;
    });
  }

  async list(user: AuthUser, q: { mode?: string; status?: string; outletId?: string }) {
    const ids = await this.scope.distributorIds(this.prisma, user);
    const where = {
      tenantId: user.tenantId,
      ...(ids === 'ALL' ? {} : user.role === 'RETAILER' ? { outletId: user.outletId ?? '-' } : { distributorId: { in: ids } }),
      ...(q.mode ? { mode: { in: q.mode.split(',') } } : {}),
      ...(q.status ? { status: { in: q.status.split(',') } } : {}),
      ...(q.outletId ? { outletId: q.outletId } : {}),
    };
    const rows = await this.prisma.payment.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
    const outlets = new Map((await this.prisma.outlet.findMany({ where: { id: { in: rows.map((r) => r.outletId) } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
    const refunds = await this.prisma.refund.findMany({ where: { paymentId: { in: rows.map((r) => r.id) } } });
    return rows.map((r) => ({ ...r, outlet: outlets.get(r.outletId), refunds: refunds.filter((f) => f.paymentId === r.id) }));
  }
}
