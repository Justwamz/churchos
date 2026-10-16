import { useEffect, useRef, useState } from 'react';
import { Button, Card, Empty, ErrorNote, Note, useAsync, useToast } from '@churchos/ui';
import { api, errText } from './api';
import { useGeo } from './Family';
import { Icon, Sheet, Skeleton } from './ui';

// ---------------- helpers ----------------

const TZ = 'Africa/Nairobi';
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-KE', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TZ }).toLowerCase();
const dayOf = (iso: string) => new Date(iso).toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
const whenOf = (iso: string) => `${dayOf(iso)}, ${timeOf(iso)}`;
const sameDay = (a: string, b: Date) => new Date(a).toLocaleDateString('en-KE', { timeZone: TZ }) === b.toLocaleDateString('en-KE', { timeZone: TZ });
/** "10:10 am" today, or "Sat 25 Oct, 10:10 am" on another day. */
const soonOf = (iso: string) => (sameDay(iso, new Date()) ? timeOf(iso) : whenOf(iso));

/** The service's state right now, worked out from its times so it stays right between refreshes. */
function stateOf(s: any, now = Date.now()): 'before' | 'open' | 'closed' {
  if (s.opensAt && s.closesAt) return now < +new Date(s.opensAt) ? 'before' : now > +new Date(s.closesAt) ? 'closed' : 'open';
  return s.state ?? 'before';
}
const published = (s: any) => !!(s.reading && s.reading.published && s.reading.title);

/** The coming services, refreshed every 30 seconds while the app is visible. */
export function useServices() {
  const q = useAsync<any>(() => api.get('/me/services'));
  const reload = useRef(q.reload);
  reload.current = q.reload;
  const [, setNow] = useState(0);
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') { setNow((n) => n + 1); if (navigator.onLine) reload.current(); } };
    const t = setInterval(tick, 30000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', tick); };
  }, []);
  const services: any[] = q.data?.services ?? [];
  return { services, reload: q.reload, loading: q.loading && !q.data, error: q.data ? undefined : q.error };
}

// ---------------- the usher code ----------------

function UsherCode() {
  const [qr, setQr] = useState<{ svg: string; name: string; seconds: number; stamp: number } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const clear = () => { clearTimeout(timer); clearTimeout(expiry); };
    const load = async () => {
      clear();
      if (!live || document.visibilityState !== 'visible') return;
      try {
        const r = await api.post('/me/attendance/qr', {});
        if (!live) return;
        setQr({ svg: r.qrSvg, name: r.name, seconds: r.refreshSeconds ?? 30, stamp: Date.now() });
        setFailed(false);
        timer = setTimeout(load, 28000);
        const left = r.expiresAt ? new Date(r.expiresAt).getTime() - Date.now() : 30000;
        expiry = setTimeout(() => { if (live) { setQr(null); setFailed(true); } }, Math.max(1000, left));
      } catch {
        if (!live) return;
        setQr(null); setFailed(true);
        timer = setTimeout(load, 5000);
      }
    };
    const onVis = () => { if (document.visibilityState === 'visible') load(); else clear(); };
    load();
    document.addEventListener('visibilitychange', onVis);
    return () => { live = false; clear(); document.removeEventListener('visibilitychange', onVis); };
  }, []);
  return (
    <section className="card fam-qr-card svc-usher" id="usher-code">
      <h3>My usher code</h3>
      <div className="fam-qr-wrap">
        {qr
          ? <div className="tk-qr fam-qr" role="img" aria-label="Your usher code" dangerouslySetInnerHTML={{ __html: qr.svg }} />
          : <div className="tk-qr fam-qr blank" role="status">{failed ? <span>Can't refresh the code. Check your connection</span> : <span>Getting your code…</span>}</div>}
        <div className="fam-bar" aria-hidden="true">{qr && <i key={qr.stamp} style={{ animationDuration: `${qr.seconds}s` }} />}</div>
        <strong className="fam-guardian">{qr?.name ?? ''}</strong>
      </div>
      <p className="fam-caption">Show this to an usher at the door</p>
      <p className="tiny muted">This code changes every 30 seconds, so a screenshot will not work.</p>
    </section>
  );
}

// ---------------- the page ----------------

type Problem = { code?: string; message: string };

export function ServicesPage({ hasMembership }: { hasMembership: boolean }) {
  const svc = useServices();
  const att = useAsync<any>(() => api.get('/me/attendance'));
  const geo = useGeo();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, Problem>>({});
  const [done, setDone] = useState<Record<string, string>>({});
  const [reading, setReading] = useState<any | null>(null);
  const [inviting, setInviting] = useState<any | null>(null);

  const setProblem = (id: string, p?: Problem) => setProblems((m) => { const n = { ...m }; if (p) n[id] = p; else delete n[id]; return n; });

  const checkIn = async (s: any, mode: 'in_person' | 'online') => {
    setBusy(s.id + mode); setProblem(s.id);
    try {
      let g;
      if (mode === 'in_person') { await geo.first(4000); g = geo.get(); }
      const r = await api.post(`/me/services/${encodeURIComponent(s.id)}/check-in`, { ...(g ? { geo: g } : {}), mode });
      setDone((d) => ({ ...d, [s.id]: r.mode === 'online' ? 'You are counted as watching online. Thank you!' : 'You are checked in. Welcome!' }));
      svc.reload(); att.reload();
      if (r.reading?.title || r.reading?.body) setReading({ ...r.reading, name: s.name });
    } catch (e: any) {
      setProblem(s.id, { code: e?.code, message: errText(e) });
    }
    setBusy(null);
  };

  const watch = async (s: any) => {
    setBusy(s.id + 'watch'); setProblem(s.id);
    // open the tab straight away so the browser does not block it, then point it at the stream
    const w = window.open('', '_blank');
    try {
      const r = await api.post(`/me/services/${encodeURIComponent(s.id)}/watch`, {});
      if (w) { try { w.opener = null; } catch { /* ignore */ } w.location.href = r.url; } else window.location.assign(r.url);
      svc.reload(); att.reload();
    } catch (e: any) {
      if (w) w.close();
      setProblem(s.id, { code: e?.code, message: e?.code === 'no_stream' ? 'This service has no live video right now.' : errText(e) });
    }
    setBusy(null);
  };

  const goUsher = () => { document.getElementById('usher-code')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); };

  if (svc.loading) return <div className="card"><Skeleton lines={4} tall /></div>;
  const weeks = Number(att.data?.weeks ?? 0);
  const invited = Number(att.data?.invited ?? 0);
  const recent: any[] = att.data?.recent ?? [];

  return (
    <div className="stack svc-page fam-page">
      <div className="fam-cols">
        {hasMembership ? <UsherCode /> : <Card title="My usher code"><Empty>You are not linked to a church yet, so there is no code to show.</Empty></Card>}
        <div className="stack fam-side">
          {svc.error && <><ErrorNote>{svc.error}</ErrorNote><Button kind="ghost" onClick={svc.reload}>Try again</Button></>}
          {!svc.error && !svc.services.length && <Card title="Services"><Empty>No services are scheduled yet.</Empty></Card>}
          {svc.services.map((s) => {
            const st = stateOf(s);
            const mine = s.mine ?? {};
            const problem = problems[s.id];
            const pub = published(s);
            const rd = s.reading;
            return (
              <section className="card svc-card" key={s.id}>
                <div className="svc-top">
                  <div className="svc-title"><strong>{s.name}</strong><span className="tiny muted">{s.branch}{s.church && s.church !== s.branch ? ` · ${s.church}` : ''}</span></div>
                  <span className={`badge ${st === 'open' ? 'good' : 'muted'}`}>{st === 'open' ? 'Check-in open' : st === 'before' ? `Opens ${soonOf(s.opensAt)}` : 'Closed'}</span>
                </div>
                <div className="svc-when">{whenOf(s.startsAt)}</div>
                {(mine.inPerson || mine.online) && (
                  <div><span className="badge good svc-in"><Icon name="check" size={14} />{mine.inPerson ? 'You are checked in' : 'You watched online'}</span></div>
                )}
                {done[s.id] && <Note tone="good">{done[s.id]}</Note>}

                {pub
                  ? <div className="svc-reading"><span className="tiny muted">Reading of the day</span><strong>{rd.title}</strong>{rd.ref && <span className="tiny">{rd.ref}</span>}<Button kind="ghost" small onClick={() => setReading({ ...rd, name: s.name })}>Read</Button></div>
                  : rd && rd.published === false && rd.releasesAt ? <p className="tiny muted svc-wait">Reading and notices will appear {soonOf(rd.releasesAt)}</p> : null}

                {st === 'open' && !mine.inPerson && (
                  <div className="stack svc-here">
                    <Button disabled={!!busy} onClick={() => checkIn(s, 'in_person')}>{busy === s.id + 'in_person' ? 'Checking you in…' : "I'm here"}</Button>
                    {geo.state === 'denied' || geo.state === 'unavailable'
                      ? <p className="tiny muted svc-wait">Location is off, so the app cannot tell you are at church. Allow location for the app, or show your usher code to an usher.</p>
                      : null}
                    {problem && (
                      <div className="svc-problem" role="alert">
                        <span>{problem.message}</span>
                        <div className="svc-alts">
                          {(problem.code === 'away_from_branch' || problem.code === 'location_needed') && (
                            <Button kind="ghost" small disabled={!!busy} onClick={() => checkIn(s, 'online')}>{busy === s.id + 'online' ? 'One moment…' : 'I am watching online'}</Button>
                          )}
                          {problem.code === 'location_needed' && <Button kind="ghost" small onClick={goUsher}>Show my usher code</Button>}
                          {problem.code === 'location_needed' && <Button kind="ghost" small onClick={() => { geo.retry(); setProblem(s.id); }}>Try again</Button>}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {!(st === 'open' && !mine.inPerson) && problem && <ErrorNote>{problem.message}</ErrorNote>}

                <div className="svc-actions">
                  {s.streamUrl && <Button kind="ghost" small disabled={!!busy} onClick={() => watch(s)}><Icon name="link" size={18} />{busy === s.id + 'watch' ? 'Opening…' : 'Watch live'}</Button>}
                  <Button kind="ghost" small onClick={() => setInviting(s)}><Icon name="send" size={18} />Bring a friend</Button>
                </div>
                {s.streamUrl && st !== 'closed' && <p className="tiny muted svc-wait">The live video starts when the service begins. Watching online is counted for you.</p>}
              </section>
            );
          })}

          {att.data && (weeks > 0 || invited > 0 || recent.length > 0) && (
            <Card title="Your attendance">
              <div className="stack">
                <p style={{ margin: 0 }}>You came to church in <strong>{weeks}</strong> of the last 8 weeks</p>
                {invited > 0 && <p style={{ margin: 0 }}>You have brought <strong>{invited}</strong> {invited === 1 ? 'friend' : 'friends'}</p>}
              </div>
            </Card>
          )}
        </div>
      </div>

      <Sheet open={!!reading} onClose={() => setReading(null)} title={reading?.title ?? 'Reading'}>
        {reading && (
          <div className="stack">
            {reading.ref && <strong>{reading.ref}</strong>}
            {reading.body && <div className="svc-body">{reading.body}</div>}
            <Button kind="ghost" onClick={() => setReading(null)}>Close</Button>
          </div>
        )}
      </Sheet>
      <Sheet open={!!inviting} onClose={() => setInviting(null)} title="Bring a friend">
        {inviting && <Invite s={inviting} onToast={toast.show} onSent={att.reload} />}
      </Sheet>
      {toast.node}
    </div>
  );
}

// ---------------- bring a friend ----------------

function Invite({ s, onToast, onSent }: { s: any; onToast: (m: string) => void; onSent: () => void }) {
  const q = useAsync<any>(() => api.get(`/me/services/${encodeURIComponent(s.id)}/invite`), [s.id]);
  const [err, setErr] = useState('');
  if (q.loading && !q.data) return <Skeleton lines={4} tall />;
  if (q.error || !q.data) return <div className="stack"><ErrorNote>{q.error ?? 'We could not prepare your invitation.'}</ErrorNote><Button kind="ghost" onClick={q.reload}>Try again</Button></div>;
  const d = q.data;
  const canShare = typeof navigator !== 'undefined' && typeof (navigator as any).share === 'function';
  const share = async (text: string, url: string) => {
    setErr('');
    try { await (navigator as any).share({ text, url }); }
    catch (e: any) { if (e?.name !== 'AbortError') setErr('Sharing did not work. Try Copy link instead.'); }
  };
  const copy = async (text: string) => {
    setErr('');
    try { await navigator.clipboard.writeText(text); onToast('Link copied'); }
    catch {
      try { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); onToast('Link copied'); }
      catch { setErr('We could not copy the link. Press and hold it to copy.'); }
    }
  };
  const wa = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`;
  return (
    <div className="stack svc-invite">
      <p className="muted" style={{ margin: 0 }}>Invite someone to {s.name}. When they come, they will be recorded as your guest.</p>
      <div className="svc-msg">{d.message}</div>
      {canShare
        ? <Button onClick={() => share(d.message, d.link)}>Share invitation</Button>
        : <a className="btn primary" href={wa(d.message)} target="_blank" rel="noopener noreferrer" onClick={() => onSent()}>Send on WhatsApp</a>}
      <Button kind="ghost" onClick={() => copy(d.link)}>Copy link</Button>
      {d.liveLink && (
        canShare
          ? <Button kind="ghost" onClick={() => share(`Join us live: ${d.liveLink}`, d.liveLink)}>Share the live link</Button>
          : <a className="btn ghost" href={wa(`Join us live: ${d.liveLink}`)} target="_blank" rel="noopener noreferrer">Share the live link</a>
      )}
      {err && <ErrorNote>{err}</ErrorNote>}
      <div className="svc-qrbox">
        <div className="tk-qr svc-invite-qr" role="img" aria-label="Invitation QR code" dangerouslySetInnerHTML={{ __html: d.qrSvg }} />
        <p className="tiny muted" style={{ margin: 0, textAlign: 'center' }}>A friend beside you can scan this with their phone camera.</p>
      </div>
      {Number(d.invited) > 0 && <p className="tiny muted" style={{ margin: 0, textAlign: 'center' }}>You have brought {d.invited} {d.invited === 1 ? 'friend' : 'friends'} so far.</p>}
    </div>
  );
}

// ---------------- Home cards ----------------

export function HomeServices({ onOpen }: { onOpen: () => void }) {
  const { services } = useServices();
  const now = Date.now();
  const open = services.find((s) => stateOf(s, now) === 'open' && !s.mine?.inPerson && !s.mine?.online);
  const rd = services.find((s) => published(s) && +new Date(s.startsAt) < now + 24 * 3600 * 1000 && +new Date(s.endsAt ?? s.startsAt) > now);
  if (!open && !rd) return null;
  return (
    <>
      {open && (
        <button type="button" className="fam-home" onClick={onOpen}>
          <span className="msg-ico"><Icon name="calendar" size={18} /></span>
          <span className="fam-name"><strong>Service now: {open.name}. Check in</strong><span className="tiny">{open.branch} · {timeOf(open.startsAt)}</span></span>
          <Icon name="chev" size={18} />
        </button>
      )}
      {rd && (
        <button type="button" className="fam-home svc-read-home" onClick={onOpen}>
          <span className="msg-ico"><Icon name="pledge" size={18} /></span>
          <span className="fam-name"><strong>Today's reading: {rd.reading.title}</strong><span className="tiny">{rd.reading.ref ? `${rd.reading.ref} · ` : ''}{rd.name}, {whenOf(rd.startsAt)}</span></span>
          <Icon name="chev" size={18} />
        </button>
      )}
    </>
  );
}
