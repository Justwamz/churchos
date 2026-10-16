import { useEffect, useRef, useState } from 'react';
import { Button, Card, ErrorNote, Field, Note, useAsync } from '@churchos/ui';
import { api, errText } from './api';
import { Icon, Sheet, Skeleton } from './ui';

// ---------------- helpers ----------------

const TZ = 'Africa/Nairobi';
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-KE', { hour: 'numeric', minute: '2-digit', hour12: false, timeZone: TZ });
const MAX_PEOPLE = 8;
const RELATIONS = ['Aunt', 'Uncle', 'Grandparent', 'Brother or sister', 'Driver', 'Family friend', 'Other'];

/** A short label for this browser, so the teacher's log shows which phone made the code. */
export function deviceLabel(): string {
  let id = '';
  try { id = localStorage.getItem('churchos:device') ?? ''; } catch { /* ignore */ }
  if (!id) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(2)), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    try { localStorage.setItem('churchos:device', id); } catch { /* ignore */ }
  }
  return `Member device ${id}`;
}

/** The member's children and approved pick-up people. An empty list means the feature stays hidden. */
export function useFamilies() {
  const q = useAsync<any>(() => api.get('/me/family'));
  const reload = useRef(q.reload);
  reload.current = q.reload;
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible' && navigator.onLine) reload.current(); };
    const t = setInterval(tick, 30000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', tick); };
  }, []);
  const families: any[] = q.data?.families ?? [];
  return { families, reload: q.reload, loading: q.loading && !q.data };
}

const chipFor = (c: any) => c.inNow
  ? (c.inNow.late
    ? { cls: 'warn', text: 'Waiting to be collected' }
    : { cls: 'good', text: `In ${c.inNow.className} · tag ${c.inNow.tag} · since ${timeOf(c.inNow.since)}` })
  : { cls: 'muted', text: 'Not at class' };

// ---------------- the phone's location ----------------

type Fix = { lat: number; lng: number; acc: number; at: number };
type GeoState = 'looking' | 'ok' | 'denied' | 'unavailable';
const GEO_MAX_AGE = 2 * 60 * 1000;

/** Watches this phone's location while the screen is shown. Never blocks anything: callers just ask for the latest fresh reading. */
export function useGeo() {
  const supported = typeof navigator !== 'undefined' && 'geolocation' in navigator;
  const last = useRef<Fix | null>(null);
  const waiters = useRef<Array<() => void>>([]);
  const [state, setState] = useState<GeoState>(supported ? 'looking' : 'unavailable');
  const [attempt, setAttempt] = useState(0);
  const fresh = () => (last.current && Date.now() - last.current.at < GEO_MAX_AGE ? last.current : null);

  useEffect(() => {
    if (!supported) return;
    let watch: number | null = null;
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { if (watch != null) navigator.geolocation.clearWatch(watch); watch = null; clearTimeout(giveUp); };
    const flush = () => { const w = waiters.current; waiters.current = []; w.forEach((f) => f()); };
    const start = () => {
      stop();
      if (document.visibilityState !== 'visible') return;
      if (!fresh()) setState((s) => (s === 'ok' ? 'looking' : s));
      giveUp = setTimeout(() => { if (!fresh()) setState((s) => (s === 'looking' ? 'unavailable' : s)); flush(); }, 10000);
      try {
        watch = navigator.geolocation.watchPosition(
          (p) => {
            last.current = { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy), at: Date.now() };
            clearTimeout(giveUp);
            setState('ok');
            flush();
          },
          (e) => {
            if (e.code === 1) { last.current = null; setState('denied'); flush(); }
            else if (!fresh()) setState((s) => (s === 'ok' ? s : 'unavailable'));
          },
          { enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 },
        );
      } catch { setState('unavailable'); flush(); }
    };
    const onVis = () => { if (document.visibilityState === 'visible') start(); else stop(); };
    // A stationary phone may not report again, so renew the watch when the last reading is getting old.
    const renew = setInterval(() => { if (document.visibilityState === 'visible' && (!last.current || Date.now() - last.current.at > GEO_MAX_AGE - 30000)) start(); }, 20000);
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => { stop(); clearInterval(renew); document.removeEventListener('visibilitychange', onVis); flush(); };
  }, [supported, attempt]);

  /** Latest fresh reading, or none. */
  const get = () => { const f = fresh(); return f ? { lat: f.lat, lng: f.lng, acc: f.acc } : undefined; };
  /** Resolves when a reading arrives, or after ms, whichever is first. */
  const first = (ms: number) => new Promise<void>((res) => {
    if (fresh() || !supported) return res();
    const t = setTimeout(res, ms);
    waiters.current.push(() => { clearTimeout(t); res(); });
  });
  const retry = () => { last.current = null; setState('looking'); setAttempt((n) => n + 1); };
  return { state, get, first, retry };
}

// ---------------- the changing code ----------------

function GuardianQr({ membershipId }: { membershipId: string }) {
  const [qr, setQr] = useState<{ svg: string; name: string; seconds: number; stamp: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const geo = useGeo();
  const geoRef = useRef(geo);
  geoRef.current = geo;
  useEffect(() => {
    let live = true;
    let firstLoad = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const clear = () => { clearTimeout(timer); clearTimeout(expiry); };
    const load = async () => {
      clear();
      if (!live || document.visibilityState !== 'visible') return;
      try {
        if (firstLoad) { firstLoad = false; await geoRef.current.first(1500); if (!live || document.visibilityState !== 'visible') return; }
        const g = geoRef.current.get();
        const r = await api.post('/me/family/qr', { membershipId, device: deviceLabel(), ...(g ? { geo: g } : {}) });
        if (!live) return;
        setQr({ svg: r.qrSvg, name: r.name, seconds: r.refreshSeconds ?? 30, stamp: Date.now() });
        setFailed(false);
        timer = setTimeout(load, 25000);
        const left = r.expiresAt ? new Date(r.expiresAt).getTime() - Date.now() : 30000;
        expiry = setTimeout(() => { if (live) { setQr(null); setFailed(true); } }, Math.max(1000, left));
      } catch {
        if (!live) return;
        setQr(null); setFailed(true);
        timer = setTimeout(load, 5000);
      }
    };
    const onVis = () => { if (document.visibilityState === 'visible') load(); else clear(); };
    setQr(null); setFailed(false);
    load();
    document.addEventListener('visibilitychange', onVis);
    return () => { live = false; clear(); document.removeEventListener('visibilitychange', onVis); };
  }, [membershipId]);

  return (
    <div className="fam-qr-wrap">
      {qr
        ? <div className="tk-qr fam-qr" role="img" aria-label="Your pick-up code" dangerouslySetInnerHTML={{ __html: qr.svg }} />
        : <div className="tk-qr fam-qr blank" role="status">{failed ? <span>Can't refresh the code. Check your connection</span> : <span>Getting your code…</span>}</div>}
      <div className="fam-bar" aria-hidden="true">{qr && <i key={qr.stamp} style={{ animationDuration: `${qr.seconds}s` }} />}</div>
      <strong className="fam-guardian">{qr?.name ?? ''}</strong>
      <div className={`fam-geo ${geo.state}`} role="status">
        {geo.state === 'ok' && <><span className="fam-geo-line"><i className="fam-dot" aria-hidden="true" />Location shared with this code</span><span className="tiny muted">Used only to confirm the check-in happens at the church.</span></>}
        {geo.state === 'looking' && <span className="fam-geo-line muted"><i className="fam-dot" aria-hidden="true" />Looking for your location...</span>}
        {(geo.state === 'denied' || geo.state === 'unavailable') && <>
          <span>Location is off. If the teacher's phone cannot tell where it is, they will not be able to check your child in. Allow location for this app in your browser or phone settings.</span>
          <button type="button" className="link-btn" onClick={geo.retry}>Try again</button>
        </>}
      </div>
    </div>
  );
}

// ---------------- the page ----------------

export function FamilyPage({ families, reload, loading }: { families: any[]; reload: () => void; loading: boolean }) {
  const [idx, setIdx] = useState(0);
  const fam = families[Math.min(idx, families.length - 1)];
  if (loading) return <Skeleton lines={4} tall />;
  if (!fam) return <Card title="Children"><p className="muted">No children are linked to your account.</p></Card>;
  return (
    <div className="stack fam-page">
      {families.length > 1 && (
        <div className="seg" role="tablist" aria-label="Church">
          {families.map((f, i) => <button key={f.membershipId} type="button" role="tab" aria-selected={i === idx} className={i === idx ? 'on' : ''} onClick={() => setIdx(i)}>{f.church}</button>)}
        </div>
      )}
      <div className="fam-cols">
        <section className="card fam-qr-card">
          <h3>Pick-up code</h3>
          <GuardianQr key={fam.membershipId} membershipId={fam.membershipId} />
          <p className="fam-caption">Show this to the teacher when you drop off and collect.</p>
          <p className="tiny muted">This code changes every 30 seconds, so a screenshot will not work.</p>
        </section>
        <div className="stack fam-side">
          <Kids fam={fam} />
          <People fam={fam} reload={reload} />
        </div>
      </div>
      <HowItWorks />
    </div>
  );
}

function Kids({ fam }: { fam: any }) {
  return (
    <section className="card">
      <h3>Your children</h3>
      <ul className="fam-list">
        {fam.children.map((c: any) => {
          const chip = chipFor(c);
          return (
            <li key={c.id} className="fam-child">
              <span className="msg-ico"><Icon name="family" size={18} /></span>
              <span className="fam-name"><strong>{c.name}</strong><span className="tiny muted">{c.age != null ? `Age ${c.age}` : ''}</span></span>
              <span className={`badge ${chip.cls} fam-chip`}>{chip.text}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function People({ fam, reload }: { fam: any; reload: () => void }) {
  const people: any[] = fam.pickupPeople ?? [];
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [rel, setRel] = useState('');
  const [other, setOther] = useState('');
  const [idn, setIdn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<any>(null);
  const relation = rel === 'Other' ? other.trim() : rel;
  const ok = name.trim().length > 1 && phone.trim().length >= 9 && relation.length > 0;

  const add = async () => {
    setBusy(true); setError('');
    try {
      await api.post('/me/family/pickup-people', { membershipId: fam.membershipId, name: name.trim(), phone: phone.trim(), relation, idNumber: idn.trim() || undefined });
      setName(''); setPhone(''); setRel(''); setOther(''); setIdn(''); setAdding(false);
      reload();
    } catch (e: any) { setError(errText(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!removing) return;
    setBusy(true); setError('');
    try { await api.post(`/me/family/pickup-people/${encodeURIComponent(removing.id)}/remove`, {}); setRemoving(null); reload(); }
    catch (e: any) { setError(errText(e)); } finally { setBusy(false); }
  };

  return (
    <section className="card">
      <h3>People who can collect your children</h3>
      <p className="tiny muted">They will get an SMS code on their phone when they come to collect. Nobody else can collect your child.</p>
      {people.length === 0 && !adding && <p className="muted">No one added yet.</p>}
      <ul className="fam-list">
        {people.map((p) => (
          <li key={p.id} className="fam-person">
            <span className="fam-name"><strong>{p.name}</strong><span className="tiny muted">{p.relation} · {p.phone}</span></span>
            <button type="button" className="link-btn fam-remove" aria-label={`Remove ${p.name}`} onClick={() => { setError(''); setRemoving(p); }}>Remove</button>
          </li>
        ))}
      </ul>
      {!adding && (people.length < MAX_PEOPLE
        ? <Button kind="ghost" onClick={() => { setError(''); setAdding(true); }}>Add a person</Button>
        : <Note>You can add up to {MAX_PEOPLE} people. Remove someone to add another.</Note>)}
      {adding && (
        <form className="stack fam-form" onSubmit={(e) => { e.preventDefault(); if (ok && !busy) add(); }}>
          <Field label="Full name"><input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={80} /></Field>
          <Field label="Their phone number" hint="The SMS code is sent here."><input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07XX XXX XXX" autoComplete="off" /></Field>
          <Field label="Who are they to your child?">
            <select value={rel} onChange={(e) => setRel(e.target.value)}>
              <option value="">Choose…</option>
              {RELATIONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          {rel === 'Other' && <Field label="Please say who"><input value={other} onChange={(e) => setOther(e.target.value)} maxLength={40} /></Field>}
          <Field label="ID number (optional)" hint="The teacher can check it at the door."><input value={idn} onChange={(e) => setIdn(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={20} /></Field>
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="fam-actions">
            <Button type="submit" disabled={!ok || busy}>{busy ? 'Saving…' : 'Save person'}</Button>
            <Button kind="ghost" onClick={() => { setAdding(false); setError(''); }} disabled={busy}>Cancel</Button>
          </div>
        </form>
      )}
      {!adding && !removing && error && <ErrorNote>{error}</ErrorNote>}
      <Sheet open={!!removing} onClose={() => setRemoving(null)} title="Remove this person?">
        <div className="stack">
          <p>{removing?.name} will no longer be able to collect your children.</p>
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="fam-actions">
            <Button kind="danger" onClick={remove} disabled={busy}>{busy ? 'Removing…' : 'Yes, remove'}</Button>
            <Button kind="ghost" onClick={() => setRemoving(null)} disabled={busy}>Keep</Button>
          </div>
        </div>
      </Sheet>
    </section>
  );
}

function HowItWorks() {
  return (
    <details className="card fam-how">
      <summary>How it works</summary>
      <ol>
        <li>Open this page and show your code to the Sunday school teacher when you drop off. They give your child a tag.</li>
        <li>When you come back, show your code again and give back the tag. The code is new every 30 seconds.</li>
        <li>If someone else will collect, add them above. They get an SMS code on their own phone to show the teacher.</li>
        <li>Check-in only works at the church. Keep location on so the teacher can confirm it.</li>
      </ol>
    </details>
  );
}

// ---------------- Home card ----------------

export function HomeKids({ families, onOpen }: { families: any[]; onOpen: () => void }) {
  const here = families.flatMap((f) => f.children).filter((c: any) => c.inNow);
  if (!here.length) return null;
  const late = here.some((c: any) => c.inNow.late);
  const text = here.map((c: any) => `${c.name.split(' ')[0]} is in ${c.inNow.className}, tag ${c.inNow.tag}, since ${timeOf(c.inNow.since)}`).join(' · ');
  return (
    <button type="button" className={`fam-home ${late ? 'late' : ''}`} onClick={onOpen}>
      <span className="msg-ico"><Icon name="family" size={18} /></span>
      <span className="fam-name"><strong>{late ? 'Please collect your child' : 'Children'}</strong><span className="tiny">{text}{late ? ' · waiting to be collected' : ''}</span></span>
      <Icon name="chev" size={18} />
    </button>
  );
}
