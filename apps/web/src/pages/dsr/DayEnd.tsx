import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { rupees } from '@rtm/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dt } from '../../lib/format';
import { dbFor } from '../../offline/db';
import { Badge, Button, Card, Empty, ErrorNote, Input, Label } from '../../components/ui';

/** Day-end: cash the DSR is holding (per distributor) and the bank deposit against it. Needs network. */
export function DayEnd() {
  const user = useAuth((s) => s.user)!;
  const db = dbFor(user.id);
  const qc = useQueryClient();
  const outlets = useLiveQuery(() => db.outlets.toArray(), [db]) ?? [];
  const distributors = [...new Map(outlets.flatMap((o) => o.services).map((s) => [s.distributorId, s.distributorName])).entries()];
  const [distributorId, setDistributorId] = useState('');
  const dist = distributorId || distributors[0]?.[0] || '';
  const position = useQuery({ queryKey: ['cash-position', dist], queryFn: () => api<{ amountPaise: number }>(`/cash/position?distributorId=${dist}`), enabled: !!dist });
  const deposits = useQuery({ queryKey: ['deposits'], queryFn: () => api<any[]>('/cash/deposits') });
  const [amount, setAmount] = useState('');
  const [slip, setSlip] = useState('');
  const pending = useLiveQuery(() => db.outbox.where('status').equals('PENDING').filter((o) => o.type === 'COLLECTION').count(), [db]) ?? 0;
  const dep = useMutation({
    mutationFn: () => api('/cash/deposits', { distributorId: dist, declaredPaise: Math.round(Number(amount) * 100), bankRef: slip.trim(), slipDate: new Date().toISOString() }),
    onSuccess: () => { setAmount(''); setSlip(''); void qc.invalidateQueries(); },
  });
  return (
    <>
      <Card title="Cash in hand">
        {pending > 0 && <p className="mb-2 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">{pending} collection(s) not synced yet — sync before depositing so the figure is complete.</p>}
        {distributors.length > 1 && (
          <select className="mb-2 rounded-md border border-slate-300 px-2 py-1 text-sm" value={dist} onChange={(e) => setDistributorId(e.target.value)}>
            {distributors.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
        <div className="text-2xl font-semibold tabular-nums">{position.data ? rupees(position.data.amountPaise) : '…'}</div>
        <ErrorNote error={position.error} />
      </Card>
      <Card title="Record bank deposit">
        <div className="space-y-3">
          <div><Label>Amount deposited (₹)</Label><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div><Label>Deposit slip / reference no.</Label><Input value={slip} onChange={(e) => setSlip(e.target.value)} /></div>
          <p className="text-xs text-slate-500">Any difference from the cash you hold is recorded as a shortage or excess and sent to your manager.</p>
          <Button className="w-full" disabled={!amount || slip.trim().length < 4 || dep.isPending} onClick={() => dep.mutate()}>Submit deposit</Button>
          <ErrorNote error={dep.error} />
        </div>
      </Card>
      <Card title="My deposits">
        {deposits.data?.length === 0 ? <Empty>None yet.</Empty> : (
          <ul className="divide-y divide-slate-100 text-sm">
            {deposits.data?.map((d) => (
              <li key={d.id} className="flex items-center justify-between py-2">
                <div><div className="font-medium">{d.depositNo} · {rupees(d.declaredPaise)}</div><div className="text-xs text-slate-500">{dt(d.createdAt)} · slip {d.bankRef}</div></div>
                <Badge tone={d.variancePaise ? 'red' : 'green'}>{d.variancePaise ? `${d.status} ${rupees(Math.abs(d.variancePaise))}` : d.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
