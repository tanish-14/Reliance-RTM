import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Gateway-neutral event, normalised from the provider's webhook body. */
export type GatewayEventNorm =
  | { id: string; type: 'payment.captured'; gatewayOrderId: string; gatewayPaymentId: string; amountPaise: number; method: string }
  | { id: string; type: 'payment.failed'; gatewayOrderId: string; gatewayPaymentId: string; reason: string }
  | { id: string; type: 'refund.processed' | 'refund.failed'; gatewayRefundId: string; gatewayPaymentId: string; amountPaise: number }
  | { id: string; type: 'settlement.processed'; settlementId: string; amountPaise: number; feesPaise: number; gatewayPaymentIds: string[] }
  | { id: string; type: 'ignored'; raw: string };

export interface PaymentGateway {
  readonly name: string;
  readonly isMock: boolean;
  /** Public config for the browser checkout (never the secret). */
  checkout(): { keyId: string | null; mode: 'mock' | 'razorpay' };
  createOrder(i: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<{ gatewayOrderId: string; paymentLinkUrl: string | null }>;
  refund(i: { gatewayPaymentId: string; amountPaise: number; notes: Record<string, string> }): Promise<{ gatewayRefundId: string }>;
  verifySignature(rawBody: Buffer, signature: string | undefined): boolean;
  parse(body: any): GatewayEventNorm;
  /** Field UPI: confirm a UTR against the collecting account. */
  verifyUpi(utr: string, amountPaise: number): Promise<'SUCCESS' | 'FAILED' | 'PENDING'>;
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

function hmacOk(secret: string, rawBody: Buffer, signature: string | undefined) {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Razorpay events -> normalised. Shared by the real gateway and the mock (same wire format). */
export function parseRazorpay(body: any): GatewayEventNorm {
  const id: string = body?.id ?? body?.payload?.payment?.entity?.id ?? `evt_${Date.now()}`;
  const p = body?.payload?.payment?.entity;
  const r = body?.payload?.refund?.entity;
  const s = body?.payload?.settlement?.entity;
  switch (body?.event) {
    case 'payment.captured':
      return { id, type: 'payment.captured', gatewayOrderId: p.order_id, gatewayPaymentId: p.id, amountPaise: p.amount, method: p.method };
    case 'payment.failed':
      return { id, type: 'payment.failed', gatewayOrderId: p.order_id, gatewayPaymentId: p.id, reason: p.error_description ?? p.error_code ?? 'failed' };
    case 'refund.processed':
    case 'refund.failed':
      return { id, type: body.event, gatewayRefundId: r.id, gatewayPaymentId: r.payment_id, amountPaise: r.amount };
    case 'settlement.processed':
      return { id, type: 'settlement.processed', settlementId: s.id, amountPaise: s.amount, feesPaise: s.fees ?? 0, gatewayPaymentIds: s.payment_ids ?? [] };
    default:
      return { id, type: 'ignored', raw: String(body?.event) };
  }
}

/**
 * Razorpay (test or live keys). Orders + payment links via REST; webhooks verified with
 * HMAC-SHA256 of the raw body using the webhook secret. Card data never touches us —
 * checkout runs on Razorpay's page (PCI-DSS scope stays with the gateway).
 */
export class RazorpayGateway implements PaymentGateway {
  readonly name = 'razorpay';
  readonly isMock = false;
  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string,
  ) {}

  checkout() {
    return { keyId: this.keyId, mode: 'razorpay' as const };
  }

  private async call(path: string, body: unknown) {
    const res = await fetch(`https://api.razorpay.com/v1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}` },
      body: JSON.stringify(body),
    });
    const j: any = await res.json();
    if (!res.ok) throw new Error(`Razorpay ${path}: ${j?.error?.description ?? res.status}`);
    return j;
  }

  async createOrder(i: { amountPaise: number; receipt: string; notes: Record<string, string> }) {
    const o = await this.call('/orders', { amount: i.amountPaise, currency: 'INR', receipt: i.receipt, notes: i.notes });
    return { gatewayOrderId: o.id as string, paymentLinkUrl: null };
  }

  async refund(i: { gatewayPaymentId: string; amountPaise: number; notes: Record<string, string> }) {
    const r = await this.call(`/payments/${i.gatewayPaymentId}/refund`, { amount: i.amountPaise, notes: i.notes });
    return { gatewayRefundId: r.id as string };
  }

  verifySignature(rawBody: Buffer, signature: string | undefined) {
    return hmacOk(this.webhookSecret, rawBody, signature);
  }

  parse = parseRazorpay;

  async verifyUpi() {
    // Static-QR UPI collections are confirmed from the bank statement (recon) in this setup.
    return 'PENDING' as const;
  }
}

/**
 * Local stand-in with Razorpay's wire format. "Completing" a mock checkout produces a signed
 * webhook that goes through exactly the same verification + processing path as production.
 */
export class MockGateway implements PaymentGateway {
  readonly name = 'mock';
  readonly isMock = true;
  constructor(readonly webhookSecret: string) {}

  checkout() {
    return { keyId: null, mode: 'mock' as const };
  }

  async createOrder() {
    return { gatewayOrderId: `order_mock_${randomBytes(7).toString('hex')}`, paymentLinkUrl: null };
  }

  async refund() {
    return { gatewayRefundId: `rfnd_mock_${randomBytes(7).toString('hex')}` };
  }

  verifySignature(rawBody: Buffer, signature: string | undefined) {
    return hmacOk(this.webhookSecret, rawBody, signature);
  }

  parse = parseRazorpay;

  /** Demo rule: a UTR ending in 0000 is unknown to the bank. */
  async verifyUpi(utr: string) {
    return utr.endsWith('0000') ? ('FAILED' as const) : ('SUCCESS' as const);
  }

  /** Build a signed Razorpay-format webhook delivery. */
  sign(body: unknown): { raw: Buffer; signature: string } {
    const raw = Buffer.from(JSON.stringify(body));
    return { raw, signature: createHmac('sha256', this.webhookSecret).update(raw).digest('hex') };
  }

  static event(event: string, payload: Record<string, unknown>) {
    return { id: `evt_mock_${randomBytes(8).toString('hex')}`, entity: 'event', event, payload, created_at: Math.floor(Date.now() / 1000) };
  }
}

export function gatewayFromEnv(): PaymentGateway {
  const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET } = process.env;
  if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET && RAZORPAY_WEBHOOK_SECRET) {
    return new RazorpayGateway(RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET);
  }
  return new MockGateway(process.env.MOCK_WEBHOOK_SECRET ?? 'mock-webhook-secret-for-local-dev');
}
