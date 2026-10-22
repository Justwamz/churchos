import { useCallback, useEffect, useRef, useState, type ImgHTMLAttributes, type ReactNode } from 'react';
import { formatKes } from '@churchos/shared';
import { ApiError, createApi, type Api } from './api';
import { addPasskey, deviceHasPasskey, passkeyError, passkeySecondFactor, passkeySignIn, passkeysSupported } from './passkeys';

export { createApi, ApiError, API_URL } from './api';
export { applyBranding, brandFile, BrandMark, useChurchBranding, type BrandApp, type BrandInfo } from './brand';
export type { Api } from './api';
export { HelpButton, HelpMarkdown } from './help';
export { safeHttpUrl, openExternal } from './safeUrl';
export { CertificateCard, QrCode, printCertificate, VERIFY_ORIGIN } from './certificate';
export { SecurityPanel, PasskeyBanner, passkeysSupported } from './passkeys';
export { AuditLog, AuditHistory, HistoryButton, ChangeTable } from './audit';
export type { CertificatePayload } from './certificate';
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
  // 'demo' shows the fixed-code hint; 'sms' sends a real code. Until /auth/mode answers (or if it fails) nothing about a code is shown beyond what the server returns.
  const [mode, setMode] = useState<'demo' | 'sms' | undefined>();
  const [wait, setWait] = useState(0);

  useEffect(() => {
    let live = true;
    p.api.get('/auth/mode').then((r: any) => { if (live && (r?.mode === 'demo' || r?.mode === 'sms')) setMode(r.mode); }).catch(() => {});
    return () => { live = false; };
  }, [p.api]);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => Math.max(0, w - 1)), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  useEffect(() => {
    if (user && !p.api.getToken()) setUser(null);
  }, [user, p.api]);

  const signOut = () => {
    void p.api.signOut(); // ends the session on the server too; the token is cleared here at once
    try { localStorage.removeItem(`${p.title}:user`); } catch { /* ignore */ }
    try { navigator.serviceWorker?.controller?.postMessage('clear-caches'); } catch { /* ignore */ }
    setUser(null);
    setStep('phone');
    setCode('');
  };

  if (user && p.api.getToken()) return <>{p.children({ user, signOut })}</>;

  const minutes = (sec: number) => (sec >= 90 ? `${Math.ceil(sec / 60)} minutes` : `${Math.max(1, Math.ceil(sec))} seconds`);
  /** A 429 reads as a calm instruction with the real wait, never a raw error. */
  const tooMany = (e: any, what: 'code' | 'try') => {
    const sec = Number(e?.retryAfter) > 0 ? Number(e.retryAfter) : 0;
    if (what === 'code' && sec) setWait(Math.ceil(sec));
    if (what === 'try') return `Too many attempts. ${sec ? `Please wait ${minutes(sec)} and try again.` : 'Please wait a little and try again.'}`;
    return e.status === 429 && /^Please wait d+ seconds/.test(e.message) ? e.message : `Too many code requests. ${sec ? `Please try again in ${minutes(sec)}.` : 'Please try again later.'}`;
  };

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
      setDevCode(mode === 'sms' ? undefined : r.devCode);
      if (mode === 'sms') setWait(30);
      setCode('');
      setStep('code');
    } catch (e: any) { setError(e.status === 429 ? tooMany(e, 'code') : e.message); }
    setBusy(false);
  };
  const verify = async () => {
    setBusy(true); setError(undefined);
    try {
      let r = await p.api.post('/auth/otp/verify', { phone, code });
      // A platform admin with a passkey shows it after the code; one who must add a passkey does that first. Demo sign-in never gets here.
      if (r.needsPasskey) r = await passkeySecondFactor(p.api, r.pending);
      else if (r.needsEnrolment) r = await addPasskey(p.api, 'My passkey', r.pending);
      finish(r);
    } catch (e: any) { setError(e.status === 429 ? tooMany(e, 'try') : e.status ? e.message : passkeyError(e)); }
    setBusy(false);
  };
  const finish = (r: any) => {
    if (p.allow && !p.allow(r.user)) {
      p.api.setToken(r.token); void p.api.signOut(); // ends the session that was just made
      setError('This number does not have access to this app.');
      return;
    }
    p.api.setToken(r.token);
    try { localStorage.setItem(`${p.title}:user`, JSON.stringify(r.user)); } catch { /* ignore */ }
    setUser(r.user);
  };
  const withPasskey = async () => {
    setBusy(true); setError(undefined);
    try { finish(await passkeySignIn(p.api)); }
    catch (e: any) { setError(e.status === 429 ? tooMany(e, 'try') : passkeyError(e)); }
    setBusy(false);
  };
  // Offered where the browser supports it and passkeys are in real use (sms mode) or one was added on this device.
  const canPasskey = passkeysSupported() && (mode === 'sms' || deviceHasPasskey());

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
            {canPasskey && <Button kind="ghost" disabled={busy} onClick={withPasskey}>Sign in with a passkey</Button>}
          </>
        ) : (
          <>
            <Field label="One-time code" hint={mode === 'sms' ? 'We sent a 6-digit code to your phone.' : devCode ? <>Development build: your code is <b>{devCode}</b></> : 'We sent a code to your phone.'}>
              <input autoFocus inputMode="numeric" maxLength={6} placeholder={mode === 'sms' ? '6-digit code' : '123456'} value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <Button type="submit" disabled={busy || code.length < 6}>{busy ? 'Checking…' : 'Sign in'}</Button>
            {mode === 'sms' && <Button kind="ghost" disabled={busy || wait > 0} onClick={requestCode}>{wait > 0 ? `Send the code again in ${wait}s` : 'Send the code again'}</Button>}
            <Button kind="ghost" onClick={() => { setStep('phone'); setError(undefined); }}>Use a different number</Button>
          </>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
      </form>
    </main>
  );
}

/**
 * A protected image as an object URL, fetched with the Authorization header (the sign-in token never goes in a URL).
 * Returns undefined while loading, or when there is no path or the file cannot be fetched.
 */
export function useBlobUrl(api: Api, path?: string | null): string | undefined {
  const [url, setUrl] = useState<string | undefined>();
  useEffect(() => {
    if (!path) { setUrl(undefined); return; }
    let live = true;
    let made: string | undefined;
    api.blobUrl(path).then((u) => { if (live) { made = u; setUrl(u); } else URL.revokeObjectURL(u); }).catch(() => { if (live) setUrl(undefined); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [api, path]);
  return url;
}

/** An <img> for a protected path. */
export function AuthImg({ api, src, ...rest }: { api: Api; src?: string | null } & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>) {
  const url = useBlobUrl(api, src);
  return <img {...rest} src={url} />;
}
