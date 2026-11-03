import { useQuery } from '@tanstack/react-query';
import { rupees } from '@rtm/shared';
import { api } from '../../lib/api';
import { dt, statusTone } from '../../lib/format';
import { Badge, Card, Empty, ErrorNote, Stat, Table, Td } from '../../components/ui';
import { Shell } from '../../components/Shell';

/** Placeholder retailer surface until the eB2B app (Phase 5): orders placed for me + what I owe. */
export function RetailerApp() {
  const q = useQuery({ queryKey: ['retailer'], queryFn: () => api<any>('/retailer/summary') });
  const s = q.data;
  return (
    <Shell narrow nav={[{ to: '/retailer', label: 'My account', end: true }]}>
      <ErrorNote error={q.error} />
      {s && (
        <>
          <Card title={s.outlet?.name}>
            <div className="text-sm text-slate-600">{s.outlet?.address}, {s.outlet?.city}</div>
            <p className="mt-2 text-xs text-slate-500">Self-service ordering and online payments arrive with the eB2B app (Phase 5).</p>
          </Card>
          <div className="grid grid-cols-2 gap-3">
            {s.balances.map((b: any) => <Stat key={b.distributor} label={`Outstanding — ${b.distributor}`} value={rupees(b.outstandingPaise)} />)}
          </div>
          <Card title="Recent orders">
            {s.orders.length === 0 ? (
              <Empty>No orders yet.</Empty>
            ) : (
              <Table head={['Order', 'Date', 'Total', 'Status']}>
                {s.orders.map((o: any) => (
                  <tr key={o.id}><Td>{o.orderNo}</Td><Td>{dt(o.receivedAt)}</Td><Td>{rupees(o.totalPaise)}</Td><Td><Badge tone={statusTone[o.status]}>{o.status}</Badge></Td></tr>
                ))}
              </Table>
            )}
          </Card>
        </>
      )}
    </Shell>
  );
}
