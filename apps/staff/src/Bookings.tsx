import { useEffect, useState } from 'react';
import { useLinkParams } from './links';
import { Button, ErrorNote, Field, Note, kes, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Load } from './worship-bits';
import { Card, EmptyState, PageHeader, SidePanel, StatusChip } from './ui';
import { Modal } from './MemberForm';
import { eat } from './Resources';
import './bookings.css';
import './pastoral.css';
import './worship.css';

type Tone = 'wait' | 'done' | 'bad' | 'info' | 'off';
const ITEM: Record<string, { text: string; tone: Tone }> = { requested: { text: 'Waiting', tone: 'wait' }, approved: { text: 'Approved', tone: 'done' }, declined: { text: 'Declined', tone: 'bad' } };
const STATUS: Record<string, { text: string; tone: Tone }> = {
  requested: { text: 'Waiting for an answer', tone: 'wait' }, awaiting_payment: { text: 'Waiting for payment', tone: 'info' }, confirmed: { text: 'Confirmed', tone: 'done' },
  declined: { text: 'Declined', tone: 'bad' }, cancelled: { text: 'Cancelled', tone: 'off' }, completed: { text: 'Done', tone: 'done' }, no_show: { text: 'No show', tone: 'bad' }, lapsed: { text: 'Not paid in time', tone: 'off' },
};

const explain = (e: any) => {
  switch (e?.code) {
    case 'time_taken': return 'Another booking already holds that time, so this cannot be approved.';
    case 'already_decided': return 'Someone has already answered this one.';
    case 'reason_required': return 'Please write a reason.';
    case 'same_person': return 'You cannot answer your own booking. Ask someone else.';
    case 'too_early': return 'This booking has not started yet.';
    case 'wrong_state': return 'This booking has changed. Refresh the page to see where it is now.';
    default: return friendly(e?.message);
  }
};

const day = (iso: string) => eat(iso, { weekday: 'short', day: 'numeric', month: 'short' });
const clock = (iso: string) => eat(iso, { hour: '2-digit', minute: '2-digit' });
const whenText = (b: any) => `${day(b.startsAt)}, ${clock(b.startsAt)} to ${clock(b.endsAt)}`;

function ReasonDialog({ title, note, label, button, onClose, run }: { title: string; note?: string; label: string; button: string; onClose: () => void; run: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    if (!reason.trim()) return setErr('Please write a reason.');
    setBusy(true); setErr('');
    try { await run(reason.trim()); } catch (e: any) { setErr(explain(e)); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack">
        {note && <Note>{note}</Note>}
        <Field label={label} hint="The member will see this."><textarea rows={3} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row"><Button kind="danger" disabled={busy} onClick={go}>{busy ? 'Saving...' : button}</Button><Button kind="ghost" onClick={onClose}>Back</Button></div>
      </div>
    </Modal>
  );
}

function MeetingLink({ b, onChanged }: { b: any; onChanged: () => void }) {
  const s = useSession();
  const toast = useToast();
  const [url, setUrl] = useState<string>(b.meetingUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { setUrl(b.meetingUrl ?? ''); }, [b.meetingUrl]);
  if (!['awaiting_payment', 'confirmed'].includes(b.status)) return null;
  const send = async (value: string | null) => {
    if (value !== null && !/^https:\/\/\S+$/i.test(value)) return setErr('Please paste a link that starts with https://');
    setBusy(true); setErr('');
    try { await api.post(`/bookings/${b.id}/meeting-link` + s.qs({ branch: undefined }), { url: value }); toast.show(value ? 'Meeting link saved' : 'Meeting link removed'); onChanged(); }
    catch (e: any) { setErr(e?.code === 'bad_link' ? 'That does not look like a safe link. It must start with https://' : e?.code === 'wrong_state' ? 'A meeting link can be added once the booking is approved.' : friendly(e?.message)); }
    setBusy(false);
  };
  const copy = async () => { try { await navigator.clipboard.writeText(b.meetingUrl); toast.show('Link copied'); } catch { toast.show('Could not copy. Select the link and copy it.', 'bad'); } };
  return (
    <div className="bk-link">
      <label className="field" style={{ margin: 0 }}>
        <span className="field-label">Meeting link</span>
        <input type="url" inputMode="url" placeholder="https://meet.google.com/..." maxLength={300} value={url} onChange={(e) => { setUrl(e.target.value); setErr(''); }} />
        <span className="field-hint">For a call or video meeting. Paste a Google Meet, Zoom or Jitsi link. Only the member and the people who look after this booking can see it.</span>
      </label>
      {err && <ErrorNote>{err}</ErrorNote>}
      <div className="row">
        <Button small disabled={busy || !url.trim() || url.trim() === (b.meetingUrl ?? '')} onClick={() => send(url.trim())}>{busy ? 'Saving...' : 'Save link'}</Button>
        {b.meetingUrl && <Button small kind="ghost" onClick={copy}>Copy</Button>}
        {b.meetingUrl && <Button small kind="ghost" disabled={busy} onClick={() => send(null)}>Remove</Button>}
      </div>
      {toast.node}
    </div>
  );
}

function BookingCard({ b, canManage, onChanged, onApprove, onDecline, onCancel, onComplete }: { b: any; canManage: boolean; onChanged: () => void; onApprove: (it: any) => void; onDecline: (it: any) => void; onCancel: () => void; onComplete: (o: 'completed' | 'no_show') => void }) {
  const st = STATUS[b.status] ?? { text: b.status, tone: 'off' as Tone };
  const started = Date.parse(b.startsAt) <= Date.now();
  const open = ['requested', 'awaiting_payment', 'confirmed'].includes(b.status);
  const canComplete = canManage && b.status === 'confirmed' && started;
  const canCancel = !!b.canCancel && open;
  return (
    <section className="bk-card">
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}><b>{b.title}</b><div className="tiny">{whenText(b)}</div></div>
        <StatusChip tone={st.tone}>{st.text}</StatusChip>
      </div>
      <div className="tiny">Asked by {b.requester}{b.attendees ? `. ${b.attendees} ${b.attendees === 1 ? 'person' : 'people'}` : ''}. Code {b.code}.</div>
      <div className="bk-items">
        {b.items.map((it: any) => {
          const s = ITEM[it.status] ?? ITEM.requested;
          return (
            <div className="bk-item" key={it.resourceId}>
              <div style={{ minWidth: 0 }}><b>{it.name}</b> <StatusChip tone={s.tone}>{s.text}</StatusChip>{it.status === 'declined' && it.reason && <div className="tiny">{it.reason}</div>}</div>
              {it.mine && it.status === 'requested' && b.status === 'requested' && (
                <div className="wo-actions"><Button small onClick={() => onApprove(it)}>Approve</Button><Button small kind="ghost" onClick={() => onDecline(it)}>Decline</Button></div>
              )}
            </div>
          );
        })}
      </div>
      {b.price != null && (
        <div className="tiny">
          {kes(b.price)}. {b.paid ? 'Paid.' : b.status === 'awaiting_payment' && b.holdUntil ? `Waiting for payment until ${day(b.holdUntil)}, ${clock(b.holdUntil)}.` : b.status === 'requested' ? 'To be paid after approval.' : 'Not paid.'}
        </div>
      )}
      {b.note && <Note>Note: {b.note}</Note>}
      {['declined', 'cancelled'].includes(b.status) && b.reason && <Note tone="warn">{b.status === 'declined' ? 'Declined' : 'Cancelled'}: {b.reason}</Note>}
      <MeetingLink b={b} onChanged={onChanged} />
      {(canComplete || canCancel) && (
        <div className="wo-actions">
          {canComplete && <><Button small onClick={() => onComplete('completed')}>Mark as done</Button><Button small kind="ghost" onClick={() => onComplete('no_show')}>No show</Button></>}
          {canCancel && <Button small kind="ghost" onClick={onCancel}>Cancel booking</Button>}
        </div>
      )}
    </section>
  );
}

type DateMode = 'month' | 'day' | 'all';
const FILTERS: { key: string; label: string; statuses: string }[] = [
  { key: 'pending', label: 'Pending', statuses: 'requested' },
  { key: 'approved', label: 'Approved, waiting for payment', statuses: 'awaiting_payment' },
  { key: 'confirmed', label: 'Confirmed', statuses: 'confirmed' },
  { key: 'declined', label: 'Declined', statuses: 'declined' },
  { key: 'cancelled', label: 'Cancelled', statuses: 'cancelled' },
  { key: 'done', label: 'Done', statuses: 'completed' },
  { key: 'noshow', label: 'No show', statuses: 'no_show' },
  { key: 'lapsed', label: 'Not paid in time', statuses: 'lapsed' },
];
const pad2 = (n: number) => String(n).padStart(2, '0');
const eatToday = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
/** The start and end (ISO) of a day or a month in East Africa Time. */
const range = (mode: DateMode, month: string, dayStr: string): { from?: string; to?: string } => {
  if (mode === 'all') return {};
  if (mode === 'day') {
    const t = Date.parse(`${dayStr}T00:00:00+03:00`);
    return Number.isNaN(t) ? {} : { from: new Date(t).toISOString(), to: new Date(t + 86400_000 - 1).toISOString() };
  }
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) return {};
  return { from: new Date(Date.UTC(y, m - 1, 1) - 3 * 3600_000).toISOString(), to: new Date(Date.UTC(y, m, 1) - 3 * 3600_000 - 1).toISOString() };
};
const shiftMonth = (month: string, d: number) => { const [y, m] = month.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + d, 1)); return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}`; };
const monthLabel = (month: string) => new Date(`${month}-01T12:00:00Z`).toLocaleString('en-KE', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export function Bookings() {
  const s = useSession();
  const toast = useToast();
  const [mode, setMode] = useState<DateMode>('month');
  const [month, setMonth] = useState(() => eatToday().slice(0, 7));
  const [dayStr, setDayStr] = useState(eatToday);
  const [picked, setPicked] = useState<string[]>([]); // filter keys, empty means every status
  const [resource, setResource] = useState('');
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState(''); // the search as sent, a moment after typing stops
  useEffect(() => { const t = setTimeout(() => setTerm(search.trim()), 300); return () => clearTimeout(t); }, [search]);
  const [open, setOpen] = useState<any>(null);
  const [moreOpen, setMoreOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth > 700);
  const [deciding, setDeciding] = useState<{ b: any; it: any } | null>(null);
  const [cancelling, setCancelling] = useState<any>(null);
  const canManage = s.can('bookings.manage');
  // A notification link: ?open=<booking id> opens that booking's panel.
  const link = useLinkParams('bookings');
  useEffect(() => {
    if (!link?.open) return;
    api.get(`/bookings/${link.open}` + s.qs({ branch: undefined })).then((b: any) => { if (b?.id) setOpen(b); }).catch(() => {});
  }, [link]); // eslint-disable-line react-hooks/exhaustive-deps
  const resources = useAsync<any[]>(() => api.get('/resources' + s.qs({ branch: undefined })).catch(() => []), [s.grant.org.id]);
  const { from, to } = range(mode, month, dayStr);
  const statuses = picked.length ? FILTERS.filter((f) => picked.includes(f.key)).map((f) => f.statuses).join(',') : '';
  const list = useAsync<any[]>(
    () => api.get(`/bookings${s.qs({ branch: undefined, status: statuses || undefined, from, to, resource: resource || undefined, q: term || undefined })}`),
    [s.grant.org.id, statuses, from, to, resource, term],
  );
  const reload = () => list.reload();
  const post = async (path: string, body: any, msg: string) => {
    try { await api.post(path + s.qs({ branch: undefined }), body); toast.show(msg); setOpen(null); reload(); } catch (e: any) { toast.show(explain(e)); }
  };
  const rows = [...(list.data ?? [])].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const waiting = rows.filter((b) => b.status === 'requested' && b.items.some((i: any) => i.mine && i.status === 'requested')).length;
  const toggleKey = (k: string) => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));

  return (
    <div>
      <PageHeader title="Bookings" subtitle="Requests to use a place, a person's time or something your church owns." />
      <div>
        <section className="u-card bk-filters">
          <label className="field" style={{ margin: 0 }}>
            <span className="field-label">Search</span>
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Booking code, member name or reason" maxLength={60} autoComplete="off" />
          </label>
          <div className="bk-filter-row">
            <div className="chips" role="group" aria-label="Which dates">
              <button type="button" className={`chip ${mode === 'month' ? 'on' : ''}`} aria-pressed={mode === 'month'} onClick={() => setMode('month')}>By month</button>
              <button type="button" className={`chip ${mode === 'day' ? 'on' : ''}`} aria-pressed={mode === 'day'} onClick={() => setMode('day')}>By day</button>
              <button type="button" className={`chip ${mode === 'all' ? 'on' : ''}`} aria-pressed={mode === 'all'} onClick={() => setMode('all')}>All dates</button>
            </div>
            {mode === 'month' && (
              <div className="row" style={{ alignItems: 'center' }}>
                <Button small kind="ghost" onClick={() => setMonth(shiftMonth(month, -1))}>Previous</Button>
                <b style={{ minWidth: 130, textAlign: 'center' }}>{monthLabel(month)}</b>
                <Button small kind="ghost" onClick={() => setMonth(shiftMonth(month, 1))}>Next</Button>
                <Button small kind="ghost" onClick={() => setMonth(eatToday().slice(0, 7))}>This month</Button>
              </div>
            )}
            {mode === 'day' && (
              <div className="row" style={{ alignItems: 'center' }}>
                <input type="date" aria-label="Day" value={dayStr} onChange={(e) => e.target.value && setDayStr(e.target.value)} style={{ width: 180 }} />
                <Button small kind="ghost" onClick={() => setDayStr(eatToday())}>Today</Button>
              </div>
            )}
          </div>
          <details className="bk-more" open={moreOpen} onToggle={(e) => setMoreOpen((e.target as HTMLDetailsElement).open)}>
            <summary>More filters{picked.length || resource ? ' (on)' : ''}</summary>
            <div className="stack" style={{ marginTop: 12 }}>
          <div>
            <div className="field-label" id="bk-st">Status</div>
            <div className="chips" role="group" aria-labelledby="bk-st">
              <button type="button" className={`chip ${picked.length === 0 ? 'on' : ''}`} aria-pressed={picked.length === 0} onClick={() => setPicked([])}>All</button>
              {FILTERS.map((f) => <button type="button" key={f.key} className={`chip ${picked.includes(f.key) ? 'on' : ''}`} aria-pressed={picked.includes(f.key)} onClick={() => toggleKey(f.key)}>{f.label}</button>)}
            </div>
          </div>
          {!!resources.data?.length && (
            <label className="field" style={{ margin: 0, maxWidth: 320 }}>
              <span className="field-label">What was booked</span>
              <select value={resource} onChange={(e) => setResource(e.target.value)}>
                <option value="">Everything</option>
                {resources.data.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
          )}
            </div>
          </details>
        </section>
        <div className="tiny" style={{ margin: '12px 0' }}>Notes are private. Only people who answer a request can read them.</div>
        <Load loading={list.loading} error={list.error} hasData={!!list.data}>
          {list.data && (rows.length === 0
            ? <Card><EmptyState icon="today" title="No bookings here" text={term ? `Nothing matches "${term}" with these choices. Try All dates and All statuses.` : 'No bookings match these choices.'} /></Card>
            : (
              <>
                <div className="tiny">{rows.length} {rows.length === 1 ? 'booking' : 'bookings'}{waiting ? `. ${waiting} for you to answer.` : ''}</div>
                <Card pad={false}>
                  <div className="bk-list">
                  {rows.map((b) => {
                    const st = STATUS[b.status] ?? { text: b.status, tone: 'off' as Tone };
                    const mine = b.status === 'requested' ? b.items.filter((i: any) => i.mine && i.status === 'requested') : [];
                    return (
                      <div className="bk-row" key={b.id}>
                        <div className="bk-when"><b>{day(b.startsAt)}</b><div className="tiny">{clock(b.startsAt)} to {clock(b.endsAt)}</div></div>
                        <div className="bk-what">
                          <div><b>{b.title}</b></div>
                          <div className="tiny">{b.items.map((it: any) => it.name).join(', ')} · Asked by {b.requester} · Code {b.code}{b.attendees ? `, ${b.attendees} people` : ''}</div>
                          <div className="bk-chips" style={{ marginTop: 6 }}>
                            <StatusChip tone={st.tone}>{st.text}</StatusChip>
                            {b.items.length > 1 && b.items.map((it: any) => <StatusChip key={it.resourceId} tone={(ITEM[it.status] ?? ITEM.requested).tone}>{it.name}: {(ITEM[it.status] ?? ITEM.requested).text}</StatusChip>)}
                            {b.meetingUrl && <StatusChip tone="info">Video link added</StatusChip>}
                            {b.status === 'awaiting_payment' && b.holdUntil && <span className="tiny">until {day(b.holdUntil)}, {clock(b.holdUntil)}</span>}
                          </div>
                        </div>
                        <div className="bk-price">{b.price == null ? 'Free' : <>{kes(b.price)}<div className="tiny">{b.paid ? 'Paid' : 'Not paid'}</div></>}</div>
                        <div className="wo-actions bk-go">
                          {mine.length === 1 && <Button small onClick={() => post(`/bookings/${b.id}/items/${mine[0].resourceId}/decide`, { approve: true, reason: '' }, `Approved ${mine[0].name}`)}>Approve</Button>}
                          {mine.length === 1 && <Button small kind="ghost" onClick={() => setDeciding({ b, it: mine[0] })}>Decline</Button>}
                          <Button small kind="ghost" onClick={() => setOpen(b)}>{mine.length > 1 ? 'Answer' : 'Details'}</Button>
                        </div>
                      </div>
                    );
                  })}
                  </div>
                </Card>
              </>
            ))}
        </Load>
      </div>
      {open && (
        <SidePanel title={open.title} subtitle={whenText(open)} onClose={() => setOpen(null)} width={520}>
          <BookingCard b={list.data?.find((x) => x.id === open.id) ?? open} canManage={canManage} onChanged={reload}
            onApprove={(it) => post(`/bookings/${open.id}/items/${it.resourceId}/decide`, { approve: true, reason: '' }, `Approved ${it.name}`)}
            onDecline={(it) => setDeciding({ b: open, it })} onCancel={() => setCancelling(open)}
            onComplete={(o) => post(`/bookings/${open.id}/complete`, { outcome: o }, o === 'completed' ? 'Marked as done' : 'Marked as no show')} />
        </SidePanel>
      )}
      {deciding && (
        <ReasonDialog title={`Decline ${deciding.it.name}?`} label="Why not?" button="Decline" onClose={() => setDeciding(null)}
          run={async (reason) => { await api.post(`/bookings/${deciding.b.id}/items/${deciding.it.resourceId}/decide` + s.qs({ branch: undefined }), { approve: false, reason }); setDeciding(null); setOpen(null); toast.show('Declined'); reload(); }} />
      )}
      {cancelling && (
        <ReasonDialog title="Cancel this booking?" note="The member is told. If they paid, arrange any refund through Payment help." label="Why is it cancelled?" button="Cancel booking" onClose={() => setCancelling(null)}
          run={async (reason) => { await api.post(`/bookings/${cancelling.id}/cancel` + s.qs({ branch: undefined }), { reason }); setCancelling(null); setOpen(null); toast.show('Booking cancelled'); reload(); }} />
      )}
      {toast.node}
    </div>
  );
}
