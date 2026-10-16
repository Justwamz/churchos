import { useState } from 'react';
import { Button, ErrorNote, Field, Note, useAsync } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Modal } from './MemberForm';
import { toIso, toLocal } from './communityBits';
import './tickets.css';

/** Postpone an event, or (when it is already postponed) set the new date. Nobody is refunded automatically. */
export function PostponeDialog({ event, onClose, onDone }: { event: any; onClose: () => void; onDone: (m: string) => void }) {
  const s = useSession();
  const already = event.status === 'postponed';
  const info = useAsync<any>(() => (event.ticketed ? api.get(`/events/${event.id}/tickets` + s.qs({ branch: undefined })) : Promise.resolve(null)), [event.id]);
  const [known, setKnown] = useState(true);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [endTouched, setEndTouched] = useState(false);
  const [note, setNote] = useState('');
  const [days, setDays] = useState('14');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const dur = event.endsAt ? Date.parse(event.endsAt) - Date.parse(event.startsAt) : 0;
  const pickStart = (v: string) => {
    setStart(v);
    if (!endTouched && v && dur > 0) setEnd(toLocal(new Date(Date.parse(toIso(v)) + dur).toISOString()));
  };
  const orders = info.data?.totals?.orders as number | undefined;
  const showDate = already || known;

  const go = async () => {
    setErr('');
    if (showDate) {
      if (!start) return setErr('Choose the new start date and time.');
      if (Date.parse(toIso(start)) < Date.now()) return setErr('The new date must be in the future.');
      if (end && Date.parse(toIso(end)) < Date.parse(toIso(start))) return setErr('The event cannot end before it starts.');
    }
    const d = Number(days);
    if (!already && showDate && event.ticketed && !(days !== '' && Number.isInteger(d) && d >= 0 && d <= 90)) return setErr('Refund window must be from 0 to 90 days.');
    const body: any = {};
    if (showDate) { body.startsAt = toIso(start); if (end) body.endsAt = toIso(end); if (event.ticketed && days !== '') body.refundDays = Number(days); }
    if (note.trim()) body.note = note.trim();
    setBusy(true);
    try {
      const r: any = await api.post(`/events/${event.id}/postpone` + s.qs({ branch: undefined }), body);
      const t = r?.told ?? {};
      const parts = [t.email ? `${t.email} email${t.email === 1 ? '' : 's'}` : '', t.sms ? `${t.sms} SMS` : '', t.app ? `${t.app} in the app` : ''].filter(Boolean);
      const base = r?.status === 'postponed' ? 'Event postponed. The date is to be confirmed.' : 'New date set.';
      onDone(`${base}${t.orders ? ` ${t.orders} ticket ${t.orders === 1 ? 'order' : 'orders'} told` : ''}${parts.length ? ` (${parts.join(', ')})` : ''}${t.rsvp ? `. ${t.rsvp} ${t.rsvp === 1 ? 'reply' : 'replies'} told` : ''}.`);
    } catch (e: any) { setErr(friendly(e.message)); setBusy(false); }
  };

  return (
    <Modal title={already ? 'Set the new date' : 'Postpone this event'} onClose={onClose}>
      <div className="stack">
        <div className="tiny"><b>{event.title}</b>{already ? ' is postponed. Buyers are waiting for the new date.' : ''}</div>
        {!already && (
          <div className="stack" style={{ gap: 8 }}>
            <label className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><input type="radio" name="ppk" checked={known} onChange={() => setKnown(true)} /> <b>I know the new date</b></label>
            <label className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><input type="radio" name="ppk" checked={!known} onChange={() => setKnown(false)} /> <b>The date is not decided yet</b></label>
          </div>
        )}
        {showDate && (
          <div className="tk-grid">
            <Field label="New start" hint="East Africa Time"><input type="datetime-local" value={start} onChange={(e) => pickStart(e.target.value)} /></Field>
            <Field label="New end" hint="Optional. East Africa Time"><input type="datetime-local" value={end} onChange={(e) => { setEnd(e.target.value); setEndTouched(true); }} /></Field>
          </div>
        )}
        <Field label="Tell buyers why" hint={`Optional. ${note.length} of 300 characters`}><textarea rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {event.ticketed && showDate && !already && (
          <Field label="Days buyers can ask for a refund after this change" hint="From 0 to 90"><input inputMode="numeric" style={{ maxWidth: 120 }} value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, '').slice(0, 2))} /></Field>
        )}
        {event.ticketed && (
          <Note>Buyers keep their tickets. Nobody is refunded automatically. Buyers who cannot make it can ask for a refund, and you approve or decline each request.</Note>
        )}
        <div className="tiny">
          {event.ticketed
            ? (orders != null ? `Tell ${orders} ticket ${orders === 1 ? 'buyer' : 'buyers'} by email, SMS and in the app.` : 'Ticket buyers are told by email, SMS and in the app.')
            : 'Everyone who replied is told.'}
          {!already && !known ? ' Tickets are not valid at the door until you set a new date.' : ''}
        </div>
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row"><Button disabled={busy} onClick={go}>{busy ? 'Saving...' : already ? 'Set the new date' : known ? 'Postpone to this date' : 'Postpone, date to be confirmed'}</Button><Button kind="ghost" onClick={onClose}>Close</Button></div>
      </div>
    </Modal>
  );
}
