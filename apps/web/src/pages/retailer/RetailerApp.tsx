import { useEffect, useMemo, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { CloudOff, Minus, Plus, ShoppingCart, Wifi } from 'lucide-react';
import { rupees, type PaymentMode } from '@rtm/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dt, statusTone } from '../../lib/format';
import { Badge, Button, Card, Empty, ErrorNote, Input, Label, Stat, Table, Td } from '../../components/ui';
import { Shell } from '../../components/Shell';
import { dbFor } from '../../offline/db';
import { capture, startAutoSync, syncNow, useSync } from '../../offline/sync';
import { quote, type DeviceQuote } from '../../offline/pricing';
import { ConsentGate, PrivacyCentre } from './Privacy';

/**
 * Retailer eB2B PWA. Same offline engine as the field app: catalogue, prices and schemes live in
 * IndexedDB, the order goes through the idempotent sync queue, and the server re-prices it.
 */
function useDb() {
  return dbFor(useAuth((s) => s.user)!.id);
}

function NetBadge() {
  const { online } = useSync();
  const forceOffline = useAuth((s) => s.forceOffline);
  const db = useDb();
  const pending = useLiveQuery(() => db.outbox.where('status').equals('PENDING').count(), [db]) ?? 0;
  const off = forceOffline || !online;
  return (
    <span className="flex items-center gap-1 rounded-md bg-red-800/60 px-2 py-1 text-xs">
      {off ? <CloudOff size={14} /> : <Wifi size={14} />} {off ? 'Offline' : 'Online'}
      {pending > 0 && <span className="rounded bg-amber-400 px-1 text-amber-950">{pending} to send</span>}
    </span>
  );
}

export function RetailerApp() {
  const db = useDb();
  const lastPull = useLiveQuery(() => db.meta.get('lastPull'), [db]);
  useEffect(() => {
    startAutoSync();
    void syncNow();
  }, []);
  return (
    <Shell
      narrow
      extra={<NetBadge />}
      nav={[
        { to: '/retailer', label: 'Shop', end: true },
        { to: '/retailer/orders', label: 'My orders' },
        { to: '/retailer/account', label: 'Dues & payments' },
        { to: '/retailer/privacy', label: 'Privacy' },
      ]}
    >
      <ConsentGate>
        {lastPull === undefined ? (
          <Card title="Setting up your catalogue">
            <p className="text-sm text-slate-600">Downloading prices and offers for your shop…</p>
          </Card>
        ) : (
          <Routes>
            <Route index element={<Shop />} />
            <Route path="orders" element={<Orders />} />
            <Route path="account" element={<Account />} />
            <Route path="pay/:intentId" element={<Checkout />} />
            <Route path="privacy" element={<PrivacyCentre />} />
          </Routes>
        )}
      </ConsentGate>
    </Shell>
  );
}

function Shop() {
  const db = useDb();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const outlet = useLiveQuery(() => db.outlets.toCollection().first(), [db]);
  const products = useLiveQuery(() => db.products.toArray(), [db]) ?? [];
  const schemes = useLiveQuery(() => db.schemes.toArray(), [db]) ?? [];
  const credit = useLiveQuery(() => db.credit.toArray(), [db]) ?? [];
  const { online } = useSync();
  const forceOffline = useAuth((s) => s.forceOffline);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [q, setQ] = useState<DeviceQuote | null>(null);
  const [mode, setMode] = useState<PaymentMode>('CREDIT');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const lines = useMemo(() => Object.entries(cart).filter(([, n]) => n > 0).map(([productId, qty]) => ({ productId, qty })), [cart]);
  useEffect(() => {
    if (!outlet || !lines.length) return setQ(null);
    void quote(db, outlet, lines).then(setQ);
  }, [db, outlet, lines]);
  if (!outlet) return <Empty>No shop linked to this login.</Empty>;
  const isOnline = online && !forceOffline;
  const available = credit.reduce((a, c) => a + (c.blocked ? 0 : c.limitPaise - c.exposurePaise), 0);
  const priced = new Map(q?.groups.flatMap((g) => g.priced.lines.map((l) => [l.productId, l] as const)) ?? []);
  const cashback = q?.groups.reduce((a, g) => a + g.priced.cashbackPaise, 0) ?? 0;

  async function checkout() {
    if (!q || !outlet) return;
    setErr(null);
    setBusy(true);
    try {
      const item = await capture('ORDER', { outletId: outlet.id, lines, clientTotalPaise: q.totalPaise, paymentMode: mode }, `Order ${lines.length} items · ${rupees(q.totalPaise)} · ${mode}`, outlet.id);
      setCart({});
      if (mode !== 'ONLINE') {
        await syncNow();
        await qc.invalidateQueries({ queryKey: ['retailer-orders'] });
        return navigate('/retailer/orders');
      }
      // Prepaid: sync now, find the held order, open checkout for it.
      await syncNow();
      const synced = await db.outbox.where('idempotencyKey').equals(item.idempotencyKey).first();
      if (synced?.status !== 'SYNCED' || !synced.refs?.length) throw new Error(synced?.lastError ?? 'Order queued — pay once you are back online (My orders).');
      const orders = await api<any[]>('/orders?status=ON_HOLD');
      const order = orders.find((o) => synced.refs!.includes(o.orderNo));
      if (!order) throw new Error('Order not found for payment');
      const intent = await api<any>('/payments/intents', { outletId: outlet.id, purpose: 'ORDER', orderId: order.id });
      await qc.invalidateQueries();
      navigate(`/retailer/pay/${intent.id}`);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  const brands = [...new Set(products.map((p) => p.brandName))];
  return (
    <>
      <Card title={outlet.name} action={<Badge tone="blue">{outlet.channelCode}</Badge>}>
        <div className="flex flex-wrap gap-2 text-sm">
          {credit.map((c) => <Badge key={c.distributorId} tone={c.blocked ? 'red' : 'green'}>{c.blocked ? 'Credit on hold' : `Credit available ${rupees(Math.max(0, c.limitPaise - c.exposurePaise))}`}</Badge>)}
        </div>
        {schemes.length > 0 && (
          <div className="mt-3 space-y-1">
            <div className="text-xs font-medium text-slate-500">Offers for you</div>
            {schemes.map((s) => <div key={s.id} className="rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-800">{s.name}</div>)}
          </div>
        )}
      </Card>
      {brands.map((b) => (
        <Card key={b} title={b}>
          <ul className="-my-2 divide-y divide-slate-100">
            {products.filter((p) => p.brandName === b).map((p) => {
              const n = cart[p.id] ?? 0;
              const l = priced.get(p.id);
              return (
                <li key={p.id} className="py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{p.name}</div>
                      <div className="text-xs text-slate-500">MRP {rupees(p.mrpPaise)} · case of {p.caseSize}</div>
                    </div>
                    <button className="rounded-md border border-slate-300 p-1.5" aria-label="less" onClick={() => setCart({ ...cart, [p.id]: Math.max(0, n - p.caseSize) })}><Minus size={14} /></button>
                    <span className="w-12 text-center text-sm tabular-nums">{n}</span>
                    <button className="rounded-md border border-slate-300 p-1.5" aria-label="more" onClick={() => setCart({ ...cart, [p.id]: n + p.caseSize })}><Plus size={14} /></button>
                  </div>
                  {l && (
                    <div className="mt-1 flex flex-wrap gap-1 text-xs text-slate-600">
                      {rupees(l.totalPaise)}
                      {l.appliedSchemes.map((s) => <Badge key={s.code} tone="green">{s.code}{s.freeQty ? ` +${s.freeQty} free` : ''}</Badge>)}
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
          <div className="space-y-2">
            <div className="flex justify-between text-sm"><span className="flex items-center gap-1"><ShoppingCart size={16} /> {lines.length} items</span><span className="font-semibold">{rupees(q.totalPaise)}</span></div>
            {cashback > 0 && <div className="text-xs text-emerald-700">+ {rupees(cashback)} cashback after delivery</div>}
            <div className="grid grid-cols-3 gap-1">
              {(['CREDIT', 'COD', 'ONLINE'] as const).map((m) => (
                <Button key={m} variant={mode === m ? 'primary' : 'secondary'} disabled={m === 'ONLINE' && !isOnline} onClick={() => setMode(m)}>
                  {m === 'CREDIT' ? 'Khata' : m === 'COD' ? 'Cash on delivery' : 'Pay now'}
                </Button>
              ))}
            </div>
            {mode === 'CREDIT' && q.totalPaise > available && <div className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">This is above your available credit — your distributor will review it before dispatch.</div>}
            {mode === 'ONLINE' && <div className="text-xs text-slate-500">UPI, cards, netbanking or wallets on the next screen.</div>}
            <Button className="w-full" disabled={busy} onClick={checkout}>{busy ? 'Placing…' : mode === 'ONLINE' ? `Pay ${rupees(q.totalPaise)}` : 'Place order'}</Button>
            <ErrorNote error={err} />
          </div>
        ) : (
          <div className="text-center text-sm text-slate-500">Add cases to your cart.</div>
        )}
      </div>
    </>
  );
}

function Orders() {
  const db = useDb();
  const queued = useLiveQuery(() => db.outbox.where('type').equals('ORDER').reverse().sortBy('seq'), [db]) ?? [];
  const q = useQuery({ queryKey: ['retailer-orders'], queryFn: () => api<any[]>('/orders'), retry: false });
  const pending = queued.filter((o) => o.status !== 'SYNCED');
  return (
    <>
      {pending.length > 0 && (
        <Card title="Waiting to send">
          <ul className="divide-y divide-slate-100 text-sm">{pending.map((o) => <li key={o.idempotencyKey} className="flex justify-between py-2"><span>{o.summary}</span><Badge tone={o.status === 'REJECTED' ? 'red' : 'amber'}>{o.status === 'REJECTED' ? 'Not accepted' : 'Queued'}</Badge></li>)}</ul>
        </Card>
      )}
      <Card title="Orders">
        {q.error ? <p className="text-sm text-slate-500">Connect to see order status.</p> : q.data?.length === 0 ? <Empty>No orders yet.</Empty> : (
          <ul className="divide-y divide-slate-100 text-sm">
            {q.data?.map((o) => (
              <li key={o.id} className="py-2">
                <div className="flex items-center justify-between">
                  <div><div className="font-medium">{o.orderNo}</div><div className="text-xs text-slate-500">{dt(o.receivedAt)} · {o.paymentMode} · {o.source}</div></div>
                  <div className="text-right"><div className="tabular-nums">{rupees(o.totalPaise)}</div><Badge tone={statusTone[o.status]}>{o.flags.includes('AWAITING_PAYMENT') ? 'Awaiting payment' : o.status.replace('_', ' ')}</Badge></div>
                </div>
                {o.flags.includes('AWAITING_PAYMENT') && o.status === 'ON_HOLD' && <PayOrder order={o} />}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function PayOrder({ order }: { order: any }) {
  const navigate = useNavigate();
  const [err, setErr] = useState<unknown>(null);
  return (
    <div className="mt-1">
      <Button variant="secondary" onClick={async () => { try { const i = await api<any>('/payments/intents', { outletId: order.outletId, purpose: 'ORDER', orderId: order.id }); navigate(`/retailer/pay/${i.id}`); } catch (e) { setErr(e); } }}>Pay now</Button>
      <ErrorNote error={err} />
    </div>
  );
}

function Account() {
  const navigate = useNavigate();
  const accounts = useQuery({ queryKey: ['retailer-credit'], queryFn: () => api<any[]>('/credit/accounts'), retry: false });
  const payments = useQuery({ queryKey: ['retailer-payments'], queryFn: () => api<any[]>('/payments'), retry: false });
  const [amount, setAmount] = useState('');
  const [err, setErr] = useState<unknown>(null);
  if (accounts.error) return <Card title="Dues"><p className="text-sm text-slate-500">Connect to see your account.</p></Card>;
  return (
    <>
      {accounts.data?.map((a) => (
        <Card key={a.id} title="Your account with your distributor">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Outstanding" value={rupees(Math.max(0, a.position.arPaise))} />
            <Stat label="Credit limit" value={rupees(a.limitPaise)} hint={a.blocked ? 'On hold' : `${a.creditDays}-day terms`} tone={a.blocked ? 'red' : undefined} />
          </div>
          {a.ageing.open.length > 0 && (
            <div className="mt-3">
              <Table head={['Invoice', 'Due', 'Open']}>
                {a.ageing.open.map((o: any) => <tr key={o.invoiceNo}><Td>{o.invoiceNo}</Td><Td>{new Date(o.dueDate).toLocaleDateString('en-IN')}{o.daysPastDue > 0 && <Badge tone="red">{o.daysPastDue}d overdue</Badge>}</Td><Td className="tabular-nums">{rupees(o.openPaise)}</Td></tr>)}
              </Table>
            </div>
          )}
          <div className="mt-3 flex items-end gap-2">
            <div className="flex-1"><Label>Pay dues online (₹)</Label><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
            <Button disabled={!(Number(amount) > 0)} onClick={async () => { try { const i = await api<any>('/payments/intents', { outletId: a.outletId, purpose: 'OUTSTANDING', amountPaise: Math.round(Number(amount) * 100), distributorId: a.distributorId }); navigate(`/retailer/pay/${i.id}`); } catch (e) { setErr(e); } }}>Pay</Button>
          </div>
          <ErrorNote error={err} />
        </Card>
      ))}
      <Card title="Payments">
        {payments.data?.length === 0 ? <Empty>No payments yet.</Empty> : (
          <ul className="divide-y divide-slate-100 text-sm">{payments.data?.map((p) => <li key={p.id} className="flex justify-between py-2"><span>{p.receiptNo} · {p.mode}<div className="text-xs text-slate-500">{dt(p.createdAt)}</div></span><span className="text-right tabular-nums">{rupees(p.amountPaise)}<div><Badge tone={p.status === 'FAILED' || p.status === 'BOUNCED' ? 'red' : 'green'}>{p.status}</Badge></div></span></li>)}</ul>
        )}
      </Card>
    </>
  );
}

declare global {
  interface Window {
    Razorpay?: new (opts: Record<string, unknown>) => { open: () => void };
  }
}

/**
 * Checkout. With real Razorpay keys this opens Razorpay's hosted checkout (card data never touches
 * us). With the local mock it simulates the bank's answer. Either way the page only *displays*
 * status — the signed webhook is what marks the payment received.
 */
function Checkout() {
  const { intentId } = useParams();
  const qc = useQueryClient();
  const intent = useQuery({ queryKey: ['intent', intentId], queryFn: () => api<any>(`/payments/intents/${intentId}`), refetchInterval: (q) => (q.state.data?.status === 'CREATED' ? 2000 : false) });
  const mock = useMutation({ mutationFn: (outcome: 'success' | 'failure') => api(`/payments/intents/${intentId}/mock-complete`, { outcome }), onSuccess: () => qc.invalidateQueries() });
  const [rzpError, setRzpError] = useState<string | null>(null);
  const i = intent.data;
  if (!i) return <ErrorNote error={intent.error} />;
  const openRazorpay = async () => {
    setRzpError(null);
    if (i.checkout?.mode !== 'razorpay') return setRzpError('Real gateway not configured on the server — use the test buttons.');
    await new Promise<void>((res, rej) => { const sc = document.createElement('script'); sc.src = 'https://checkout.razorpay.com/v1/checkout.js'; sc.onload = () => res(); sc.onerror = () => rej(); document.body.appendChild(sc); });
    new window.Razorpay!({ key: i.checkout.keyId, order_id: i.gatewayOrderId, amount: i.amountPaise, currency: 'INR', name: 'RCPL' }).open();
  };
  return (
    <Card title={`Payment ${i.intentNo}`}>
      <div className="mb-3 text-3xl font-semibold tabular-nums">{rupees(i.amountPaise)}</div>
      <div className="mb-4 text-sm text-slate-600">{i.purpose === 'ORDER' ? 'For your order' : 'Towards your outstanding'} · gateway order <span className="font-mono">{i.gatewayOrderId}</span></div>
      {i.status === 'PAID' ? (
        <div className="space-y-3">
          <Badge tone="green">Paid — confirmed by the payment gateway</Badge>
          <div><Link to="/retailer/orders" className="text-red-700">See my orders →</Link></div>
        </div>
      ) : i.status === 'EXPIRED' ? (
        <Badge tone="red">This payment link expired — your order was not confirmed.</Badge>
      ) : (
        <div className="space-y-2">
          {i.gateway === 'mock' ? (
            <>
              <div className="rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-600">Test mode — simulates the customer's bank. The result arrives as a signed gateway webhook.</div>
              <Button className="w-full" disabled={mock.isPending} onClick={() => mock.mutate('success')}>Pay with UPI (test success)</Button>
              <Button className="w-full" variant="secondary" disabled={mock.isPending} onClick={() => mock.mutate('failure')}>Simulate bank decline</Button>
            </>
          ) : (
            <Button className="w-full" onClick={openRazorpay}>Pay with Razorpay</Button>
          )}
          {i.lastFailure && <div className="text-sm text-red-700">Last attempt failed: {i.lastFailure} — you can try again.</div>}
          <div className="text-xs text-slate-500">Expires {dt(i.expiresAt)}</div>
          <ErrorNote error={mock.error} />
          {rzpError && <div className="text-sm text-red-700">{rzpError}</div>}
        </div>
      )}
    </Card>
  );
}
