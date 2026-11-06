import { useMemo, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BeatInput,
  ChannelInput,
  DistributorInput,
  isValidGstin,
  MarginRuleInput,
  OutletInput,
  outletRowToInput,
  PriceRevisionInput,
  ProductInput,
  ROLES,
  RtmModelInput,
  rupees,
  STOCK_SOURCES,
  INVOICE_TIMINGS,
  UserInput,
} from '@rtm/shared';
import { api } from '../../lib/api';
import { Badge, Button, Card, ErrorNote, Input, Label, Select, Table, Td } from '../../components/ui';
import { Shell } from '../../components/Shell';
import { AuditTrail } from '../hq/HqApp';
import { EntityForm, type Field } from './EntityForm';
import { AdminOps } from './AdminOps';

export function AdminApp() {
  return (
    <Shell
      nav={[
        { to: '/admin', label: 'Outlets', end: true },
        { to: '/admin/products', label: 'Products & prices' },
        { to: '/admin/distributors', label: 'Distributors' },
        { to: '/admin/people', label: 'People & beats' },
        { to: '/admin/config', label: 'Channels & models' },
        { to: '/admin/import', label: 'Bulk import' },
        { to: '/admin/ops', label: 'Schemes, partners, privacy' },
        { to: '/admin/audit', label: 'Audit trail' },
      ]}
    >
      <Routes>
        <Route index element={<Outlets />} />
        <Route path="products" element={<Products />} />
        <Route path="distributors" element={<Distributors />} />
        <Route path="people" element={<People />} />
        <Route path="config" element={<Config />} />
        <Route path="import" element={<Import />} />
        <Route path="ops/*" element={<AdminOps />} />
        <Route path="audit" element={<AuditTrail />} />
      </Routes>
    </Shell>
  );
}

export function useMasters() {
  return useQuery({ queryKey: ['masters'], queryFn: () => api<any>('/admin/masters') });
}
const opts = (rows: any[] | undefined, v = 'code', l = (r: any) => `${r.code} — ${r.name}`) => (rows ?? []).map((r) => ({ value: r[v], label: l(r) }));
const save = (path: string, qc: ReturnType<typeof useQueryClient>) => async (input: unknown) => {
  await api(path, input);
  await qc.invalidateQueries({ queryKey: ['masters'] });
};

function Outlets() {
  const qc = useQueryClient();
  const m = useMasters().data;
  const [edit, setEdit] = useState<any>(null);
  const [filter, setFilter] = useState('');
  const fields: Field[] = useMemo(
    () => [
      { name: 'code', label: 'Outlet code' },
      { name: 'name', label: 'Name' },
      { name: 'ownerName', label: 'Owner' },
      { name: 'phone', label: 'Mobile' },
      { name: 'gstin', label: 'GSTIN (optional)', hint: 'Checksum and state are validated' },
      { name: 'channelCode', label: 'Channel', type: 'select', options: opts(m?.channels) },
      { name: 'tier', label: 'Tier' },
      { name: 'stateCode', label: 'State code', hint: '27 MH · 07 DL · 24 GJ · 29 KA' },
      { name: 'city', label: 'City' },
      { name: 'address', label: 'Address' },
      { name: 'lat', label: 'Latitude', type: 'number' },
      { name: 'lng', label: 'Longitude', type: 'number' },
      { name: 'creditLimitRupees', label: 'Credit limit (₹)', type: 'number' },
      { name: 'creditDays', label: 'Credit days', type: 'number' },
      { name: 'services', label: 'Served by', span: 2, hint: 'MODEL:DISTRIBUTOR[:BRAND|BRAND][:primary], separated by ;  e.g. VAN_SALES:MH01:CAMPA;DISTRIBUTOR_LED:MH01::primary' },
      { name: 'active', label: 'Active', type: 'checkbox' },
    ],
    [m],
  );
  const blank = { code: '', name: '', ownerName: '', phone: '', gstin: '', channelCode: 'GT', tier: '', stateCode: '27', city: '', address: '', lat: '', lng: '', creditLimitRupees: '', creditDays: '14', services: 'DISTRIBUTOR_LED:MH01', active: true };
  const initial = edit
    ? {
        ...blank,
        ...Object.fromEntries(Object.entries(edit).filter(([, x]) => typeof x !== 'object' || x === null).map(([k, x]) => [k, x ?? ''])),
        channelCode: edit.channel.code,
        lat: String(edit.lat),
        lng: String(edit.lng),
        services: edit.services.map((s: any) => `${s.rtmModel.code}:${s.distributor.code}:${(s.brandCodes ?? []).join('|')}:${s.isPrimary ? 'primary' : 'secondary'}`).join(';'),
      }
    : blank;
  const rows = (m?.outlets ?? []).filter((o: any) => !filter || `${o.code} ${o.name} ${o.city} ${o.channel.code}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <>
      <Card title={edit ? `Edit ${edit.code}` : 'New outlet'} action={edit && <Button variant="ghost" onClick={() => setEdit(null)}>New instead</Button>}>
        <EntityForm fields={fields} initial={initial} schema={OutletInput} toInput={(v) => outletRowToInput(v as any)} onSubmit={save('/admin/outlets', qc)} />
      </Card>
      <Card title={`Outlets (${m?.outlets.length ?? 0})`} action={<Input className="w-48" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />}>
        <Table head={['Code', 'Outlet', 'Channel', 'GSTIN', 'Served by', '']}>
          {rows.map((o: any) => (
            <tr key={o.id}>
              <Td className="font-mono text-xs">{o.code}</Td>
              <Td>{o.name}<div className="text-xs text-slate-500">{o.city} · {o.stateCode}{o.active ? '' : ' · inactive'}</div></Td>
              <Td>{o.channel.code}{o.tier ? ` · ${o.tier}` : ''}</Td>
              <Td className="font-mono text-xs">{o.gstin ? <>{o.gstin} {isValidGstin(o.gstin) ? <Badge tone="green">valid</Badge> : <Badge tone="red">invalid</Badge>}</> : '—'}</Td>
              <Td>{o.services.map((s: any) => <Badge key={s.id} tone="blue">{s.rtmModel.code} · {s.distributor.code}{s.brandIds.length ? ' (brands)' : ''}</Badge>)}</Td>
              <Td><Button variant="ghost" onClick={() => { setEdit(o); window.scrollTo({ top: 0 }); }}>Edit</Button></Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}

function Products() {
  const qc = useQueryClient();
  const m = useMasters().data;
  const [edit, setEdit] = useState<any>(null);
  const [listId, setListId] = useState('');
  const list = useQuery({ queryKey: ['pricelist', listId], queryFn: () => api<any>(`/admin/price-lists/${listId}`), enabled: !!listId });
  const fields: Field[] = [
    { name: 'code', label: 'SKU code' },
    { name: 'name', label: 'Name' },
    { name: 'brandCode', label: 'Brand code', hint: 'New codes create the brand' },
    { name: 'category', label: 'Category' },
    { name: 'packSize', label: 'Pack size' },
    { name: 'caseSize', label: 'Units per case', type: 'number' },
    { name: 'hsnCode', label: 'HSN' },
    { name: 'gstRatePct', label: 'GST %', type: 'select', options: ['0', '0.25', '3', '5', '18', '40'].map((x) => ({ value: x, label: `${x}%` })) },
    { name: 'mrpRupees', label: 'MRP (₹)', type: 'number' },
    { name: 'shelfLifeDays', label: 'Shelf life (days)', type: 'number' },
    { name: 'active', label: 'Active', type: 'checkbox' },
  ];
  const blank = { code: '', name: '', brandCode: '', category: '', packSize: '', caseSize: '', hsnCode: '', gstRatePct: '5', mrpRupees: '', shelfLifeDays: '', active: true };
  const initial = edit
    ? { code: edit.code, name: edit.name, brandCode: edit.brand.code, category: edit.category, packSize: edit.packSize, caseSize: String(edit.caseSize), hsnCode: edit.hsnCode, gstRatePct: String(edit.gstRateBp / 100), mrpRupees: String(edit.mrpPaise / 100), shelfLifeDays: String(edit.shelfLifeDays), active: edit.active }
    : blank;
  return (
    <>
      <Card title={edit ? `Edit ${edit.code}` : 'New product'} action={edit && <Button variant="ghost" onClick={() => setEdit(null)}>New instead</Button>}>
        <EntityForm fields={fields} initial={initial} schema={ProductInput} onSubmit={save('/admin/products', qc)} />
      </Card>
      <Card title="Products">
        <Table head={['SKU', 'Name', 'Brand', 'HSN', 'GST', 'MRP', '']}>
          {m?.products.map((p: any) => (
            <tr key={p.id}>
              <Td className="font-mono text-xs">{p.code}</Td><Td>{p.name}</Td><Td>{p.brand.name}</Td><Td>{p.hsnCode}</Td><Td>{p.gstRateBp / 100}%</Td><Td>{rupees(p.mrpPaise)}</Td>
              <Td><Button variant="ghost" onClick={() => setEdit(p)}>Edit</Button></Td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Price lists — effective-dated versions">
        <Table head={['Code', 'Scope', 'Valid', 'Items', '']}>
          {m?.priceLists.map((p: any) => (
            <tr key={p.id}>
              <Td className="font-mono text-xs">{p.code}</Td>
              <Td>{p.channelCode ?? 'all channels'} / {p.stateCode ?? 'all states'}</Td>
              <Td className="text-xs">{new Date(p.validFrom).toLocaleDateString('en-IN')} → {p.validTo ? new Date(p.validTo).toLocaleDateString('en-IN') : 'open'}</Td>
              <Td>{p._count.items}</Td>
              <Td>{!p.validTo && <Button variant="ghost" onClick={() => setListId(p.id)}>Revise</Button>}</Td>
            </tr>
          ))}
        </Table>
        {list.data && <PriceRevision list={list.data} onDone={() => { setListId(''); void qc.invalidateQueries({ queryKey: ['masters'] }); }} />}
      </Card>
      <MarginRules />
    </>
  );
}

function PriceRevision({ list, onDone }: { list: any; onDone: () => void }) {
  const [prices, setPrices] = useState<Record<string, string>>(Object.fromEntries(list.items.map((i: any) => [i.product.code, String(i.basePaise / 100)])));
  const [from, setFrom] = useState(new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  const [err, setErr] = useState<unknown>(null);
  const changed = list.items.filter((i: any) => Number(prices[i.product.code]) * 100 !== i.basePaise);
  return (
    <div className="mt-4 rounded-lg border border-slate-200 p-3">
      <div className="mb-2 text-sm font-medium">New version of {list.code} — changed rows only are sent; orders captured before the date keep old prices.</div>
      <div className="grid gap-2 sm:grid-cols-2">
        {list.items.map((i: any) => (
          <label key={i.id} className="flex items-center gap-2 text-sm">
            <span className="flex-1 truncate">{i.product.name}</span>
            <Input className="w-28" value={prices[i.product.code]} onChange={(e) => setPrices({ ...prices, [i.product.code]: e.target.value })} />
          </label>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div><Label>Effective from</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <Button
          disabled={changed.length === 0}
          onClick={async () => {
            setErr(null);
            const body = { validFrom: new Date(`${from}T00:00:00+05:30`).toISOString(), items: changed.map((i: any) => ({ productCode: i.product.code, baseRupees: Number(prices[i.product.code]) })) };
            const r = PriceRevisionInput.safeParse(body);
            if (!r.success) return setErr(new Error(r.error.issues[0].message));
            try {
              await api(`/admin/price-lists/${list.id}/revise`, body);
              onDone();
            } catch (e) {
              setErr(e);
            }
          }}
        >
          Publish {changed.length} change(s)
        </Button>
      </div>
      <ErrorNote error={err} />
    </div>
  );
}

function MarginRules() {
  const qc = useQueryClient();
  const m = useMasters().data;
  const fields: Field[] = [
    { name: 'channelCode', label: 'Channel', type: 'select', options: opts(m?.channels) },
    { name: 'stateCode', label: 'State code' },
    { name: 'tier', label: 'Partner tier' },
    { name: 'brandCode', label: 'Brand code' },
    { name: 'productCode', label: 'SKU code' },
    { name: 'marginPct', label: 'Margin %', type: 'number' },
    { name: 'validFrom', label: 'Valid from', type: 'date' },
  ];
  const clean = (v: Record<string, any>) => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== ''));
  return (
    <Card title="Trade margins — most specific rule wins (SKU › brand › tier › channel › state)">
      <EntityForm fields={fields} initial={{ marginPct: '', validFrom: new Date().toISOString().slice(0, 10) }} schema={MarginRuleInput} toInput={clean} onSubmit={save('/admin/margin-rules', qc)} submitLabel="Add rule" />
      <div className="mt-4">
        <Table head={['Scope', 'Margin', 'Valid', '']}>
          {m?.marginRules.map((r: any) => (
            <tr key={r.id}>
              <Td className="text-xs">{[r.channelCode, r.stateCode, r.tier, r.brandId && 'brand', r.productId && 'SKU'].filter(Boolean).join(' · ') || 'all'}</Td>
              <Td>{r.marginBp / 100}%</Td>
              <Td className="text-xs">{new Date(r.validFrom).toLocaleDateString('en-IN')} → {r.validTo ? new Date(r.validTo).toLocaleDateString('en-IN') : 'open'}</Td>
              <Td>{!r.validTo && <Button variant="ghost" onClick={async () => { await api(`/admin/margin-rules/${r.id}/end`, {}); await qc.invalidateQueries({ queryKey: ['masters'] }); }}>End now</Button>}</Td>
            </tr>
          ))}
        </Table>
      </div>
    </Card>
  );
}

function Distributors() {
  const qc = useQueryClient();
  const m = useMasters().data;
  const [edit, setEdit] = useState<any>(null);
  const managers = (m?.users ?? []).filter((u: any) => u.role === 'MANAGER');
  const fields: Field[] = [
    { name: 'code', label: 'Code (≤ 6, used in invoice numbers)' },
    { name: 'name', label: 'Name' },
    { name: 'gstin', label: 'GSTIN' },
    { name: 'stateCode', label: 'State code' },
    { name: 'city', label: 'City' },
    { name: 'address', label: 'Address' },
    { name: 'lat', label: 'Latitude', type: 'number' },
    { name: 'lng', label: 'Longitude', type: 'number' },
    { name: 'tier', label: 'Tier' },
    { name: 'managerEmail', label: 'Responsible ASM', type: 'select', options: managers.map((u: any) => ({ value: u.email, label: `${u.name} (${u.title})` })) },
    { name: 'active', label: 'Active', type: 'checkbox' },
  ];
  const blank = { code: '', name: '', gstin: '', stateCode: '', city: '', address: '', lat: '', lng: '', tier: '', managerEmail: '', active: true };
  const initial = edit ? { ...blank, ...edit, lat: String(edit.lat), lng: String(edit.lng), tier: edit.tier ?? '', managerEmail: managers.find((u: any) => u.hierarchyPath === edit.hierarchyPath)?.email ?? '' } : blank;
  return (
    <>
      <Card title={edit ? `Edit ${edit.code}` : 'New distributor'} action={edit && <Button variant="ghost" onClick={() => setEdit(null)}>New instead</Button>}>
        <EntityForm fields={fields} initial={initial} schema={DistributorInput} onSubmit={save('/admin/distributors', qc)} />
      </Card>
      <Card title="Distributors">
        <Table head={['Code', 'Distributor', 'GSTIN', 'Territory', '']}>
          {m?.distributors.map((d: any) => (
            <tr key={d.id}>
              <Td>{d.code}</Td><Td>{d.name}<div className="text-xs text-slate-500">{d.city}</div></Td><Td className="font-mono text-xs">{d.gstin}</Td><Td className="font-mono text-xs">{d.hierarchyPath}</Td>
              <Td><Button variant="ghost" onClick={() => setEdit(d)}>Edit</Button></Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}

function People() {
  const qc = useQueryClient();
  const m = useMasters().data;
  const managers = (m?.users ?? []).filter((u: any) => u.role === 'MANAGER');
  const userFields: Field[] = [
    { name: 'email', label: 'Email (login)' },
    { name: 'name', label: 'Name' },
    { name: 'role', label: 'Role', type: 'select', options: ROLES.map((r) => ({ value: r, label: r })) },
    { name: 'title', label: 'Title' },
    { name: 'managerEmail', label: 'Reports to', type: 'select', options: managers.map((u: any) => ({ value: u.email, label: `${u.name} (${u.title})` })) },
    { name: 'distributorCode', label: 'Distributor (DSR / distributor users)', type: 'select', options: opts(m?.distributors) },
    { name: 'outletCode', label: 'Outlet (retailer users)' },
    { name: 'password', label: 'Initial / new password' },
  ];
  const beatFields: Field[] = [
    { name: 'code', label: 'Beat code' },
    { name: 'name', label: 'Name' },
    { name: 'distributorCode', label: 'Distributor', type: 'select', options: opts(m?.distributors) },
    { name: 'dsrEmail', label: 'DSR', type: 'select', options: (m?.users ?? []).filter((u: any) => u.role === 'DSR').map((u: any) => ({ value: u.email, label: u.name })) },
    { name: 'days', label: 'Days (0=Sun … 6=Sat)', hint: 'e.g. 1,3,5' },
    { name: 'anchorLat', label: 'Start latitude', type: 'number' },
    { name: 'anchorLng', label: 'Start longitude', type: 'number' },
    { name: 'geofenceM', label: 'Attendance geofence (m)', type: 'number' },
    { name: 'outlets', label: 'Outlet codes in visit order', span: 2, hint: 'Comma-separated' },
  ];
  const clean = (v: Record<string, any>) => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== ''));
  return (
    <>
      <Card title="Add or update a person (hierarchy path is derived from 'reports to')">
        <EntityForm fields={userFields} initial={{ role: 'DSR' }} schema={UserInput} toInput={clean} onSubmit={save('/admin/users', qc)} />
      </Card>
      <Card title="Field hierarchy">
        <Table head={['Path', 'Name', 'Role']}>
          {[...(m?.users ?? [])].sort((a: any, b: any) => a.hierarchyPath.localeCompare(b.hierarchyPath)).map((u: any) => (
            <tr key={u.id}>
              <Td className="font-mono text-xs" >{' '.repeat(Math.max(0, (u.hierarchyPath.split('/').length - 3) * 3))}{u.hierarchyPath}</Td>
              <Td>{u.name}<div className="text-xs text-slate-500">{u.email}</div></Td><Td>{u.title ?? u.role}</Td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Beats / journey plans">
        <EntityForm
          fields={beatFields}
          initial={{ geofenceM: '500', days: '1,2,3,4,5,6' }}
          schema={BeatInput}
          toInput={(v) => ({ ...v, daysOfWeek: String(v.days ?? '').split(',').filter(Boolean).map(Number), outletCodes: String(v.outlets ?? '').split(',').map((s) => s.trim()).filter(Boolean) })}
          onSubmit={save('/admin/beats', qc)}
        />
        <div className="mt-4">
          <Table head={['Beat', 'DSR', 'Days', 'Outlets']}>
            {m?.beats.map((b: any) => <tr key={b.id}><Td>{b.code} — {b.name}</Td><Td>{b.dsr.name}</Td><Td>{b.daysOfWeek.join(',')}</Td><Td>{b._count.outlets}</Td></tr>)}
          </Table>
        </div>
      </Card>
    </>
  );
}

function Config() {
  const qc = useQueryClient();
  const m = useMasters().data;
  return (
    <>
      <Card title="Channels — add a channel without code changes">
        <EntityForm
          fields={[{ name: 'code', label: 'Code' }, { name: 'name', label: 'Name' }, { name: 'minResidualShelfDays', label: 'Min residual shelf life (days)', type: 'number' }]}
          initial={{ minResidualShelfDays: '15' }}
          schema={ChannelInput}
          onSubmit={save('/admin/channels', qc)}
        />
        <div className="mt-4">
          <Table head={['Channel', 'Min residual shelf life']}>
            {m?.channels.map((c: any) => <tr key={c.id}><Td>{c.code} — {c.name}</Td><Td>{c.minResidualShelfDays} days</Td></tr>)}
          </Table>
        </div>
      </Card>
      <Card title="RTM / delivery models — behaviour is these columns">
        <EntityForm
          fields={[
            { name: 'code', label: 'Code' },
            { name: 'name', label: 'Name' },
            { name: 'stockSource', label: 'Stock source', type: 'select', options: STOCK_SOURCES.map((s) => ({ value: s, label: s })) },
            { name: 'invoiceTiming', label: 'Invoice timing', type: 'select', options: INVOICE_TIMINGS.map((s) => ({ value: s, label: s })) },
            { name: 'autoFulfil', label: 'Fulfil + deliver at order time', type: 'checkbox' },
            { name: 'requiresCreditCheck', label: 'Credit check', type: 'checkbox' },
          ]}
          initial={{ stockSource: 'DISTRIBUTOR_WAREHOUSE', invoiceTiming: 'ON_DISPATCH', autoFulfil: false, requiresCreditCheck: true }}
          schema={RtmModelInput}
          onSubmit={save('/admin/rtm-models', qc)}
        />
        <div className="mt-4">
          <Table head={['Model', 'Stock source', 'Invoice', 'Auto-fulfil', 'Credit check']}>
            {m?.rtmModels.map((r: any) => <tr key={r.id}><Td>{r.code} — {r.name}</Td><Td>{r.stockSource}</Td><Td>{r.invoiceTiming}</Td><Td>{r.autoFulfil ? 'yes' : '—'}</Td><Td>{r.requiresCreditCheck ? 'yes' : '—'}</Td></tr>)}
          </Table>
        </div>
      </Card>
    </>
  );
}

const TEMPLATES: Record<string, string> = {
  products: 'code,name,brandCode,category,packSize,caseSize,hsnCode,gstRatePct,mrpRupees,shelfLifeDays\nIND-RICE-5KG,Independence Basmati Rice 5 kg,INDEPENDENCE,Staples,5 kg,4,10063020,5,650,365\n',
  distributors: 'code,name,gstin,stateCode,city,address,lat,lng,tier,managerEmail\nMH02,Konkan Traders,27AAKFK1234M1Z5,27,Thane,Wagle Estate,19.2,72.97,GOLD,asm.mumbai@rcpl.test\n',
  outlets: 'code,name,ownerName,phone,gstin,channelCode,tier,stateCode,city,address,lat,lng,creditLimitRupees,services\nOUT-101,Shiv Shakti Stores,Anil More,9822001100,,GT,SILVER,27,Mumbai,Versova Road,19.131,72.818,40000,DISTRIBUTOR_LED:MH01\n',
  prices: 'productCode,baseRupees\nCAMPA-COLA-500,12.75\n',
};

function Import() {
  const qc = useQueryClient();
  const m = useMasters().data;
  const [entity, setEntity] = useState('outlets');
  const [csv, setCsv] = useState(TEMPLATES.outlets);
  const [priceList, setPriceList] = useState('PL-NATIONAL-FY27');
  const [validFrom, setValidFrom] = useState(new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const history = useQuery({ queryKey: ['imports'], queryFn: () => api<any[]>('/admin/imports') });
  const run = async (dryRun: boolean) => {
    setErr(null);
    try {
      const r = await api(`/admin/import/${entity}`, { csv, dryRun, priceListCode: priceList, validFrom: new Date(`${validFrom}T00:00:00+05:30`).toISOString() });
      setResult(r);
      await qc.invalidateQueries();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <>
      <Card title="Bulk import (CSV) — validated row by row, applied all-or-nothing">
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <div>
            <Label>What</Label>
            <Select value={entity} onChange={(e) => { setEntity(e.target.value); setCsv(TEMPLATES[e.target.value]); setResult(null); }}>
              {Object.keys(TEMPLATES).map((k) => <option key={k} value={k}>{k}</option>)}
            </Select>
          </div>
          {entity === 'prices' && (
            <>
              <div><Label>Price list</Label><Select value={priceList} onChange={(e) => setPriceList(e.target.value)}>{(m?.priceLists ?? []).filter((p: any) => !p.validTo).map((p: any) => <option key={p.id} value={p.code.replace(/~v\d+$/, '')}>{p.code}</option>)}</Select></div>
              <div><Label>Effective from</Label><Input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} /></div>
            </>
          )}
          <label className="cursor-pointer rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50">
            Load file…
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} />
          </label>
        </div>
        <textarea className="h-40 w-full rounded-lg border border-slate-300 p-2 font-mono text-xs" value={csv} onChange={(e) => setCsv(e.target.value)} />
        <div className="mt-2 flex gap-2">
          <Button variant="secondary" onClick={() => run(true)}>Validate (dry run)</Button>
          <Button onClick={() => run(false)}>Import</Button>
        </div>
        <ErrorNote error={err} />
        {result && (
          <div className="mt-3 text-sm">
            <Badge tone={result.status === 'INVALID' ? 'red' : 'green'}>{result.status}</Badge> {result.okRows}/{result.totalRows} rows OK
            <ul className="mt-2 space-y-1 text-xs text-red-700">
              {result.errors.map((e: any, i: number) => <li key={i}>{e.row ? `Row ${e.row}: ` : ''}{e.errors.join('; ')}</li>)}
            </ul>
          </div>
        )}
      </Card>
      <Card title="Recent imports">
        <Table head={['When', 'What', 'Mode', 'Result', 'Rows']}>
          {history.data?.map((j) => (
            <tr key={j.id}><Td className="text-xs">{new Date(j.createdAt).toLocaleString('en-IN')}</Td><Td>{j.entity}</Td><Td>{j.dryRun ? 'dry run' : 'apply'}</Td><Td><Badge tone={j.status === 'INVALID' ? 'red' : 'green'}>{j.status}</Badge></Td><Td>{j.okRows}/{j.totalRows}</Td></tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
