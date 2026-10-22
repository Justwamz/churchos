import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { BrandInfo } from '@churchos/ui';
import { usePageBranding } from './brand';
import { BrandMark, ApiError, Button, Card, ErrorNote, Field, Note, Spinner, createApi, safeHttpUrl } from '@churchos/ui';
import './attend.css';

const api = createApi('churchos:giving:attend');

const VISITOR_KEY = 'churchos:visitor';
const loadVisitor = (): { name: string; phone: string } => {
  try {
    const v = JSON.parse(localStorage.getItem(VISITOR_KEY) ?? '{}');
    return { name: typeof v.name === 'string' ? v.name : '', phone: typeof v.phone === 'string' ? v.phone : '' };
  } catch { return { name: '', phone: '' }; }
};
const saveVisitor = (name: string, phone: string) => {
  try { localStorage.setItem(VISITOR_KEY, JSON.stringify({ name, phone })); } catch { /* storage blocked */ }
};

interface Reading { published: boolean; title?: string; ref?: string; body?: string }
interface W { one: string; many: string; oneLower: string; manyLower: string }
const DEFAULT_W: W = { one: 'Service', many: 'Services', oneLower: 'service', manyLower: 'services' };
const wordsOf = (i?: { words?: Partial<W> } | null): W => (i?.words?.one && i.words.oneLower ? { ...DEFAULT_W, ...i.words } as W : DEFAULT_W);
interface Info {
  words?: W;
  name: string; church: string; branch?: string; startsAt: string;
  state: 'before' | 'open' | 'closed' | 'cancelled'; opensAt: string; closesAt: string;
  hasStream: boolean; reading: Reading | null; invitedBy?: string | null;
  code?: string; live?: boolean; startsInMin?: number;
  /** Not sent by the API yet: shown and applied only when it is. */
  branding?: BrandInfo | null;
}
interface Done { status: 'recorded' | 'already'; kind: 'member' | 'visitor'; name: string; first: boolean; returning: boolean; reading: Reading | null; streamUrl?: string }

const eat = (d: string, o: Intl.DateTimeFormatOptions) => new Date(d).toLocaleString('en-GB', { timeZone: 'Africa/Nairobi', ...o });
const clock = (d: string) => eat(d, { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
const dayKey = (d: string) => eat(d, { day: 'numeric', month: 'numeric', year: 'numeric' });
const dayLabel = (d: string) => eat(d, { weekday: 'long', day: 'numeric', month: 'long' });
const isToday = (d: string) => dayKey(d) === dayKey(new Date().toISOString());
const dayTime = (d: string) => (isToday(d) ? clock(d) : `${dayLabel(d)}, ${clock(d)}`);
const errOf = (e: unknown) => (e instanceof ApiError && e.message ? e.message : 'Something went wrong. Please try again.');

function Page({ info, children }: { info?: Info | null; children: ReactNode }) {
  usePageBranding(info?.branding, info?.church);
  return (
    <div className="mobile giving at">
      <header className="at-head">
        {info?.branding?.hasLogo && <div style={{ marginBottom: 8 }}><BrandMark brand={{ ...info.branding, name: info.church }} size={44} /></div>}
        <div className="at-church">{info ? `${info.church}${info.branch ? `, ${info.branch}` : ''}` : 'Welcome'}</div>
        {info && <h1>{info.name}</h1>}
        {info && <div className="at-when">{isToday(info.startsAt) ? 'Today' : dayLabel(info.startsAt)}, {clock(info.startsAt)}</div>}
      </header>
      <div className="stack">{children}</div>
    </div>
  );
}

function Problem({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mobile giving at">
      <header className="at-head"><div className="at-church">Welcome</div><h1>{title}</h1></header>
      <Card><div className="stack">{children}</div></Card>
    </div>
  );
}

function ReadingCard({ reading, w }: { reading: Reading | null | undefined; w: W }) {
  if (!reading) return null;
  if (!reading.published) return <Note tone="info">{`The reading and notices will appear here a little before the ${w.oneLower}.`}</Note>;
  return (
    <Card>
      <div className="stack">
        <div className="at-church">Today at church</div>
        {reading.title && <h2>{reading.title}</h2>}
        {reading.ref && <p className="at-ref">{reading.ref}</p>}
        {reading.body && <p className="at-body">{reading.body}</p>}
      </div>
    </Card>
  );
}

function NamePhone({ name, setName, phone, setPhone }: { name: string; setName: (v: string) => void; phone: string; setPhone: (v: string) => void }) {
  return (
    <>
      <Field label="Your name">
        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="Your full name" maxLength={80} />
      </Field>
      <Field label="Your phone number">
        <input type="tel" inputMode="tel" autoComplete="tel" placeholder="0712 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </Field>
    </>
  );
}

function useInfo(path: string) {
  const [info, setInfo] = useState<Info | undefined>();
  const [error, setError] = useState<{ message: string; code?: string } | undefined>();
  useEffect(() => {
    let alive = true;
    setInfo(undefined); setError(undefined);
    api.get<Info>(path)
      .then((r) => alive && setInfo(r))
      .catch((e) => alive && setError({ message: errOf(e), code: e instanceof ApiError ? e.code : undefined }));
    return () => { alive = false; };
  }, [path]);
  return { info, error };
}

const Loading = () => <div className="mobile giving at"><div className="stack" style={{ paddingTop: 60 }}><Spinner /></div></div>;

export function HerePage() {
  const { token = '' } = useParams();
  const { info, error } = useInfo(`/public/here/${encodeURIComponent(token)}`);
  const [name, setName] = useState(() => loadVisitor().name);
  const [phone, setPhone] = useState(() => loadVisitor().phone);
  const [mode, setMode] = useState<'in_person' | 'online'>('in_person');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  const [done, setDone] = useState<Done | undefined>();

  if (error) {
    const expired = error.code === 'expired';
    return (
      <Problem title={expired ? 'This code has expired' : 'We could not open this page'}>
        <ErrorNote>{error.message}</ErrorNote>
        <p className="muted">{expired ? 'Please scan the code at the door again, or ask an usher for help.' : 'Please scan the code at the door again, or ask an usher or the person who invited you for a new link.'}</p>
      </Problem>
    );
  }
  if (!info) return <Loading />;
  const w = wordsOf(info);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(undefined);
    try {
      const r = await api.post<Done>(`/public/here/${encodeURIComponent(token)}`, { name: name.trim(), phone: phone.trim(), ...(info.hasStream ? { mode } : {}) });
      saveVisitor(name.trim(), phone.trim());
      setDone(r);
      window.scrollTo?.(0, 0);
    } catch (e2) { setErr(errOf(e2)); }
    setBusy(false);
  };

  if (done) {
    const first = done.name || name.trim().split(/\s+/)[0];
    const reading = done.reading !== undefined ? done.reading : info.reading;
    const headline = done.status === 'already' ? 'You are already checked in. Welcome!' : done.returning ? `Welcome back, ${first}!` : `Welcome, ${first}!`;
    return (
      <Page info={info}>
        <Card>
          <div className="stack center" aria-live="polite">
            <div className="at-tick" aria-hidden="true">&#10003;</div>
            <h2>{headline}</h2>
            {done.kind === 'member' && <p className="muted" style={{ margin: 0 }}>Good to see you, {first}. You are counted as a member.</p>}
            {done.kind === 'visitor' && done.first && done.status !== 'already' && <p className="muted" style={{ margin: 0 }}>We are so glad you came. A short welcome message is on its way to your phone.</p>}
          </div>
        </Card>
        {done.streamUrl && <a className="btn primary" href={done.streamUrl} target="_blank" rel="noopener noreferrer">{`Watch the ${w.oneLower}`}</a>}
        <ReadingCard reading={reading} w={w} />
      </Page>
    );
  }

  const invited = info.invitedBy ? <div className="at-welcome">{info.invitedBy} invited you. We are so glad you came.</div> : null;

  if (info.state === 'cancelled') {
    return <Page info={info}><Note tone="warn">{`This ${w.oneLower} has been cancelled. Please check with your church for the next one. We hope to see you soon.`}</Note></Page>;
  }
  if (info.state === 'closed') {
    return <Page info={info}><Note tone="info">{`Check-in for this ${w.oneLower} has ended. Thank you for being part of it. We hope to see you next time.`}</Note><ReadingCard reading={info.reading} w={w} /></Page>;
  }
  if (info.state === 'before') {
    return (
      <Page info={info}>
        {invited}
        <Note tone="info"><b>Check-in opens at {dayTime(info.opensAt)}.</b> Please come back then, or scan the code at the door.</Note>
        <ReadingCard reading={info.reading} w={w} />
      </Page>
    );
  }

  return (
    <Page info={info}>
      {invited}
      <form onSubmit={submit} noValidate>
        <Card>
          <div className="stack">
            {info.hasStream && (
              <div className="stack">
                <div className="field-label">How are you joining us?</div>
                <div className="at-choice" role="group" aria-label="How are you joining us?">
                  <button type="button" className="at-opt" aria-pressed={mode === 'in_person'} onClick={() => setMode('in_person')}>I'm at the church</button>
                  <button type="button" className="at-opt" aria-pressed={mode === 'online'} onClick={() => setMode('online')}>I'm watching online</button>
                </div>
              </div>
            )}
            <NamePhone name={name} setName={setName} phone={phone} setPhone={setPhone} />
            <p className="at-tiny">We will send you one welcome message. We will not share your number.</p>
            <div aria-live="polite">{err && <ErrorNote>{err}</ErrorNote>}</div>
            <Button type="submit" disabled={busy}>{busy ? 'One moment...' : "I'm here"}</Button>
          </div>
        </Card>
      </form>
      <ReadingCard reading={info.reading} w={w} />
    </Page>
  );
}

export function LivePage() {
  const { code = '' } = useParams();
  const [search] = useSearchParams();
  const ref = search.get('ref') ?? '';
  const { info, error } = useInfo(`/public/live/${encodeURIComponent(code)}`);
  const [name, setName] = useState(() => loadVisitor().name);
  const [phone, setPhone] = useState(() => loadVisitor().phone);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  const [url, setUrl] = useState<string | undefined>();

  if (error) {
    return (
      <Problem title="We could not find this gathering">
        <ErrorNote>{error.message}</ErrorNote>
        <p className="muted">Please check the link, or ask the person who shared it with you for a new one.</p>
      </Problem>
    );
  }
  if (!info) return <Loading />;
  const w = wordsOf(info);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(undefined);
    try {
      const r = await api.post<{ url: string }>(`/public/live/${encodeURIComponent(code)}`, { name: name.trim(), phone: phone.trim(), ...(ref ? { ref } : {}) });
      saveVisitor(name.trim(), phone.trim());
      setUrl(r.url);
      const to = safeHttpUrl(r.url, { httpsOnly: true });
      if (!to) { setErr('This live link is not a safe address. Ask the church for a new one.'); return; }
      window.location.href = to;
      return;
    } catch (e2) { setErr(errOf(e2)); }
    setBusy(false);
  };

  const mins = info.startsInMin ?? 0;
  const startsIn = mins >= 2880 ? `Starts in ${Math.round(mins / 1440)} days` : mins >= 120 ? `Starts in ${Math.round(mins / 60)} hours` : mins >= 60 ? 'Starts in about an hour' : `Starts in ${Math.max(mins, 1)} minute${mins === 1 ? '' : 's'}`;
  const ended = info.state === 'closed';
  const cancelled = info.state === 'cancelled';
  const status = cancelled ? `This ${w.oneLower} has been cancelled.` : ended ? `The ${w.oneLower} has ended. The recording may be on our YouTube channel.` : info.live ? 'Live now' : info.state === 'open' ? 'Starting very soon' : startsIn;

  return (
    <Page info={info}>
      <div className={`at-status ${info.live && !ended && !cancelled ? 'live' : ''}`} role="status">{status}</div>
      <ReadingCard reading={info.reading} w={w} />
      {!ended && !cancelled && (
        <form onSubmit={submit} noValidate>
          <Card>
            <div className="stack">
              <NamePhone name={name} setName={setName} phone={phone} setPhone={setPhone} />
              <p className="at-tiny">We ask for your name and number so we can say hello, we will not share them.</p>
              <div aria-live="polite">{err && <ErrorNote>{err}</ErrorNote>}</div>
              <Button type="submit" disabled={busy}>{busy ? 'Opening the stream...' : 'Watch now'}</Button>
              {url && <p className="at-fallback">If nothing happens, <a href={url} target="_blank" rel="noopener noreferrer">open the stream here</a>.</p>}
            </div>
          </Card>
        </form>
      )}
    </Page>
  );
}
