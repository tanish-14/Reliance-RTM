import { useState } from 'react';
import { Link, Route, Routes, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rupees } from '@rtm/shared';
import { api } from '../../lib/api';
import { dt, statusTone } from '../../lib/format';
import { Badge, Button, Card, Empty, ErrorNote, Input, Table, Td } from '../../components/ui';
import { Shell } from '../../components/Shell';

export function DistributorApp() {
  return (
    <Shell
      nav={[
        { to: '/distributor', label: 'Orders', end: true },
        { to: '/distributor/returns', label: 'Returns' },
        { to: '/distributor/stock', label: 'Stock' },
      ]}
    >
      <Routes>
        <Route index element={<Orders />} />
        <Route path="orders/:id" element={<OrderDetail />} />
        <Route path="returns" element={<Returns />} />
        <Route path="stock" element={<Stock />} />
      </Routes>
    </Shell>
  );
}

const FILTERS = [
  { label: 'To fulfil', status: 'CONFIRMED,PARTIALLY_FULFILLED' },
  { label: 'Awaiting delivery', status: 'FULFILLED' },
  { label: 'On hold', status: 'ON_HOLD' },
  { label: 'Closed', status: 'CLOSED,CANCELLED,REJECTED' },
];

function Orders() {
  const [f, setF] = useState(FILTERS[0]);
  const q = useQuery({ queryKey: ['orders', f.status], queryFn: () => api<any[]>(`/orders?status=${f.status}`), refetchInterval: 15_000 });
  return (
    <Card
      title="Orders"
      action={
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((x) => (
            <button key={x.label} onClick={() => setF(x)} className={`rounded-md px-2.5 py-1 text-xs ${f === x ? 'bg-red-700 text-white' : 'bg-slate-100 text-slate-700'}`}>
              {x.label}
            </button>
          ))}
        </div>
      }
    >
      <ErrorNote error={q.error} />
      {q.data?.length === 0 ? (
        <Empty>No orders here.</Empty>
      ) : (
        <Table head={['Order', 'Outlet', 'Model', 'Received', 'Total', 'Status']}>
          {q.data?.map((o) => (
            <tr key={o.id} className="hover:bg-slate-50">
              <Td>
                <Link to={`orders/${o.id}`} className="font-medium text-red-700">{o.orderNo}</Link>
              </Td>
              <Td>{o.outlet?.name}</Td>
              <Td>{o.rtmModel.name}</Td>
              <Td>{dt(o.receivedAt)}</Td>
              <Td className="tabular-nums">{rupees(o.totalPaise)}</Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  <Badge tone={statusTone[o.status]}>{o.status.replace('_', ' ')}</Badge>
                  {o.flags.map((fl: string) => <Badge key={fl} tone="amber">{fl}</Badge>)}
                </div>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function OrderDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['order', id], queryFn: () => api<any>(`/orders/${id}`) });
  const refresh = () => qc.invalidateQueries();
  const [reason, setReason] = useState('');
  const act = useMutation({ mutationFn: ({ path, body }: { path: string; body: unknown }) => api(path, body), onSuccess: refresh });
  const o = q.data;
  if (!o) return <ErrorNote error={q.error} />;
  const canFulfil = ['CONFIRMED', 'PARTIALLY_FULFILLED'].includes(o.status);
  const canCancel = ['CONFIRMED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'ON_HOLD'].includes(o.status);
  return (
    <>
      <div className="text-sm"><Link to="/distributor" className="text-red-700">← Orders</Link></div>
      <Card
        title={
          <span className="flex flex-wrap items-center gap-2">
            {o.orderNo} <Badge tone={statusTone[o.status]}>{o.status.replace('_', ' ')}</Badge>
            {o.flags.map((f: string) => <Badge key={f} tone="amber">{f}</Badge>)}
          </span>
        }
        action={
          canFulfil && (
            <Button disabled={act.isPending} onClick={() => act.mutate({ path: `/orders/${o.id}/fulfil`, body: {} })}>
              Fulfil &amp; invoice
            </Button>
          )
        }
      >
        <div className="mb-3 grid gap-1 text-sm text-slate-600 sm:grid-cols-2">
          <div>Outlet: <span className="font-medium text-slate-800">{o.outlet.name}</span> ({o.channelCode}, {o.outlet.stateCode})</div>
          <div>Model: {o.rtmModel.name} · {o.isInterState ? 'IGST (inter-state)' : 'CGST + SGST'}</div>
          <div>Captured {dt(o.capturedAt)} · priced as of {dt(o.pricedAt)}</div>
          <div>Total {rupees(o.totalPaise)} (taxable {rupees(o.taxablePaise)}, scheme −{rupees(o.schemeDiscPaise)}, margin −{rupees(o.marginDiscPaise)})</div>
        </div>
        <Table head={['SKU', 'Ordered', 'Free', 'Invoiced', 'In stock', 'Taxable', 'Schemes']}>
          {o.lines.map((l: any) => (
            <tr key={l.id}>
              <Td>{o.products[l.productId]?.name}</Td>
              <Td className="tabular-nums">{l.qty}</Td>
              <Td className="tabular-nums">{l.freeQty || '—'}</Td>
              <Td className="tabular-nums">{l.qtyInvoiced + l.freeInvoiced}/{l.qty + l.freeQty}</Td>
              <Td className={`tabular-nums ${(o.stock[l.productId] ?? 0) < l.qty - l.qtyInvoiced ? 'text-red-700' : ''}`}>{o.stock[l.productId] ?? 0}</Td>
              <Td className="tabular-nums">{rupees(l.taxablePaise)}</Td>
              <Td>{(l.appliedSchemes as any[]).map((s) => <Badge key={s.code} tone="green">{s.code}</Badge>)}</Td>
            </tr>
          ))}
        </Table>
        <ErrorNote error={act.error} />
      </Card>

      <Card title="Invoices & deliveries">
        {o.invoices.length === 0 ? (
          <Empty>Not invoiced yet.</Empty>
        ) : (
          <div className="space-y-3">
            {o.invoices.map((inv: any) => (
              <div key={inv.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-semibold">{inv.invoiceNo}</span> · {dt(inv.issuedAt)} · {rupees(inv.totalPaise)}{' '}
                    <Badge tone={inv.status === 'ISSUED' ? 'green' : 'red'}>{inv.status}</Badge>
                  </div>
                  {inv.deliveries.map((d: any) =>
                    d.status === 'DISPATCHED' ? (
                      <Button key={d.id} variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ path: `/deliveries/${d.id}/deliver`, body: { podNote: 'Received by retailer' } })}>
                        Mark delivered
                      </Button>
                    ) : (
                      <Badge key={d.id} tone={statusTone[d.status]}>{d.status}{d.deliveredAt ? ` ${dt(d.deliveredAt)}` : ''}</Badge>
                    ),
                  )}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  GSTIN {inv.supplierGstin} → {inv.buyerGstin ?? 'unregistered'} · PoS {inv.placeOfSupply} · taxable {rupees(inv.taxablePaise)} · CGST {rupees(inv.cgstPaise)} · SGST {rupees(inv.sgstPaise)} · IGST {rupees(inv.igstPaise)}
                </div>
                <div className="mt-1 text-xs text-slate-500">Batches: {inv.lines.map((l: any) => `${o.products[l.productId]?.code} ×${l.qty}${l.freeQty ? `+${l.freeQty}` : ''}`).join(', ')}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {canCancel && (
        <Card title="Cancel or short-close">
          <div className="flex flex-wrap gap-2">
            <Input className="max-w-sm" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <Button variant="danger" disabled={reason.length < 3 || act.isPending} onClick={() => act.mutate({ path: `/orders/${o.id}/cancel`, body: { reason } })}>
              Cancel order
            </Button>
            {o.status === 'PARTIALLY_FULFILLED' && (
              <Button variant="secondary" disabled={reason.length < 3 || act.isPending} onClick={() => act.mutate({ path: `/orders/${o.id}/close-short`, body: { reason } })}>
                Close backorder
              </Button>
            )}
          </div>
          <p className="mt-2 text-xs text-slate-500">Cancelling after invoicing issues a credit note and an explicit reversing ledger entry; delivered goods must come back as a return.</p>
        </Card>
      )}

      <Card title="History">
        <ul className="space-y-1 text-sm">
          {o.events.map((e: any) => (
            <li key={e.id} className="text-slate-600">
              <span className="text-slate-400">{dt(e.at)}</span> {e.fromStatus ?? '—'} → <span className="font-medium text-slate-800">{e.toStatus}</span> {e.note && `· ${e.note}`}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function Returns() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['returns'], queryFn: () => api<any[]>('/returns'), refetchInterval: 15_000 });
  const act = useMutation({ mutationFn: ({ id, decision }: { id: string; decision: string }) => api(`/returns/${id}/decide`, { decision }), onSuccess: () => qc.invalidateQueries() });
  return (
    <Card title="Market returns">
      <ErrorNote error={q.error ?? act.error} />
      {q.data?.length === 0 ? (
        <Empty>No returns.</Empty>
      ) : (
        <Table head={['Return', 'Outlet', 'Lines', 'Status', '']}>
          {q.data?.map((r) => (
            <tr key={r.id}>
              <Td>
                <div className="font-medium">{r.returnNo}</div>
                <div className="text-xs text-slate-500">{dt(r.capturedAt)} · {r.reason}</div>
              </Td>
              <Td>{r.outlet}</Td>
              <Td>
                {r.lines.map((l: any) => (
                  <div key={l.id} className="text-xs">
                    {l.product} ×{l.qty} <Badge tone={l.condition === 'SALEABLE' ? 'green' : 'red'}>{l.condition}</Badge>
                  </div>
                ))}
              </Td>
              <Td>
                <Badge tone={statusTone[r.status]}>{r.status}</Badge>
                {r.creditNote && <div className="mt-1 text-xs text-slate-600">CN {r.creditNote.creditNoteNo} · {rupees(r.creditNote.totalPaise)}</div>}
              </Td>
              <Td>
                {r.status === 'REQUESTED' && (
                  <div className="flex gap-1">
                    <Button disabled={act.isPending} onClick={() => act.mutate({ id: r.id, decision: 'ACCEPT' })}>Accept &amp; credit</Button>
                    <Button variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, decision: 'REJECT' })}>Reject</Button>
                  </div>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function Stock() {
  const q = useQuery({ queryKey: ['inventory'], queryFn: () => api<any[]>('/inventory') });
  const soon = Date.now() + 15 * 86_400_000;
  return (
    <Card title="Stock by batch (FEFO order)">
      <ErrorNote error={q.error} />
      <Table head={['SKU', 'Batch', 'Location', 'Bucket', 'Expiry', 'On hand']}>
        {q.data?.map((b) => (
          <tr key={b.id}>
            <Td>{b.product?.name}</Td>
            <Td className="font-mono text-xs">{b.batchCode}</Td>
            <Td>{b.location.type === 'VAN' ? b.location.name : 'Warehouse'}</Td>
            <Td><Badge tone={b.bucket === 'SALEABLE' ? 'green' : 'red'}>{b.bucket}</Badge></Td>
            <Td>
              {new Date(b.expiryDate).toLocaleDateString('en-IN')} {Date.parse(b.expiryDate) < soon && b.bucket === 'SALEABLE' && <Badge tone="amber">near expiry — held back from GT</Badge>}
            </Td>
            <Td className="tabular-nums">{b.qtyOnHand}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}
