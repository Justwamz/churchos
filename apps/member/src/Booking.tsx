import { useEffect, useMemo, useState } from 'react';
import { Button, ErrorNote, Note, useAsync } from '@churchos/ui';
import { api, errText } from './api';
import { Icon, Sheet, Skeleton } from './ui';
import { PastoralInfo } from './Prayer';

const TZ = 'Africa/Nairobi';
const EAT_MS = 3 * 3600_000;
const DOWS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const dateLong = (iso: string) => new Date(iso).toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ });
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-KE', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
const slotTime = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
const whenText = (b: { startsAt: string; endsAt: string }) => `${dateLong(b.startsAt)}, ${timeOf(b.startsAt)} to ${timeOf(b.endsAt)}`;
const money = (cents: number) => `KES ${(cents / 100).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;
const priceLine = (r: any) => (r.price == null || r.price <= 0 ? 'Free' : `${money(r.price)} per ${r.pricePer === 'hour' ? 'hour' : 'booking'}`);
const lenText = (m: number) => (m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60} ${m === 60 ? 'hour' : 'hours'}` : `${Math.floor(m / 60)} h ${m % 60} min`);

/** The next 14 days in East Africa Time as { date, dow, label }. */
function nextDays(n = 14) {
  const base = Date.now() + EAT_MS;
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(base + i * 86400_000);
    const date = d.toISOString().slice(0, 10);
    return {
      date,
      dow: DOWS[d.getUTCDay()],
      day: d.getUTCDate(),
      wk: i === 0 ? 'Today' : d.toLocaleDateString('en-KE', { weekday: 'short', timeZone: 'UTC' }),
      mon: d.toLocaleDateString('en-KE', { month: 'short', timeZone: 'UTC' }),
    };
  });
}

const BOOK_ERR: Record<string, string> = {
  outside_hours: 'That time is outside the working hours. Please pick one of the times shown.',
  bad_slot: 'That time does not fit the booking length. Please pick one of the times shown.',
  too_soon: 'That is too soon. Please pick a later time.',
  too_far: 'That is too far ahead. Please pick a nearer date.',
  too_long: 'That is longer than allowed. Please choose a shorter time.',
  over_capacity: 'There are too many people for this place. Please lower the number.',
  time_taken: 'Someone else just booked that time. Please pick another time.',
  blocked: 'This is not available then. Please pick another day or time.',
  too_many: 'You have 10 bookings waiting for an answer. Please wait for some to be answered first.',
};
const DECIDE_ERR: Record<string, string> = {
  time_taken: 'That time has been taken by another booking, so it cannot be approved.',
  reason_required: 'Please say why, so the member can pick another time.',
  already_decided: 'This request has already been answered.',
  wrong_state: 'This request is no longer waiting for an answer.',
};

const STATUS: Record<string, { label: string; tone: string }> = {
  requested: { label: 'Waiting for an answer', tone: 'warn' },
  awaiting_payment: { label: 'Approved: pay to confirm', tone: 'info' },
  confirmed: { label: 'Confirmed', tone: 'good' },
  approved: { label: 'Approved', tone: 'good' },
  declined: { label: 'Not accepted', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
  lapsed: { label: 'Released', tone: 'muted' },
  completed: { label: 'Done', tone: 'muted' },
  no_show: { label: 'Done', tone: 'muted' },
};
const Chip = ({ s }: { s: string }) => {
  const x = STATUS[s] ?? { label: s, tone: 'muted' };
  return <span className={`badge ${x.tone}`}>{x.label}</span>;
};
const isUpcoming = (b: any) => ['requested', 'awaiting_payment', 'confirmed'].includes(b.status) && new Date(b.endsAt).getTime() >= Date.now();

// ---------------- Home card ----------------

export function HomeBookings({ onAll }: { onAll: () => void }) {
  const q = useAsync<any[]>(() => api.get('/me/bookings'));
  const rows = (q.data ?? []).filter(isUpcoming).sort((a, b) => a.startsAt.localeCompare(b.startsAt)).slice(0, 2);
  if (!rows.length) return null;
  return (
    <section className="block">
      <div className="block-head"><h3>Your bookings</h3><button type="button" className="link-btn" onClick={onAll}>See all</button></div>
      <ul className="plain-list">
        {rows.map((b) => (
          <li key={b.id}>
            <button type="button" className="bk-mini" onClick={onAll}>
              <span className="msg-ico"><Icon name="calendar" size={18} /></span>
              <span className="bk-mini-main">
                <strong className="ell">{b.title}</strong>
                <span className="tiny ell">{dateLong(b.startsAt)}, {timeOf(b.startsAt)}</span>
              </span>
              <Chip s={b.status} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------- page ----------------

export type BookTab = 'book' | 'mine' | 'diary';

export function BookPage({ initialTab = 'book' }: { initialTab?: BookTab }) {
  const [tab, setTab] = useState<BookTab>(initialTab);
  const diary = useAsync<any[]>(() => api.get('/me/diary'));
  const mine = useAsync<any[]>(() => api.get('/me/bookings'));
  const showDiary = (diary.data ?? []).length > 0;
  useEffect(() => { if (tab === 'diary' && !showDiary && diary.data) setTab('book'); }, [tab, showDiary, diary.data]);
  const reloadAll = () => { mine.reload(); diary.reload(); };
  return (
    <div className="stack">
      <div className="seg" role="tablist" aria-label="Bookings">
        <button type="button" role="tab" aria-selected={tab === 'book'} className={tab === 'book' ? 'on' : ''} onClick={() => setTab('book')}>Book</button>
        <button type="button" role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>My bookings</button>
        {showDiary && <button type="button" role="tab" aria-selected={tab === 'diary'} className={tab === 'diary' ? 'on' : ''} onClick={() => setTab('diary')}>My diary</button>}
      </div>
      {tab === 'book' && <BookTabView onBooked={reloadAll} onSeeMine={() => setTab('mine')} />}
      {tab === 'mine' && <MineTabView q={mine} />}
      {tab === 'diary' && showDiary && <DiaryTabView rows={diary.data ?? []} reload={reloadAll} />}
    </div>
  );
}

// ---------------- Book tab ----------------

const GROUPS: { kind: string; title: string }[] = [
  { kind: 'person', title: 'People' },
  { kind: 'place', title: 'Places' },
  { kind: 'thing', title: 'Things' },
];

function BookTabView({ onBooked, onSeeMine }: { onBooked: () => void; onSeeMine: () => void }) {
  const q = useAsync<any[]>(() => api.get('/me/resources'));
  const [open, setOpen] = useState<any | null>(null);
  const rows = q.data ?? [];
  if (q.loading && !q.data) return <div className="card"><Skeleton lines={4} /></div>;
  if (q.error && !q.data) return <div className="stack"><ErrorNote>{q.error}</ErrorNote><Button kind="ghost" onClick={q.reload}>Try again</Button></div>;
  if (!rows.length) return <div className="empty-state"><Icon name="calendar" size={40} /><strong>Nothing to book yet</strong><span>When your church opens people, places or things for booking, they will show here.</span></div>;
  return (
    <div className="stack">
      {GROUPS.map((g) => {
        const items = rows.filter((r) => r.kind === g.kind);
        if (!items.length) return null;
        return (
          <section key={g.kind} className="agenda">
            <h3 className="agenda-month">{g.title}</h3>
            <ul className="notice-list">
              {items.map((r) => (
                <li key={r.id} className="block">
                  <button type="button" className="res-card" onClick={() => setOpen(r)}>
                    <span className="res-top"><strong>{r.name}</strong><Icon name="chev" size={18} /></span>
                    {r.description && <span className="clamp2 res-desc">{r.description}</span>}
                    <span className="res-facts">
                      <span className="badge info">{priceLine(r)}</span>
                      <span className="tiny">{r.approval === 'auto' ? 'Confirmed straight away' : 'Approved by the church'}</span>
                      {r.kind === 'place' && r.capacity ? <span className="tiny">Holds {r.capacity} people</span> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <Sheet open={!!open} onClose={() => setOpen(null)} title={open ? `Book ${open.name}` : ''}>
        {open && <BookForm key={open.id} r={open} all={rows} onBooked={onBooked} onSeeMine={() => { setOpen(null); onSeeMine(); }} onClose={() => setOpen(null)} />}
      </Sheet>
    </div>
  );
}

function BookForm({ r, all, onBooked, onSeeMine, onClose }: { r: any; all: any[]; onBooked: () => void; onSeeMine: () => void; onClose: () => void }) {
  const days = useMemo(() => nextDays(14), []);
  const open = (d: { dow: string }) => ((r.hours ?? {})[d.dow] ?? []).length > 0;
  const noticeDays = Math.ceil(Number(r.minNoticeHours ?? 0) / 24); // start on the first day that the notice rule allows
  const firstOpen = days.find((d, i) => i >= noticeDays && open(d)) ?? days.find(open) ?? days[0];
  const [date, setDate] = useState(firstOpen.date);
  const step = Number(r.slotMinutes) || 60;
  const max = r.maxMinutes ? Number(r.maxMinutes) : step * 8;
  const lengths: number[] = [];
  for (let m = step; m <= max && lengths.length < 12; m += step) lengths.push(m);
  const [minutes, setMinutes] = useState(step);
  const [slot, setSlot] = useState<{ startsAt: string; endsAt: string } | null>(null);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [people, setPeople] = useState('');
  const [extra, setExtra] = useState<string[]>([]);
  const [showExtra, setShowExtra] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<any | null>(null);
  const [tick, setTick] = useState(0);
  const pastoral = useAsync<any>(() => (r.kind === 'person' ? api.get('/me/pastoral/info') : Promise.resolve(undefined)), [r.id]);

  const av = useAsync<any>(() => api.get(`/me/resources/${encodeURIComponent(r.id)}/availability?date=${date}&minutes=${minutes}`), [date, minutes, tick]);
  useEffect(() => { setSlot(null); }, [date, minutes, tick]);
  const slots: { startsAt: string; endsAt: string }[] = av.data?.slots ?? [];
  // The notice rule can leave the first days with nothing free (for example late in the evening for something that needs a day's notice).
  // Until the member picks a day themselves, move on to the first day that has free times.
  const [chosen, setChosen] = useState(false);
  const nextWithDay = () => { const i = days.findIndex((d) => d.date === date); return days.slice(i + 1).find(open); };
  useEffect(() => {
    if (chosen || av.loading || !av.data || slots.length > 0) return;
    const n = nextWithDay();
    if (n) setDate(n.date);
  }, [av.loading, av.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const others = all.filter((x) => x.id !== r.id && x.church === r.church);
  const toggle = (id: string) => setExtra((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= 4 ? c : [...c, id]));
  const peopleN = people.trim() === '' ? null : Number(people);
  const peopleBad = r.kind === 'place' && people.trim() !== '' && (!Number.isInteger(peopleN) || (peopleN as number) < 1 || (r.capacity != null && (peopleN as number) > r.capacity));
  const ready = !!slot && title.trim().length > 0 && !peopleBad;

  const submit = async () => {
    if (!slot) return;
    setBusy(true); setError(undefined);
    try {
      const body: any = { resourceIds: [r.id, ...extra], startsAt: slot.startsAt, endsAt: slot.endsAt, title: title.trim(), note: note.trim() || undefined };
      if (r.kind === 'place' && peopleN) body.attendees = peopleN;
      const res = await api.post<any>('/me/bookings', body);
      setResult(res);
      onBooked();
    } catch (err: any) {
      setError(BOOK_ERR[err?.code] ?? errText(err));
      if (err?.code === 'time_taken') setTick((t) => t + 1);
    }
    setBusy(false);
  };

  if (result) {
    const st = result.status;
    const done = st === 'confirmed';
    const wait = st === 'requested';
    return (
      <div className="stack bk-result">
        <div className={`bk-result-ico ${done ? 'good' : ''}`}><Icon name={done ? 'check' : 'calendar'} size={34} /></div>
        <h3>{done ? 'You are booked' : wait ? 'Request sent' : st === 'awaiting_payment' ? 'Approved: pay to confirm' : 'Request sent'}</h3>
        <p className="full-text">
          {done ? 'Your time is confirmed.' : wait ? 'We will tell you when it is answered. You will find the answer in your messages.' : st === 'awaiting_payment' ? 'Pay within 24 hours to keep your time. You can find the Pay button under My bookings.' : 'We will tell you what happens next.'}
        </p>
        <div className="bk-sum"><strong>{result.title}</strong><span>{whenText(result)}</span></div>
        <Button onClick={onSeeMine}>See my bookings</Button>
        <Button kind="ghost" onClick={onClose}>Done</Button>
      </div>
    );
  }

  return (
    <div className="bk-form">
      <div className="bk-fields">
        <div className="tiny">{r.name} · {priceLine(r)} · {r.approval === 'auto' ? 'Confirmed straight away' : 'Approved by the church'}</div>

        <div>
          <div className="field-label">Which day?</div>
          <div className="date-strip" role="listbox" aria-label="Choose a day">
            {days.map((d) => (
              <button type="button" key={d.date} role="option" aria-selected={date === d.date} className={`date-chip ${date === d.date ? 'on' : ''} ${open(d) ? '' : 'closed'}`} onClick={() => { setChosen(true); setDate(d.date); }}>
                <i>{d.wk}</i><b>{d.day}</b><i>{d.mon}</i>
              </button>
            ))}
          </div>
          {!open(days.find((d) => d.date === date)!) && <p className="tiny">Closed on this day.</p>}
        </div>

        {lengths.length > 1 && (
          <div>
            <div className="field-label">How long?</div>
            <div className="chips bk-chips">
              {lengths.map((m) => <button type="button" key={m} className={`chip ${minutes === m ? 'on' : ''}`} aria-pressed={minutes === m} onClick={() => setMinutes(m)}>{lenText(m)}</button>)}
            </div>
          </div>
        )}

        <div>
          <div className="field-label">What time?</div>
          {av.loading ? <Skeleton lines={1} /> : av.error ? <p className="tiny">We could not load the times. <button type="button" className="link-btn tiny-link" onClick={av.reload}>Try again</button></p> : !slots.length ? (
            <div className="stack">
              <p className="mini-empty">No free times on this day</p>
              {nextWithDay() && <Button kind="ghost" small onClick={() => { setChosen(true); setDate(nextWithDay()!.date); }}>Show the next day</Button>}
            </div>
          ) : (
            <div className="chips bk-chips">
              {slots.map((s) => <button type="button" key={s.startsAt} className={`chip ${slot?.startsAt === s.startsAt ? 'on' : ''}`} aria-pressed={slot?.startsAt === s.startsAt} onClick={() => setSlot(s)}>{slotTime(s.startsAt)}</button>)}
            </div>
          )}
          {slot && <p className="tiny bk-when">{dateLong(slot.startsAt)}, {slotTime(slot.startsAt)} to {slotTime(slot.endsAt)}</p>}
          <p className="bk-price"><span>Price</span><strong>{av.data?.price ? money(av.data.price) : av.data ? 'Free' : '...'}</strong></p>
        </div>

        <label className="field">
          <span className="field-label">What is it for?</span>
          <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="For example, Counselling or Youth meeting" />
        </label>

        {r.kind === 'place' && (
          <label className="field">
            <span className="field-label">How many people?</span>
            <input inputMode="numeric" value={people} onChange={(e) => setPeople(e.target.value.replace(/\D/g, '').slice(0, 5))} placeholder={r.capacity ? `Up to ${r.capacity}` : 'Number of people'} />
            {peopleBad && <span className="field-error">{r.capacity ? `Choose a number from 1 to ${r.capacity}.` : 'Enter a number.'}</span>}
          </label>
        )}

        <label className="field">
          <span className="field-label">Anything we should know?</span>
          <textarea rows={3} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          <span className="field-hint">Only you and the people who answer your request can read this.</span>
        </label>

        {others.length > 0 && (
          <div className="bk-extra">
            <button type="button" className="link-btn" aria-expanded={showExtra} onClick={() => setShowExtra((v) => !v)}>{showExtra ? 'Hide extra things' : 'Add something else to this booking'}</button>
            {showExtra && (
              <>
                <p className="tiny">Every one must be free at the same time and each is approved separately.</p>
                <div className="pick-list">
                  {others.map((x) => (
                    <label key={x.id} className="check-row">
                      <input type="checkbox" checked={extra.includes(x.id)} onChange={() => toggle(x.id)} />
                      <span className="bk-extra-name"><strong>{x.name}</strong><span className="tiny">{priceLine(x)}</span></span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {r.kind === 'person' && pastoral.data && <PastoralInfo info={pastoral.data} title="Before you book" />}
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
      <div className="bk-submit">
        <Button disabled={!ready || busy} onClick={submit}>{busy ? 'Sending…' : r.approval === 'auto' && extra.length === 0 ? 'Book now' : 'Send request'}</Button>
      </div>
    </div>
  );
}

// ---------------- My bookings ----------------

function MineTabView({ q }: { q: ReturnType<typeof useAsync<any[]>> }) {
  const [cancel, setCancel] = useState<any | null>(null);
  const rows = q.data ?? [];
  if (q.loading && !q.data) return <div className="card"><Skeleton lines={4} /></div>;
  if (q.error && !q.data) return <div className="stack"><ErrorNote>{q.error}</ErrorNote><Button kind="ghost" onClick={q.reload}>Try again</Button></div>;
  if (!rows.length) return <div className="empty-state"><Icon name="calendar" size={40} /><strong>No bookings yet</strong><span>Book a person, place or thing and it will show here.</span></div>;
  const upcoming = rows.filter(isUpcoming).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const past = rows.filter((b) => !isUpcoming(b));
  return (
    <div className="stack">
      {upcoming.length > 0 && <section className="agenda"><h3 className="agenda-month">Coming up</h3><ul className="notice-list">{upcoming.map((b) => <li key={b.id}><BookingCard b={b} onCancel={() => setCancel(b)} /></li>)}</ul></section>}
      {past.length > 0 && <section className="agenda"><h3 className="agenda-month">Earlier</h3><ul className="notice-list">{past.map((b) => <li key={b.id}><BookingCard b={b} onCancel={() => setCancel(b)} /></li>)}</ul></section>}
      <CancelSheet b={cancel} onClose={() => setCancel(null)} onDone={q.reload} />
    </div>
  );
}

function BookingCard({ b, onCancel }: { b: any; onCancel: () => void }) {
  const upcoming = isUpcoming(b);
  const showReason = ['declined', 'cancelled', 'lapsed'].includes(b.status) && b.reason;
  return (
    <div className="block bk-card">
      <div className="bk-card-top"><strong className="bk-title">{b.title}</strong><Chip s={b.status} /></div>
      <div className="tiny">{whenText(b)}</div>
      {b.items?.length > 0 && (
        <ul className="bk-items">
          {b.items.map((i: any, n: number) => <li key={n}><span className="ell">{i.name}</span>{b.items.length > 1 && <Chip s={i.status} />}</li>)}
        </ul>
      )}
      {b.attendees ? <div className="tiny">{b.attendees} people</div> : null}
      {b.price ? <div className="tiny">{money(b.price)}{b.paid ? ' · Paid' : ''}</div> : null}
      {showReason && <Note tone={b.status === 'declined' ? 'bad' : 'info'}>{b.reason}</Note>}
      {b.meetingUrl && ['awaiting_payment', 'confirmed', 'approved'].includes(b.status) && (
        <div className="bk-join">
          <a className="btn primary bk-join-btn" href={b.meetingUrl} target="_blank" rel="noopener noreferrer">Join the meeting</a>
          <span className="tiny">{dateLong(b.startsAt)}, {timeOf(b.startsAt)}</span>
        </div>
      )}
      {b.status === 'awaiting_payment' && (
        <div className="bk-pay">
          {b.holdUntil && <p className="tiny">Time is held until {dateLong(b.holdUntil)}, {timeOf(b.holdUntil)}</p>}
          {b.payUrl && <a className="btn primary bk-pay-btn" href={b.payUrl}>Pay {money(b.price ?? 0)}</a>}
          {b.payCode && <p className="tiny">Payment code: {b.payCode}</p>}
        </div>
      )}
      {b.canCancel && <button type="button" className="btn ghost bk-cancel" onClick={onCancel}>Cancel booking</button>}
      {!b.canCancel && upcoming && <p className="tiny">To cancel inside 24 hours, please contact the church.</p>}
    </div>
  );
}

function CancelSheet({ b, onClose, onDone }: { b: any | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => { setReason(''); setError(undefined); }, [b?.id]);
  const go = async () => {
    setBusy(true); setError(undefined);
    try {
      await api.post(`/me/bookings/${encodeURIComponent(b.id)}/cancel`, { reason: reason.trim() || undefined });
      onDone(); onClose();
    } catch (err: any) {
      setError(err?.code === 'too_late' ? 'To cancel inside 24 hours, please contact the church.' : errText(err));
      if (err?.code === 'too_late' || err?.code === 'wrong_state') onDone();
    }
    setBusy(false);
  };
  return (
    <Sheet open={!!b} onClose={onClose} title="Cancel this booking?">
      {b && (
        <div className="stack">
          <div className="bk-sum"><strong>{b.title}</strong><span>{whenText(b)}</span></div>
          {b.paid && <Note tone="info">This booking was paid. The church will arrange any refund with you.</Note>}
          <label className="field"><span className="field-label">Why? (optional)</span><input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></label>
          {error && <ErrorNote>{error}</ErrorNote>}
          <Button kind="danger" disabled={busy} onClick={go}>{busy ? 'Cancelling…' : 'Yes, cancel booking'}</Button>
          <Button kind="ghost" onClick={onClose}>Keep booking</Button>
        </div>
      )}
    </Sheet>
  );
}

// ---------------- My diary ----------------

function DiaryTabView({ rows, reload }: { rows: any[]; reload: () => void }) {
  const [decline, setDecline] = useState<any | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [busyId, setBusyId] = useState<string | null>(null);
  const waiting = rows.filter((b) => b.status === 'requested' && b.items.some((i: any) => i.mine && i.status === 'requested'));
  const rest = rows.filter((b) => !waiting.includes(b));

  const approve = async (b: any) => {
    setBusyId(b.id); setError(undefined);
    try { await api.post(`/me/diary/${encodeURIComponent(b.id)}/decide`, { approve: true }); } catch (err: any) { setError(DECIDE_ERR[err?.code] ?? errText(err)); }
    setBusyId(null); reload();
  };

  return (
    <div className="stack">
      {error && <ErrorNote>{error}</ErrorNote>}
      {waiting.length > 0 && (
        <section className="agenda">
          <h3 className="agenda-month">Waiting for your answer</h3>
          <ul className="notice-list">
            {waiting.map((b) => (
              <li key={b.id} className="block bk-card">
                <div className="bk-card-top"><strong className="bk-title">{b.title}</strong><Chip s={b.status} /></div>
                <div className="tiny">{whenText(b)}</div>
                <div className="tiny">From {b.requester}{b.attendees ? ` · ${b.attendees} people` : ''}</div>
                <div className="tiny">{b.items.filter((i: any) => i.mine).map((i: any) => i.name).join(', ')}</div>
                {b.note && <p className="bk-note">{b.note}</p>}
                <div className="bk-actions">
                  <Button disabled={busyId === b.id} onClick={() => approve(b)}>Approve</Button>
                  <Button kind="ghost" disabled={busyId === b.id} onClick={() => setDecline(b)}>Decline</Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="agenda">
        <h3 className="agenda-month">Your diary</h3>
        {rest.length === 0 ? <p className="mini-empty">Nothing else in your diary yet</p> : (
          <ul className="notice-list">
            {rest.map((b) => (
              <li key={b.id} className="block bk-card">
                <div className="bk-card-top"><strong className="bk-title">{b.title}</strong><Chip s={b.status} /></div>
                <div className="tiny">{whenText(b)}</div>
                <div className="tiny">{b.requester}{b.attendees ? ` · ${b.attendees} people` : ''}</div>
                {b.note && <p className="bk-note">{b.note}</p>}
                {['approved', 'awaiting_payment', 'confirmed'].includes(b.status) && new Date(b.endsAt).getTime() >= Date.now() && <MeetingLink b={b} onDone={reload} />}
              </li>
            ))}
          </ul>
        )}
      </section>
      <DeclineSheet b={decline} onClose={() => setDecline(null)} onDone={reload} />
    </div>
  );
}

function MeetingLink({ b, onDone }: { b: any; onDone: () => void }) {
  const [url, setUrl] = useState<string>(b.meetingUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | undefined>();
  useEffect(() => setUrl(b.meetingUrl ?? ''), [b.meetingUrl]);
  const save = async (clear: boolean) => {
    setBusy(true); setMsg(undefined);
    try {
      await api.post(`/bookings/${encodeURIComponent(b.id)}/meeting-link`, { url: clear ? null : url.trim() });
      if (clear) setUrl('');
      setMsg({ ok: true, text: clear ? 'Link removed.' : 'Link saved. The member can now join.' });
      onDone();
    } catch (err: any) { setMsg({ ok: false, text: err?.code === 'bad_link' ? 'The link must start with https://' : errText(err) }); }
    setBusy(false);
  };
  return (
    <div className="bk-link">
      <label className="field">
        <span className="field-label">Meeting link (Google Meet, Zoom, Jitsi...)</span>
        <input type="url" inputMode="url" value={url} maxLength={300} placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
        <span className="field-hint">Only the member and you can see this link.</span>
      </label>
      {msg && (msg.ok ? <p className="tiny bk-ok">{msg.text}</p> : <ErrorNote>{msg.text}</ErrorNote>)}
      <div className="bk-actions">
        <Button disabled={busy || !url.trim() || url.trim() === (b.meetingUrl ?? '')} onClick={() => save(false)}>{busy ? 'Saving…' : 'Save'}</Button>
        {b.meetingUrl && <Button kind="ghost" disabled={busy} onClick={() => save(true)}>Remove link</Button>}
      </div>
    </div>
  );
}

function DeclineSheet({ b, onClose, onDone }: { b: any | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => { setReason(''); setError(undefined); }, [b?.id]);
  const go = async () => {
    setBusy(true); setError(undefined);
    try {
      await api.post(`/me/diary/${encodeURIComponent(b.id)}/decide`, { approve: false, reason: reason.trim() });
      onDone(); onClose();
    } catch (err: any) { setError(DECIDE_ERR[err?.code] ?? errText(err)); }
    setBusy(false);
  };
  return (
    <Sheet open={!!b} onClose={onClose} title="Decline this request">
      {b && (
        <div className="stack">
          <div className="bk-sum"><strong>{b.title}</strong><span>{whenText(b)}</span></div>
          <label className="field"><span className="field-label">Why?</span><textarea rows={3} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /><span className="field-hint">The member will read this, so they can pick another time.</span></label>
          {error && <ErrorNote>{error}</ErrorNote>}
          <Button kind="danger" disabled={busy || !reason.trim()} onClick={go}>{busy ? 'Sending…' : 'Decline request'}</Button>
        </div>
      )}
    </Sheet>
  );
}
