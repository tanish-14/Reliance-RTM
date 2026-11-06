import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rupees } from '@rtm/shared';
import { api } from '../../lib/api';
import { dt } from '../../lib/format';
import { Badge, Button, Card, Empty, ErrorNote, Input, Label, Stat, Table, Td } from '../../components/ui';

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}%`);

function Meter({ value }: { value: number }) {
  return (
    <div className="h-2 w-full min-w-16 rounded bg-slate-100">
      <div className="h-2 rounded bg-red-600" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

export function Kpis() {
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  const q = useQuery({ queryKey: ['kpis', from, to], queryFn: () => api<any>(`/reports/kpis?from=${from}&to=${to}`), refetchInterval: 30_000 });
  const k = q.data;
  return (
    <>
      <Card title="Period">
        <div className="flex flex-wrap items-end gap-3">
          <div><Label>From</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><Label>To (exclusive)</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          {k && <span className="text-sm text-slate-500">Outlet universe: {k.universe.outlets} ({k.universe.byChannel.map((c: any) => `${c.channel} ${c.outlets}`).join(' · ')})</span>}
        </div>
      </Card>
      <ErrorNote error={q.error} />
      {k && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Strike rate" value={pct(k.strikeRate.pct)} hint={`${k.strikeRate.productive}/${k.strikeRate.visits} visits productive`} />
            <Stat label="Credit utilisation" value={pct(k.credit.utilisationPct)} hint={`${rupees(k.credit.exposurePaise)} of ${rupees(k.credit.limitsPaise)}`} tone={k.credit.utilisationPct > 80 ? 'red' : undefined} />
            <Stat label="Overdue (>15 days)" value={rupees(k.credit.ageing['16-30'] + k.credit.ageing['31-60'] + k.credit.ageing['60+'])} hint={`${k.credit.blockedAccounts} accounts blocked`} tone={k.credit.blockedAccounts ? 'amber' : undefined} />
            <Stat label="Cash in transit" value={rupees(k.cashInTransitPaise)} hint="Collected, not deposited" />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Card title="Distribution by brand">
              <Table head={['Brand', 'Numeric', '', 'Weighted', 'Outlets']}>
                {k.distribution.byBrand.map((b: any) => (
                  <tr key={b.brand}><Td>{b.brand}</Td><Td>{pct(b.numericPct)}</Td><Td><Meter value={b.numericPct} /></Td><Td>{pct(b.weightedPct)}</Td><Td>{b.buyingOutlets}</Td></tr>
                ))}
              </Table>
              <p className="mt-2 text-xs text-slate-500">Numeric = share of outlets that bought. Weighted = those outlets' share of total sales.</p>
            </Card>
            <Card title="Distribution by SKU">
              <Table head={['SKU', 'Numeric', 'Weighted']}>
                {k.distribution.bySku.map((s: any) => <tr key={s.sku}><Td className="text-xs">{s.name}</Td><Td>{pct(s.numericPct)}</Td><Td>{pct(s.weightedPct)}</Td></tr>)}
              </Table>
            </Card>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Card title="Strike rate by DSR">
              {k.strikeRate.byDsr.length === 0 ? <Empty>No visits in this period.</Empty> : (
                <Table head={['DSR', 'Visits', 'Productive', 'Strike rate']}>
                  {k.strikeRate.byDsr.map((d: any) => <tr key={d.dsr}><Td>{d.dsr}</Td><Td>{d.visits}</Td><Td>{d.productive}</Td><Td>{pct(d.pct)}</Td></tr>)}
                </Table>
              )}
            </Card>
            <Card title="Receivables ageing">
              <Table head={['Bucket', 'Amount']}>
                {Object.entries(k.credit.ageing).map(([b, v]) => <tr key={b}><Td>{b === 'NOT_DUE' ? 'Not due' : `${b} days past due`}</Td><Td className="tabular-nums">{rupees(v as number)}</Td></tr>)}
              </Table>
            </Card>
          </div>
          <Card title={`Pipeline gap — stock cover vs ${k.targetCoverDays}-day target (30-day run-rate)`}>
            <Table head={['Distributor', 'SKU', 'Daily rate', 'On hand', 'Cover (days)', 'Gap (units)']}>
              {k.pipeline.slice(0, 20).map((p: any) => (
                <tr key={p.distributor + p.sku}><Td>{p.distributor}</Td><Td className="font-mono text-xs">{p.sku}</Td><Td>{p.dailyRate}</Td><Td>{p.onHand}</Td><Td className={p.coverDays !== null && p.coverDays < k.targetCoverDays ? 'text-red-700 font-medium' : ''}>{p.coverDays ?? '—'}</Td><Td className={p.gapUnits ? 'text-red-700 font-medium' : 'text-slate-400'}>{p.gapUnits || '—'}</Td></tr>
              ))}
            </Table>
          </Card>
          <Card title="Scheme ROI (incremental secondary sales ÷ scheme cost)">
            <Table head={['Scheme', 'Status', 'Sales during', 'Baseline', 'Incremental', 'Cost', 'ROI', 'Budget used']}>
              {k.schemeRoi.map((s: any) => (
                <tr key={s.schemeId}>
                  <Td>{s.code}<div className="text-xs text-slate-500">{s.type} · {s.days} days</div></Td>
                  <Td><Badge tone={s.status === 'ACTIVE' ? 'green' : 'slate'}>{s.status}</Badge></Td>
                  <Td className="tabular-nums">{rupees(s.salesDuringPaise)}</Td>
                  <Td className="tabular-nums">{rupees(s.salesBaselinePaise)}</Td>
                  <Td className="tabular-nums">{rupees(s.incrementalPaise)}</Td>
                  <Td className="tabular-nums">{rupees(s.costPaise)}</Td>
                  <Td className={`font-medium ${s.roi !== null && s.roi < 1 ? 'text-red-700' : 'text-emerald-700'}`}>{s.roi === null ? '—' : `${s.roi}×`}</Td>
                  <Td>{s.budgetUsedPct === null ? 'no cap' : <div className="flex items-center gap-2"><Meter value={s.budgetUsedPct} />{s.budgetUsedPct}%</div>}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
    </>
  );
}

export function Approvals() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['approvals'], queryFn: () => api<any>('/approvals'), refetchInterval: 15_000 });
  const decide = useMutation({ mutationFn: ({ id, decision }: { id: string; decision: string }) => api(`/approvals/${id}/decide`, { decision }), onSuccess: () => qc.invalidateQueries() });
  const d = q.data;
  return (
    <>
      <Card title={`Approvals waiting${d ? ` — you approve up to level ${d.myLevel}` : ''}`}>
        <ErrorNote error={q.error ?? decide.error} />
        {d?.pending.length === 0 ? <Empty>Nothing waiting.</Empty> : (
          <Table head={['Request', 'Kind', 'Amount', 'Needs level', 'Raised', '']}>
            {d?.pending.map((a: any) => (
              <tr key={a.id}>
                <Td>{a.title}</Td>
                <Td><Badge tone="blue">{a.kind.replace('_', ' ')}</Badge></Td>
                <Td className="tabular-nums">{a.amountPaise !== null ? rupees(a.amountPaise) : '—'}</Td>
                <Td>{a.requiredLevel === 3 ? 'National' : a.requiredLevel === 2 ? 'RSM' : 'ASM'}</Td>
                <Td className="text-xs">{dt(a.createdAt)}</Td>
                <Td>
                  {a.canDecide ? (
                    <div className="flex gap-1"><Button onClick={() => decide.mutate({ id: a.id, decision: 'APPROVE' })}>Approve</Button><Button variant="secondary" onClick={() => decide.mutate({ id: a.id, decision: 'REJECT' })}>Reject</Button></div>
                  ) : <span className="text-xs text-slate-500">Not yours to decide</span>}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Recently decided">
        <ul className="divide-y divide-slate-100 text-sm">
          {d?.recent.map((a: any) => <li key={a.id} className="flex justify-between py-2"><span>{a.title}</span><Badge tone={a.status === 'APPROVED' ? 'green' : 'red'}>{a.status}</Badge></li>)}
        </ul>
      </Card>
    </>
  );
}
