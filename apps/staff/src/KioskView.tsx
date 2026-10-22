import { useCallback, useEffect, useRef, useState } from 'react';
import { API_URL, brandFile } from '@churchos/ui';
import './kiosk.css';

/**
 * The kiosk screen: a full-screen self check-in terminal. It is NOT a staff session. It holds one revocable device token (made by pairing)
 * that only works on /kiosk endpoints. It never shows a list or a search of people, and the welcome only repeats the name typed on the screen.
 */
const KEY = 'churchos:kiosk-device';
const WELCOME_MS = 8000;
const IDLE_MS = 60_000;
const GREETER = 'Please see a greeter.';

const store = {
  get: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
  set: (t: string | null) => { try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch { /* lasts until the page closes */ } },
};
class KioskError extends Error { constructor(public status: number, m: string) { super(m); } }

async function call(token: string | null, method: 'GET' | 'POST', path: string, body?: unknown) {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { method, headers: { 'x-churchos-app': 'staff', ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new KioskError(0, GREETER); }
  let data: any; try { data = await res.json(); } catch { /* none */ }
  if (!res.ok) throw new KioskError(res.status, data?.error ?? GREETER);
  return data;
}

type Config = { church: string; branch: string; device: string; words: { one: string; oneLower: string }; branding: { orgId: string; hasLogo: boolean; version: number; themeColor: string | null }; service: { name: string; startsAt: string } | null };
type Step = 'home' | 'phone' | 'number' | 'name' | 'welcome' | 'error';

const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi', hour: 'numeric', minute: '2-digit' });

function Keypad({ onKey, label }: { onKey: (k: string) => void; label: string }) {
  return (
    <div className="kx-pad" role="group" aria-label={label}>
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => <button key={k} type="button" onClick={() => onKey(k)}>{k}</button>)}
      <button type="button" className="fn" onClick={() => onKey('clear')} aria-label="Clear all">Clear</button>
      <button type="button" onClick={() => onKey('0')}>0</button>
      <button type="button" className="fn" onClick={() => onKey('back')} aria-label="Delete last digit">&#9003;</button>
    </div>
  );
}

export function KioskView() {
  const [token, setToken] = useState<string | null>(store.get());
  const [cfg, setCfg] = useState<Config | null>(null);
  const [step, setStep] = useState<Step>('home');
  const [phone, setPhone] = useState('');
  const [num, setNum] = useState('');
  const [first, setFirst] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [pairCode, setPairCode] = useState(() => new URLSearchParams(location.search).get('code') ?? '');
  const [pairErr, setPairErr] = useState('');
  const timer = useRef<number | undefined>(undefined);

  const reset = useCallback(() => { setStep('home'); setPhone(''); setNum(''); setFirst(''); setMsg(''); setBusy(false); }, []);
  const lost = useCallback(() => { store.set(null); setToken(null); setCfg(null); reset(); }, [reset]);

  // No way out: back is trapped, the context menu and text selection are off, and there are no links on this screen.
  useEffect(() => {
    history.pushState(null, '', location.href);
    const back = () => history.pushState(null, '', location.href);
    const menu = (e: Event) => e.preventDefault();
    window.addEventListener('popstate', back);
    document.addEventListener('contextmenu', menu);
    document.body.classList.add('kx-body');
    return () => { window.removeEventListener('popstate', back); document.removeEventListener('contextmenu', menu); document.body.classList.remove('kx-body'); };
  }, []);

  // The configuration is also the heartbeat: a revoked device finds out here and goes back to the pairing screen.
  useEffect(() => {
    if (!token) return;
    let alive = true;
    const load = () => call(token, 'GET', '/kiosk/config').then((c) => { if (alive) setCfg(c); }).catch((e) => { if (alive && e.status === 401) lost(); });
    load();
    const t = window.setInterval(load, 45_000);
    return () => { alive = false; clearInterval(t); };
  }, [token, lost]);

  // Idle reset, and the welcome goes away by itself.
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (step === 'home') return;
    timer.current = window.setTimeout(reset, step === 'welcome' || step === 'error' ? WELCOME_MS : IDLE_MS);
    return () => window.clearTimeout(timer.current);
  }, [step, phone, num, first, reset]);

  const bump = () => { try { if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.(); } catch { /* optional */ } };

  const pair = async () => {
    setBusy(true); setPairErr('');
    try { const r = await call(null, 'POST', '/kiosk/pair', { code: pairCode }); store.set(r.token); setToken(r.token); history.replaceState(null, '', '/kiosk'); }
    catch (e: any) { setPairErr(e.status === 400 ? 'That code did not work. Ask a staff member for a new one.' : GREETER); }
    finally { setBusy(false); }
  };

  const digits = (cur: string, k: string, max: number) => (k === 'clear' ? '' : k === 'back' ? cur.slice(0, -1) : cur.length < max ? cur + k : cur);

  const submit = async () => {
    if (!token || busy) return;
    setBusy(true);
    try {
      const r = await call(token, 'POST', '/kiosk/checkin', { ...(phone ? { phone } : { memberNumber: num }), firstName: first });
      setMsg(r.firstName ? `Welcome, ${r.firstName}!` : 'Welcome!'); setStep('welcome');
    } catch (e: any) {
      if (e.status === 401) return lost();
      setMsg(e.status === 409 ? 'Check-in is not open yet.' : GREETER); setStep('error');
    } finally { setBusy(false); }
  };

  const brand = cfg?.branding;
  const style = brand?.themeColor ? ({ ['--kx-brand' as any]: brand.themeColor } as React.CSSProperties) : undefined;
  const logo = brand?.hasLogo && brand.orgId ? <img className="kx-logo" src={brandFile(brand.orgId, 'icon-192.png', brand.version)} alt="" width={96} height={96} /> : null;

  if (!token) {
    return (
      <main className="kx" onPointerDown={bump}>
        <h1>Set up this kiosk</h1>
        <p className="kx-sub">A staff member makes a pairing code in the staff app under Kiosk. Type it here.</p>
        <label className="kx-label" htmlFor="kx-code">Pairing code</label>
        <input id="kx-code" className="kx-input" value={pairCode} autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={9} onChange={(e) => setPairCode(e.target.value.toUpperCase())} />
        {pairErr && <p className="kx-err" role="alert">{pairErr}</p>}
        <button type="button" className="kx-btn" onClick={pair} disabled={busy || pairCode.replace(/[^A-Z0-9]/g, '').length < 8}>{busy ? 'Please wait' : 'Pair this screen'}</button>
      </main>
    );
  }

  const w = cfg?.words.oneLower ?? 'service';
  return (
    <main className={`kx ${step}`} style={style} onPointerDown={bump} aria-live="polite">
      {step === 'home' && (
        <>
          {logo}
          <h1>{cfg?.church ?? ' '}</h1>
          <p className="kx-sub">{cfg ? (cfg.service ? `${cfg.service.name}${cfg.service.startsAt ? ` at ${clock(cfg.service.startsAt)}` : ''}` : `There is no ${w} open for check-in right now.`) : 'Loading...'}</p>
          <button type="button" className="kx-btn big" disabled={!cfg?.service} onClick={() => setStep('phone')}>Check in with my phone number</button>
          <button type="button" className="kx-btn ghost" disabled={!cfg?.service} onClick={() => setStep('number')}>I have a member number</button>
          {cfg && !cfg.service && <p className="kx-hint">{GREETER}</p>}
        </>
      )}
      {(step === 'phone' || step === 'number') && (
        <>
          <h1>{step === 'phone' ? 'Your phone number' : 'Your member number'}</h1>
          {step === 'phone'
            ? <div className="kx-display" aria-live="polite" aria-label="Phone number">{phone || '07__ ___ ___'}</div>
            : <input className="kx-input" aria-label="Member number" value={num} autoComplete="off" autoCapitalize="characters" maxLength={20} onChange={(e) => setNum(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))} placeholder="M00001" />}
          {step === 'phone' && <Keypad label="Phone number keypad" onKey={(k) => setPhone((p) => digits(p, k, 13))} />}
          <div className="kx-row">
            <button type="button" className="kx-btn ghost" onClick={reset}>Cancel</button>
            <button type="button" className="kx-btn" disabled={step === 'phone' ? phone.length < 9 : num.length < 2} onClick={() => setStep('name')}>Next</button>
          </div>
        </>
      )}
      {step === 'name' && (
        <>
          <h1>What is your first name?</h1>
          <input className="kx-input" aria-label="First name" autoFocus value={first} autoComplete="off" autoCapitalize="words" maxLength={24} onChange={(e) => setFirst(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && first.trim().length >= 2) void submit(); }} />
          <div className="kx-row">
            <button type="button" className="kx-btn ghost" onClick={() => setStep(phone ? 'phone' : 'number')}>Back</button>
            <button type="button" className="kx-btn" disabled={busy || first.trim().length < 2} onClick={submit}>{busy ? 'Please wait' : 'Check me in'}</button>
          </div>
        </>
      )}
      {step === 'welcome' && (
        <>
          {logo}
          <h1 className="kx-welcome">{msg}</h1>
          <p className="kx-sub">We are glad you are here.</p>
          <button type="button" className="kx-btn ghost" onClick={reset}>Done</button>
        </>
      )}
      {step === 'error' && (
        <>
          <h1>{msg}</h1>
          <button type="button" className="kx-btn" onClick={reset}>OK</button>
        </>
      )}
    </main>
  );
}
