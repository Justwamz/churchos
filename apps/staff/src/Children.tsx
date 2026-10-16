import { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { Badge, Button, Empty, ErrorNote, Field, Note, useAsync, useToast } from '@churchos/ui';
import { api, friendly, label, useSession } from './session';
import { Load, PageHead } from './bits';
import { Modal } from './MemberForm';
import './tickets.css';
import './children.css';

/** A short name for this browser, so the log can say which device did what. */
export function deviceLabel(): string {
  let id = '';
  try {
    id = localStorage.getItem('churchos:device') ?? '';
    if (!id) { id = Math.random().toString(16).slice(2, 6).toUpperCase().padEnd(4, '0'); localStorage.setItem('churchos:device', id); }
  } catch { /* storage blocked: fall back to a label for this page load */ }
  if (!id) id = (deviceLabel as any).tmp ??= Math.random().toString(16).slice(2, 6).toUpperCase().padEnd(4, '0');
  return `Staff device ${id}`;
}

const hhmm = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', hour12: false }) : '');
const when = (iso: string) => new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const shortDay = (iso: string) => new Date(iso).toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', year: 'numeric' });
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
const tagText = (t: number | string) => `Tag ${String(t).padStart(2, '0')}`;
async function patch(path: string, body: unknown) {
  let res: Response;
  try {
    res = await fetch(`${api.API_URL}${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-churchos-app': 'staff', authorization: `Bearer ${api.getToken() ?? ''}` }, body: JSON.stringify(body) });
  } catch { throw new Error('Cannot reach the server. Check your connection and try again.'); }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}
const errMsg = (e: any) => friendly(e?.message);

function beep(ok: boolean) {
  try { navigator.vibrate?.(ok ? 80 : [120, 80, 120]); } catch { /* optional */ }
  try {
    const A = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!A) return;
    const c = new A();
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.value = ok ? 880 : 240;
    g.gain.value = 0.08;
    o.connect(g); g.connect(c.destination);
    o.start(); o.stop(c.currentTime + 0.12);
    setTimeout(() => c.close(), 400);
  } catch { /* optional */ }
}

// ---------- device location ----------

type Geo = { lat: number; lng: number; acc: number };
type Loc = { status: 'ok' | 'away' | 'unknown' | 'unchecked'; source?: string; distanceM?: number | null; radiusM?: number; branch?: string; message?: string };
let lastGeo: (Geo & { at: number }) | null = null;
/** The latest reading from any open watcher, or null when there is none or it is older than 2 minutes. */
export function geoNow(): Geo | null {
  if (!lastGeo || Date.now() - lastGeo.at > 120_000) return null;
  return { lat: lastGeo.lat, lng: lastGeo.lng, acc: lastGeo.acc };
}
const withGeo = <T extends object>(body: T): T & { geo?: Geo } => { const g = geoNow(); return g ? { ...body, geo: g } : body; };

/** Watches the device position while `active`. Never throws: denied or missing location becomes a state. */
function useGeo(active = true) {
  const ref = useRef<Geo | null>(null);
  const [reading, setReading] = useState<Geo | null>(null);
  const [state, setState] = useState<'waiting' | 'ok' | 'denied' | 'unavailable'>('waiting');
  useEffect(() => {
    if (!active) return;
    if (!('geolocation' in navigator)) { setState('unavailable'); return; }
    let id: number | null = null;
    try {
      id = navigator.geolocation.watchPosition(
        (p) => {
          const g = { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) };
          ref.current = g; lastGeo = { ...g, at: Date.now() };
          setReading(g); setState('ok');
        },
        (e) => { if (e.code === 1) { setState('denied'); ref.current = null; lastGeo = null; setReading(null); } else if (!ref.current) setState('unavailable'); },
        { enableHighAccuracy: true, maximumAge: 15000, timeout: 10000 },
      );
    } catch { setState('unavailable'); }
    return () => { if (id != null) navigator.geolocation.clearWatch(id); };
  }, [active]);
  return { ref, reading, state, geoNow };
}

type Banner = { tone: 'good' | 'warn' | 'bad'; title: string; lines?: string[]; sticky?: boolean };

function BannerView({ b, onClose }: { b: Banner | null; onClose: () => void }) {
  useEffect(() => {
    if (!b || b.sticky) return;
    const t = setTimeout(onClose, 5000);
    return () => clearTimeout(t);
  }, [b, onClose]);
  if (!b) return null;
  return (
    <div className={`kd-result ${b.tone}`} role="status" aria-live="assertive" onClick={onClose}>
      <div className="kd-mark" aria-hidden="true">{b.tone === 'good' ? '✓' : b.tone === 'warn' ? '!' : '✗'}</div>
      <div className="kd-title">{b.title}</div>
      {b.lines?.map((l, i) => <div key={i}>{l}</div>)}
    </div>
  );
}

// ---------- camera ----------

function useScanner(onText: (t: string) => void) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const raf = useRef(0);
  const [camOn, setCamOn] = useState(false);
  const [camMsg, setCamMsg] = useState('');
  const cb = useRef(onText);
  cb.current = onText;

  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    setCamOn(false);
  }, []);

  useEffect(() => {
    const h = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', h);
    return () => { document.removeEventListener('visibilitychange', h); stop(); };
  }, [stop]);

  const start = async () => {
    setCamMsg('');
    if (!navigator.mediaDevices?.getUserMedia) return setCamMsg('This browser cannot use the camera here. You can find the guardian by name instead.');
    try {
      const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      stream.current = st;
      setCamOn(true);
      const v = video.current!;
      v.srcObject = st;
      await v.play().catch(() => {});
      const BD = (window as any).BarcodeDetector;
      let detector: any = null;
      if (BD) { try { detector = new BD({ formats: ['qr_code'] }); } catch { detector = null; } }
      let busyFrame = false;
      const tick = async () => {
        if (!stream.current) return;
        if (!busyFrame && v.readyState >= 2 && v.videoWidth) {
          busyFrame = true;
          try {
            let text = '';
            if (detector) {
              const found = await detector.detect(v);
              text = found[0]?.rawValue ?? '';
            } else {
              const c = canvas.current!;
              const w = Math.min(640, v.videoWidth);
              const h = Math.round((w / v.videoWidth) * v.videoHeight);
              c.width = w; c.height = h;
              const ctx = c.getContext('2d', { willReadFrequently: true })!;
              ctx.drawImage(v, 0, 0, w, h);
              text = jsQR(ctx.getImageData(0, 0, w, h).data, w, h)?.data ?? '';
            }
            if (text) cb.current(text);
          } catch { /* keep scanning */ }
          busyFrame = false;
        }
        raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    } catch (e: any) {
      stop();
      setCamMsg(e?.name === 'NotAllowedError' || e?.name === 'SecurityError'
        ? 'The camera is blocked. Allow the camera for this page in your browser, or find the guardian by name.'
        : e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError'
          ? 'No camera was found on this device. You can find the guardian by name instead.'
          : 'We could not start the camera. You can find the guardian by name instead.');
    }
  };
  return { video, canvas, camOn, camMsg, start, stop };
}

// ---------- guardian panel (drop off and collect) ----------

type Panel = {
  guardian: { id?: string; name: string };
  proof: string;
  dropOff: { id: string; name: string; age?: number | null; inClass?: string | null }[];
  collect: { id: string; name: string; tag: number | string; dropper?: string; byDifferentPerson?: boolean; state?: string }[];
  note?: string;
  location?: Loc | null;
};

function GuardianPanel({ sessionId, panel, onClose, onChanged, onTag, onBanner, onLoc }: {
  sessionId: string; panel: Panel; onClose: () => void; onChanged: () => void; onLoc: (l: Loc | null) => void;
  onTag: (t: { tag: number | string; names: string[]; codeSent: boolean }) => void; onBanner: (b: Banner) => void;
}) {
  const [drop, setDrop] = useState<Set<string>>(new Set());
  const [coll, setColl] = useState<Set<string>>(new Set(panel.collect.map((c) => c.id)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [loc, setLoc] = useState<Loc | null>(panel.location ?? null);
  const [rechecking, setRechecking] = useState(false);
  const blockedHere = loc?.status === 'away' || loc?.status === 'unknown';
  const recheck = async () => {
    setRechecking(true);
    try { const r = await api.post(`/kids/sessions/${sessionId}/locate`, withGeo({})); setLoc(r.location); onLoc(r.location); } catch (e: any) { setErr(errMsg(e)); }
    setRechecking(false);
  };
  const toggle = (set: Set<string>, id: string, fn: (s: Set<string>) => void) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); fn(n); };
  const nothing = panel.dropOff.length === 0 && panel.collect.length === 0;

  const checkIn = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.post(`/kids/sessions/${sessionId}/checkin`, withGeo({ proof: panel.proof, childIds: [...drop], device: deviceLabel() }));
      beep(true);
      onChanged();
      onTag({ tag: r.tag, names: (r.children ?? []).map((c: any) => c.name), codeSent: !!r.codeSent });
    } catch (e: any) {
      setErr(errMsg(e)); setBusy(false);
      if (e?.code === 'away_from_branch' || e?.code === 'location_needed' || /branch|location/i.test(e?.message ?? '')) { onBanner({ tone: 'bad', title: 'Cannot check in here', lines: [errMsg(e)], sticky: true }); recheck(); }
    }
  };
  const handOver = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.post(`/kids/sessions/${sessionId}/checkout`, withGeo({ proof: panel.proof, checkinIds: [...coll], device: deviceLabel() }));
      const done: any[] = r.done ?? [];
      const refused: any[] = r.refused ?? [];
      beep(refused.length === 0);
      onChanged();
      onBanner({
        tone: refused.length ? (done.length ? 'warn' : 'bad') : done.length && r.location?.status === 'away' ? 'warn' : 'good',
        title: done.length ? 'Handed over' : 'Not handed over',
        lines: [...(done.length ? [done.map((d) => d.name).join(', ')] : []), ...refused.map((x) => `${x.name}: ${x.reason}`), ...(done.length && r.location?.status === 'away' ? ['Handed over. Your location was away from the branch, this is recorded.'] : [])],
        sticky: refused.length > 0 || (done.length > 0 && r.location?.status === 'away'),
      });
      onClose();
    } catch (e: any) { setErr(errMsg(e)); setBusy(false); }
  };

  return (
    <Modal title={panel.guardian.name} onClose={onClose}>
      <div className="stack">
        {panel.note && <Note>{panel.note}</Note>}
        {nothing && <Empty>Nothing to do for this guardian. They have no children to drop off and none in this room.</Empty>}
        {panel.dropOff.length > 0 && (
          <section className="stack kd-sec">
            <h3>Drop off</h3>
            <div className="kd-picks">
              {panel.dropOff.map((c) => (
                <label key={c.id} className={`kd-pick ${c.inClass ? 'off' : ''}`}>
                  <input type="checkbox" disabled={!!c.inClass} checked={drop.has(c.id)} onChange={() => toggle(drop, c.id, setDrop)} />
                  <span><b>{c.name}</b>{c.age != null && <span className="tiny"> age {c.age}</span>}{c.inClass && <span className="tiny"> In {c.inClass}</span>}</span>
                </label>
              ))}
            </div>
            <div className="row"><Button disabled={busy || drop.size === 0 || blockedHere} onClick={checkIn}>{busy ? 'Working...' : drop.size > 1 ? `Check in ${drop.size} children` : 'Check in'}</Button></div>
            {blockedHere && (
              <div className={`kd-why ${loc!.status}`} role="alert">
                <div>{loc!.message}</div>
                {loc!.status === 'unknown' && <Button small kind="ghost" disabled={rechecking} onClick={recheck}>{rechecking ? 'Checking...' : 'Check my location again'}</Button>}
              </div>
            )}
          </section>
        )}
        {panel.collect.length > 0 && (
          <section className="stack kd-sec">
            <h3>Collect</h3>
            <div className="kd-picks">
              {panel.collect.map((c) => (
                <label key={c.id} className="kd-pick">
                  <input type="checkbox" checked={coll.has(c.id)} onChange={() => toggle(coll, c.id, setColl)} />
                  <span>
                    <b>{c.name}</b> <span className="kd-tag-sm">{tagText(c.tag)}</span>
                    {c.byDifferentPerson && <span className="kd-amber">Not the person who dropped off{c.dropper ? ` (${c.dropper})` : ''}</span>}
                  </span>
                </label>
              ))}
            </div>
            <div className="row"><Button disabled={busy || coll.size === 0} onClick={handOver}>{busy ? 'Working...' : 'Hand over'}</Button></div>
          </section>
        )}
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row"><Button kind="ghost" onClick={onClose}>Cancel</Button></div>
      </div>
    </Modal>
  );
}

// ---------- find by name or phone ----------

function FindModal({ sessionId, onClose, onFound, onBanner }: { sessionId: string; onClose: () => void; onFound: (p: Panel) => void; onBanner: (b: Banner) => void }) {
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [res, setRes] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    if (dq.length < 2) { setRes(null); return; }
    let live = true;
    api.get(`/kids/sessions/${sessionId}/guardians?q=${encodeURIComponent(dq)}`)
      .then((r: any) => { if (live) { setRes(r.guardians ?? []); setErr(''); } })
      .catch((e: any) => live && setErr(errMsg(e)));
    return () => { live = false; };
  }, [dq, sessionId]);
  const pick = async (g: any) => {
    setBusy(true); setErr('');
    try {
      const r = await api.post(`/kids/sessions/${sessionId}/find`, withGeo({ guardianId: g.id, device: deviceLabel() }));
      onFound({ guardian: r.guardian ?? { name: g.name }, proof: r.proof, dropOff: r.dropOff ?? [], collect: r.collect ?? [], location: r.location });
    } catch (e: any) { setErr(errMsg(e)); onBanner({ tone: 'bad', title: 'Could not find them', lines: [errMsg(e)] }); setBusy(false); }
  };
  return (
    <Modal title="Find by name or phone" onClose={onClose}>
      <div className="stack">
        <input autoFocus aria-label="Name or phone" placeholder="Type at least 2 letters or the last digits of a phone" value={q} onChange={(e) => setQ(e.target.value)} />
        {err && <ErrorNote>{err}</ErrorNote>}
        {res && res.length === 0 && <Empty>No guardian found. Check the spelling, or try the phone number.</Empty>}
        <div className="kd-results">
          {res?.map((g) => (
            <div key={g.id} className="kd-guardian">
              <div>
                <b>{g.name}</b> <span className="tiny">{g.memberNumber}{g.phone ? ` · ${g.phone}` : ''}</span>
                <div className="tiny">{g.children?.length ? g.children.map((c: any) => c.name).join(', ') : 'No children listed'}</div>
                {g.hasApp && <div className="kd-hint">This guardian has the app. Scanning their code is safer.</div>}
              </div>
              <Button small kind={g.hasApp ? 'ghost' : 'primary'} disabled={busy} onClick={() => pick(g)}>Choose</Button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

// ---------- pick-up code ----------

function CodeModal({ sessionId, onClose, onFound }: { sessionId: string; onClose: () => void; onFound: (p: Panel) => void }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.post(`/kids/sessions/${sessionId}/lookup`, withGeo({ code, device: deviceLabel() }));
      if (r.result !== 'ok') { setErr(r.message ?? 'That code did not work.'); setBusy(false); return; }
      onFound({ guardian: { name: r.holder }, proof: r.proof, dropOff: [], collect: r.children ?? [], note: r.kind === 'approved' ? 'This is an approved pick-up person.' : undefined });
    } catch (e: any) { setErr(errMsg(e)); setBusy(false); }
  };
  return (
    <Modal title="I have a pick-up code" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); go(); }}>
        <Field label="The 6-digit code they read out"><input className="kd-code" autoFocus inputMode="numeric" maxLength={6} autoComplete="off" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="000000" /></Field>
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row"><Button type="submit" disabled={busy || code.length !== 6}>{busy ? 'Checking...' : 'Check code'}</Button><Button kind="ghost" onClick={onClose}>Cancel</Button></div>
      </form>
    </Modal>
  );
}

// ---------- someone else is collecting ----------

function OtherCollector({ sessionId, row, onClose, onFound }: { sessionId: string; row: any; onClose: () => void; onFound: (p: Panel) => void }) {
  const list = useAsync<any>(() => api.get(`/kids/checkins/${row.id}/collectors`), [row.id]);
  const [chosen, setChosen] = useState<any>(null);
  const [sentTo, setSentTo] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const all = [...(list.data?.guardians ?? []), ...(list.data?.people ?? [])];

  const send = async (p: any) => {
    setBusy(true); setErr(''); setChosen(p);
    try {
      const r = await api.post(`/kids/checkins/${row.id}/send-code`, withGeo({ kind: p.kind, id: p.id, device: deviceLabel() }));
      setSentTo(r.sentTo);
    } catch (e: any) { setErr(errMsg(e)); setChosen(null); }
    setBusy(false);
  };
  const verify = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.post(`/kids/sessions/${sessionId}/lookup`, withGeo({ code, device: deviceLabel() }));
      if (r.result !== 'ok') { setErr(r.message ?? 'That code did not work.'); setBusy(false); return; }
      onFound({ guardian: { name: r.holder }, proof: r.proof, dropOff: [], collect: r.children ?? [], note: r.kind === 'approved' ? 'This is an approved pick-up person.' : undefined });
    } catch (e: any) { setErr(errMsg(e)); setBusy(false); }
  };

  return (
    <Modal title={`Someone else is collecting ${row.name}`} onClose={onClose}>
      <div className="stack">
        {!sentTo && (
          <>
            <p className="muted" style={{ margin: 0 }}>Choose who is collecting. We send a code to their own phone, and they read it out to you.</p>
            <Load loading={list.loading} error={list.error} hasData={!!list.data}>
              {list.data && all.length === 0 && <Empty>No one else is set up to collect this child. Ask the guardian to add a pick-up person in the app.</Empty>}
              <div className="kd-results">
                {all.map((p) => (
                  <div key={`${p.kind}${p.id}`} className="kd-guardian">
                    <div><b>{p.name}</b> <span className="tiny">{p.kind === 'guardian' ? 'Guardian' : 'Approved pick-up person'}{p.phone ? ` · ${p.phone}` : ''}</span>{p.note && <div className="tiny">{p.note}</div>}</div>
                    <Button small disabled={busy} onClick={() => send(p)}>{busy && chosen?.id === p.id ? 'Sending...' : 'Send code'}</Button>
                  </div>
                ))}
              </div>
            </Load>
          </>
        )}
        {sentTo && (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); verify(); }}>
            <Note tone="good">Code sent to {sentTo}. Type the code they read out.</Note>
            <Field label="6-digit code"><input className="kd-code" autoFocus inputMode="numeric" maxLength={6} autoComplete="off" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="000000" /></Field>
            <div className="row"><Button type="submit" disabled={busy || code.length !== 6}>{busy ? 'Checking...' : 'Check code'}</Button><Button kind="ghost" onClick={() => { setSentTo(''); setCode(''); setErr(''); }}>Choose someone else</Button></div>
          </form>
        )}
        {err && <ErrorNote>{err}</ErrorNote>}
      </div>
    </Modal>
  );
}

// ---------- late children: call and alert ----------

function Contacts({ row, onClose }: { row: any; onClose: () => void }) {
  const q = useAsync<any>(() => api.get(`/kids/checkins/${row.id}/contacts?device=${encodeURIComponent(deviceLabel())}${(() => { const g = geoNow(); return g ? `&geo=${g.lat},${g.lng},${g.acc}` : ''; })()}`), [row.id]);
  return (
    <Modal title={`Call the guardians of ${row.name}`} onClose={onClose}>
      <div className="stack">
        <Load loading={q.loading} error={q.error} hasData={!!q.data}>
          {q.data && (
            <>
              {q.data.guardians?.length === 0 && <Empty>No phone numbers are on file.</Empty>}
              {q.data.guardians?.map((g: any, i: number) => (
                <div key={i} className="kd-guardian">
                  <div><b>{g.name}</b><div className="mono">{g.phone}</div></div>
                  <a className="btn primary" href={`tel:${String(g.phone).replace(/\s/g, '')}`}>Call</a>
                </div>
              ))}
              <div className="tiny">Showing these numbers is recorded in the log.</div>
            </>
          )}
        </Load>
        <div className="row"><Button kind="ghost" onClick={onClose}>Close</Button></div>
      </div>
    </Modal>
  );
}

function Escalate({ row, onClose, onDone }: { row: any; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try { await api.post(`/kids/checkins/${row.id}/escalate`, withGeo({ note: note.trim(), device: deviceLabel() })); onDone(); }
    catch (e: any) { setErr(errMsg(e)); setBusy(false); }
  };
  return (
    <Modal title="Alert the church office" onClose={onClose}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>{row.name} ({tagText(row.tag)}) has not been collected. The church office will be told and the guardians' phone numbers become available to you.</p>
        <Field label="Note (optional)"><textarea rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row"><Button kind="danger" disabled={busy} onClick={go}>{busy ? 'Alerting...' : 'Alert the office'}</Button><Button kind="ghost" onClick={onClose}>Cancel</Button></div>
      </div>
    </Modal>
  );
}

// ---------- one room ----------

const STATE_CHIP: Record<string, { text: string; tone: 'warn' | 'bad' }> = {
  late: { text: 'Late', tone: 'warn' },
  alerted: { text: 'Guardians alerted', tone: 'warn' },
  escalated: { text: 'Office alerted', tone: 'bad' },
};

function Room({ id, onBack }: { id: string; onBack: () => void }) {
  const q = useAsync<any>(() => api.get(`/kids/sessions/${id}`), [id]);
  const reload = q.reload;
  const [banner, setBanner] = useState<Banner | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [tag, setTag] = useState<{ tag: number | string; names: string[]; codeSent: boolean } | null>(null);
  const [mode, setMode] = useState<'' | 'find' | 'code'>('');
  const [other, setOther] = useState<any>(null);
  const [calling, setCalling] = useState<any>(null);
  const [escalating, setEscalating] = useState<any>(null);
  const [showGone, setShowGone] = useState(false);
  const [closeErr, setCloseErr] = useState('');
  const [closing, setClosing] = useState(false);
  const toast = useToast();
  const geo = useGeo(true);
  const [loc, setLoc] = useState<Loc | null>(null);
  const busy = useRef(false);
  const last = useRef({ code: '', at: 0 });
  const blocked = useRef(false);
  blocked.current = !!panel || !!tag || mode !== '' || !!other;

  useEffect(() => { const t = setInterval(reload, 10_000); return () => clearInterval(t); }, [reload]);

  const [locating, setLocating] = useState(false);
  const locate = useCallback(async () => {
    setLocating(true);
    try { const r = await api.post(`/kids/sessions/${id}/locate`, withGeo({})); setLoc(r.location ?? null); } catch { /* the strip just stays as it was */ }
    setLocating(false);
  }, [id]);
  // Check the position when the first reading (or a refusal) arrives, then every minute.
  useEffect(() => { if (geo.state !== 'waiting') locate(); }, [geo.state, locate]);
  useEffect(() => { const t = setInterval(locate, 60_000); return () => clearInterval(t); }, [locate]);

  const onScan = useCallback(async (raw: string) => {
    const token = raw.trim();
    if (!token || blocked.current || busy.current) return;
    const now = Date.now();
    if (last.current.code === token && now - last.current.at < 4000) return;
    last.current = { code: token, at: now };
    busy.current = true;
    try {
      const r = await api.post(`/kids/sessions/${id}/scan`, withGeo({ token, device: deviceLabel() }));
      if (r.result === 'ok') {
        beep(true);
        setPanel({ guardian: r.guardian, proof: r.proof, dropOff: r.dropOff ?? [], collect: r.collect ?? [], location: r.location });
        if (r.location) setLoc(r.location);
      } else {
        beep(false);
        setBanner({ tone: r.result === 'expired' ? 'warn' : 'bad', title: r.result === 'expired' ? 'Code has expired' : r.result === 'wrong_church' ? 'Not our church' : 'Not a valid code', lines: [r.message ?? 'Ask the guardian to open their code again.'] });
      }
    } catch (e: any) { beep(false); setBanner({ tone: 'bad', title: 'Could not read the code', lines: [errMsg(e)] }); }
    busy.current = false;
  }, [id]);

  const scan = useScanner(onScan);
  const d = q.data;
  const rows: any[] = d?.children ?? [];
  const here = rows.filter((c) => c.status === 'in');
  const gone = rows.filter((c) => c.status === 'out');
  const over = d ? new Date(d.serverNow) > new Date(d.session.endsAt) : false;
  const isOpen = d?.session?.status === 'open';

  const found = (p: Panel) => { setMode(''); setOther(null); setPanel(p); };

  const closeSession = async () => {
    setClosing(true); setCloseErr('');
    try { await api.post(`/kids/sessions/${id}/close`, withGeo({ device: deviceLabel() })); scan.stop(); onBack(); }
    catch (e: any) { setCloseErr(errMsg(e)); setClosing(false); }
  };

  return (
    <div className="kd">
      {toast.node}
      <BannerView b={banner} onClose={() => setBanner(null)} />
      <div className="row"><Button small kind="ghost" onClick={() => { scan.stop(); onBack(); }}>Back to classes</Button></div>
      <Load loading={q.loading} error={q.error} hasData={!!d}>
        {d && (
          <>
            <div className="card kd-top">
              <div>
                <div className="tiny">{d.room ? `${d.room} · ` : ''}{d.branch}</div>
                <h2 style={{ margin: '2px 0' }}>{d.className}</h2>
                <div className={over ? 'kd-over' : 'tiny'}>{isOpen ? (over ? `Ended ${hhmm(d.session.endsAt)}. Time is up.` : `Ends ${hhmm(d.session.endsAt)}`) : 'This session is closed.'}</div>
              </div>
              <div className="kd-count"><b>{here.length}</b><span>here now</span></div>
            </div>

            {isOpen && loc && loc.status !== 'unchecked' && (
              <div className={`kd-loc ${loc.status}`} role="status">
                {loc.status === 'ok' ? <b>At {loc.branch ?? d.branch}</b> : <div>{loc.message}</div>}
                {loc.status === 'unknown' && (
                  <>
                    <div className="tiny">Allow location for this site in your browser settings. Location needs https or localhost.</div>
                    <Button small kind="ghost" disabled={locating} onClick={locate}>{locating ? 'Trying...' : 'Try again'}</Button>
                  </>
                )}
              </div>
            )}

            {isOpen && (
              <div className="card stack">
                <h3 style={{ margin: 0 }}>Scan a guardian</h3>
                <div className="ck-video-wrap" style={scan.camOn ? undefined : { aspectRatio: '16 / 7' }}>
                  <video ref={scan.video} playsInline muted style={scan.camOn ? undefined : { display: 'none' }} />
                  {scan.camOn && <div className="ck-frame" aria-hidden="true" />}
                  {!scan.camOn && <div>Point the camera at the code on the guardian's phone</div>}
                </div>
                <canvas ref={scan.canvas} hidden />
                <div className="row">
                  {scan.camOn ? <Button kind="ghost" onClick={scan.stop}>Stop scanning</Button> : <Button onClick={scan.start}>Start scanning</Button>}
                </div>
                {scan.camMsg && <ErrorNote>{scan.camMsg}</ErrorNote>}
                <div className="kd-alt">
                  <Button kind="ghost" onClick={() => setMode('find')}>Find by name or phone</Button>
                  <Button kind="ghost" onClick={() => setMode('code')}>I have a pick-up code</Button>
                </div>
              </div>
            )}

            <div className="card stack">
              <h3 style={{ margin: 0 }}>In the room ({here.length})</h3>
              {here.length === 0 ? <Empty>No children are in the room right now.</Empty> : (
                <div className="kd-list">
                  {here.map((c) => {
                    const chip = STATE_CHIP[c.state];
                    const late = c.state === 'late' || c.state === 'alerted' || c.state === 'escalated';
                    return (
                      <div key={c.id} className={`kd-child ${late ? 'late' : ''}`}>
                        <div className="kd-tag">{String(c.tag).padStart(2, '0')}</div>
                        <div className="kd-info">
                          <div className="kd-name">{c.name} {chip && <Badge tone={chip.tone}>{chip.text}</Badge>}</div>
                          <div className="tiny">Since {hhmm(c.inAt)}{c.dropper || c.inBy ? ` by ${c.dropper ?? c.inBy}` : ''}</div>
                          <div className="kd-actions">
                            <Button small kind="ghost" onClick={() => setOther(c)}>Someone else is collecting</Button>
                            {late && <Button small kind="danger" onClick={() => setCalling(c)}>Call guardians</Button>}
                            {late && c.state !== 'escalated' && <Button small kind="ghost" onClick={() => setEscalating(c)}>Alert the church office</Button>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {gone.length > 0 && (
                <div className="stack">
                  <button type="button" className="kd-toggle" aria-expanded={showGone} onClick={() => setShowGone(!showGone)}>{showGone ? '▾' : '▸'} Gone home ({gone.length})</button>
                  {showGone && (
                    <div className="ck-recent">
                      {gone.map((c) => <div key={c.id}><span><b>{c.name}</b> <span className="tiny">{tagText(c.tag)}</span></span><span className="tiny">{hhmm(c.outAt)}{c.collector ? ` · ${c.collector}` : ''}</span></div>)}
                    </div>
                  )}
                </div>
              )}
            </div>

            {isOpen && (
              <div className="card stack">
                <div className="row between">
                  <div><b>Finished for the day?</b><div className="tiny">Every child must be handed over before you can close.</div></div>
                  <Button kind="ghost" disabled={closing} onClick={closeSession}>{closing ? 'Closing...' : 'Close session'}</Button>
                </div>
                {closeErr && <ErrorNote>{closeErr}</ErrorNote>}
              </div>
            )}
          </>
        )}
      </Load>

      {mode === 'find' && <FindModal sessionId={id} onClose={() => setMode('')} onFound={found} onBanner={setBanner} />}
      {mode === 'code' && <CodeModal sessionId={id} onClose={() => setMode('')} onFound={found} />}
      {other && <OtherCollector sessionId={id} row={other} onClose={() => setOther(null)} onFound={found} />}
      {calling && <Contacts row={calling} onClose={() => { setCalling(null); reload(); }} />}
      {escalating && <Escalate row={escalating} onClose={() => setEscalating(null)} onDone={() => { setEscalating(null); toast.show('The church office has been alerted'); reload(); }} />}
      {panel && <GuardianPanel sessionId={id} panel={panel} onClose={() => setPanel(null)} onChanged={reload} onLoc={(l) => l && setLoc(l)} onTag={(t) => { setPanel(null); setTag(t); }} onBanner={setBanner} />}
      {tag && (
        <div className="modal-scrim" role="presentation">
          <div className="modal kd-tagcard" role="dialog" aria-modal="true" aria-label="Tag number">
            <div className="tiny">Give the guardian this tag</div>
            <div className="kd-tag-big">{tagText(tag.tag)}</div>
            <div className="kd-who">{tag.names.join(', ')}</div>
            {tag.codeSent && <Note tone="good">An SMS with the pick-up code was sent to the guardian.</Note>}
            <div className="row" style={{ justifyContent: 'center' }}><Button onClick={() => setTag(null)}>Done</Button></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- classes and rooms ----------

function ClassEditor({ cls, branches, onClose, onDone }: { cls?: any; branches: { id: string; name: string }[]; onClose: () => void; onDone: () => void }) {
  const s = useSession();
  const [name, setName] = useState<string>(cls?.name ?? '');
  const [room, setRoom] = useState<string>(cls?.room ?? '');
  const [branchId, setBranchId] = useState<string>(cls?.branchId ?? (s.scope !== 'all' ? s.scope : branches[0]?.id ?? ''));
  const [teachers, setTeachers] = useState<Set<string>>(new Set((cls?.teachers ?? []).map((t: any) => t.id)));
  const [active, setActive] = useState<boolean>(cls?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const pool = useAsync<any>(() => api.get(`/kids/teachers?branchId=${encodeURIComponent(branchId)}`), [branchId]);
  const list: { id: string; name: string }[] = [...(pool.data?.teachers ?? [])];
  for (const t of cls?.teachers ?? []) if (!list.some((x) => x.id === t.id)) list.push(t);

  const save = async () => {
    if (name.trim().length < 2) return setErr('Give the class a name, for example Sunday School.');
    setBusy(true); setErr('');
    try {
      if (cls) await patch(`/kids/classes/${cls.id}`, { name: name.trim(), room: room.trim(), teachers: [...teachers], active });
      else await api.post('/kids/classes', { branchId, name: name.trim(), room: room.trim(), teachers: [...teachers] });
      onDone();
    } catch (e: any) { setErr(errMsg(e)); setBusy(false); }
  };

  return (
    <Modal title={cls ? `Edit ${cls.name}` : 'Add a class'} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Field label="Class name"><input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Sunday School" /></Field>
        <Field label="Room"><input value={room} maxLength={80} onChange={(e) => setRoom(e.target.value)} placeholder="Room 2, ground floor" /></Field>
        {!cls && branches.length > 1 && (
          <Field label="Branch"><select value={branchId} onChange={(e) => setBranchId(e.target.value)}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        )}
        <div className="stack" style={{ gap: 8 }}>
          <span className="field-label">Teachers</span>
          <Load loading={pool.loading} error={pool.error} hasData={!!pool.data}>
            {list.length === 0 ? <div className="tiny">No staff can check children in at this branch yet. Give someone the teacher role in Team.</div> : (
              <div className="kd-picks">
                {list.map((t) => (
                  <label key={t.id} className="kd-pick"><input type="checkbox" checked={teachers.has(t.id)} onChange={() => { const n = new Set(teachers); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); setTeachers(n); }} /><span>{t.name}</span></label>
                ))}
              </div>
            )}
          </Load>
        </div>
        {cls && <label className="kd-pick"><input type="checkbox" checked={!active} onChange={() => setActive(!active)} /><span>Switch this class off (it will not be offered for check-in)</span></label>}
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row"><Button type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save'}</Button><Button kind="ghost" onClick={onClose}>Cancel</Button></div>
      </form>
    </Modal>
  );
}

function OpenSession({ cls, onClose, onOpened }: { cls: any; onClose: () => void; onOpened: (id: string) => void }) {
  const [minutes, setMinutes] = useState(120);
  const [custom, setCustom] = useState('');
  const [grace, setGrace] = useState('15');
  const [escalate, setEscalate] = useState('30');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useGeo(true);
  const mins = custom ? Number(custom) : minutes;
  const go = async () => {
    if (!Number.isFinite(mins) || mins < 15 || mins > 720) return setErr('Choose a time between 15 minutes and 12 hours.');
    setBusy(true); setErr('');
    try {
      const r = await api.post(`/kids/classes/${cls.id}/sessions`, withGeo({ minutes: Math.round(mins), graceMin: Number(grace) || 15, escalateMin: Number(escalate) || 30, device: deviceLabel() }));
      onOpened(r.id);
    } catch (e: any) { setErr(errMsg(e)); setBusy(false); }
  };
  return (
    <Modal title={`Open ${cls.name}`} onClose={onClose}>
      <div className="stack">
        <div>
          <div className="field-label" style={{ marginBottom: 8 }}>How long will the class run?</div>
          <div className="chips">
            {[[60, '1 hour'], [90, '1½ hours'], [120, '2 hours'], [180, '3 hours']].map(([m, t]) => (
              <button key={m} type="button" className={`chip ${!custom && minutes === m ? 'on' : ''}`} onClick={() => { setMinutes(m as number); setCustom(''); }}>{t}</button>
            ))}
          </div>
        </div>
        <Field label="Or choose your own (minutes)"><input inputMode="numeric" value={custom} onChange={(e) => setCustom(e.target.value.replace(/\D/g, ''))} placeholder="for example 100" /></Field>
        <details className="kd-details">
          <summary>Late alerts</summary>
          <div className="stack" style={{ marginTop: 12 }}>
            <Field label="Alert guardians when a child is this many minutes late"><input inputMode="numeric" value={grace} onChange={(e) => setGrace(e.target.value.replace(/\D/g, ''))} /></Field>
            <Field label="Tell the staff when a child is this many minutes late"><input inputMode="numeric" value={escalate} onChange={(e) => setEscalate(e.target.value.replace(/\D/g, ''))} /></Field>
          </div>
        </details>
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row"><Button disabled={busy} onClick={go}>{busy ? 'Opening...' : 'Open session'}</Button><Button kind="ghost" onClick={onClose}>Cancel</Button></div>
      </div>
    </Modal>
  );
}

function BranchLocation({ branches, onChanged }: { branches: any[]; onChanged: () => void }) {
  const [radius, setRadius] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<Record<string, { tone: 'good' | 'bad' | 'warn'; text: string }>>({});
  const [pending, setPending] = useState<{ id: string; g: Geo } | null>(null);
  const geo = useGeo(true);
  const say = (id: string, tone: 'good' | 'bad' | 'warn', text: string) => setMsg((m) => ({ ...m, [id]: { tone, text } }));
  const rad = (b: any) => Number(radius[b.id] ?? b.location?.radiusM ?? 300);

  const read = (b: any) => {
    const r = rad(b);
    if (!Number.isFinite(r) || r < 50 || r > 2000) return say(b.id, 'bad', 'Choose a radius between 50 and 2000 metres.');
    setBusy(b.id); setPending(null); say(b.id, 'warn', 'Reading your location...');
    if (!('geolocation' in navigator)) { setBusy(''); return say(b.id, 'bad', 'This browser cannot give a location.'); }
    const done = (g: Geo) => {
      setBusy('');
      if (g.acc <= 200) { setPending({ id: b.id, g }); say(b.id, 'good', `Location found, accurate to about ${g.acc} m. Confirm to save it as the church location.`); }
      else say(b.id, 'bad', `Your reading is not accurate enough (about ${g.acc} m). Stand outside the church and try again.`);
    };
    // A reading from the live watch in the last 30 seconds is as good as a new one.
    if (lastGeo && Date.now() - lastGeo.at < 30_000) return done({ lat: lastGeo.lat, lng: lastGeo.lng, acc: lastGeo.acc });
    navigator.geolocation.getCurrentPosition(
      (p) => done({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) }),
      (e) => { setBusy(''); say(b.id, 'bad', e.code === 1 ? 'Location is blocked. Allow location for this site in your browser settings, then try again.' : 'Could not read your location. Stand outside the church and try again.'); },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
  };
  const save = async (b: any) => {
    if (!pending) return;
    setBusy(b.id);
    try { await api.put(`/kids/branches/${b.id}/location`, { lat: pending.g.lat, lng: pending.g.lng, radiusM: rad(b) }); setPending(null); say(b.id, 'good', 'Saved. Children can now only be checked in near the church.'); onChanged(); }
    catch (e: any) { say(b.id, 'bad', errMsg(e)); }
    setBusy('');
  };
  const clear = async (b: any) => {
    if (!window.confirm(`Remove the location check for ${b.name}? Children could then be checked in from anywhere.`)) return;
    setBusy(b.id);
    try { await api.put(`/kids/branches/${b.id}/location`, { clear: true }); setPending(null); say(b.id, 'good', 'The location check was removed.'); onChanged(); }
    catch (e: any) { say(b.id, 'bad', errMsg(e)); }
    setBusy('');
  };
  if (branches.length === 0) return null;
  return (
    <div className="card stack kd-branch">
      <div><h3 style={{ margin: 0 }}>Branch location</h3><div className="tiny">Do this while standing at the church. Children can then only be checked in when the teacher is there.</div></div>
      {branches.map((b) => (
        <div key={b.id} className="kd-brow">
          <b>{b.name}</b>
          {b.location
            ? <div className="kd-set">Set: children can only be checked in within {b.location.radiusM} m of the church</div>
            : <div className="kd-hint">Not set: children can be checked in from anywhere. Set it while you are at the church.</div>}
          <div className="kd-radius">
            <Field label="Radius (metres)"><input inputMode="numeric" value={radius[b.id] ?? String(b.location?.radiusM ?? 300)} onChange={(e) => setRadius({ ...radius, [b.id]: e.target.value.replace(/\D/g, '') })} /></Field>
          </div>
          <div className="row">
            {pending?.id === b.id
              ? <><Button disabled={busy === b.id} onClick={() => save(b)}>Yes, save this location</Button><Button kind="ghost" onClick={() => { setPending(null); setMsg((m) => { const n = { ...m }; delete n[b.id]; return n; }); }}>Cancel</Button></>
              : <Button disabled={busy === b.id} onClick={() => read(b)}>{busy === b.id ? 'Working...' : 'Use my current location'}</Button>}
            {b.location && !pending && <Button kind="ghost" disabled={busy === b.id} onClick={() => clear(b)}>Remove location check</Button>}
          </div>
          {geo.state === 'denied' && !msg[b.id] && <div className="tiny">Location is blocked for this site. Allow it in your browser settings first.</div>}
          {msg[b.id] && <div className={`kd-msg ${msg[b.id].tone}`}>{msg[b.id].text}</div>}
        </div>
      ))}
    </div>
  );
}

function Classes({ onRoom }: { onRoom: (id: string) => void }) {
  const q = useAsync<any>(() => api.get('/kids/classes'), []);
  const reload = q.reload;
  const [opening, setOpening] = useState<any>(null);
  const [editing, setEditing] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => { const t = setInterval(reload, 15_000); return () => clearInterval(t); }, [reload]);
  const d = q.data;
  const classes: any[] = d?.classes ?? [];
  return (
    <div className="stack">
      {d?.canManage && <BranchLocation branches={d.branches ?? []} onChanged={reload} />}
      {d?.canManage && <div className="row"><Button onClick={() => setAdding(true)}>Add a class</Button></div>}
      <Load loading={q.loading} error={q.error} hasData={!!d}>
        {d && (classes.length === 0 ? <Empty>{d.canManage ? 'No classes yet. Add the first one.' : 'No classes are set up for you yet. Ask a church manager to add you to a class.'}</Empty> : (
          <div className="kd-cards">
            {classes.map((c) => (
              <div key={c.id} className={`card kd-class ${c.active ? '' : 'off'}`}>
                <div className="row between">
                  <h3 style={{ margin: 0 }}>{c.name}</h3>
                  {!c.active && <Badge tone="muted">Switched off</Badge>}
                  {c.session && <Badge tone="good">{c.session.stillIn} here</Badge>}
                </div>
                <div className="tiny">{c.room ? `${c.room} · ` : ''}{c.branch}</div>
                <div className="tiny">{c.teachers.length ? `Teachers: ${c.teachers.map((t: any) => t.name).join(', ')}` : 'No teachers chosen yet'}</div>
                {c.session && <div className="tiny">Open until {hhmm(c.session.endsAt)} · {c.session.checkedIn} checked in so far</div>}
                <div className="row" style={{ marginTop: 4 }}>
                  {c.session ? <Button onClick={() => onRoom(c.session.id)}>Open room</Button> : c.active ? <Button onClick={() => setOpening(c)}>Open session</Button> : null}
                  {c.canManage && <Button kind="ghost" onClick={() => setEditing(c)}>Edit</Button>}
                </div>
              </div>
            ))}
          </div>
        ))}
      </Load>
      {opening && <OpenSession cls={opening} onClose={() => setOpening(null)} onOpened={(id) => { setOpening(null); onRoom(id); }} />}
      {(adding || editing) && <ClassEditor cls={editing ?? undefined} branches={d?.branches ?? []} onClose={() => { setAdding(false); setEditing(null); }} onDone={() => { setAdding(false); setEditing(null); reload(); }} />}
    </div>
  );
}

// ---------- manager tabs ----------

function LogTab() {
  const [from, setFrom] = useState(daysAgo(7));
  const [to, setTo] = useState(today());
  const [text, setText] = useState('');
  const [dq, setDq] = useState('');
  const [action, setAction] = useState('');
  const [actions, setActions] = useState<string[]>([]);
  useEffect(() => { const t = setTimeout(() => setDq(text.trim()), 300); return () => clearTimeout(t); }, [text]);
  const qs = (csv = false) => {
    const p = new URLSearchParams({ from, to });
    if (dq) p.set('q', dq);
    if (action) p.set('action', action);
    if (csv) p.set('csv', '1');
    return p.toString();
  };
  const q = useAsync<any>(() => api.get(`/kids/log?${qs()}`), [from, to, dq, action]);
  const log: any[] = q.data?.log ?? [];
  useEffect(() => { if (q.data) setActions((a) => [...new Set([...a, ...log.map((l) => l.action)])].sort()); }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const res = (r: string) => <Badge tone={r === 'ok' ? 'good' : r === 'refused' || r === 'invalid' ? 'bad' : 'warn'}>{label(r)}</Badge>;
  const locCell = (l: any) => !l.locationStatus ? <span className="tiny">-</span> : (
    <div className={`kd-locrow ${l.locationStatus === 'Away from the branch' ? 'away' : l.locationStatus === 'Location not shared' ? 'unknown' : ''}`}>
      <b>{l.locationStatus}</b>{l.distanceM != null && l.distanceM !== '' ? ` · ${l.distanceM} m` : ''}{l.locationSource ? <span className="tiny"> ({l.locationSource})</span> : null}
      {l.teacherLocation && <div className="tiny">Teacher: {l.teacherLocation}</div>}
      {l.guardianLocation && <div className="tiny">Guardian: {l.guardianLocation}</div>}
    </div>
  );
  const who = (n?: string, dev?: string) => <>{n || '-'}{dev && <div className="tiny">{dev}</div>}</>;
  return (
    <div className="stack">
      <div className="kd-filters">
        <Field label="From"><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Search"><input value={text} onChange={(e) => setText(e.target.value)} placeholder="Name or class" /></Field>
        <Field label="What happened"><select value={action} onChange={(e) => setAction(e.target.value)}><option value="">Everything</option>{actions.map((a) => <option key={a} value={a}>{label(a)}</option>)}</select></Field>
        <div className="kd-filter-btn"><Button kind="ghost" onClick={() => window.open(api.url(`/kids/log?${qs(true)}`), '_blank')}>Download CSV</Button></div>
      </div>
      <Load loading={q.loading} error={q.error} hasData={!!q.data}>
        {q.data && (log.length === 0 ? <Empty>Nothing was logged in these dates.</Empty> : (
          <>
            <div className="table-wrap kd-desktop">
              <table className="table">
                <thead><tr>{['When', 'What', 'Result', 'Class', 'Teacher', 'Guardian', 'Children', 'Location', 'Detail'].map((h) => <th key={h}>{h}</th>)}</tr></thead>
                <tbody>
                  {log.map((l) => (
                    <tr key={l.id}>
                      <td>{when(l.at)}</td><td>{label(l.action)}{l.method && <div className="tiny">{label(l.method)}</div>}</td><td>{res(l.result)}</td><td>{l.className || '-'}</td>
                      <td>{who(l.teacher, l.teacherDevice)}</td><td>{who(l.guardian, l.guardianDevice)}</td><td>{l.children || '-'}</td><td>{locCell(l)}</td><td className="tiny">{l.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="kd-mobile stack" style={{ gap: 10 }}>
              {log.map((l) => (
                <div key={l.id} className="tk-row">
                  <div className="row between"><b>{label(l.action)}</b>{res(l.result)}</div>
                  <div className="tiny">{when(l.at)}{l.className ? ` · ${l.className}` : ''}</div>
                  {l.children && <div>Children: {l.children}</div>}
                  <div className="tiny">Teacher: {l.teacher || '-'}{l.teacherDevice ? ` (${l.teacherDevice})` : ''}</div>
                  {l.guardian && <div className="tiny">Guardian: {l.guardian}{l.guardianDevice ? ` (${l.guardianDevice})` : ''}</div>}
                  {l.locationStatus && <div className="tiny">Location: {locCell(l)}</div>}
                  {l.detail && <div className="tiny">{l.detail}</div>}
                </div>
              ))}
            </div>
          </>
        ))}
      </Load>
    </div>
  );
}

function ReportTab() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());
  const q = useAsync<any>(() => api.get(`/kids/report?from=${from}&to=${to}`), [from, to]);
  const t = q.data?.totals;
  const rows: any[] = q.data?.sessions ?? [];
  return (
    <div className="stack">
      <div className="kd-filters">
        <Field label="From"><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
        <div className="kd-filter-btn"><Button kind="ghost" onClick={() => window.open(api.url(`/kids/report?from=${from}&to=${to}&csv=1`), '_blank')}>Download CSV</Button></div>
      </div>
      <Load loading={q.loading} error={q.error} hasData={!!q.data}>
        {q.data && (
          <>
            <div className="kd-totals">
              {([['Sessions', t.sessions], ['Children checked in', t.checkedIn], ['Late pick-ups', t.late], ['Office alerts', t.escalated]] as const).map(([k, v]) => <div key={k} className="card"><b>{v}</b><span className="tiny">{k}</span></div>)}
            </div>
            {rows.length === 0 ? <Empty>No sessions were held in these dates.</Empty> : (
              <>
                <div className="table-wrap kd-desktop">
                  <table className="table">
                    <thead><tr>{['Date', 'Class', 'Branch', 'Ended', 'Status', 'Checked in', 'Still in', 'Late', 'Office alerted'].map((h) => <th key={h}>{h}</th>)}</tr></thead>
                    <tbody>{rows.map((r) => <tr key={r.id}><td>{shortDay(r.date)}</td><td>{r.className}</td><td>{r.branch}</td><td>{hhmm(r.endsAt)}</td><td>{label(r.status)}</td><td className="num">{r.checkedIn}</td><td className="num">{r.stillIn}</td><td className="num">{r.late}</td><td className="num">{r.escalated}</td></tr>)}</tbody>
                  </table>
                </div>
                <div className="kd-mobile stack" style={{ gap: 10 }}>
                  {rows.map((r) => (
                    <div key={r.id} className="tk-row">
                      <div className="row between"><b>{r.className}</b><span className="tiny">{shortDay(r.date)}</span></div>
                      <div className="tiny">{r.branch} · {label(r.status)} · ended {hhmm(r.endsAt)}</div>
                      <div>{r.checkedIn} checked in, {r.stillIn} still in, {r.late} late, {r.escalated} office alerts</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </Load>
    </div>
  );
}

export function Children() {
  const s = useSession();
  const can = s.can('kids.manage');
  const [tab, setTab] = useState<'classes' | 'log' | 'report'>('classes');
  const [room, setRoom] = useState('');
  if (room) return <div><PageHead title="Children" sub="Check children in and out of class." /><Room id={room} onBack={() => setRoom('')} /></div>;
  return (
    <div>
      <PageHead title="Children" sub="Check children in and out of class." />
      <div className="stack">
        {can && (
          <div className="chips" role="tablist">
            {([['classes', 'Classes & rooms'], ['log', 'Log'], ['report', 'Reports']] as const).map(([k, t]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={`chip ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{t}</button>
            ))}
          </div>
        )}
        {tab === 'classes' || !can ? <Classes onRoom={setRoom} /> : tab === 'log' ? <LogTab /> : <ReportTab />}
      </div>
    </div>
  );
}
