import { useQuery } from '@tanstack/react-query';
import { Route, Routes } from 'react-router-dom';
import { isValidGstin, rupees } from '@rtm/shared';
import { api } from '../../lib/api';
import { Badge, Card, ErrorNote, Table, Td } from '../../components/ui';
import { Shell } from '../../components/Shell';
import { AuditTrail } from '../hq/HqApp';

export function AdminApp() {
  return (
    <Shell
      nav={[
        { to: '/admin', label: 'Master data', end: true },
        { to: '/admin/audit', label: 'Audit trail' },
      ]}
    >
      <Routes>
        <Route index element={<Masters />} />
        <Route path="audit" element={<AuditTrail />} />
      </Routes>
    </Shell>
  );
}

/** Read-only in this slice; CRUD + bulk import arrive in Phase 2. */
function Masters() {
  const q = useQuery({ queryKey: ['masters'], queryFn: () => api<any>('/admin/masters') });
  const m = q.data;
  if (!m) return <ErrorNote error={q.error} />;
  return (
    <>
      <Card title="Channels & RTM models (configuration, not code)">
        <div className="grid gap-4 md:grid-cols-2">
          <Table head={['Channel', 'Min residual shelf life']}>
            {m.channels.map((c: any) => (
              <tr key={c.id}><Td>{c.code} — {c.name}</Td><Td>{c.minResidualShelfDays} days</Td></tr>
            ))}
          </Table>
          <Table head={['RTM model', 'Stock source', 'Invoice', 'Auto-fulfil']}>
            {m.rtmModels.map((r: any) => (
              <tr key={r.id}><Td>{r.name}</Td><Td>{r.stockSource}</Td><Td>{r.invoiceTiming}</Td><Td>{r.autoFulfil ? 'yes' : '—'}</Td></tr>
            ))}
          </Table>
        </div>
      </Card>
      <Card title={`Outlets (${m.outlets.length})`}>
        <Table head={['Code', 'Outlet', 'Channel', 'State', 'GSTIN', 'Served by']}>
          {m.outlets.map((o: any) => (
            <tr key={o.id}>
              <Td className="font-mono text-xs">{o.code}</Td>
              <Td>{o.name}<div className="text-xs text-slate-500">{o.city}</div></Td>
              <Td>{o.channel.code}</Td>
              <Td>{o.stateCode}</Td>
              <Td className="font-mono text-xs">{o.gstin ? <>{o.gstin} {isValidGstin(o.gstin) ? <Badge tone="green">valid</Badge> : <Badge tone="red">invalid</Badge>}</> : '—'}</Td>
              <Td>{o.services.map((s: any) => <Badge key={s.id} tone="blue">{s.rtmModel.code} · {s.distributor.code}</Badge>)}</Td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Products">
        <Table head={['SKU', 'Name', 'HSN', 'GST', 'MRP', 'Case']}>
          {m.products.map((p: any) => (
            <tr key={p.id}><Td className="font-mono text-xs">{p.code}</Td><Td>{p.name}</Td><Td>{p.hsnCode}</Td><Td>{p.gstRateBp / 100}%</Td><Td>{rupees(p.mrpPaise)}</Td><Td>{p.caseSize}</Td></tr>
          ))}
        </Table>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Price lists (effective-dated)">
          <Table head={['Code', 'Scope', 'Valid from', 'Items']}>
            {m.priceLists.map((p: any) => (
              <tr key={p.id}><Td>{p.code}</Td><Td>{p.channelCode ?? 'all channels'} / {p.stateCode ?? 'all states'}</Td><Td>{new Date(p.validFrom).toLocaleDateString('en-IN')}</Td><Td>{p._count.items}</Td></tr>
            ))}
          </Table>
        </Card>
        <Card title="Schemes">
          <Table head={['Code', 'Type', 'Channels', 'Valid to']}>
            {m.schemes.map((s: any) => (
              <tr key={s.id}><Td>{s.code}<div className="text-xs text-slate-500">{s.name}</div></Td><Td>{s.type}</Td><Td>{s.channelCodes.join(', ') || 'all'}</Td><Td>{new Date(s.validTo).toLocaleDateString('en-IN')}</Td></tr>
            ))}
          </Table>
        </Card>
      </div>
      <Card title="Distributors & field hierarchy">
        <div className="grid gap-4 md:grid-cols-2">
          <Table head={['Code', 'Distributor', 'GSTIN', 'Territory']}>
            {m.distributors.map((d: any) => (
              <tr key={d.id}><Td>{d.code}</Td><Td>{d.name}<div className="text-xs text-slate-500">{d.city}</div></Td><Td className="font-mono text-xs">{d.gstin}</Td><Td className="font-mono text-xs">{d.hierarchyPath}</Td></tr>
            ))}
          </Table>
          <Table head={['User', 'Role', 'Hierarchy']}>
            {m.users.map((u: any) => (
              <tr key={u.id}><Td>{u.name}<div className="text-xs text-slate-500">{u.email}</div></Td><Td>{u.title ?? u.role}</Td><Td className="font-mono text-xs">{u.hierarchyPath}</Td></tr>
            ))}
          </Table>
        </div>
      </Card>
    </>
  );
}
