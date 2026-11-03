import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Route, Routes } from 'react-router-dom';
import { rupees } from '@rtm/shared';
import { api } from '../../lib/api';
import { dt } from '../../lib/format';
import { Badge, Button, Card, Empty, ErrorNote, Stat, Table, Td } from '../../components/ui';
import { Shell } from '../../components/Shell';

export function HqApp() {
  return (
    <Shell nav={[{ to: '/hq', label: 'Overview', end: true }, { to: '/hq/audit', label: 'Audit trail' }]}>
      <Routes>
        <Route index element={<Overview />} />
        <Route path="audit" element={<AuditTrail />} />
      </Routes>
    </Shell>
  );
}

function Bars({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  if (rows.length === 0) return <Empty>No secondary sales yet this month.</Empty>;
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.label} className="text-sm">
          <div className="flex justify-between">
            <span>{r.label}</span>
            <span className="tabular-nums text-slate-600">{rupees(r.value)}</span>
          </div>
          <div className="mt-1 h-2 rounded bg-slate-100">
            <div className="h-2 rounded bg-red-600" style={{ width: `${(Math.abs(r.value) / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Overview() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['summary'], queryFn: () => api<any>('/reports/summary'), refetchInterval: 15_000 });
  const review = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'APPROVE' | 'REJECT' }) => api(`/orders/${id}/review`, { decision }),
    onSuccess: () => qc.invalidateQueries(),
  });
  const resolve = useMutation({
    mutationFn: (id: string) => api(`/exceptions/${id}/resolve`, { resolution: 'Reviewed — OK' }),
    onSuccess: () => qc.invalidateQueries(),
  });
  const s = q.data;
  if (!s) return <ErrorNote error={q.error} />;
  const exposure = s.creditExposure.reduce((a: number, r: any) => a + r.outstandingPaise, 0);
  const cit = s.cashInTransit.reduce((a: number, r: any) => a + r.amountPaise, 0);
  const openOrders = s.orders.filter((o: any) => ['CONFIRMED', 'PARTIALLY_FULFILLED', 'ON_HOLD'].includes(o.status)).reduce((a: number, o: any) => a + o.count, 0);
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Secondary sales MTD (net)" value={rupees(s.secondarySales.mtdNetPaise)} hint={`Today ${rupees(s.secondarySales.todayNetPaise)}`} />
        <Stat label="Credit exposure (AR)" value={rupees(exposure)} hint={`${s.creditExposure.length} outlets with balance`} />
        <Stat label="Cash in transit" value={rupees(cit)} hint="Collected, not yet deposited" tone={cit > 0 ? 'amber' : undefined} />
        <Stat label="Open orders" value={openOrders} hint={`${s.holds.length} on hold`} tone={s.holds.length ? 'red' : undefined} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Secondary sales by channel (MTD)">
          <Bars rows={s.secondarySales.byChannel.map((r: any) => ({ label: r.channelCode, value: r.netPaise }))} />
        </Card>
        <Card title="Secondary sales by brand (MTD)">
          <Bars rows={s.secondarySales.byBrand.map((r: any) => ({ label: r.brand, value: r.netPaise }))} />
        </Card>
      </div>

      <Card title={`Orders on hold (${s.holds.length})`}>
        <ErrorNote error={review.error} />
        {s.holds.length === 0 ? (
          <Empty>Nothing waiting for approval.</Empty>
        ) : (
          <Table head={['Order', 'Outlet', 'Distributor', 'Total', 'Why', '']}>
            {s.holds.map((h: any) => (
              <tr key={h.id}>
                <Td className="font-medium">{h.orderNo}</Td>
                <Td>{h.outlet}</Td>
                <Td>{h.distributor}</Td>
                <Td className="tabular-nums">{rupees(h.totalPaise)}</Td>
                <Td>{h.flags.map((f: string) => <Badge key={f} tone="amber">{f}</Badge>)}</Td>
                <Td>
                  <div className="flex gap-1">
                    <Button disabled={review.isPending} onClick={() => review.mutate({ id: h.id, decision: 'APPROVE' })}>Approve</Button>
                    <Button variant="secondary" disabled={review.isPending} onClick={() => review.mutate({ id: h.id, decision: 'REJECT' })}>Reject</Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Credit exposure by outlet">
          {s.creditExposure.length === 0 ? (
            <Empty>No receivables.</Empty>
          ) : (
            <Table head={['Outlet', 'Outstanding', 'Limit']}>
              {s.creditExposure.slice(0, 12).map((r: any) => (
                <tr key={r.outlet + r.distributor}>
                  <Td>{r.outlet}<div className="text-xs text-slate-500">{r.distributor}</div></Td>
                  <Td className={`tabular-nums ${r.limitPaise && r.outstandingPaise > r.limitPaise ? 'text-red-700 font-medium' : ''}`}>{rupees(r.outstandingPaise)}</Td>
                  <Td className="tabular-nums">{r.limitPaise ? rupees(r.limitPaise) : '—'}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="Cash in transit by agent">
          {s.cashInTransit.length === 0 ? (
            <Empty>No undeposited cash.</Empty>
          ) : (
            <Table head={['Agent', 'Distributor', 'Amount']}>
              {s.cashInTransit.map((r: any) => (
                <tr key={r.agent + r.distributor}>
                  <Td>{r.agent}</Td>
                  <Td>{r.distributor}</Td>
                  <Td className="tabular-nums">{rupees(r.amountPaise)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      <Card title={`Exceptions to review (${s.exceptions.length})`}>
        {s.exceptions.length === 0 ? (
          <Empty>All clear.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {s.exceptions.map((e: any) => (
              <li key={e.id} className="flex items-center justify-between gap-2 py-2">
                <div>
                  <Badge tone={e.kind === 'ORDER_HOLD' ? 'red' : 'amber'}>{e.kind}</Badge> <span className="ml-1">{e.summary}</span>
                  <div className="text-xs text-slate-500">{dt(e.createdAt)}</div>
                </div>
                {e.kind !== 'ORDER_HOLD' && (
                  <Button variant="secondary" disabled={resolve.isPending} onClick={() => resolve.mutate(e.id)}>Mark reviewed</Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Attendance today">
        {s.attendance.length === 0 ? (
          <Empty>No check-ins yet.</Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {s.attendance.map((a: any) => (
              <li key={a.id}>
                <span className="text-slate-400">{dt(a.capturedAt)}</span> {a.user} · {a.kind.replace('_', '-').toLowerCase()} · {a.distanceM ?? '?'} m from beat{' '}
                {a.flags.map((f: string) => <Badge key={f} tone="amber">{f}</Badge>)}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

export function AuditTrail() {
  const q = useQuery({ queryKey: ['audit'], queryFn: () => api<any[]>('/audit') });
  return (
    <Card title="Audit trail (immutable)">
      <ErrorNote error={q.error} />
      <Table head={['When', 'Who', 'Action', 'Entity', 'Detail']}>
        {q.data?.map((a) => (
          <tr key={a.id}>
            <Td className="whitespace-nowrap text-xs text-slate-500">{dt(a.at)}</Td>
            <Td className="text-xs">{a.actorRole}</Td>
            <Td><Badge tone="slate">{a.action}</Badge></Td>
            <Td className="text-xs">{a.entityType}</Td>
            <Td className="max-w-md truncate font-mono text-xs text-slate-600">{JSON.stringify(a.after ?? a.meta ?? {})}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}
