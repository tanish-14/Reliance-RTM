import { create } from 'zustand';
import type { MastersBundle, SyncMutationType, SyncPushResponse } from '@rtm/shared';
import { api, OfflineError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dbFor, deviceId, type OutboxItem, type RtmDb } from './db';

interface SyncState {
  syncing: boolean;
  online: boolean;
  lastError: string | null;
  lastPushAt: string | null;
  set: (s: Partial<SyncState>) => void;
}
export const useSync = create<SyncState>((set) => ({
  syncing: false,
  online: navigator.onLine,
  lastError: null,
  lastPushAt: null,
  set,
}));

function db(): RtmDb {
  const user = useAuth.getState().user;
  if (!user) throw new Error('not logged in');
  return dbFor(user.id);
}

/** Masters pull — server wins: local copies are replaced wholesale. */
export async function pullMasters() {
  const b = await api<MastersBundle>('/sync/pull');
  const d = db();
  await d.transaction('rw', [d.outlets, d.products, d.priceLists, d.marginRules, d.schemes, d.beats, d.credit, d.meta], async () => {
    await Promise.all([d.outlets.clear(), d.products.clear(), d.priceLists.clear(), d.marginRules.clear(), d.schemes.clear(), d.beats.clear(), d.credit.clear()]);
    await d.outlets.bulkPut(b.outlets);
    await d.products.bulkPut(b.products);
    await d.priceLists.bulkPut(b.priceLists);
    await d.marginRules.bulkPut(b.marginRules);
    await d.schemes.bulkPut(b.schemes);
    await d.beats.bulkPut(b.beats);
    await d.credit.bulkPut(b.credit);
    await d.meta.put({ key: 'lastPull', value: b.serverTime });
  });
}

/** Outbox push. Each item carries `deviceId:localId`; the server applies it at most once. */
export async function pushOutbox(): Promise<number> {
  const d = db();
  const pending = await d.outbox.where('status').equals('PENDING').sortBy('seq');
  let done = 0;
  for (let i = 0; i < pending.length; i += 50) {
    const batch = pending.slice(i, i + 50);
    const res = await api<SyncPushResponse>('/sync/push', {
      deviceId: deviceId(),
      mutations: batch.map((m) => ({ idempotencyKey: m.idempotencyKey, capturedAt: m.capturedAt, type: m.type, payload: m.payload })),
    });
    for (const r of res.results) {
      const item = batch.find((b) => b.idempotencyKey === r.idempotencyKey);
      if (!item?.seq) continue;
      if (r.status === 'APPLIED' || r.status === 'DUPLICATE') {
        await d.outbox.update(item.seq, { status: 'SYNCED', refs: r.refs, flags: r.flags, syncedAt: res.serverTime, duplicate: r.status === 'DUPLICATE' });
        done++;
      } else if (r.status === 'REJECTED') {
        await d.outbox.update(item.seq, { status: 'REJECTED', lastError: `${r.error?.code}: ${r.error?.message}` });
      } else {
        await d.outbox.update(item.seq, { attempts: item.attempts + 1, lastError: r.error?.message });
      }
    }
  }
  return done;
}

let running: Promise<void> | null = null;
/** Push first (so the server's credit picture includes our orders), then pull fresh masters. */
export function syncNow(): Promise<void> {
  if (running) return running;
  const s = useSync.getState();
  running = (async () => {
    s.set({ syncing: true });
    try {
      await pushOutbox();
      await pullMasters();
      s.set({ online: true, lastError: null, lastPushAt: new Date().toISOString() });
    } catch (e) {
      if (e instanceof OfflineError) s.set({ online: false, lastError: null });
      else s.set({ lastError: (e as Error).message });
    } finally {
      s.set({ syncing: false });
      running = null;
    }
  })();
  return running;
}

/** Record a field transaction locally (works offline) and try to sync in the background. */
export async function capture(type: SyncMutationType, payload: unknown, summary: string, outletId?: string) {
  const localId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const item: OutboxItem = {
    idempotencyKey: `${deviceId()}:${localId}`,
    type,
    capturedAt: new Date().toISOString(),
    payload,
    outletId,
    summary,
    status: 'PENDING',
    attempts: 0,
  };
  await db().outbox.add(item);
  void syncNow();
  return item;
}

/** Re-send already-synced items with their original keys — demonstrates server-side dedupe. */
export async function replaySynced(): Promise<SyncPushResponse> {
  const d = db();
  const synced = await d.outbox.where('status').equals('SYNCED').sortBy('seq');
  const res = await api<SyncPushResponse>('/sync/push', {
    deviceId: deviceId(),
    mutations: synced.slice(-50).map((m) => ({ idempotencyKey: m.idempotencyKey, capturedAt: m.capturedAt, type: m.type, payload: m.payload })),
  });
  return res;
}

let started = false;
export function startAutoSync() {
  if (started) return;
  started = true;
  window.addEventListener('online', () => {
    useSync.getState().set({ online: true });
    void syncNow();
  });
  window.addEventListener('offline', () => useSync.getState().set({ online: false }));
  setInterval(() => {
    if (!useAuth.getState().forceOffline && navigator.onLine) void syncNow();
  }, 60_000);
}
