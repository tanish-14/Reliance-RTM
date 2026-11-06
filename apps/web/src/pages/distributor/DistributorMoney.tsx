import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rupees } from '@rtm/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dt } from '../../lib/format';
import { Badge, Button, Card, Empty, ErrorNote, Input, Label, PromptButton, Select, Table, Td } from '../../components/ui';

const tone = (s: string) => (['VERIFIED', 'CLEARED', 'RECEIVED', 'MATCHED', 'PROCESSED', 'SETTLED', 'APPROVED', 'VALIDATED', 'BANK_MATCHED'].includes(s) ? 'green' : ['FAILED', 'BOUNCED', 'REJECTED', 'EXCEPTION', 'SHORT'].includes(s) ? 'red' : 'amber');

export function Payments() {
  const qc = useQueryClient();
  const [mode, setMode] = useState('');
  const q = useQuery({ queryKey: ['payments', mode], queryFn: () => api<any[]>(`/payments${mode ? `?mode=${mode}` : ''}`) });
  const act = useMutation({ mutationFn: ({ path, body }: { path: string; body?: unknown }) => api(path, body ?? {}), onSuccess: () => qc.invalidateQueries() });
  return (
    <Card
      title="Receipts"
      action={
        <Select className="w-40" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="">All modes</option>
          {['CASH', 'UPI', 'CHEQUE', 'ONLINE', 'BANK_TRANSFER'].map((m) => <option key={m}>{m}</option>)}
        </Select>
      }
    >
      <ErrorNote error={q.error ?? act.error} />
      {q.data?.length === 0 ? (
        <Empty>No receipts.</Empty>
      ) : (
        <Table head={['Receipt', 'Outlet', 'Mode', 'Amount', 'Status', '']}>
          {q.data?.map((p) => (
            <tr key={p.id}>
              <Td><div className="font-medium">{p.receiptNo}</div><div className="text-xs text-slate-500">{dt(p.capturedAt)}</div></Td>
              <Td>{p.outlet}</Td>
              <Td>{p.mode}<div className="text-xs text-slate-500">{p.chequeNo ? `chq ${p.chequeNo} · ${p.chequeBank}` : p.reference ?? p.gatewayPaymentId ?? ''}</div></Td>
              <Td className="tabular-nums">{rupees(p.amountPaise)}{p.refunds.length > 0 && <div className="text-xs text-slate-500">refunded {rupees(p.refunds.reduce((a: number, r: any) => a + (r.status === 'PROCESSED' ? r.amountPaise : 0), 0))}</div>}</Td>
              <Td><Badge tone={tone(p.status)}>{p.status}</Badge>{p.failureReason && <div className="text-xs text-red-700">{p.failureReason}</div>}</Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  {p.mode === 'CHEQUE' && p.status === 'RECEIVED' && <Button variant="secondary" onClick={() => act.mutate({ path: `/payments/${p.id}/cheque/deposit` })}>Deposit</Button>}
                  {p.mode === 'CHEQUE' && ['RECEIVED', 'DEPOSITED'].includes(p.status) && (
                    <>
                      <Button variant="secondary" onClick={() => act.mutate({ path: `/payments/${p.id}/cheque/clear` })}>Cleared</Button>
                      <Button variant="danger" onClick={() => act.mutate({ path: `/payments/${p.id}/cheque/bounce`, body: { reason: 'Funds insufficient' } })}>Bounced</Button>
                    </>
                  )}
                  {p.mode === 'ONLINE' && ['RECEIVED', 'VERIFIED'].includes(p.status) && (
                    <PromptButton variant="ghost" label="Refund" placeholder="₹" defaultValue={String(p.amountPaise / 100)} confirmLabel="Refund" onSubmit={(v) => act.mutate({ path: `/payments/${p.id}/refund`, body: { amountPaise: Math.round(Number(v) * 100), reason: 'Customer refund' } })} />
                  )}
                </div>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

export function CashBank() {
  const qc = useQueryClient();
  const user = useAuth((s) => s.user)!;
  const deposits = useQuery({ queryKey: ['deposits'], queryFn: () => api<any[]>('/cash/deposits') });
  const lines = useQuery({ queryKey: ['recon-lines'], queryFn: () => api<any[]>(`/recon/lines?distributorId=${user.distributorId}`) });
  const today = new Date().toISOString().slice(0, 10);
  const [csv, setCsv] = useState(`date,amount,reference,narration\n${today},490.00,SLIP-0001,CASH DEPOSIT BY DSR\n`);
  const [result, setResult] = useState<any>(null);
  const imp = useMutation({ mutationFn: () => api('/recon/statements', { distributorId: user.distributorId, csv }), onSuccess: (r) => { setResult(r); void qc.invalidateQueries(); } });
  return (
    <>
      <Card title="Field cash deposits (day-end)">
        <ErrorNote error={deposits.error} />
        {deposits.data?.length === 0 ? <Empty>No deposits yet.</Empty> : (
          <Table head={['Deposit', 'Agent', 'Collected', 'Deposited', 'Variance', 'Status']}>
            {deposits.data?.map((d) => (
              <tr key={d.id}>
                <Td><div className="font-medium">{d.depositNo}</div><div className="text-xs text-slate-500">slip {d.bankRef} · {dt(d.createdAt)}</div></Td>
                <Td>{d.agent}</Td>
                <Td className="tabular-nums">{rupees(d.expectedPaise)}</Td>
                <Td className="tabular-nums">{rupees(d.declaredPaise)}</Td>
                <Td className={`tabular-nums ${d.variancePaise ? 'text-red-700 font-medium' : ''}`}>{rupees(d.variancePaise)}</Td>
                <Td><Badge tone={tone(d.status)}>{d.status}</Badge>{d.bankLineId && <Badge tone="green">bank ✓</Badge>}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Bank statement reconciliation">
        <p className="mb-2 text-sm text-slate-600">Paste or load your bank statement (CSV: date, amount in ₹, reference, narration). Credits are matched to deposits (slip no.), cheques (cheque no.), transfers and UPI (UTR). Anything else goes to the exception queue.</p>
        <div className="mb-2 flex gap-2">
          <label className="cursor-pointer rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50">
            Load CSV…
            <input type="file" accept=".csv" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} />
          </label>
          <Button onClick={() => imp.mutate()} disabled={imp.isPending}>Import &amp; match</Button>
        </div>
        <textarea className="h-28 w-full rounded-lg border border-slate-300 p-2 font-mono text-xs" value={csv} onChange={(e) => setCsv(e.target.value)} />
        <ErrorNote error={imp.error} />
        {result && <p className="mt-2 text-sm">{result.inserted} new lines ({result.duplicatesSkipped} already imported) · <span className="text-emerald-700">{result.matched} matched</span> · <span className="text-red-700">{result.exceptions} exceptions</span></p>}
        <div className="mt-4">
          <Table head={['Value date', 'Reference', 'Amount', 'Status', 'Matched to']}>
            {lines.data?.map((l) => (
              <tr key={l.id}>
                <Td>{new Date(l.valueDate).toLocaleDateString('en-IN')}</Td>
                <Td className="font-mono text-xs">{l.reference}<div className="text-slate-500">{l.narration}</div></Td>
                <Td className="tabular-nums">{rupees(l.amountPaise)}</Td>
                <Td><Badge tone={tone(l.status)}>{l.status}</Badge></Td>
                <Td className="text-xs">{l.matchedType ?? '—'}</Td>
              </tr>
            ))}
          </Table>
        </div>
      </Card>
      <Exceptions />
    </>
  );
}

export function Exceptions() {
  const q = useQuery({ queryKey: ['exceptions'], queryFn: () => api<any[]>('/exceptions') });
  return (
    <Card title={`Exception queue (${q.data?.length ?? 0})`}>
      {q.data?.length === 0 ? <Empty>Nothing needs attention.</Empty> : (
        <ul className="divide-y divide-slate-100 text-sm">
          {q.data?.map((e) => (
            <li key={e.id} className="py-2"><Badge tone={e.kind.includes('HOLD') || e.kind.includes('SHORT') || e.kind.includes('BOUNCED') ? 'red' : 'amber'}>{e.kind}</Badge> <span className="ml-1">{e.summary}</span><div className="text-xs text-slate-500">{dt(e.createdAt)}</div></li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function Credit() {
  const q = useQuery({ queryKey: ['credit-accounts'], queryFn: () => api<any[]>('/credit/accounts') });
  const req = useMutation({ mutationFn: ({ id, newLimitRupees }: { id: string; newLimitRupees: number }) => api(`/credit/accounts/${id}/limit-request`, { newLimitRupees, reason: 'Requested from credit screen' }) });
  const buckets = ['NOT_DUE', '1-15', '16-30', '31-60', '60+'];
  return (
    <Card title="Credit / khata — limits, exposure and ageing (FIFO)">
      <ErrorNote error={q.error ?? req.error} />
      {req.isSuccess && <p className="mb-2 text-sm text-emerald-700">Limit change sent for approval.</p>}
      <Table head={['Outlet', 'Limit', 'Exposure', ...buckets.map((b) => (b === 'NOT_DUE' ? 'Not due' : `${b} d`)), 'Status']}>
        {q.data?.map((a) => (
          <tr key={a.id}>
            <Td>{a.outlet?.name}<div className="text-xs text-slate-500">{a.creditDays} days · {a.bounceCount} bounces</div></Td>
            <Td className="tabular-nums">{rupees(a.limitPaise)}<div className="mt-1"><PromptButton variant="ghost" label="Change…" placeholder="New limit ₹" defaultValue={String(a.limitPaise / 100)} confirmLabel="Request" onSubmit={(v) => req.mutate({ id: a.id, newLimitRupees: Number(v) })} /></div></Td>
            <Td className={`tabular-nums ${a.position.exposurePaise > a.limitPaise ? 'text-red-700 font-medium' : ''}`}>{rupees(a.position.exposurePaise)}</Td>
            {buckets.map((b) => <Td key={b} className={`tabular-nums ${b !== 'NOT_DUE' && a.ageing.buckets[b] ? 'text-amber-700' : 'text-slate-500'}`}>{a.ageing.buckets[b] ? rupees(a.ageing.buckets[b]) : '—'}</Td>)}
            <Td>{a.blocked ? <Badge tone="red">{a.autoBlocked ? 'Auto-blocked' : 'Blocked'}</Badge> : <Badge tone="green">Open</Badge>}{a.blockReason && <div className="text-xs text-slate-500">{a.blockReason}</div>}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

export function Claims() {
  const qc = useQueryClient();
  const role = useAuth((s) => s.user)!.role;
  const claims = useQuery({ queryKey: ['claims'], queryFn: () => api<any[]>('/claims') });
  const schemes = useQuery({ queryKey: ['schemes'], queryFn: () => api<any[]>('/schemes') });
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const [f, setF] = useState({ schemeCode: '', periodFrom: monthStart, periodTo: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), claimedRupees: '' });
  const submit = useMutation({
    mutationFn: () => api('/claims', { ...f, periodFrom: new Date(`${f.periodFrom}T00:00:00+05:30`).toISOString(), periodTo: new Date(`${f.periodTo}T00:00:00+05:30`).toISOString(), claimedRupees: Number(f.claimedRupees) }),
    onSuccess: () => qc.invalidateQueries(),
  });
  const decide = useMutation({ mutationFn: ({ id, decision }: { id: string; decision: string }) => api(`/claims/${id}/decide`, { decision }), onSuccess: () => qc.invalidateQueries() });
  const settle = useMutation({ mutationFn: (id: string) => api(`/claims/${id}/settle`, {}), onSuccess: () => qc.invalidateQueries() });
  return (
    <>
      {role === 'DISTRIBUTOR' && (
        <Card title="Raise a scheme claim — validated against your actual invoiced secondary sales">
          <div className="grid gap-3 sm:grid-cols-4">
            <div><Label>Scheme</Label><Select value={f.schemeCode} onChange={(e) => setF({ ...f, schemeCode: e.target.value })}><option value="">—</option>{schemes.data?.map((s) => <option key={s.id} value={s.code}>{s.code}</option>)}</Select></div>
            <div><Label>From</Label><Input type="date" value={f.periodFrom} onChange={(e) => setF({ ...f, periodFrom: e.target.value })} /></div>
            <div><Label>To (exclusive)</Label><Input type="date" value={f.periodTo} onChange={(e) => setF({ ...f, periodTo: e.target.value })} /></div>
            <div><Label>Claim amount (₹)</Label><Input value={f.claimedRupees} onChange={(e) => setF({ ...f, claimedRupees: e.target.value })} /></div>
          </div>
          <Button className="mt-3" disabled={!f.schemeCode || !f.claimedRupees || submit.isPending} onClick={() => submit.mutate()}>Submit claim</Button>
          <ErrorNote error={submit.error} />
        </Card>
      )}
      <Card title="Claims">
        <ErrorNote error={claims.error ?? decide.error ?? settle.error} />
        {claims.data?.length === 0 ? <Empty>No claims.</Empty> : (
          <Table head={['Claim', 'Scheme', 'Period', 'Claimed', 'Supported by sales', 'Approved', 'Status', '']}>
            {claims.data?.map((c) => (
              <tr key={c.id}>
                <Td><div className="font-medium">{c.claimNo}</div><div className="text-xs text-slate-500">{c.distributor?.code}</div></Td>
                <Td>{c.scheme?.code}</Td>
                <Td className="text-xs">{new Date(c.periodFrom).toLocaleDateString('en-IN')} – {new Date(c.periodTo).toLocaleDateString('en-IN')}</Td>
                <Td className="tabular-nums">{rupees(c.claimedPaise)}</Td>
                <Td className="tabular-nums">{rupees(c.validatedPaise)}<div className="text-xs text-slate-500">{c.evidence.invoices} invoices · {c.evidence.outlets} outlets</div></Td>
                <Td className="tabular-nums">{c.approvedPaise ? rupees(c.approvedPaise) : '—'}</Td>
                <Td><Badge tone={tone(c.status)}>{c.status}</Badge>{c.flags.map((x: string) => <Badge key={x} tone="red">{x}</Badge>)}</Td>
                <Td>
                  {role !== 'DISTRIBUTOR' && ['VALIDATED', 'PARTIALLY_VALIDATED'].includes(c.status) && (
                    <div className="flex gap-1"><Button onClick={() => decide.mutate({ id: c.id, decision: 'APPROVE' })}>Approve</Button><Button variant="secondary" onClick={() => decide.mutate({ id: c.id, decision: 'REJECT' })}>Reject</Button></div>
                  )}
                  {role === 'ADMIN' && c.status === 'APPROVED' && <Button onClick={() => settle.mutate(c.id)}>Settle</Button>}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
