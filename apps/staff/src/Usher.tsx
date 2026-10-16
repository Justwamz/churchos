import { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { Button, Empty, ErrorNote, Field, useAsync } from '@churchos/ui';
import { api, friendly } from './session';
import { Load, PageHead } from './bits';
import './usher.css';

const when = (iso: string) => new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi', hour: 'numeric', minute: '2-digit' });
const VIA: Record<string, string> = { app: 'member app', door: 'door screen', usher: 'usher', live_link: 'live link', invite: 'invite' };

type Banner = { tone: 'good' | 'warn' | 'bad'; title: string; line?: string };

function beep(ok: boolean) {
  try { navigator.vibrate?.(ok ? 80 : [120, 80, 120]); } catch { /* optional */ }
  try {
    const A = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!A) return;
    const c = new A(); const o = c.createOscillator(); const g = c.createGain();
    o.frequency.value = ok ? 880 : 240; g.gain.value = 0.08;
    o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime + 0.12);
    setTimeout(() => c.close(), 400);
  } catch { /* optional */ }
}

function DoorScreen({ id, onClose }: { id: string; onClose: () => void }) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [left, setLeft] = useState(45);
  useEffect(() => {
    let alive = true;
    const load = () => api.get(`/attendance/services/${id}/door`).then((r) => { if (alive) { setD(r); setErr(''); setLeft(r.refreshSeconds ?? 45); } }).catch((e: any) => alive && setErr(friendly(e?.message)));
    load();
    const t = setInterval(load, 40_000);
    const c = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => { alive = false; clearInterval(t); clearInterval(c); window.removeEventListener('keydown', k); };
  }, [id, onClose]);
  return (
    <div className="us-door" role="dialog" aria-label="Door screen">
      <button className="x" onClick={onClose} aria-label="Close door screen">×</button>
      {d && <><h1>{d.service.church}</h1><div className="sub">{d.service.name} · {when(d.service.startsAt)}</div></>}
      {err && <ErrorNote>{err}</ErrorNote>}
      {d ? <div className="qr" data-testid="door-qr" dangerouslySetInnerHTML={{ __html: d.qrSvg }} /> : !err && <div className="sub">Loading...</div>}
      <div className="go">Scan with your phone camera to check in</div>
      <div className="tiny">The code changes by itself. New code in {left}s.</div>
    </div>
  );
}

function Stepper({ label, value, set }: { label: string; value: string; set: (v: string) => void }) {
  const n = parseInt(value || '0', 10) || 0;
  return (
    <div className="us-step">
      <b>{label}</b>
      <div className="ctl">
        <button type="button" aria-label={`Less ${label}`} onClick={() => set(String(Math.max(0, n - 1)))}>−</button>
        <input inputMode="numeric" aria-label={label} value={value} onChange={(e) => set(e.target.value.replace(/\D/g, '').slice(0, 6))} />
        <button type="button" aria-label={`More ${label}`} onClick={() => set(String(n + 1))}>+</button>
      </div>
    </div>
  );
}

function Working({ svc, reloadSvc }: { svc: any; reloadSvc: () => void }) {
  const id = svc.id as string;
  const live = useAsync<any>(() => api.get(`/attendance/services/${id}/live`), [id]);
  const reload = live.reload;
  const [tab, setTab] = useState<'scan' | 'find' | 'visitor'>('scan');
  const [banner, setBanner] = useState<Banner | null>(null);
  const [err, setErr] = useState('');
  const hide = useRef<ReturnType<typeof setTimeout>>();
  const [doorOpen, setDoorOpen] = useState(false);
  const closeDoor = useCallback(() => setDoorOpen(false), []);

  useEffect(() => { const t = setInterval(reload, 8000); return () => clearInterval(t); }, [reload]);
  useEffect(() => () => clearTimeout(hide.current), []);

  const show = (b: Banner, ms = 4000) => {
    setBanner(b); beep(b.tone === 'good');
    clearTimeout(hide.current); hide.current = setTimeout(() => setBanner(null), ms);
  };
  const refresh = () => { reload(); reloadSvc(); };

  // Scan
  const [typed, setTyped] = useState('');
  const [camOn, setCamOn] = useState(false);
  const [camMsg, setCamMsg] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const raf = useRef(0);
  const last = useRef({ code: '', at: 0 });
  const busy = useRef(false);

  const send = useCallback(async (raw: string) => {
    const token = raw.trim();
    if (!token) return;
    const now = Date.now();
    if (last.current.code === token && now - last.current.at < 3000) return;
    last.current = { code: token, at: now };
    if (busy.current) return;
    busy.current = true; setErr('');
    try {
      const r = await api.post(`/attendance/services/${id}/scan`, { token });
      if (r.result === 'ok') show({ tone: 'good', title: `Welcome, ${r.name}`, line: r.memberNumber });
      else if (r.result === 'already') show({ tone: 'warn', title: 'Already counted', line: r.name });
      else show({ tone: 'bad', title: 'Not counted', line: r.message });
      refresh();
    } catch (e: any) { setErr(friendly(e?.message)); }
    busy.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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
  useEffect(() => { if (tab !== 'scan') stop(); }, [tab, stop]);

  const start = async () => {
    setCamMsg('');
    if (!navigator.mediaDevices?.getUserMedia) return setCamMsg('This browser cannot use the camera here. You can type the code instead.');
    try {
      const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      stream.current = st; setCamOn(true);
      const v = video.current!; v.srcObject = st; await v.play().catch(() => {});
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
            if (detector) text = (await detector.detect(v))[0]?.rawValue ?? '';
            else {
              const c = canvas.current!; const w = Math.min(640, v.videoWidth); const h = Math.round((w / v.videoWidth) * v.videoHeight);
              c.width = w; c.height = h;
              const ctx = c.getContext('2d', { willReadFrequently: true })!;
              ctx.drawImage(v, 0, 0, w, h);
              text = jsQR(ctx.getImageData(0, 0, w, h).data, w, h)?.data ?? '';
            }
            if (text) send(text);
          } catch { /* keep scanning */ }
          busyFrame = false;
        }
        raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    } catch (e: any) {
      stop();
      setCamMsg(e?.name === 'NotAllowedError' || e?.name === 'SecurityError'
        ? 'The camera is blocked. Allow the camera for this page in your browser, or type the code instead.'
        : e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError'
          ? 'No camera was found on this device. You can type the code instead.'
          : 'We could not start the camera. You can type the code instead.');
    }
  };

  // Find
  const [q, setQ] = useState('');
  const [found, setFound] = useState<any[] | null>(null);
  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) { setFound(null); return; }
    let alive = true;
    const t = setTimeout(() => {
      api.get(`/attendance/services/${id}/members?q=${encodeURIComponent(s)}`).then((r) => alive && (setFound(r.members), setErr(''))).catch((e: any) => alive && setErr(friendly(e?.message)));
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q, id]);
  const mark = async (m: any) => {
    setErr('');
    try {
      const r = await api.post(`/attendance/services/${id}/mark`, { membershipId: m.id });
      show(r.result === 'ok' ? { tone: 'good', title: `Welcome, ${r.name}` } : { tone: 'warn', title: 'Already counted', line: r.name });
      setFound((f) => f && f.map((x) => (x.id === m.id ? { ...x, here: true } : x)));
      refresh();
    } catch (e: any) { setErr(friendly(e?.message)); }
  };

  // Visitor
  const [vName, setVName] = useState('');
  const [vPhone, setVPhone] = useState('');
  const [vBusy, setVBusy] = useState(false);
  const addVisitor = async () => {
    setErr(''); setVBusy(true);
    try {
      const r = await api.post(`/attendance/services/${id}/visitor`, { name: vName.trim(), phone: vPhone.trim() });
      const first = String(r.name).split(' ')[0];
      if (r.already) show({ tone: 'warn', title: 'Already counted', line: r.name });
      else if (r.kind === 'member') show({ tone: 'good', title: `Welcome, ${first}`, line: `That number belongs to ${r.name}, a member: counted as a member.` });
      else if (r.returning && !r.first) show({ tone: 'good', title: `Welcome back, ${first}` });
      else show({ tone: 'good', title: `Welcome ${first}`, line: 'A welcome SMS is on its way.' }, 5000);
      setVName(''); setVPhone('');
      refresh();
    } catch (e: any) { setErr(friendly(e?.message)); }
    setVBusy(false);
  };

  // Headcount
  const hc = svc.headcount;
  const [a, setA] = useState(String(hc?.adults ?? 0));
  const [c, setC] = useState(String(hc?.children ?? 0));
  const [v, setV] = useState(String(hc?.visitors ?? 0));
  const [peak, setPeak] = useState(String(svc.onlinePeak ?? 0));
  const [hcMsg, setHcMsg] = useState('');
  const [pkMsg, setPkMsg] = useState('');
  const num = (s: string) => parseInt(s || '0', 10) || 0;
  const saveHc = async () => {
    setErr(''); setHcMsg('');
    try { const r = await api.put(`/attendance/services/${id}/headcount`, { adults: num(a), children: num(c), visitors: num(v) }); setHcMsg(`Saved. Headcount total: ${r.total}.`); reloadSvc(); } catch (e: any) { setErr(friendly(e?.message)); }
  };
  const savePeak = async () => {
    setErr(''); setPkMsg('');
    try { await api.put(`/attendance/services/${id}/online`, { peak: num(peak) }); setPkMsg(`Saved. Online peak: ${num(peak)}.`); reloadSvc(); } catch (e: any) { setErr(friendly(e?.message)); }
  };

  const cn = svc.counts ?? { members: 0, visitors: 0, online: 0 };
  const pct = hc && hc.total > 0 ? Math.min(100, Math.round(((cn.members + cn.visitors) / hc.total) * 100)) : null;
  const recent: any[] = (live.data?.recent ?? []).slice(0, 12);

  return (
    <div className="us">
      {banner && (
        <div className={`us-result ${banner.tone}`} role="status" aria-live="assertive" onClick={() => setBanner(null)}>
          <div className="t">{banner.title}</div>
          {banner.line && <div>{banner.line}</div>}
        </div>
      )}
      <div className="card" style={{ textAlign: 'center' }}>
        <div className="tiny">{svc.church} · {svc.branch}</div>
        <b>{svc.name}</b> <span className="tiny">{when(svc.startsAt)}</span>
      </div>
      <div className="us-counters" aria-live="polite">
        <div><b>{cn.members}</b><span>Members</span></div>
        <div><b>{cn.visitors}</b><span>Visitors</span></div>
        <div><b>{cn.online}</b><span>Online</span></div>
        <div><b>{hc ? hc.total : '-'}</b><span>{pct !== null ? `Headcount (${pct}% in)` : 'Headcount'}</span></div>
      </div>
      {err && <ErrorNote>{err}</ErrorNote>}

      <div className="us-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'scan'} className={tab === 'scan' ? 'on' : ''} onClick={() => setTab('scan')}>Scan a member</button>
        <button role="tab" aria-selected={tab === 'find'} className={tab === 'find' ? 'on' : ''} onClick={() => setTab('find')}>Find a member</button>
        <button role="tab" aria-selected={tab === 'visitor'} className={tab === 'visitor' ? 'on' : ''} onClick={() => setTab('visitor')}>Add a visitor</button>
      </div>

      {tab === 'scan' && (
        <div className="card stack">
          <div className="us-video" style={camOn ? undefined : { aspectRatio: '16 / 7' }}>
            <video ref={video} playsInline muted style={camOn ? undefined : { display: 'none' }} />
            {camOn && <div className="fr" aria-hidden="true" />}
            {!camOn && <div>Point the camera at the code in the member's app</div>}
          </div>
          <canvas ref={canvas} hidden />
          <div className="row">{camOn ? <Button kind="ghost" onClick={stop}>Stop scanning</Button> : <Button onClick={start}>Start scanning</Button>}</div>
          {camMsg && <ErrorNote>{camMsg}</ErrorNote>}
          <form className="stack" onSubmit={(e) => { e.preventDefault(); const t = typed; setTyped(''); last.current = { code: '', at: 0 }; send(t); }}>
            <Field label="Or type or paste the code"><input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="A1...." autoCapitalize="off" autoCorrect="off" spellCheck={false} /></Field>
            <div className="row"><Button type="submit" disabled={!typed.trim()}>Count this member</Button></div>
          </form>
        </div>
      )}

      {tab === 'find' && (
        <div className="card stack">
          <Field label="Name or member number"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type at least 2 letters" autoCorrect="off" /></Field>
          {found && found.length === 0 && <div className="tiny">No member found. You can add them as a visitor.</div>}
          {found && found.length > 0 && (
            <div className="us-rows">
              {found.map((m) => (
                <div key={m.id}>
                  <span className="nm"><b>{m.name}</b> <span className="tiny">{m.memberNumber}</span></span>
                  {m.here ? <span className="us-chip good">Here</span> : <Button small onClick={() => mark(m)}>Mark present</Button>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'visitor' && (
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); if (!vBusy) addVisitor(); }}>
          <Field label="Name"><input value={vName} onChange={(e) => setVName(e.target.value)} autoComplete="off" /></Field>
          <Field label="Phone number" hint="A phone number that belongs to a member counts as that member."><input value={vPhone} onChange={(e) => setVPhone(e.target.value)} inputMode="tel" placeholder="0712 345 678" autoComplete="off" /></Field>
          <div className="row"><Button type="submit" disabled={vBusy || !vName.trim() || !vPhone.trim()}>Add visitor</Button></div>
        </form>
      )}

      <div className="card stack">
        <h3 style={{ margin: 0 }}>Headcount</h3>
        <div className="tiny">Count the people in the room{hc ? `. Last saved total: ${hc.total}.` : '.'}</div>
        <Stepper label="Adults" value={a} set={setA} />
        <Stepper label="Children" value={c} set={setC} />
        <Stepper label="Visitors" value={v} set={setV} />
        <div className="row"><Button onClick={saveHc}>Save headcount</Button></div>
        {hcMsg && <div className="tiny" role="status">{hcMsg}</div>}
        <hr style={{ border: 0, borderTop: '1px solid var(--line)', width: '100%' }} />
        <Field label="Online peak (from YouTube)"><input inputMode="numeric" value={peak} onChange={(e) => setPeak(e.target.value.replace(/\D/g, '').slice(0, 6))} /></Field>
        <div className="row"><Button onClick={savePeak}>Save online peak</Button></div>
        {pkMsg && <div className="tiny" role="status">{pkMsg}</div>}
      </div>

      <div className="card stack">
        <h3 style={{ margin: 0 }}>Door screen</h3>
        <div className="tiny">A big code visitors scan with their phone camera.</div>
        <div className="row"><Button kind="ghost" onClick={() => setDoorOpen(true)}>Show door screen</Button></div>
      </div>
      {doorOpen && <DoorScreen id={id} onClose={closeDoor} />}

      <div className="card stack">
        <h3 style={{ margin: 0 }}>Just now</h3>
        {recent.length ? (
          <div className="us-rows">
            {recent.map((r, i) => (
              <div key={i}>
                <span className="nm"><b>{r.name}</b><br /><span className={`us-chip ${r.kind === 'member' ? 'good' : 'info'}`}>{r.kind}</span>{r.mode === 'online' && <span className="us-chip">online</span>}<span className="tiny">{VIA[r.via] ?? r.via}</span></span>
                <span className="tiny">{clock(r.at)}</span>
              </div>
            ))}
          </div>
        ) : <div className="tiny">No one has been counted yet.</div>}
      </div>
    </div>
  );
}

function Coming() {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const to = new Date(today.getTime() + 3 * 86400000);
  const r = useAsync<any>(() => api.get(`/attendance/services?from=${iso(today)}&to=${iso(to)}`), []);
  return (
    <Load loading={r.loading} error={r.error} hasData={!!r.data}>
      {r.data && (r.data.services.length === 0 ? <div className="tiny">No services in the next 3 days.</div> : (
        <div className="us-rows">
          {r.data.services.map((s: any) => (
            <div key={s.id}><span className="nm"><b>{s.name}</b> <span className="tiny">{s.branch}</span></span><span className="tiny">{when(s.startsAt)}</span></div>
          ))}
        </div>
      ))}
    </Load>
  );
}

export function Usher() {
  const list = useAsync<any>(() => api.get('/attendance/open'), []);
  const reload = list.reload;
  const [pick, setPick] = useState('');
  const [showComing, setShowComing] = useState(false);
  useEffect(() => { const t = setInterval(reload, 30_000); return () => clearInterval(t); }, [reload]);
  const services: any[] = list.data?.services ?? [];
  useEffect(() => { if (!pick && services[0]) setPick(services[0].id); }, [pick, services]);
  const chosen = services.find((s) => s.id === pick) ?? services[0];
  return (
    <div>
      <PageHead title="Usher" sub="Record who came to the service." />
      <Load loading={list.loading && !list.data} error={list.error} hasData={!!list.data}>
        {list.data && (!chosen ? (
          <div className="us">
            <Empty>No service is open for check-in right now. It opens 20 minutes before the start. A manager sets the schedule under Services.</Empty>
            {showComing ? <div className="card stack"><h3 style={{ margin: 0 }}>Coming services</h3><Coming /></div>
              : <div className="row" style={{ justifyContent: 'center' }}><Button kind="ghost" onClick={() => setShowComing(true)}>Show coming services</Button></div>}
          </div>
        ) : (
          <div className="stack">
            {services.length > 1 && (
              <div className="us"><Field label="Service"><select value={chosen.id} onChange={(e) => setPick(e.target.value)}>{services.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.branch} ({clock(s.startsAt)})</option>)}</select></Field></div>
            )}
            <Working key={chosen.id} svc={chosen} reloadSvc={reload} />
          </div>
        ))}
      </Load>
    </div>
  );
}
