import { useEffect, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorNote, Field, Note, Table, useAsync, useToast } from '@churchos/ui';
import { api, useSession } from './session';
import { Load, PageHead } from './bits';
import { Modal } from './MemberForm';
import { AudiencePicker, audienceValue, explainCommunity as explain, initialAudience, toIso, toLocal, type AudState } from './communityBits';
import { TicketsEditor, blankType, explainTickets, rowFromType, typesPayload, type Poster, type TypeRow } from './TicketsEditor';
import { TicketPanel } from './TicketPanel';
import './community.css';
import './tickets.css';

const fmt = (iso: string, o: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', ...o });
const whenText = (e: any) => `${fmt(e.startsAt, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}${e.endsAt ? ` to ${fmt(e.endsAt, { hour: 'numeric', minute: '2-digit' })}` : ''}`;

function EventForm({ event, onClose, onSaved }: { event?: any; onClose: () => void; onSaved: (m: string) => void }) {
  const s = useSession();
  const [title, setTitle] = useState<string>(event?.title ?? '');
  const [desc, setDesc] = useState<string>(event?.description ?? '');
  const [place, setPlace] = useState<string>(event?.location ?? '');
  const [start, setStart] = useState(toLocal(event?.startsAt));
  const [end, setEnd] = useState(toLocal(event?.endsAt));
  const [aud, setAud] = useState<AudState>(initialAudience(event?.audience, s.branches[0]?.id ?? ''));
  const [rsvp, setRsvp] = useState<boolean>(!!event?.rsvp);
  const [cap, setCap] = useState<string>(event?.capacity != null ? String(event.capacity) : '');
  const [ticketed, setTicketed] = useState<boolean>(!!event?.ticketed);
  const [rows, setRows] = useState<TypeRow[]>([blankType()]);
  const [poster, setPoster] = useState<Poster | null>(null);
  const existing = useAsync<any>(() => (event?.ticketed ? api.get(`/events/${event.id}/tickets` + s.qs({ branch: undefined })) : Promise.resolve(null)), [event?.id]);
  useEffect(() => { if (existing.data?.types?.length) setRows(existing.data.types.map(rowFromType)); }, [existing.data]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setErr('');
    if (!title.trim()) return setErr('Write the name of the event.');
    if (!start) return setErr('Choose when the event starts.');
    if (end && Date.parse(`${end}:00+03:00`) < Date.parse(`${start}:00+03:00`)) return setErr('The event cannot end before it starts.');
    if (aud.kind === 'group' && !aud.group) return setErr('Choose a group.');
    if (!ticketed && rsvp && cap.trim() && !(Number(cap) >= 1)) return setErr('Capacity must be a number, or leave it empty.');
    let types: any[] | undefined;
    if (ticketed) {
      const r = typesPayload(rows);
      if (r.error) return setErr(r.error);
      types = r.types;
    }
    const wasTicketed = !!event?.ticketed;
    const payload = {
      title: title.trim(), description: desc.trim(), location: place.trim(), startsAt: toIso(start), endsAt: end ? toIso(end) : null,
      audience: audienceValue(aud), rsvp: ticketed ? false : rsvp, capacity: !ticketed && rsvp && cap.trim() ? Math.floor(Number(cap)) : null,
    };
    setBusy(true);
    try {
      let id: string = event?.id;
      if (event) await api.put(`/events/${event.id}` + s.qs({ branch: undefined }), payload);
      else id = (await api.post('/events' + s.qs({ branch: undefined }), payload)).id;
      try {
        if (ticketed || wasTicketed) await api.put(`/events/${id}/ticketing` + s.qs({ branch: undefined }), { ticketed, types: ticketed ? types : [] });
        if (ticketed && poster) await api.post(`/events/${id}/poster` + s.qs({ branch: undefined }), { image: { mime: poster.mime, data: poster.data } });
      } catch (e: any) {
        setErr(`The event was saved, but its tickets were not. ${explainTickets(e) ?? explain(e)}${event ? '' : ' Close this form and edit the event to set up its tickets.'}`);
        setBusy(false);
        return;
      }
      onSaved(event ? 'Changes saved' : 'Event created');
    } catch (e: any) { setErr(explain(e)); setBusy(false); }
  };

  return (
    <div className="stack">
      <div className="row between"><h2 style={{ margin: 0 }}>{event ? 'Edit event' : 'New event'}</h2><Button kind="ghost" small onClick={onClose}>Cancel</Button></div>
      <Card title="1. About the event">
        <div className="stack">
          <Field label="Name" hint={`${title.length} of 80 characters`}><input maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="Details" hint={`Optional. ${desc.length} of 1000 characters`}><textarea rows={4} maxLength={1000} value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
          <Field label="Place" hint="Optional"><input maxLength={120} value={place} onChange={(e) => setPlace(e.target.value)} /></Field>
          <div className="grid cols-2">
            <Field label="Starts" hint="East Africa Time"><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
            <Field label="Ends" hint="Optional. East Africa Time"><input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
          </div>
        </div>
      </Card>
      <Card title="2. Who is it for?"><AudiencePicker name="evaud" value={aud} onChange={setAud} /></Card>
      <Card title="3. Tickets or replies">
        <div className="stack">
          <label className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><input type="radio" name="evtk" checked={!ticketed} onChange={() => setTicketed(false)} /> <b>Free event, people reply</b></label>
          <label className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><input type="radio" name="evtk" checked={ticketed} onChange={() => setTicketed(true)} /> <b>Tickets</b></label>
          {ticketed ? (
            <>
              {existing.loading && !existing.data && event?.ticketed ? <div className="tiny">Loading your tickets...</div> : null}
              <TicketsEditor rows={rows} setRows={setRows} poster={poster} setPoster={setPoster} existingPoster={existing.data?.hasPoster ? api.url(existing.data.posterUrl) : undefined} />
            </>
          ) : (
            <>
              <label className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><input type="checkbox" checked={rsvp} onChange={(e) => setRsvp(e.target.checked)} /> <b>Ask people to reply</b></label>
              {rsvp && (
                <>
                  <Field label="Capacity" hint="Optional. Leave empty for no limit. Guests count towards capacity, up to 10 per reply."><input inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value.replace(/\D/g, ''))} /></Field>
                  <div className="tiny">People who are going get a reminder 24 hours before.</div>
                </>
              )}
            </>
          )}
        </div>
      </Card>
      {err && <ErrorNote>{err}</ErrorNote>}
      <div className="row"><Button disabled={busy} onClick={save}>{busy ? 'Saving...' : event ? 'Save changes' : 'Create event'}</Button><Button kind="ghost" disabled={busy} onClick={onClose}>Cancel</Button></div>
    </div>
  );
}

function CancelDialog({ event, onClose, onDone }: { event: any; onClose: () => void; onDone: (m: string) => void }) {
  const s = useSession();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try {
      const r: any = await api.post(`/events/${event.id}/cancel` + s.qs({ branch: undefined }), { reason: reason.trim() });
      const o = r?.ordersToRefund ?? 0, t = r?.ticketsToRefund ?? 0;
      onDone(o > 0 ? `Event cancelled. ${o} paid ${o === 1 ? 'order' : 'orders'} (${t} ${t === 1 ? 'ticket' : 'tickets'}) need a refund. Arrange these through Payment help.` : 'Event cancelled');
    }
    catch (e: any) { setErr(explain(e)); setBusy(false); }
  };
  return (
    <Modal title="Cancel this event?" onClose={onClose}>
      <div className="stack">
        <Note>Everyone who said they are going is told. This cannot be undone.</Note>
        <Field label="Why is it cancelled?" hint="Optional. Members will see this."><textarea rows={3} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row"><Button kind="danger" disabled={busy} onClick={go}>{busy ? 'Cancelling...' : 'Cancel event'}</Button><Button kind="ghost" onClick={onClose}>Keep event</Button></div>
      </div>
    </Modal>
  );
}

function Replies({ event, onClose }: { event: any; onClose: () => void }) {
  const s = useSession();
  const d = useAsync<any>(() => api.get(`/events/${event.id}/rsvps` + s.qs({ branch: undefined })), [event.id]);
  return (
    <Modal title="Who is coming" onClose={onClose}>
      <div className="stack">
        <div className="tiny">Names and guest counts only. Phone numbers are never shown here.</div>
        <Load loading={d.loading} error={d.error} hasData={!!d.data}>
          {d.data && (
            <>
              <div><b>{d.data.totals.people}</b> {d.data.totals.people === 1 ? 'person' : 'people'} coming: {d.data.totals.going} {d.data.totals.going === 1 ? 'member' : 'members'} and {d.data.totals.people - d.data.totals.going} {d.data.totals.people - d.data.totals.going === 1 ? 'guest' : 'guests'}. {d.data.totals.declined} said they cannot come.</div>
              {d.data.going.length === 0 ? <Empty>No one has said they are going yet.</Empty> : (
                <Table head={['Name', 'Guests they bring', 'People']}>
                  {d.data.going.map((g: any, i: number) => <tr key={i}><td>{g.name}</td><td>{g.guests > 0 ? g.guests : 'None'}</td><td><b>{1 + g.guests}</b></td></tr>)}
                </Table>
              )}
              {d.data.notGoing.length > 0 && (
                <div><b>Cannot come</b><div className="tiny" style={{ overflowWrap: 'anywhere' }}>{d.data.notGoing.map((n: any) => n.name).join(', ')}</div></div>
              )}
            </>
          )}
        </Load>
      </div>
    </Modal>
  );
}

function EventCard({ e, canManage, onEdit, onCancel, onReplies, onTickets }: { e: any; canManage: boolean; onEdit: () => void; onCancel: () => void; onReplies: () => void; onTickets: () => void }) {
  const cancelled = e.status === 'cancelled';
  const pct = e.capacity ? Math.min(100, Math.round((e.peopleComing / e.capacity) * 100)) : 0;
  return (
    <section className="card ev-item">
      <div className="ev-date" aria-hidden="true"><b>{fmt(e.startsAt, { day: 'numeric' })}</b><span>{fmt(e.startsAt, { month: 'short' })}</span></div>
      <div className="stack" style={{ gap: 8, minWidth: 0 }}>
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}><b style={{ overflowWrap: 'anywhere' }}>{e.title}</b>{e.description && <div className="muted" style={{ fontSize: 14, overflowWrap: 'anywhere' }}>{e.description}</div>}</div>
          {cancelled && <Badge tone="bad">Cancelled</Badge>}
        </div>
        <div className="tiny">{whenText(e)}{e.location ? `. ${e.location}` : ''}. For: {e.audienceLabel}.</div>
        {cancelled && e.cancelReason && <Note tone="warn">Cancelled: {e.cancelReason}</Note>}
        {e.rsvp && (
          <div className="stack" style={{ gap: 4 }}>
            <div className="row"><Badge tone="info">Asks for replies</Badge><span className="tiny"><b>{e.peopleComing}</b> {e.peopleComing === 1 ? 'person' : 'people'} coming{e.capacity ? ` of ${e.capacity}` : ''}. {e.notComing} cannot come.{e.spotsLeft != null ? ` ${e.spotsLeft} ${e.spotsLeft === 1 ? 'spot' : 'spots'} left.` : ''}</span></div>
            {e.capacity ? <div className="progress" aria-label={`${pct}% full`}><i style={{ width: `${Math.max(pct, 2)}%` }} /></div> : null}
          </div>
        )}
        {e.ticketed && (
          <div className="row"><Badge tone="info">Tickets</Badge><span className="tiny"><b>{e.ticketsSold}</b> sold. Code <b>{e.code}</b></span></div>
        )}
        {canManage && (
          <div className="row">
            {e.ticketed && <Button small onClick={onTickets}>Tickets and sales</Button>}
            {e.rsvp && <Button small kind="ghost" onClick={onReplies}>Who is coming</Button>}
            {!cancelled && <Button small kind="ghost" onClick={onEdit}>Edit</Button>}
            {!cancelled && <Button small kind="ghost" onClick={onCancel}>Cancel event</Button>}
          </div>
        )}
      </div>
    </section>
  );
}

export function Events() {
  const s = useSession();
  const toast = useToast();
  const [tab, setTab] = useState<'up' | 'past'>('up');
  const list = useAsync<any[]>(() => api.get('/events' + s.qs({ branch: undefined, past: tab === 'past' ? '1' : undefined })), [s.grant.org.id, tab]);
  const [mode, setMode] = useState<'list' | 'form'>('list');
  const [editing, setEditing] = useState<any>(null);
  const [cancelling, setCancelling] = useState<any>(null);
  const [replies, setReplies] = useState<any>(null);
  const [tickets, setTickets] = useState<any>(null);
  const canManage = s.can('events.manage');

  if (mode === 'form') {
    return (
      <div>
        <PageHead title="Events" />
        <EventForm event={editing} onClose={() => setMode('list')} onSaved={(m) => { setMode('list'); toast.show(m); list.reload(); }} />
        {toast.node}
      </div>
    );
  }
  return (
    <div>
      <PageHead title="Events" sub="Things happening at your church. Members see them in the member app." action={canManage ? <Button onClick={() => { setEditing(null); setMode('form'); }}>New event</Button> : undefined} />
      <div className="stack">
        <div className="chips" role="tablist">
          <button type="button" className={`chip ${tab === 'up' ? 'on' : ''}`} onClick={() => setTab('up')}>Upcoming</button>
          <button type="button" className={`chip ${tab === 'past' ? 'on' : ''}`} onClick={() => setTab('past')}>Past</button>
        </div>
        <Load loading={list.loading} error={list.error} hasData={!!list.data}>
          {list.data && (list.data.length === 0
            ? <Empty>{tab === 'past' ? 'No past events.' : `No upcoming events.${canManage ? ' Create your first one.' : ''}`}</Empty>
            : <div>{list.data.map((e) => <EventCard key={e.id} e={e} canManage={canManage} onEdit={() => { setEditing(e); setMode('form'); }} onCancel={() => setCancelling(e)} onReplies={() => setReplies(e)} onTickets={() => setTickets(e)} />)}</div>)}
        </Load>
      </div>
      {cancelling && <CancelDialog event={cancelling} onClose={() => setCancelling(null)} onDone={(m) => { setCancelling(null); toast.show(m); list.reload(); }} />}
      {tickets && <TicketPanel event={tickets} onClose={() => setTickets(null)} />}
      {replies && <Replies event={replies} onClose={() => setReplies(null)} />}
      {toast.node}
    </div>
  );
}
