import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth, type SessionUser } from '../lib/auth';
import { Button, ErrorNote, Input, Label } from '../components/ui';

// Seeded demo accounts (see apps/api/prisma/seed.ts). Password for all: Rcpl@1234.
const DEMO = [
  { email: 'dsr.ravi@rcpl.test', label: 'DSR — Ravi (Mumbai, has a van)' },
  { email: 'dist.mh01@rcpl.test', label: 'Distributor — Shree Ganesh (MH01)' },
  { email: 'hq@rcpl.test', label: 'HQ — National Sales Head (MFA)' },
  { email: 'asm.mumbai@rcpl.test', label: 'Manager — ASM Mumbai (MFA)' },
  { email: 'retailer.gt@rcpl.test', label: 'Retailer — Laxmi Kirana (eB2B)' },
  { email: 'admin@rcpl.test', label: 'Admin (MFA)' },
];

type Session = { token: string; home: string; user: SessionUser };
type Challenge = { mfaRequired: true; enroll: boolean; secret?: string; otpauthUrl?: string; mfaToken: string; demoCode?: string };

export function LoginPage() {
  const navigate = useNavigate();
  const setSession = useAuth((s) => s.setSession);
  const [email, setEmail] = useState(DEMO[0].email);
  const [password, setPassword] = useState('Rcpl@1234');
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const done = (r: Session) => {
    setSession(r.token, r.user, r.home);
    navigate(r.home, { replace: true });
  };

  async function submit(e?: FormEvent, asEmail = email) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<Session | Challenge>('/auth/login', { tenant: 'rcpl', email: asEmail, password });
      if ('mfaRequired' in r) {
        setChallenge(r);
        setCode('');
      } else done(r);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      done(await api<Session>('/auth/mfa/verify', { mfaToken: challenge.mfaToken, code }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-gradient-to-b from-red-700 to-red-900 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-5 flex items-center gap-3">
          <img src="/icon.svg" alt="" className="h-10 w-10" />
          <div>
            <h1 className="text-lg font-semibold">RCPL Route-to-Market</h1>
            <p className="text-xs text-slate-500">Field sales · distribution · retail</p>
          </div>
        </div>
        {challenge ? (
          <form onSubmit={verify} className="space-y-3">
            {challenge.enroll ? (
              <div className="space-y-2 text-sm">
                <p className="font-medium">Set up two-step verification</p>
                <p className="text-slate-600">Add this key to Google Authenticator, Microsoft Authenticator or Authy, then enter the 6-digit code.</p>
                <div className="break-all rounded-md bg-slate-100 p-2 font-mono text-xs">{challenge.secret}</div>
                <a className="text-xs text-red-700 underline" href={challenge.otpauthUrl}>Open in authenticator app</a>
              </div>
            ) : (
              <p className="text-sm text-slate-600">Enter the 6-digit code from your authenticator app.</p>
            )}
            <div>
              <Label>Verification code</Label>
              <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
            </div>
            {challenge.demoCode && (
              <button type="button" className="w-full rounded-md bg-amber-50 px-2 py-1 text-left text-xs text-amber-800" onClick={() => setCode(challenge.demoCode!)}>
                Demo mode: current code is <span className="font-mono font-semibold">{challenge.demoCode}</span> (tap to fill)
              </button>
            )}
            <ErrorNote error={error} />
            <Button type="submit" disabled={busy || code.length !== 6} className="w-full">{busy ? 'Verifying…' : 'Verify'}</Button>
            <button type="button" className="w-full text-xs text-slate-500" onClick={() => setChallenge(null)}>← Back</button>
          </form>
        ) : (
          <>
            <form onSubmit={submit} className="space-y-3">
              <div>
                <Label>Email</Label>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
              </div>
              <div>
                <Label>Password</Label>
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              </div>
              <ErrorNote error={error} />
              <Button type="submit" disabled={busy} className="w-full">{busy ? 'Signing in…' : 'Sign in'}</Button>
            </form>
            <div className="mt-5 border-t border-slate-100 pt-4">
              <div className="mb-2 text-xs font-medium text-slate-500">Demo accounts (password Rcpl@1234)</div>
              <div className="space-y-1">
                {DEMO.map((d) => (
                  <button key={d.email} disabled={busy} onClick={() => { setEmail(d.email); void submit(undefined, d.email); }} className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-red-50">
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
