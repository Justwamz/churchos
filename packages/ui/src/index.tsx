import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { formatKes } from '@churchos/shared';
import { ApiError, createApi, type Api } from './api';

export { createApi, ApiError, API_URL } from './api';
export type { Api } from './api';
export { formatKes, toCents, DEFAULT_FEE_SCHEDULE } from '@churchos/shared';

/** KES from cents, for display. */
export const kes = (cents: number | string | null | undefined) => formatKes(Number(cents ?? 0));
export const shortDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' }) : '';
export const dateOnly = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Nairobi' }) : '';
export const phonePretty = (p: string | null | undefined) => (p ? p.replace(/^254/, '0') : '');

/** Loads data and exposes loading, error and a reload function. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    setLoading(true);
    fn()
      .then((d) => alive.current && (setData(d), setError(undefined)))
      .catch((e) => alive.current && setError(e instanceof ApiError ? e.message : 'Something went wrong'))
      .finally(() => alive.current && setLoading(false));
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

// ---------- small components ----------

export function Button(p: { children: ReactNode; onClick?: () => void; kind?: 'primary' | 'ghost' | 'danger'; disabled?: boolean; type?: 'button' | 'submit'; small?: boolean }) {
  return (
    <button type={p.type ?? 'button'} className={`btn ${p.kind ?? 'primary'} ${p.small ? 'small' : ''}`} onClick={p.onClick} disabled={p.disabled}>
      {p.children}
    </button>
  );
}

export function Card(p: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${p.className ?? ''}`}>
      {(p.title || p.action) && (
        <header className="card-head">
          <h3>{p.title}</h3>
          {p.action}
        </header>
      )}
      {p.children}
    </section>
  );
}

export function Stat(p: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className={`stat ${p.tone ?? ''}`}>
      <div className="stat-label">{p.label}</div>
      <div className="stat-value">{p.value}</div>
      {p.hint && <div className="stat-hint">{p.hint}</div>}
    </div>
  );
}

export function Badge(p: { children: ReactNode; tone?: 'good' | 'warn' | 'bad' | 'info' | 'muted' }) {
  return <span className={`badge ${p.tone ?? 'muted'}`}>{p.children}</span>;
}

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'info' | 'muted'> = {
  pending: 'warn', available: 'info', paid_out: 'good', paid: 'good', confirmed: 'good', completed: 'good', approved: 'good', recorded: 'good',
  reversed: 'bad', refunded: 'bad', failed: 'bad', rejected: 'bad', suspense: 'warn', counted: 'warn', requested: 'warn', initiated: 'warn',
  awaiting_second: 'warn', created: 'warn',
};
export const STATUS_LABEL: Record<string, string> = {
  pending: 'In 48h hold', available: 'Ready to pay out', paid_out: 'Paid out', reversed: 'Reversed', refunded: 'Refunded', suspense: 'Held (unmatched)',
  counted: 'Awaiting sign-off', recorded: 'Recorded', awaiting_second: 'Awaiting 2nd approver',
};
export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'muted'}>{STATUS_LABEL[status] ?? status.replace(/_/g, ' ')}</Badge>;
}

export function Field(p: { label: string; children: ReactNode; hint?: ReactNode; error?: string }) {
  return (
    <label className="field">
      <span className="field-label">{p.label}</span>
      {p.children}
      {p.hint && <span className="field-hint">{p.hint}</span>}
      {p.error && <span className="field-error">{p.error}</span>}
    </label>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div className="note bad" role="alert">{children}</div>;
}
export function Note({ children, tone }: { children: ReactNode; tone?: 'good' | 'warn' | 'bad' | 'info' }) {
  return <div className={`note ${tone ?? 'info'}`}>{children}</div>;
}

export function Table(p: { head: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className="table-wrap">
      <table className={`table ${p.className ?? ''}`}>
        <thead>
          <tr>{p.head.map((h, i) => <th key={i}>{h}</th>)}</tr>
        </thead>
        <tbody>{p.children}</tbody>
      </table>
    </div>
  );
}

export function Spinner() {
  return <div className="spinner" role="status" aria-label="Loading" />;
}

/** Toast messages that disappear on their own. */
export function useToast() {
  const [msg, setMsg] = useState<{ text: string; tone: 'good' | 'bad' } | null>(null);
  const show = useCallback((text: string, tone: 'good' | 'bad' = 'good') => {
    setMsg({ text, tone });
    setTimeout(() => setMsg(null), 4000);
  }, []);
  const node = msg ? <div className={`toast ${msg.tone}`} role="status">{msg.text}</div> : null;
  return { show, node };
}

// ---------- sign in (phone + one-time code) ----------

/**
 * Wraps an app so nothing renders until the user is signed in. In development the server returns the one-time code,
 * and this screen shows it, so testers never wait for an SMS.
 */
export function LoginGate(p: { api: Api; title: string; subtitle: string; allow?: (user: any) => boolean; children: (ctx: { user: any; signOut: () => void }) => ReactNode }) {
  const [user, setUser] = useState<any>(() => {
    try {
      return JSON.parse(localStorage.getItem(`${p.title}:user`) ?? 'null');
    } catch {
      return null;
    }
  });
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [devCode, setDevCode] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user && !p.api.getToken()) setUser(null);
  }, [user, p.api]);

  const signOut = () => {
    p.api.setToken(null);
    try { localStorage.removeItem(`${p.title}:user`); } catch { /* ignore */ }
    setUser(null);
    setStep('phone');
    setCode('');
  };

  if (user && p.api.getToken()) return <>{p.children({ user, signOut })}</>;

  const requestCode = async () => {
    setBusy(true); setError(undefined);
    try {
      const r = await p.api.post('/auth/otp/request', { phone });
      if (r.known === false) {
        // Only present in development builds: production answers identically for every number.
        setError('This number is not in the test data. Use one of the seeded numbers listed in the README, for example 0711000001 (member), 0700000002 (staff) or 0700000099 (admin).');
        setBusy(false);
        return;
      }
      setDevCode(r.devCode);
      setStep('code');
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  };
  const verify = async () => {
    setBusy(true); setError(undefined);
    try {
      const r = await p.api.post('/auth/otp/verify', { phone, code });
      if (p.allow && !p.allow(r.user)) {
        setError('This number does not have access to this app.');
        setBusy(false);
        return;
      }
      p.api.setToken(r.token);
      try { localStorage.setItem(`${p.title}:user`, JSON.stringify(r.user)); } catch { /* ignore */ }
      setUser(r.user);
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  };

  return (
    <main className="login">
      <form className="login-card" onSubmit={(e) => { e.preventDefault(); step === 'phone' ? requestCode() : verify(); }}>
        <div className="brand">ChurchOS</div>
        <h1>{p.title}</h1>
        <p className="muted">{p.subtitle}</p>
        {step === 'phone' ? (
          <>
            <Field label="Phone number"><input autoFocus inputMode="tel" placeholder="0712 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
            <Button type="submit" disabled={busy || phone.trim().length < 9}>{busy ? 'Sending…' : 'Send me a code'}</Button>
          </>
        ) : (
          <>
            <Field label="One-time code" hint={devCode ? <>Development build: your code is <b>{devCode}</b></> : 'We sent a code to your phone.'}>
              <input autoFocus inputMode="numeric" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <Button type="submit" disabled={busy || code.length < 6}>{busy ? 'Checking…' : 'Sign in'}</Button>
            <Button kind="ghost" onClick={() => { setStep('phone'); setError(undefined); }}>Use a different number</Button>
          </>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
      </form>
    </main>
  );
}
