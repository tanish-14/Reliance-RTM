import Dexie, { type Table } from 'dexie';
import type { MastersBundle, SyncMutationType } from '@rtm/shared';

export type BundleOutlet = MastersBundle['outlets'][number];
export type BundleProduct = MastersBundle['products'][number];
export type BundleBeat = MastersBundle['beats'][number];
export type BundleCredit = MastersBundle['credit'][number];

/** A field transaction waiting for (or done with) the server. Append-only on the device too. */
export interface OutboxItem {
  seq?: number;
  idempotencyKey: string;
  type: SyncMutationType;
  capturedAt: string;
  payload: any;
  outletId?: string;
  summary: string;
  status: 'PENDING' | 'SYNCED' | 'REJECTED';
  attempts: number;
  lastError?: string;
  refs?: string[];
  flags?: string[];
  syncedAt?: string;
  duplicate?: boolean;
}

export interface Meta {
  key: string;
  value: any;
}

export class RtmDb extends Dexie {
  outlets!: Table<BundleOutlet, string>;
  products!: Table<BundleProduct, string>;
  priceLists!: Table<MastersBundle['priceLists'][number], string>;
  marginRules!: Table<MastersBundle['marginRules'][number], string>;
  schemes!: Table<MastersBundle['schemes'][number], string>;
  beats!: Table<BundleBeat, string>;
  credit!: Table<BundleCredit, [string, string]>;
  outbox!: Table<OutboxItem, number>;
  meta!: Table<Meta, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      outlets: 'id',
      products: 'id',
      priceLists: 'id',
      marginRules: 'id',
      schemes: 'id',
      beats: 'id',
      credit: '[outletId+distributorId], outletId',
      outbox: '++seq, &idempotencyKey, status, type, outletId',
      meta: 'key',
    });
  }
}

/** One IndexedDB per user, so two people sharing a phone never see each other's data. */
let current: { userId: string; db: RtmDb } | null = null;
export function dbFor(userId: string): RtmDb {
  if (current?.userId !== userId) current = { userId, db: new RtmDb(`rtm-${userId}`) };
  return current.db;
}

export function deviceId(): string {
  let id = localStorage.getItem('rtm-device-id');
  if (!id) {
    id = `dev-${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem('rtm-device-id', id);
  }
  return id;
}
