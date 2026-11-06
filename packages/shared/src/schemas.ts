import { z } from 'zod';
import { COLLECTION_MODES, PAYMENT_MODES, RETURN_CONDITIONS } from './enums';

export const LoginSchema = z.object({
  tenant: z.string().min(1).default('rcpl'),
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof LoginSchema>;

const geo = {
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().nonnegative().optional(),
};

/**
 * Every field transaction carries an idempotency key `deviceId:localId`.
 * The server applies each key at most once and replays the stored result on retry.
 */
const base = {
  idempotencyKey: z.string().min(3).max(120),
  capturedAt: z.string().datetime(),
};

export const AttendanceMutation = z.object({
  ...base,
  type: z.literal('ATTENDANCE'),
  payload: z.object({ kind: z.enum(['CHECK_IN', 'CHECK_OUT']), beatId: z.string().optional(), ...geo }),
});

export const VisitMutation = z.object({
  ...base,
  type: z.literal('VISIT'),
  payload: z.object({
    outletId: z.string(),
    beatId: z.string().optional(),
    outcome: z.enum(['ORDER', 'NO_ORDER', 'CLOSED']),
    noOrderReason: z.string().max(200).optional(),
    ...geo,
  }),
});

export const OrderMutation = z.object({
  ...base,
  type: z.literal('ORDER'),
  payload: z.object({
    outletId: z.string(),
    lines: z.array(z.object({ productId: z.string(), qty: z.number().int().positive() })).min(1).max(200),
    /** Total the device showed the retailer; compared with the server's re-pricing. */
    clientTotalPaise: z.number().int().nonnegative(),
    notes: z.string().max(500).optional(),
    /** CREDIT (khata), COD (pay at delivery) or ONLINE (prepaid; held until the gateway confirms). */
    paymentMode: z.enum(PAYMENT_MODES).default('CREDIT'),
  }),
});

export const CollectionMutation = z.object({
  ...base,
  type: z.literal('COLLECTION'),
  payload: z.object({
    outletId: z.string(),
    /** Which distributor's account is credited; defaults to the outlet's primary distributor. */
    distributorId: z.string().optional(),
    mode: z.enum(COLLECTION_MODES),
    amountPaise: z.number().int().positive(),
    /** UPI UTR / reference; required for UPI. */
    reference: z.string().max(64).optional(),
    chequeNo: z.string().regex(/^\d{6}$/, '6-digit cheque number').optional(),
    chequeBank: z.string().max(60).optional(),
    chequeDate: z.string().optional(),
  }),
});

export const ReturnMutation = z.object({
  ...base,
  type: z.literal('RETURN'),
  payload: z.object({
    outletId: z.string(),
    reason: z.string().max(200),
    lines: z
      .array(
        z.object({
          productId: z.string(),
          qty: z.number().int().positive(),
          condition: z.enum(RETURN_CONDITIONS),
          batchCode: z.string().max(40).optional(),
        }),
      )
      .min(1)
      .max(100),
  }),
});

export const SyncMutationSchema = z.discriminatedUnion('type', [
  AttendanceMutation,
  VisitMutation,
  OrderMutation,
  CollectionMutation,
  ReturnMutation,
]);
export type SyncMutation = z.infer<typeof SyncMutationSchema>;
export type SyncMutationType = SyncMutation['type'];

export const SyncPushSchema = z.object({
  deviceId: z.string().min(3).max(64),
  mutations: z.array(SyncMutationSchema).min(1).max(100),
});
export type SyncPushInput = z.infer<typeof SyncPushSchema>;

/** RETRY = transient server problem; the device keeps the item queued and retries later. */
export type SyncResultStatus = 'APPLIED' | 'DUPLICATE' | 'REJECTED' | 'RETRY';
export interface SyncResult {
  idempotencyKey: string;
  status: SyncResultStatus;
  /** Human-facing references created (order numbers, receipt numbers…). */
  refs?: string[];
  flags?: string[];
  error?: { code: string; message: string };
}
export interface SyncPushResponse {
  serverTime: string;
  results: SyncResult[];
}

export const FulfilSchema = z.object({
  /** Optional per-line caps; default is "as much as stock allows". */
  lines: z.array(z.object({ orderLineId: z.string(), qty: z.number().int().nonnegative() })).optional(),
});

export const DeliverSchema = z.object({
  podNote: z.string().max(200).optional(),
  /** Cash / UPI collected at the door for a COD order. */
  cod: z.object({ mode: z.enum(['CASH', 'UPI']), amountPaise: z.number().int().positive(), reference: z.string().max(64).optional() }).optional(),
});

export const ReviewDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  note: z.string().max(300).optional(),
});

export const CancelSchema = z.object({ reason: z.string().min(3).max(300) });

export const ReturnDecisionSchema = z.object({
  decision: z.enum(['ACCEPT', 'REJECT']),
  note: z.string().max(300).optional(),
});
