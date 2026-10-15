import { useState } from 'react';
import { Badge, Button, Empty, ErrorNote, Field, Note, kes, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Load, PageHead } from './bits';
import { Modal } from './MemberForm';
import { eat } from './Resources';
import './bookings.css';

const ITEM: Record<string, { text: string; tone: 'warn' | 'good' | 'bad' }> = { requested: { text: 'Waiting', tone: 'warn' }, approved: { text: 'Approved', tone: 'good' }, declined: { text: 'Declined', tone: 'bad' } };
const STATUS: Record<string, { text: string; tone: 'warn' | 'good' | 'bad' | 'info' | 'muted' }> = {
  requested: { text: 'Waiting for an answer', tone: 'warn' }, awaiting_payment: { text: 'Waiting for payment', tone: 'info' }, confirmed: { text: 'Confirmed', tone: 'good' },
  declined: { text: 'Declined', tone: 'bad' }, cancelled: { text: 'Cancelled', tone: 'muted' }, completed: { text: 'Done', tone: 'good' }, no_show: { text: 'No show', tone: 'bad' }, lapsed: { text: 'Not paid in time', tone: 'muted' },
};
const TABS = { need: 'requested', up: 'confirmed,awaiting_payment', past: 'completed,no_show,declined,cancelled,lapsed' } as const;
type Tab = keyof typeof TABS;

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

function BookingCard({ b, canManage, onApprove, onDecline, onCancel, onComplete }: { b: any; canManage: boolean; onApprove: (it: any) => void; onDecline: (it: any) => void; onCancel: () => void; onComplete: (o: 'completed' | 'no_show') => void }) {
  const st = STATUS[b.status] ?? { text: b.status, tone: 'muted' as const };
  const started = Date.parse(b.startsAt) <= Date.now();
  const open = ['requested', 'awaiting_payment', 'confirmed'].includes(b.status);
  const canComplete = canManage && b.status === 'confirmed' && started;
  const canCancel = !!b.canCancel && open;
  return (
    <section className="card bk-card">
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}><b>{b.title}</b><div className="tiny">{whenText(b)}</div></div>
        <Badge tone={st.tone}>{st.text}</Badge>
      </div>
      <div className="tiny">Asked by {b.requester}{b.attendees ? `. ${b.attendees} ${b.attendees === 1 ? 'person' : 'people'}` : ''}. Code {b.code}.</div>
      <div className="bk-items">
        {b.items.map((it: any) => {
          const s = ITEM[it.status] ?? ITEM.requested;
          return (
            <div className="bk-item" key={it.resourceId}>
              <div style={{ minWidth: 0 }}><b>{it.name}</b> <Badge tone={s.tone}>{s.text}</Badge>{it.status === 'declined' && it.reason && <div className="tiny">{it.reason}</div>}</div>
              {it.mine && it.status === 'requested' && b.status === 'requested' && (
                <div className="row"><Button small onClick={() => onApprove(it)}>Approve</Button><Button small kind="ghost" onClick={() => onDecline(it)}>Decline</Button></div>
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
      {(canComplete || canCancel) && (
        <div className="row">
          {canComplete && <><Button small onClick={() => onComplete('completed')}>Mark as done</Button><Button small kind="ghost" onClick={() => onComplete('no_show')}>No show</Button></>}
          {canCancel && <Button small kind="ghost" onClick={onCancel}>Cancel booking</Button>}
        </div>
      )}
    </section>
  );
}

export function Bookings() {
  const s = useSession();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('need');
  const q = (t: Tab): Promise<any[]> => api.get(`/bookings${s.qs({ branch: undefined, status: TABS[t] })}`);
  const need = useAsync<any[]>(() => q('need'), [s.grant.org.id]);
  const other = useAsync<any[]>(() => (tab === 'need' ? Promise.resolve([]) : q(tab)), [s.grant.org.id, tab]);
  const [deciding, setDeciding] = useState<{ b: any; it: any } | null>(null);
  const [cancelling, setCancelling] = useState<any>(null);
  const canManage = s.can('bookings.manage');
  const needing = (need.data ?? []).filter((b) => b.status === 'requested' && b.items.some((i: any) => i.mine && i.status === 'requested'));
  const reload = () => { need.reload(); other.reload(); };
  const post = async (path: string, body: any, msg: string) => {
    try { await api.post(path + s.qs({ branch: undefined }), body); toast.show(msg); reload(); } catch (e: any) { toast.show(explain(e)); }
  };

  const d = tab === 'need'
    ? { loading: need.loading, error: need.error, data: need.data ? needing : undefined }
    : { loading: other.loading, error: other.error, data: other.data ? (tab === 'up' ? [...other.data].reverse() : other.data) : undefined };
  return (
    <div>
      <PageHead title="Bookings" sub="Requests to use a place, a person's time or something your church owns." />
      <div className="stack">
        <div className="chips" role="tablist">
          <button type="button" className={`chip ${tab === 'need' ? 'on' : ''}`} onClick={() => setTab('need')}>Needs an answer{needing.length > 0 && <span className="bk-count">{needing.length}</span>}</button>
          <button type="button" className={`chip ${tab === 'up' ? 'on' : ''}`} onClick={() => setTab('up')}>Coming up</button>
          <button type="button" className={`chip ${tab === 'past' ? 'on' : ''}`} onClick={() => setTab('past')}>Past and closed</button>
        </div>
        <div className="tiny">Notes are private. Only people who answer a request can read them.</div>
        <Load loading={d.loading} error={d.error} hasData={!!d.data}>
          {d.data && (d.data.length === 0
            ? <Empty>{tab === 'need' ? 'Nothing is waiting for you.' : tab === 'up' ? 'No bookings coming up.' : 'No past bookings.'}</Empty>
            : <div>{d.data.map((b) => (
              <BookingCard key={b.id} b={b} canManage={canManage}
                onApprove={(it) => post(`/bookings/${b.id}/items/${it.resourceId}/decide`, { approve: true, reason: '' }, `Approved ${it.name}`)}
                onDecline={(it) => setDeciding({ b, it })} onCancel={() => setCancelling(b)}
                onComplete={(o) => post(`/bookings/${b.id}/complete`, { outcome: o }, o === 'completed' ? 'Marked as done' : 'Marked as no show')} />
            ))}</div>)}
        </Load>
      </div>
      {deciding && (
        <ReasonDialog title={`Decline ${deciding.it.name}?`} label="Why not?" button="Decline" onClose={() => setDeciding(null)}
          run={async (reason) => { await api.post(`/bookings/${deciding.b.id}/items/${deciding.it.resourceId}/decide` + s.qs({ branch: undefined }), { approve: false, reason }); setDeciding(null); toast.show('Declined'); reload(); }} />
      )}
      {cancelling && (
        <ReasonDialog title="Cancel this booking?" note="The member is told. If they paid, arrange any refund through Payment help." label="Why is it cancelled?" button="Cancel booking" onClose={() => setCancelling(null)}
          run={async (reason) => { await api.post(`/bookings/${cancelling.id}/cancel` + s.qs({ branch: undefined }), { reason }); setCancelling(null); toast.show('Booking cancelled'); reload(); }} />
      )}
      {toast.node}
    </div>
  );
}
