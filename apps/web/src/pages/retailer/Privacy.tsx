import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { dt } from '../../lib/format';
import { Badge, Button, Card, ErrorNote, Input } from '../../components/ui';

/** DPDP: first-use notice + consent. Optional purposes can be changed any time in the Privacy tab. */
export function ConsentGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const consents = useQuery({ queryKey: ['consents'], queryFn: () => api<any>('/privacy/consents'), retry: false });
  const notice = useQuery({ queryKey: ['notice'], queryFn: () => api<any>('/privacy/notice'), retry: false });
  const [opt, setOpt] = useState<Record<string, boolean>>({ MARKETING: false, ANALYTICS: false, CREDIT_ASSESSMENT: true });
  const save = useMutation({
    mutationFn: () => api('/privacy/consents', { items: [{ purpose: 'ORDER_PROCESSING', granted: true }, ...Object.entries(opt).map(([purpose, granted]) => ({ purpose, granted }))] }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['consents'] }),
  });
  // Offline: keep working with what's on the device; the server re-checks consent on sync.
  if (consents.isError || consents.data?.complete || !notice.data) return <>{children}</>;
  return (
    <Card title="Your privacy">
      <div className="space-y-3 text-sm">
        <p>{notice.data.controller} processes your shop's data in India. {notice.data.residency}</p>
        {notice.data.purposes.map((p: any) => (
          <label key={p.code} className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={p.required || !!opt[p.code]} disabled={p.required} onChange={(e) => setOpt({ ...opt, [p.code]: e.target.checked })} />
            <span>{p.text} {p.required && <Badge tone="slate">required</Badge>}</span>
          </label>
        ))}
        <p className="text-xs text-slate-500">You can access, correct or erase your data and withdraw optional consents at any time. Grievance officer: {notice.data.grievanceOfficer}. Notice {notice.data.version}.</p>
        <Button className="w-full" onClick={() => save.mutate()} disabled={save.isPending}>Agree and continue</Button>
        <ErrorNote error={save.error} />
      </div>
    </Card>
  );
}

export function PrivacyCentre() {
  const qc = useQueryClient();
  const consents = useQuery({ queryKey: ['consents'], queryFn: () => api<any>('/privacy/consents') });
  const requests = useQuery({ queryKey: ['data-requests'], queryFn: () => api<any[]>('/privacy/requests') });
  const toggle = useMutation({ mutationFn: (i: { purpose: string; granted: boolean }) => api('/privacy/consents', { items: [i] }), onSuccess: () => qc.invalidateQueries({ queryKey: ['consents'] }) });
  const [details, setDetails] = useState('');
  const raise = useMutation({ mutationFn: (type: string) => api('/privacy/requests', { type, details: details || undefined }), onSuccess: () => qc.invalidateQueries({ queryKey: ['data-requests'] }) });
  const download = async () => {
    const data = await api('/privacy/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'my-rcpl-data.json';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <Card title="Consents">
        <ul className="divide-y divide-slate-100 text-sm">
          {consents.data?.state.map((c: any) => (
            <li key={c.purpose} className="flex items-center justify-between py-2">
              <span>{c.purpose.replace('_', ' ').toLowerCase()}<div className="text-xs text-slate-500">{c.at ? `since ${dt(c.at)}` : 'not given'}</div></span>
              {c.purpose === 'ORDER_PROCESSING' ? <Badge tone="slate">required</Badge> : (
                <Button variant={c.granted ? 'secondary' : 'primary'} onClick={() => toggle.mutate({ purpose: c.purpose, granted: !c.granted })}>{c.granted ? 'Withdraw' : 'Allow'}</Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Your data">
        <div className="space-y-2">
          <Button variant="secondary" className="w-full" onClick={download}>Download a copy (JSON)</Button>
          <Input placeholder="Details (optional) — e.g. what to correct" value={details} onChange={(e) => setDetails(e.target.value)} />
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => raise.mutate('CORRECTION')}>Request correction</Button>
            <Button variant="danger" onClick={() => confirm('Erase your personal data? Tax records are kept as the law requires; you will no longer be able to log in.') && raise.mutate('ERASURE')}>Request erasure</Button>
          </div>
          <ErrorNote error={raise.error} />
        </div>
        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          {requests.data?.map((r) => <li key={r.id} className="flex justify-between py-2"><span>{r.type.toLowerCase()} · {dt(r.createdAt)}</span><Badge tone={r.status === 'OPEN' ? 'amber' : 'green'}>{r.status}</Badge></li>)}
        </ul>
      </Card>
    </>
  );
}
