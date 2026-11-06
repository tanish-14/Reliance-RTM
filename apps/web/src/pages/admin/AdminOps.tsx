import { useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rupees, SchemeInput } from '@rtm/shared';
import { api } from '../../lib/api';
import { dt } from '../../lib/format';
import { Badge, Button, Card, Empty, ErrorNote, Table, Td } from '../../components/ui';
import { EntityForm, type Field } from './EntityForm';

export function AdminOps() {
  const tab = ({ isActive }: { isActive: boolean }) => `rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-red-700 text-white' : 'bg-white text-slate-700 border border-slate-200'}`;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <NavLink to="/admin/ops" end className={tab}>Schemes</NavLink>
        <NavLink to="/admin/ops/partners" className={tab}>Trading partners</NavLink>
        <NavLink to="/admin/ops/integrations" className={tab}>Integrations & jobs</NavLink>
        <NavLink to="/admin/ops/privacy" className={tab}>Privacy requests</NavLink>
      </div>
      <Routes>
        <Route index element={<Schemes />} />
        <Route path="partners" element={<Partners />} />
        <Route path="integrations" element={<Integrations />} />
        <Route path="privacy" element={<PrivacyRequests />} />
      </Routes>
    </>
  );
}

const list = (v: string) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
/** "48:4, 96:7" -> [{a:48,b:4},…] */
const pairs = (v: string, a: string, b: string) => list(v).map((p) => { const [x, y] = p.split(':'); return { [a]: x?.trim(), [b]: y?.trim() }; });

function Schemes() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['schemes'], queryFn: () => api<any[]>('/schemes') });
  const act = useMutation({ mutationFn: ({ path, body }: { path: string; body?: unknown }) => api(path, body ?? {}), onSuccess: () => qc.invalidateQueries() });
  const today = new Date().toISOString().slice(0, 10);
  const fields: Field[] = [
    { name: 'code', label: 'Code' },
    { name: 'name', label: 'Name' },
    { name: 'type', label: 'Type', type: 'select', options: ['QTY_SLAB', 'VALUE_SLAB', 'FREE_GOODS', 'TRADE_DISCOUNT', 'COMBO', 'CASHBACK'].map((t) => ({ value: t, label: t })) },
    { name: 'budgetRupees', label: 'Budget (₹)', type: 'number' },
    { name: 'validFrom', label: 'Valid from', type: 'date' },
    { name: 'validTo', label: 'Valid to', type: 'date' },
    { name: 'channelCodes', label: 'Channels (comma; blank = all)' },
    { name: 'stateCodes', label: 'States (comma; blank = all)', hint: 'Geo-bound, e.g. 27,24' },
    { name: 'brandCodes', label: 'Brands (comma)' },
    { name: 'productCodes', label: 'SKUs (comma)' },
    { name: 'qtySlabs', label: 'QTY_SLAB: minQty:discount%', hint: '48:4, 96:7' },
    { name: 'valueSlabs', label: 'VALUE_SLAB: min ₹:discount%', hint: '5000:2, 10000:3' },
    { name: 'buyFree', label: 'FREE_GOODS: buy:free', hint: '24:2' },
    { name: 'discountPct', label: 'TRADE_DISCOUNT / COMBO discount %', type: 'number' },
    { name: 'comboItems', label: 'COMBO: SKU:minQty', hint: 'IND-ATTA-5KG:4, IND-SOYA-1L:12' },
    { name: 'cashback', label: 'CASHBACK: min ₹:cashback%:max ₹', hint: '5000:1:500' },
  ];
  const toInput = (v: Record<string, any>) => {
    const [buyQty, freeQty] = String(v.buyFree ?? '').split(':');
    const [minValueRupees, cashbackPct, maxCashbackRupees] = String(v.cashback ?? '').split(':');
    return {
      code: v.code, name: v.name, type: v.type, validFrom: v.validFrom, validTo: v.validTo,
      channelCodes: list(v.channelCodes), stateCodes: list(v.stateCodes), brandCodes: list(v.brandCodes), productCodes: list(v.productCodes),
      ...(v.budgetRupees ? { budgetRupees: v.budgetRupees } : {}),
      ...(v.type === 'QTY_SLAB' ? { qtySlabs: pairs(v.qtySlabs, 'minQty', 'discountPct') } : {}),
      ...(v.type === 'VALUE_SLAB' ? { valueSlabs: pairs(v.valueSlabs, 'minValueRupees', 'discountPct') } : {}),
      ...(v.type === 'FREE_GOODS' ? { buyQty, freeQty } : {}),
      ...(['TRADE_DISCOUNT', 'COMBO'].includes(v.type) ? { discountPct: v.discountPct } : {}),
      ...(v.type === 'COMBO' ? { comboItems: pairs(v.comboItems, 'productCode', 'minQty') } : {}),
      ...(v.type === 'CASHBACK' ? { minValueRupees, cashbackPct, ...(maxCashbackRupees ? { maxCashbackRupees } : {}) } : {}),
    };
  };
  return (
    <>
      <Card title="New scheme — saved as DRAFT; goes live after approval">
        <EntityForm fields={fields} initial={{ type: 'QTY_SLAB', validFrom: today, validTo: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) }} schema={SchemeInput} toInput={toInput} onSubmit={async (i) => { await api('/schemes', i); await qc.invalidateQueries({ queryKey: ['schemes'] }); }} />
      </Card>
      <Card title="Schemes">
        <ErrorNote error={q.error ?? act.error} />
        <Table head={['Scheme', 'Type', 'Valid', 'Budget used', 'Status', '']}>
          {q.data?.map((s) => (
            <tr key={s.id}>
              <Td>{s.code}<div className="text-xs text-slate-500">{s.name}</div></Td>
              <Td>{s.type}</Td>
              <Td className="text-xs">{new Date(s.validFrom).toLocaleDateString('en-IN')} – {new Date(s.validTo).toLocaleDateString('en-IN')}</Td>
              <Td className="tabular-nums">{rupees(s.consumedPaise)}{s.budgetPaise ? ` / ${rupees(s.budgetPaise)}` : ''}</Td>
              <Td><Badge tone={s.status === 'ACTIVE' ? 'green' : s.status === 'DRAFT' ? 'amber' : 'slate'}>{s.status}</Badge></Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  {['DRAFT', 'PAUSED'].includes(s.status) && <Button variant="secondary" onClick={() => act.mutate({ path: `/schemes/${s.id}/request-activation` })}>Request activation</Button>}
                  {s.status === 'ACTIVE' && <Button variant="secondary" onClick={() => act.mutate({ path: `/schemes/${s.id}/status`, body: { status: 'PAUSED' } })}>Pause</Button>}
                  {s.status !== 'ENDED' && <Button variant="ghost" onClick={() => act.mutate({ path: `/schemes/${s.id}/status`, body: { status: 'ENDED' } })}>End</Button>}
                </div>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}

const SAMPLES: Record<string, unknown> = {
  'STAR-HYPER': { PONumber: 'PO-DEMO-1', ShipTo: { StoreCode: 'STAR-AND-01' }, Lines: [{ EAN: '8909000000010', Cases: 4 }, { EAN: '8909000000017', Cases: 2 }], POValue: 2500 },
  SHOPKART: { order_id: 'SK-DEMO-1', fc_code: 'BHI-FC1', items: [{ sku: 'CAMPA-COLA-500', qty: 96 }, { sku: 'IND-ATTA-5KG', qty: 20 }] },
  ZIPMART: { replenishment_id: 'ZM-DEMO-1', dark_store: 'PWI-DS', lines: [{ item_code: 'ZM-COLA-200', units: 48 }, { item_code: 'ZM-ORANGE-200', units: 48 }] },
};

function Partners() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['partners'], queryFn: () => api<any[]>('/admin/partners') });
  const [sel, setSel] = useState('SHOPKART');
  const [payload, setPayload] = useState(JSON.stringify(SAMPLES.SHOPKART, null, 2));
  const [result, setResult] = useState<any>(null);
  const sim = useMutation({ mutationFn: () => api(`/admin/partners/${sel}/simulate`, JSON.parse(payload)), onSuccess: (r) => { setResult(r); void qc.invalidateQueries({ queryKey: ['partners'] }); } });
  return (
    <>
      <Card title="Trading partners — payload format is configuration (one generic adapter)">
        <Table head={['Partner', 'Channel', 'Field mapping', 'Stores', 'SKU maps']}>
          {q.data?.map((p) => (
            <tr key={p.id}>
              <Td>{p.code}<div className="text-xs text-slate-500">{p.name}</div></Td>
              <Td>{p.channelCode}</Td>
              <Td className="font-mono text-xs">{Object.entries(p.config).map(([k, v]) => `${k}=${v}`).join(' · ')}</Td>
              <Td className="text-xs">{p.stores.map((s: any) => s.externalStoreId).join(', ')}</Td>
              <Td>{p.skus.length || 'own codes'}</Td>
            </tr>
          ))}
        </Table>
        <p className="mt-2 text-xs text-slate-500">Live intake: POST /api/integrations/orders/&lt;PARTNER&gt; with headers X-Partner-Key and X-Partner-Signature (HMAC-SHA256 of the body).</p>
      </Card>
      <Card title="Try a partner payload (same adapter, no credentials)">
        <div className="mb-2 flex gap-2">
          {Object.keys(SAMPLES).map((k) => (
            <Button key={k} variant={sel === k ? 'primary' : 'secondary'} onClick={() => { setSel(k); setPayload(JSON.stringify({ ...(SAMPLES[k] as object), ...{ [Object.keys(SAMPLES[k] as object)[0]]: `${k}-${Date.now()}` } }, null, 2)); setResult(null); }}>{k}</Button>
          ))}
        </div>
        <textarea className="h-40 w-full rounded-lg border border-slate-300 p-2 font-mono text-xs" value={payload} onChange={(e) => setPayload(e.target.value)} />
        <Button className="mt-2" onClick={() => sim.mutate()} disabled={sim.isPending}>Send</Button>
        <ErrorNote error={sim.error} />
        {result && (
          <div className="mt-2 text-sm">
            <Badge tone={result.status === 'ACCEPTED' ? 'green' : result.status === 'DUPLICATE' ? 'amber' : 'red'}>{result.status}</Badge> {result.orderNos?.join(', ')} {result.flags?.map((f: string) => <Badge key={f} tone="amber">{f}</Badge>)}
            {result.error && <div className="text-red-700">{result.error.code}: {result.error.message}</div>}
          </div>
        )}
      </Card>
    </>
  );
}

function Integrations() {
  const qc = useQueryClient();
  const logs = useQuery({ queryKey: ['int-logs'], queryFn: () => api<any[]>('/admin/integrations/logs') });
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: () => api<any[]>('/admin/jobs'), refetchInterval: 5000 });
  const act = useMutation({ mutationFn: (path: string) => api(path, {}), onSuccess: () => qc.invalidateQueries() });
  return (
    <>
      <Card title="Actions">
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => act.mutate('/admin/jobs/drain')}>Run queued jobs now</Button>
          <Button variant="secondary" onClick={() => act.mutate('/admin/integrations/catalogue')}>Publish catalogue to JioMart Partner (mock)</Button>
          <Button variant="secondary" onClick={() => act.mutate('/payments/mock/settle')}>Simulate gateway settlement (mock)</Button>
        </div>
        <ErrorNote error={act.error} />
        {act.data && <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-2 text-xs">{JSON.stringify(act.data, null, 1)}</pre>}
      </Card>
      <Card title="Integration log (ERP · 3PL · marketplace)">
        {logs.data?.length === 0 ? <Empty>Nothing sent yet.</Empty> : (
          <Table head={['When', 'Target', 'Event', 'External ref', 'Status']}>
            {logs.data?.map((l) => <tr key={l.id}><Td className="text-xs">{dt(l.at)}</Td><Td>{l.target}</Td><Td>{l.event}</Td><Td className="font-mono text-xs">{l.externalRef ?? '—'}</Td><Td><Badge tone={l.status === 'SENT' ? 'green' : 'amber'}>{l.status}</Badge></Td></tr>)}
          </Table>
        )}
      </Card>
      <Card title="Job queue (transactional outbox)">
        <Table head={['Job', 'Status', 'Attempts', 'Run at', 'Last error']}>
          {jobs.data?.map((j) => <tr key={j.id}><Td className="font-mono text-xs">{j.name}</Td><Td><Badge tone={j.status === 'DONE' ? 'green' : j.status === 'FAILED' ? 'red' : 'amber'}>{j.status}</Badge></Td><Td>{j.attempts}</Td><Td className="text-xs">{dt(j.runAt)}</Td><Td className="max-w-xs truncate text-xs text-red-700">{j.lastError}</Td></tr>)}
        </Table>
      </Card>
    </>
  );
}

function PrivacyRequests() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['privacy-admin'], queryFn: () => api<any[]>('/admin/privacy/requests') });
  const act = useMutation({ mutationFn: ({ id, decision }: { id: string; decision: string }) => api(`/admin/privacy/requests/${id}/complete`, { decision }), onSuccess: () => qc.invalidateQueries() });
  return (
    <Card title="Data-principal requests (DPDP)">
      <ErrorNote error={q.error ?? act.error} />
      {q.data?.length === 0 ? <Empty>No requests.</Empty> : (
        <Table head={['Raised', 'Subject', 'Type', 'Details', 'Status', '']}>
          {q.data?.map((r) => (
            <tr key={r.id}>
              <Td className="text-xs">{dt(r.createdAt)}</Td>
              <Td>{r.subject?.name}<div className="text-xs text-slate-500">{r.subject?.email}</div></Td>
              <Td>{r.type}</Td>
              <Td className="text-xs">{r.details ?? '—'}</Td>
              <Td><Badge tone={r.status === 'OPEN' ? 'amber' : 'green'}>{r.status}</Badge></Td>
              <Td>{r.status === 'OPEN' && <div className="flex gap-1"><Button onClick={() => act.mutate({ id: r.id, decision: 'COMPLETE' })}>{r.type === 'ERASURE' ? 'Erase' : 'Complete'}</Button><Button variant="secondary" onClick={() => act.mutate({ id: r.id, decision: 'REJECT' })}>Reject</Button></div>}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
