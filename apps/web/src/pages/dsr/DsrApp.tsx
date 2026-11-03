import { useEffect, useMemo, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { CloudOff, MapPin, Minus, Plus, RefreshCw, Store, Wifi } from 'lucide-react';
import { rupees, withinGeofence, type ReturnCondition } from '@rtm/shared';
import { useAuth } from '../../lib/auth';
import { ago, dt, statusTone } from '../../lib/format';
import { Badge, Button, Card, Empty, ErrorNote, Input, Label, Select } from '../../components/ui';
import { Shell } from '../../components/Shell';
import { dbFor, type BundleOutlet, type OutboxItem } from '../../offline/db';
import { capture, replaySynced, startAutoSync, syncNow, useSync } from '../../offline/sync';
import { quote, type DeviceQuote } from '../../offline/pricing';
import { currentFix } from '../../offline/geo';

function useDb() {
  const user = useAuth((s) => s.user)!;
  return dbFor(user.id);
}

const today = () => new Date().toISOString().slice(0, 10);

/** Online/offline, unsynced count, data freshness — always visible in the field app. */
function SyncBadge() {
  const db = useDb();
  const { syncing, online } = useSync();
  const forceOffline = useAuth((s) => s.forceOffline);
  const pending = useLiveQuery(() => db.outbox.where('status').equals('PENDING').count(), [db]) ?? 0;
  const lastPull = useLiveQuery(() => db.meta.get('lastPull'), [db])?.value as string | undefined;
  const offline = forceOffline || !online;
  return (
    <button
      onClick={() => void syncNow()}
      title={`Masters updated ${ago(lastPull)}. Tap to sync.`}
      className="flex items-center gap-1.5 rounded-md bg-red-800/60 px-2 py-1 text-xs hover:bg-red-800"
    >
      {offline ? <CloudOff size={14} /> : <Wifi size={14} />}
      <span>{offline ? 'Offline' : 'Online'}</span>
      <span className={`rounded px-1 ${pending ? 'bg-amber-400 text-amber-950' : 'bg-red-900/60'}`}>{pending} unsynced</span>
      <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
    </button>
  );
}

export function DsrApp() {
  const db = useDb();
  const lastPull = useLiveQuery(() => db.meta.get('lastPull'), [db]);
  useEffect(() => {
    startAutoSync();
    void syncNow();
  }, []);
  return (
    <Shell
      narrow
      extra={<SyncBadge />}
      nav={[
        { to: '/dsr', label: 'Today', end: true },
        { to: '/dsr/outbox', label: 'Sync queue' },
        { to: '/dsr/settings', label: 'Settings' },
      ]}
    >
      {lastPull === undefined ? (
        <FirstSync />
      ) : (
        <Routes>
          <Route index element={<Today />} />
          <Route path="outlet/:id" element={<OutletPage />} />
          <Route path="outlet/:id/order" element={<OrderPage />} />
          <Route path="outlet/:id/collect" element={<CollectPage />} />
          <Route path="outlet/:id/return" element={<ReturnPage />} />
          <Route path="outbox" element={<Outbox />} />
          <Route path="settings" element={<Settings />} />
        </Routes>
      )}
    </Shell>
  );
}

function FirstSync() {
  const { syncing, lastError } = useSync();
  return (
    <Card title="Download today's data">
      <p className="mb-3 text-sm text-slate-600">Your beats, outlets, prices and schemes are stored on this phone so you can work without network. Connect once to download them.</p>
      {lastError && <ErrorNote error={new Error(lastError)} />}
      <Button onClick={() => void syncNow()} disabled={syncing}>
        {syncing ? 'Downloading…' : 'Download'}
      </Button>
    </Card>
  );
}

function Today() {
  const db = useDb();
  const beats = useLiveQuery(() => db.beats.toArray(), [db]) ?? [];
  const beat = beats.find((b) => b.daysOfWeek.includes(new Date().getDay())) ?? beats[0];
  const outlets = useLiveQuery(() => db.outlets.toArray(), [db]) ?? [];
  const todays = useLiveQuery(() => db.outbox.filter((o) => o.capturedAt.slice(0, 10) === today()).toArray(), [db]) ?? [];
  const checkIn = todays.find((o) => o.type === 'ATTENDANCE' && o.payload.kind === 'CHECK_IN');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function markAttendance(kind: 'CHECK_IN' | 'CHECK_OUT') {
    if (!beat) return;
    setBusy(true);
    const fix = await currentFix({ lat: beat.anchorLat, lng: beat.anchorLng });
    const g = withinGeofence(fix, { lat: beat.anchorLat, lng: beat.anchorLng }, beat.geofenceM);
    await capture('ATTENDANCE', { kind, beatId: beat.id, lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM }, `${kind === 'CHECK_IN' ? 'Check-in' : 'Check-out'} at ${beat.name}`);
    setMsg(g.inside ? `${kind === 'CHECK_IN' ? 'Checked in' : 'Checked out'} — ${g.distanceM} m from beat start.` : `Recorded, but you are ${g.distanceM} m outside the beat geofence — your manager will review it.`);
    setBusy(false);
  }

  const ordered = new Set(todays.filter((o) => o.type === 'ORDER').map((o) => o.outletId));
  const visited = new Set(todays.filter((o) => o.type === 'VISIT').map((o) => o.outletId));
  const beatOutlets = beat ? beat.outletIds.map((id) => outlets.find((o) => o.id === id)).filter(Boolean) as BundleOutlet[] : [];

  return (
    <>
      <Card title={beat ? `Today's beat · ${beat.name}` : 'No beat today'} action={checkIn ? <Badge tone="green">Checked in {dt(checkIn.capturedAt)}</Badge> : <Badge tone="amber">Not checked in</Badge>}>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => markAttendance('CHECK_IN')} disabled={busy || !!checkIn || !beat}>
            <MapPin size={16} /> Check in
          </Button>
          <Button variant="secondary" onClick={() => markAttendance('CHECK_OUT')} disabled={busy || !checkIn}>
            Check out
          </Button>
        </div>
        {msg && <p className="mt-3 text-sm text-slate-600">{msg}</p>}
      </Card>
      <Card title={`Outlets (${beatOutlets.length})`}>
        <ul className="-my-2 divide-y divide-slate-100">
          {beatOutlets.map((o, i) => (
            <li key={o.id}>
              <Link to={`/dsr/outlet/${o.id}`} className="flex items-center gap-3 py-2.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{o.name}</div>
                  <div className="truncate text-xs text-slate-500">
                    {o.ownerName} · {o.channelCode} · {o.services.map((s) => s.rtmModelCode).join(' + ')}
                  </div>
                </div>
                {ordered.has(o.id) ? <Badge tone="green">Ordered</Badge> : visited.has(o.id) ? <Badge tone="blue">Visited</Badge> : null}
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function useOutlet() {
  const { id } = useParams();
  const db = useDb();
  return useLiveQuery(() => db.outlets.get(id!), [db, id]);
}

function OutletPage() {
  const db = useDb();
  const outlet = useOutlet();
  const credit = useLiveQuery(() => (outlet ? db.credit.where('outletId').equals(outlet.id).toArray() : []), [db, outlet?.id]) ?? [];
  const items = useLiveQuery(() => (outlet ? db.outbox.where('outletId').equals(outlet.id).reverse().sortBy('seq') : []), [db, outlet?.id]) ?? [];
  const visitedToday = items.some((i) => i.type === 'VISIT' && i.capturedAt.slice(0, 10) === today());
  const [msg, setMsg] = useState<string | null>(null);
  if (!outlet) return <Empty>Outlet not found on this device.</Empty>;

  async function visit() {
    const fix = await currentFix(outlet!);
    const g = withinGeofence(fix, outlet!, outlet!.geofenceM);
    await capture('VISIT', { outletId: outlet!.id, outcome: 'ORDER', lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM }, `Visit ${outlet!.name}`, outlet!.id);
    setMsg(g.inside ? `Checked in at outlet (${g.distanceM} m).` : `You are ${g.distanceM} m from the outlet — flagged for review.`);
  }

  return (
    <>
      <Card title={outlet.name} action={<Badge tone="slate">{outlet.channelCode}{outlet.tier ? ` · ${outlet.tier}` : ''}</Badge>}>
        <div className="space-y-1 text-sm text-slate-600">
          <div>{outlet.ownerName} · {outlet.phone}</div>
          <div>{outlet.address}</div>
          <div className="flex flex-wrap gap-1 pt-1">
            {outlet.services.map((s) => (
              <Badge key={s.rtmModelCode + s.distributorId} tone="blue">
                {s.rtmModelCode.replace('_', ' ')} · {s.distributorName}
                {s.brandIds.length ? ' (some brands)' : ''}
              </Badge>
            ))}
          </div>
          {credit.map((c) => (
            <div key={c.distributorId} className="pt-1">
              Credit: {rupees(c.exposurePaise)} used of {rupees(c.limitPaise)} {c.blocked && <Badge tone="red">Blocked</Badge>}
            </div>
          ))}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={visit} disabled={visitedToday}>
            <Store size={16} /> {visitedToday ? 'Checked in' : 'Check in'}
          </Button>
          <Link to="order" className="contents">
            <Button>Take order</Button>
          </Link>
          <Link to="collect" className="contents">
            <Button variant="secondary">Collect payment</Button>
          </Link>
          <Link to="return" className="contents">
            <Button variant="secondary">Market return</Button>
          </Link>
        </div>
        {msg && <p className="mt-3 text-sm text-slate-600">{msg}</p>}
      </Card>
      <Card title="Captured here">
        {items.length === 0 ? <Empty>Nothing yet.</Empty> : <OutboxList items={items} />}
      </Card>
    </>
  );
}

function OrderPage() {
  const db = useDb();
  const outlet = useOutlet();
  const navigate = useNavigate();
  const products = useLiveQuery(() => db.products.toArray(), [db]) ?? [];
  const [qty, setQty] = useState<Record<string, number>>({});
  const [q, setQ] = useState<DeviceQuote | null>(null);
  const lines = useMemo(() => Object.entries(qty).filter(([, n]) => n > 0).map(([productId, n]) => ({ productId, qty: n })), [qty]);

  useEffect(() => {
    if (!outlet || lines.length === 0) return setQ(null);
    void quote(db, outlet, lines).then(setQ);
  }, [db, outlet, lines]);

  if (!outlet) return <Empty>Outlet not found.</Empty>;
  const priced = new Map(q?.groups.flatMap((g) => g.priced.lines.map((l) => [l.productId, l] as const)) ?? []);
  const add = (id: string, n: number) => setQty((s) => ({ ...s, [id]: Math.max(0, (s[id] ?? 0) + n) }));

  async function place() {
    if (!q || !outlet) return;
    const summary = `Order ${outlet.name}: ${lines.length} SKUs, ${rupees(q.totalPaise)}`;
    await capture('ORDER', { outletId: outlet.id, lines, clientTotalPaise: q.totalPaise }, summary, outlet.id);
    navigate(`/dsr/outlet/${outlet.id}`);
  }

  const brands = [...new Set(products.map((p) => p.brandName))];
  return (
    <>
      <div className="text-sm text-slate-500">
        <Link to={`/dsr/outlet/${outlet.id}`} className="text-red-700">← {outlet.name}</Link>
      </div>
      {brands.map((b) => (
        <Card key={b} title={b}>
          <ul className="-my-2 divide-y divide-slate-100">
            {products.filter((p) => p.brandName === b).map((p) => {
              const l = priced.get(p.id);
              const n = qty[p.id] ?? 0;
              return (
                <li key={p.id} className="py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{p.name}</div>
                      <div className="text-xs text-slate-500">MRP {rupees(p.mrpPaise)} · case of {p.caseSize} · GST {p.gstRateBp / 100}%</div>
                    </div>
                    <button className="rounded-md border border-slate-300 p-1.5" onClick={() => add(p.id, -1)} aria-label="less"><Minus size={14} /></button>
                    <input
                      inputMode="numeric"
                      value={n || ''}
                      placeholder="0"
                      onChange={(e) => setQty((s) => ({ ...s, [p.id]: Math.max(0, parseInt(e.target.value || '0', 10) || 0) }))}
                      className="w-14 rounded-md border border-slate-300 px-1 py-1 text-center text-sm tabular-nums"
                    />
                    <button className="rounded-md border border-slate-300 p-1.5" onClick={() => add(p.id, 1)} aria-label="more"><Plus size={14} /></button>
                    <button className="rounded-md bg-slate-100 px-2 py-1 text-xs" onClick={() => add(p.id, p.caseSize)}>+case</button>
                  </div>
                  {l && (
                    <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-slate-600">
                      <span>{rupees(l.totalPaise)} incl. GST</span>
                      {l.marginDiscPaise > 0 && <Badge tone="slate">margin −{rupees(l.marginDiscPaise)}</Badge>}
                      {l.appliedSchemes.map((s) => (
                        <Badge key={s.code} tone="green">
                          {s.code}
                          {s.discountPaise ? ` −${rupees(s.discountPaise)}` : ''}
                          {s.freeQty ? ` +${s.freeQty} free` : ''}
                        </Badge>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      ))}
      <div className="sticky bottom-0 -mx-4 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
        {q ? (
          <div className="space-y-1.5">
            {q.groups.length > 1 && (
              <div className="text-xs text-slate-500">Splits into {q.groups.length} orders: {q.groups.map((g) => `${g.rtmModelCode.replace('_', ' ')} ${rupees(g.priced.totalPaise)}`).join(' · ')}</div>
            )}
            <div className="flex justify-between text-xs text-slate-500">
              <span>Taxable {rupees(q.groups.reduce((a, g) => a + g.priced.taxablePaise, 0))} · GST {rupees(q.groups.reduce((a, g) => a + g.priced.taxPaise, 0))}</span>
              <span>Savings {rupees(q.groups.reduce((a, g) => a + g.priced.marginDiscPaise + g.priced.schemeDiscPaise, 0))}</span>
            </div>
            {q.groups.map((g) => g.creditWarning && <div key={g.distributorId} className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">{g.creditWarning}</div>)}
            <Button className="w-full" onClick={place} disabled={!!q.unroutable.length}>
              Place order · {rupees(q.totalPaise)}
            </Button>
          </div>
        ) : (
          <div className="text-center text-sm text-slate-500">Add quantities to see the price, schemes and GST.</div>
        )}
      </div>
    </>
  );
}

function CollectPage() {
  const outlet = useOutlet();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'CASH' | 'UPI'>('CASH');
  const [amount, setAmount] = useState('');
  const [ref, setRef] = useState('');
  if (!outlet) return <Empty>Outlet not found.</Empty>;
  const paise = Math.round(parseFloat(amount || '0') * 100);
  const valid = paise > 0 && (mode === 'CASH' || ref.trim().length >= 6);
  return (
    <Card title={`Collect from ${outlet.name}`}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          {(['CASH', 'UPI'] as const).map((m) => (
            <Button key={m} variant={mode === m ? 'primary' : 'secondary'} onClick={() => setMode(m)}>
              {m === 'CASH' ? 'Cash' : 'UPI'}
            </Button>
          ))}
        </div>
        <div>
          <Label>Amount (₹)</Label>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        </div>
        {mode === 'UPI' && (
          <div>
            <Label>UPI reference / UTR</Label>
            <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. 431298765432" />
          </div>
        )}
        <p className="text-xs text-slate-500">{mode === 'CASH' ? 'Cash stays in your cash-in-transit until you deposit it.' : 'UPI is confirmed against the gateway after sync.'}</p>
        <Button
          className="w-full"
          disabled={!valid}
          onClick={async () => {
            await capture('COLLECTION', { outletId: outlet.id, mode, amountPaise: paise, reference: mode === 'UPI' ? ref.trim() : undefined }, `${mode} ${rupees(paise)} from ${outlet.name}`, outlet.id);
            navigate(`/dsr/outlet/${outlet.id}`);
          }}
        >
          Record {rupees(paise)}
        </Button>
      </div>
    </Card>
  );
}

function ReturnPage() {
  const db = useDb();
  const outlet = useOutlet();
  const navigate = useNavigate();
  const products = useLiveQuery(() => db.products.toArray(), [db]) ?? [];
  const [lines, setLines] = useState<{ productId: string; qty: number; condition: ReturnCondition; batchCode: string }[]>([]);
  const [reason, setReason] = useState('Damaged in transit');
  if (!outlet) return <Empty>Outlet not found.</Empty>;
  const ok = lines.length > 0 && lines.every((l) => l.productId && l.qty > 0);
  return (
    <Card title={`Market return — ${outlet.name}`}>
      <div className="space-y-3">
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 p-2">
            <Select className="col-span-2" value={l.productId} onChange={(e) => setLines((s) => s.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)))}>
              <option value="">Product…</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
            <Input inputMode="numeric" placeholder="Qty (units)" value={l.qty || ''} onChange={(e) => setLines((s) => s.map((x, j) => (j === i ? { ...x, qty: parseInt(e.target.value || '0', 10) || 0 } : x)))} />
            <Select value={l.condition} onChange={(e) => setLines((s) => s.map((x, j) => (j === i ? { ...x, condition: e.target.value as ReturnCondition } : x)))}>
              <option value="SALEABLE">Saleable</option>
              <option value="DAMAGED">Damaged</option>
              <option value="EXPIRED">Expired</option>
            </Select>
            <Input className="col-span-2" placeholder="Batch code (if readable)" value={l.batchCode} onChange={(e) => setLines((s) => s.map((x, j) => (j === i ? { ...x, batchCode: e.target.value } : x)))} />
          </div>
        ))}
        <Button variant="secondary" onClick={() => setLines((s) => [...s, { productId: '', qty: 0, condition: 'DAMAGED', batchCode: '' }])}>
          <Plus size={14} /> Add product
        </Button>
        <div>
          <Label>Reason</Label>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <Button
          className="w-full"
          disabled={!ok}
          onClick={async () => {
            await capture(
              'RETURN',
              { outletId: outlet.id, reason, lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, condition: l.condition, batchCode: l.batchCode || undefined })) },
              `Return ${lines.reduce((a, l) => a + l.qty, 0)} units from ${outlet.name}`,
              outlet.id,
            );
            navigate(`/dsr/outlet/${outlet.id}`);
          }}
        >
          Submit return for inspection
        </Button>
      </div>
    </Card>
  );
}

function OutboxList({ items }: { items: OutboxItem[] }) {
  return (
    <ul className="-my-2 divide-y divide-slate-100">
      {items.map((i) => (
        <li key={i.idempotencyKey} className="py-2 text-sm">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate font-medium">{i.summary}</div>
              <div className="text-xs text-slate-500">
                {dt(i.capturedAt)} · {i.type}
                {i.refs?.length ? ` · ${i.refs.filter((r) => !/^c[a-z0-9]{20,}$/.test(r)).join(', ')}` : ''}
              </div>
              {i.flags && i.flags.length > 0 && <div className="mt-0.5 flex flex-wrap gap-1">{i.flags.map((f) => <Badge key={f} tone="amber">{f}</Badge>)}</div>}
              {i.lastError && <div className="mt-0.5 text-xs text-red-700">{i.lastError}</div>}
            </div>
            <Badge tone={statusTone[i.status] ?? 'slate'}>{i.status === 'REJECTED' ? 'Rejected' : i.status === 'SYNCED' ? 'Synced' : 'Waiting'}</Badge>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Outbox() {
  const db = useDb();
  const items = useLiveQuery(() => db.outbox.reverse().sortBy('seq'), [db]) ?? [];
  const [replay, setReplay] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  return (
    <>
      <Card
        title="Sync queue"
        action={
          <Button variant="secondary" onClick={() => void syncNow()}>
            <RefreshCw size={14} /> Sync now
          </Button>
        }
      >
        {items.length === 0 ? <Empty>No transactions captured on this device yet.</Empty> : <OutboxList items={items} />}
      </Card>
      <Card title="Duplicate-safety check">
        <p className="mb-3 text-sm text-slate-600">Re-sends already-synced items with their original idempotency keys, as a flaky network would. The server should answer DUPLICATE and create nothing.</p>
        <Button
          variant="secondary"
          onClick={async () => {
            setErr(null);
            try {
              const r = await replaySynced();
              const counts = r.results.reduce<Record<string, number>>((a, x) => ({ ...a, [x.status]: (a[x.status] ?? 0) + 1 }), {});
              setReplay(Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing to replay');
            } catch (e) {
              setErr(e);
            }
          }}
        >
          Replay synced items
        </Button>
        {replay && <p className="mt-2 text-sm font-medium text-emerald-700">Server answered: {replay}</p>}
        <ErrorNote error={err} />
      </Card>
    </>
  );
}

function Settings() {
  const { forceOffline, setForceOffline, simulateGps, setSimulateGps } = useAuth();
  return (
    <Card title="Device settings">
      <div className="space-y-4 text-sm">
        <label className="flex items-start gap-3">
          <input type="checkbox" className="mt-1" checked={forceOffline} onChange={(e) => {
            setForceOffline(e.target.checked);
            useSync.getState().set({ online: !e.target.checked });
            if (!e.target.checked) void syncNow();
          }} />
          <span>
            <span className="font-medium">Airplane mode (demo)</span>
            <span className="block text-slate-500">Work as if there were no network. Everything you capture waits in the sync queue; switch off to sync.</span>
          </span>
        </label>
        <label className="flex items-start gap-3">
          <input type="checkbox" className="mt-1" checked={simulateGps} onChange={(e) => setSimulateGps(e.target.checked)} />
          <span>
            <span className="font-medium">Demo GPS</span>
            <span className="block text-slate-500">Use the beat / outlet location instead of this device's GPS (for desk demos).</span>
          </span>
        </label>
      </div>
    </Card>
  );
}
