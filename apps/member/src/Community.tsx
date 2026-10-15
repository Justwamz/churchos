import { useState } from 'react';
import { Button, ErrorNote, Note, useAsync } from '@churchos/ui';
import { api, errText } from './api';
import { Icon, Sheet, Skeleton } from './ui';
import { Poster, TicketBuy, priceLine } from './Tickets';

const TZ = 'Africa/Nairobi';
const dayNum = (iso: string) => new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', timeZone: TZ });
const monShort = (iso: string) => new Date(iso).toLocaleDateString('en-KE', { month: 'short', timeZone: TZ });
const monthLong = (iso: string) => new Date(iso).toLocaleDateString('en-KE', { month: 'long', year: 'numeric', timeZone: TZ });
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-KE', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
const dateShort = (iso: string) => new Date(iso).toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
const dateLong = (iso: string) => new Date(iso).toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ });
const dayKey = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
const timeRange = (e: any) => {
  const sameDay = e.endsAt && dayKey(e.endsAt) === dayKey(e.startsAt);
  if (!e.endsAt) return timeOf(e.startsAt);
  return sameDay ? `${timeOf(e.startsAt)} to ${timeOf(e.endsAt)}` : `${timeOf(e.startsAt)} to ${dateLong(e.endsAt)}, ${timeOf(e.endsAt)}`;
};

/** "2h ago" style time. */
export function relTime(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', timeZone: TZ });
}

// ---------------- notices ----------------

function NoticeCard({ n, onOpen }: { n: any; onOpen: () => void }) {
  return (
    <button type="button" className="notice" onClick={onOpen}>
      <span className={`msg-ico ${n.pinned ? 'announce' : ''}`}><Icon name={n.pinned ? 'pin' : 'megaphone'} size={18} /></span>
      <span className="notice-main">
        <strong>{n.title}</strong>
        <span className="clamp2 notice-body">{n.body}</span>
        <span className="tiny">{n.pinned ? 'Pinned · ' : ''}{n.church} · {relTime(n.publishedAt)}</span>
      </span>
    </button>
  );
}

function NoticeSheet({ n, onClose }: { n: any | null; onClose: () => void }) {
  return (
    <Sheet open={!!n} onClose={onClose} title={n?.title}>
      {n && (
        <div className="stack">
          <div className="tiny">{n.pinned ? 'Pinned · ' : ''}{n.church} · {relTime(n.publishedAt)}</div>
          <p className="full-text">{n.body}</p>
        </div>
      )}
    </Sheet>
  );
}

export function HomeNotices({ onAll }: { onAll: () => void }) {
  const q = useAsync<any[]>(() => api.get('/me/notices'));
  const [open, setOpen] = useState<any | null>(null);
  const rows = (q.data ?? []).slice(0, 3);
  return (
    <section className="block">
      <div className="block-head"><h3>Notice board</h3>{rows.length > 0 && <button type="button" className="link-btn" onClick={onAll}>See all</button>}</div>
      {q.loading && !q.data ? <Skeleton lines={2} /> : q.error && !q.data ? <p className="tiny">We could not load notices right now.</p> : !rows.length ? (
        <p className="mini-empty">No notices right now</p>
      ) : (
        <ul className="plain-list">{rows.map((n) => <li key={n.id}><NoticeCard n={n} onOpen={() => setOpen(n)} /></li>)}</ul>
      )}
      <NoticeSheet n={open} onClose={() => setOpen(null)} />
    </section>
  );
}

export function NoticesPage() {
  const q = useAsync<any[]>(() => api.get('/me/notices'));
  const [open, setOpen] = useState<any | null>(null);
  const rows = q.data ?? [];
  return (
    <div className="stack">
      {q.loading && !q.data ? <div className="card"><Skeleton lines={4} /></div> : q.error && !q.data ? (
        <div className="stack"><ErrorNote>{q.error}</ErrorNote><Button kind="ghost" onClick={q.reload}>Try again</Button></div>
      ) : !rows.length ? (
        <div className="empty-state"><Icon name="megaphone" size={40} /><strong>No notices right now</strong><span>Notices from your church will show here.</span></div>
      ) : (
        <ul className="notice-list">{rows.map((n) => <li key={n.id} className="block"><NoticeCard n={n} onOpen={() => setOpen(n)} /></li>)}</ul>
      )}
      <NoticeSheet n={open} onClose={() => setOpen(null)} />
    </div>
  );
}

// ---------------- events ----------------

const RSVP_ERR: Record<string, string> = {
  event_full: 'This event is full. Please try fewer guests or check back later.',
  bad_guests: 'You can bring between 0 and 10 guests.',
  cancelled: 'This event was cancelled, so replies are closed.',
  started: 'This event has already started, so your reply cannot be changed.',
  no_rsvp: 'This event does not ask for replies.',
};

const hasStarted = (e: any) => new Date(e.startsAt).getTime() <= Date.now();

function Pill({ e }: { e: any }) {
  if (e.status === 'cancelled') return <span className="badge bad">Cancelled</span>;
  if (!e.rsvp) return null;
  if (e.myResponse === 'going') return <span className="badge good">Going</span>;
  if (e.myResponse === 'not_going') return <span className="badge muted">Not going</span>;
  if (e.full) return <span className="badge warn">Full</span>;
  return <span className="badge info">Reply</span>;
}

function DateBlock({ iso, cancelled }: { iso: string; cancelled?: boolean }) {
  return <span className={`datebox ${cancelled ? 'off' : ''}`} aria-hidden="true"><b>{dayNum(iso)}</b><i>{monShort(iso)}</i></span>;
}

function EventCard({ e, onOpen, church }: { e: any; onOpen: () => void; church?: boolean }) {
  return (
    <button type="button" className="event" onClick={onOpen} aria-label={`${e.title}, ${dateLong(e.startsAt)}`}>
      {e.ticketed ? <Poster url={e.posterUrl} title={e.title} className="thumb" /> : <DateBlock iso={e.startsAt} cancelled={e.status === 'cancelled'} />}
      <span className="event-main">
        <strong className={e.status === 'cancelled' ? 'struck' : ''}>{e.title}</strong>
        <span className="tiny ell">{e.ticketed ? `${dateShort(e.startsAt)} · ${timeOf(e.startsAt)}${e.location ? ` · ${e.location}` : ''}` : `${timeRange(e)}${e.location ? ` · ${e.location}` : ''}`}</span>
        {e.ticketed && e.status !== 'cancelled' && <span className={`tk-from ${e.soldOut ? 'out' : ''}`}>{priceLine(e)}</span>}
        {church && <span className="tiny ell">{e.church}</span>}
      </span>
      {e.ticketed && e.status !== 'cancelled' ? <span className={`tk-get ${e.soldOut ? 'out' : ''}`}>{e.soldOut ? 'Sold out' : 'Get tickets'}</span> : <Pill e={e} />}
    </button>
  );
}

function EventSheet({ id, events, onClose, onSaved }: { id: string | null; events: any[]; onClose: () => void; onSaved: () => void }) {
  const e = id ? events.find((x) => x.id === id) : null;
  if (e?.ticketed && e.code && e.status !== 'cancelled') return <TicketBuy code={e.code} eventId={e.id} onClose={() => { onClose(); onSaved(); }} />;
  return (
    <Sheet open={!!e} onClose={onClose} title={e?.title}>
      {e && <EventBody key={e.id} e={e} onSaved={onSaved} />}
    </Sheet>
  );
}

function EventBody({ e, onSaved }: { e: any; onSaved: () => void }) {
  const [choice, setChoice] = useState<'going' | 'not_going' | null>(e.myResponse ?? null);
  const [guests, setGuests] = useState<number>(e.myGuests ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const cancelled = e.status === 'cancelled';
  const started = hasStarted(e);
  // places I could take: what is left, plus the places I already hold
  const mine = e.myResponse === 'going' ? 1 + (e.myGuests ?? 0) : 0;
  const avail = e.spotsLeft == null ? null : e.spotsLeft + mine;
  const full = avail !== null && avail <= 0;
  const maxGuests = avail == null ? 10 : Math.max(0, Math.min(10, avail - 1));
  const locked = started || cancelled;

  const save = async (response: 'going' | 'not_going') => {
    setBusy(true); setError(undefined); setDone(undefined);
    const g = response === 'going' ? Math.min(guests, maxGuests) : 0;
    try {
      await api.post(`/me/events/${encodeURIComponent(e.id)}/rsvp`, { response, guests: g });
      setDone(response === 'going' ? (g > 0 ? `You are going with ${g} ${g === 1 ? 'guest' : 'guests'}` : 'You are going') : 'You are not going');
      setChoice(response);
      onSaved();
    } catch (err: any) { setError(RSVP_ERR[err?.code] ?? errText(err)); onSaved(); }
    setBusy(false);
  };

  return (
    <div className="stack">
      <div className="event-facts">
        <span><Icon name="calendar" size={18} /> {dateLong(e.startsAt)}, {timeRange(e)}</span>
        {e.location && <span><Icon name="pin" size={18} /> {e.location}</span>}
        <span className="tiny">{e.church}</span>
      </div>
      {cancelled && <Note tone="bad">This event was cancelled.{e.cancelReason ? ` Reason: ${e.cancelReason}` : ''}</Note>}
      {e.description && <p className="full-text">{e.description}</p>}
      {e.rsvp && !cancelled && (
        <div className="rsvp">
          <div className="field-label">Will you come?</div>
          {started && <Note tone="info">This event has started, so your reply can no longer be changed.</Note>}
          {full && !started && <Note tone="warn">This event is full{e.myResponse === 'going' ? '' : '. You can still tell us you are not going.'}</Note>}
          {!full && avail !== null && !started && <p className="tiny places" aria-live="polite">{avail} {avail === 1 ? 'place' : 'places'} left</p>}
          <div className="rsvp-btns">
            <button type="button" className={`rsvp-btn go ${choice === 'going' ? 'on' : ''}`} aria-pressed={choice === 'going'} disabled={locked || busy || full} onClick={() => { setChoice('going'); setDone(undefined); }}><Icon name="check" size={22} /> Going</button>
            <button type="button" className={`rsvp-btn no ${choice === 'not_going' ? 'on' : ''}`} aria-pressed={choice === 'not_going'} disabled={locked || busy} onClick={() => save('not_going')}>Not going</button>
          </div>
          {choice === 'going' && !locked && !full && (
            <>
              <div className="stepper-row">
                <span id={`g-${e.id}`}>Bring guests</span>
                <div className="stepper" role="group" aria-labelledby={`g-${e.id}`}>
                  <button type="button" aria-label="One less guest" disabled={guests <= 0 || busy} onClick={() => setGuests((g) => Math.max(0, g - 1))}>-</button>
                  <output aria-live="polite">{Math.min(guests, maxGuests)}</output>
                  <button type="button" aria-label="One more guest" disabled={guests >= maxGuests || busy} onClick={() => setGuests((g) => Math.min(maxGuests, g + 1))}>+</button>
                </div>
              </div>
              <Button disabled={busy} onClick={() => save('going')}>{busy ? 'Saving…' : e.myResponse === 'going' ? 'Update my reply' : 'Save my reply'}</Button>
            </>
          )}
          {done && <Note tone="good">{done}</Note>}
          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      )}
    </div>
  );
}

export function HomeEvents({ onAll }: { onAll: () => void }) {
  const q = useAsync<any[]>(() => api.get('/me/events'));
  const [open, setOpen] = useState<string | null>(null);
  const all = q.data ?? [];
  const rows = all.slice(0, 3);
  return (
    <section className="block">
      <div className="block-head"><h3>Coming up</h3>{rows.length > 0 && <button type="button" className="link-btn" onClick={onAll}>See all</button>}</div>
      {q.loading && !q.data ? <Skeleton lines={2} /> : q.error && !q.data ? <p className="tiny">We could not load events right now.</p> : !rows.length ? (
        <p className="mini-empty">No events coming up</p>
      ) : (
        <ul className="plain-list">{rows.map((e) => <li key={e.id}><EventCard e={e} onOpen={() => setOpen(e.id)} /></li>)}</ul>
      )}
      <EventSheet id={open} events={all} onClose={() => setOpen(null)} onSaved={q.reload} />
    </section>
  );
}

export function EventsPage() {
  const q = useAsync<any[]>(() => api.get('/me/events'));
  const [open, setOpen] = useState<string | null>(null);
  const rows = q.data ?? [];
  const groups: { month: string; items: any[] }[] = [];
  for (const e of rows) {
    const m = monthLong(e.startsAt);
    const last = groups[groups.length - 1];
    if (last && last.month === m) last.items.push(e); else groups.push({ month: m, items: [e] });
  }
  return (
    <div className="stack">
      {q.loading && !q.data ? <div className="card"><Skeleton lines={4} /></div> : q.error && !q.data ? (
        <div className="stack"><ErrorNote>{q.error}</ErrorNote><Button kind="ghost" onClick={q.reload}>Try again</Button></div>
      ) : !rows.length ? (
        <div className="empty-state"><Icon name="calendar" size={40} /><strong>No events coming up</strong><span>Events from your church will show here.</span></div>
      ) : groups.map((g) => (
        <section key={g.month} className="agenda">
          <h3 className="agenda-month">{g.month}</h3>
          <ul className="notice-list">{g.items.map((e) => <li key={e.id} className="block"><EventCard e={e} church onOpen={() => setOpen(e.id)} /></li>)}</ul>
        </section>
      ))}
      <EventSheet id={open} events={rows} onClose={() => setOpen(null)} onSaved={q.reload} />
    </div>
  );
}
