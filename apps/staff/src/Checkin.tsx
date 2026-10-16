import { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { Button, Empty, ErrorNote, Field, useAsync } from '@churchos/ui';
import { api, friendly } from './session';
import { Load, PageHead } from './bits';
import './tickets.css';

const time = (iso: string) => new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

type Result = { result: string; holder?: string; type?: string; serial?: string; message?: string; usedAt?: string; usedBy?: string; group?: { total: number; checkedIn: number } };

const TONE: Record<string, 'good' | 'warn' | 'bad'> = { valid: 'good', already_used: 'warn', cancelled: 'bad', wrong_event: 'bad', event_cancelled: 'bad', not_found: 'bad' };
const TITLE: Record<string, string> = { valid: 'Valid', already_used: 'Already used', cancelled: 'Cancelled', wrong_event: 'Wrong event', event_cancelled: 'Event cancelled', not_found: 'Not found' };

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

function Door({ event }: { event: { id: string; title: string } }) {
  const stats = useAsync<any>(() => api.get(`/events/${event.id}/checkin/stats`), [event.id]);
  const [result, setResult] = useState<Result | null>(null);
  const [typed, setTyped] = useState('');
  const [sendErr, setSendErr] = useState('');
  const [camOn, setCamOn] = useState(false);
  const [camMsg, setCamMsg] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const raf = useRef(0);
  const last = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const hide = useRef<ReturnType<typeof setTimeout>>();
  const busy = useRef(false);
  const reload = stats.reload;

  useEffect(() => { const t = setInterval(reload, 10_000); return () => clearInterval(t); }, [reload]);

  const send = useCallback(async (raw: string) => {
    const code = raw.trim();
    if (!code) return;
    const now = Date.now();
    if (last.current.code === code && now - last.current.at < 3000) return;
    last.current = { code, at: now };
    if (busy.current) return;
    busy.current = true;
    setSendErr('');
    try {
      const r: Result = await api.post(`/events/${event.id}/checkin`, { code });
      setResult(r);
      beep(r.result === 'valid');
      clearTimeout(hide.current);
      hide.current = setTimeout(() => setResult(null), 4000);
      reload();
    } catch (e: any) { setSendErr(friendly(e?.message)); }
    busy.current = false;
  }, [event.id, reload]);

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
    return () => { document.removeEventListener('visibilitychange', h); stop(); clearTimeout(hide.current); };
  }, [stop]);

  const start = async () => {
    setCamMsg('');
    if (!navigator.mediaDevices?.getUserMedia) return setCamMsg('This browser cannot use the camera here. You can type the code instead.');
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

  const st = stats.data;
  const pct = st && st.sold > 0 ? Math.min(100, Math.round((st.checkedIn / st.sold) * 100)) : 0;
  const tone = result ? TONE[result.result] ?? 'bad' : 'good';

  return (
    <div className="ck">
      <div className="card" style={{ textAlign: 'center' }}>
        <div className="tiny">{event.title}</div>
        {st ? (
          <>
            <div className="tk-big">Checked in {st.checkedIn} of {st.sold}</div>
            <div className="progress" style={{ marginTop: 10 }} aria-label={`${pct}% arrived`}><i style={{ width: `${Math.max(pct, 2)}%` }} /></div>
          </>
        ) : <div className="tiny">Loading...</div>}
      </div>

      {result && (
        <div className={`ck-result ${tone}`} role="status" aria-live="assertive" onClick={() => setResult(null)}>
          <div className="ck-mark" aria-hidden="true">{result.result === 'valid' ? '✓' : result.result === 'already_used' ? '!' : '✗'}</div>
          <div className="ck-title">{TITLE[result.result] ?? 'Not valid'}</div>
          {result.holder && <div className="ck-who">{result.holder}{result.type ? `, ${result.type}` : ''}</div>}
          {result.result === 'valid' && result.group && result.group.total > 1 && <div>{result.group.checkedIn} of {result.group.total} in this order have arrived</div>}
          <div>{result.message}</div>
          {result.result === 'already_used' && (result.usedAt || result.usedBy) && <div className="tiny" style={{ color: 'inherit' }}>{result.usedAt ? time(result.usedAt) : ''}{result.usedBy ? ` by ${result.usedBy}` : ''}</div>}
        </div>
      )}
      {sendErr && <ErrorNote>{sendErr}</ErrorNote>}

      <div className="card stack">
        <div className="ck-video-wrap" style={camOn ? undefined : { aspectRatio: '16 / 7' }}>
          <video ref={video} playsInline muted style={camOn ? undefined : { display: 'none' }} />
          {camOn && <div className="ck-frame" aria-hidden="true" />}
          {!camOn && <div>Point the camera at the QR code on the ticket</div>}
        </div>
        <canvas ref={canvas} hidden />
        <div className="row">{camOn ? <Button kind="ghost" onClick={stop}>Stop scanning</Button> : <Button onClick={start}>Start scanning</Button>}</div>
        {camMsg && <ErrorNote>{camMsg}</ErrorNote>}
        <div className="tiny">On a phone the camera works when the page is opened with https or on localhost; otherwise type the code.</div>
      </div>

      <form className="card stack" onSubmit={(e) => { e.preventDefault(); const c = typed; setTyped(''); last.current = { code: '', at: 0 }; send(c); }}>
        <Field label="Type the code"><input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="GALA01-0001" autoCapitalize="characters" autoCorrect="off" spellCheck={false} /></Field>
        <div className="row"><Button type="submit" disabled={!typed.trim()}>Check in</Button></div>
      </form>

      <div className="card stack">
        <h3 style={{ margin: 0 }}>Recent check-ins</h3>
        {st && st.recent.length > 0 ? (
          <div className="ck-recent">
            {st.recent.map((r: any, i: number) => <div key={i}><span><b>{r.holder}</b> <span className="tiny">{r.type}</span></span><span className="tiny">{time(r.at)}</span></div>)}
          </div>
        ) : <div className="tiny">No one has been checked in yet.</div>}
      </div>
    </div>
  );
}

export function Checkin() {
  const list = useAsync<any[]>(() => api.get('/checkin/events'), []);
  const [pick, setPick] = useState('');
  const events = list.data ?? [];
  const chosen = events.find((e) => e.id === pick) ?? events[0];
  return (
    <div>
      <PageHead title="Check-in" sub="Scan tickets at the door." />
      <Load loading={list.loading} error={list.error} hasData={!!list.data}>
        {list.data && (events.length === 0 ? <Empty>No ticketed event is happening around now.</Empty> : (
          <div className="stack">
            {events.length > 1 && (
              <div className="ck"><Field label="Event"><select value={chosen.id} onChange={(e) => setPick(e.target.value)}>{events.map((e) => <option key={e.id} value={e.id}>{e.title} ({time(e.startsAt)})</option>)}</select></Field></div>
            )}
            <Door key={chosen.id} event={chosen} />
          </div>
        ))}
      </Load>
    </div>
  );
}
