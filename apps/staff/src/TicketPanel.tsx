import { useEffect, useState } from 'react';
import { Badge, Button, Empty, ErrorNote, Field, Note, Table, kes, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Load } from './bits';
import { Modal } from './MemberForm';
import './tickets.css';

const STATUS: Record<string, { text: string; tone: 'good' | 'bad' | 'info' }> = { valid: { text: 'Valid', tone: 'info' }, used: { text: 'Checked in', tone: 'good' }, cancelled: { text: 'Cancelled', tone: 'bad' } };
const when = (iso: string) => new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function CancelTicket({ t, onClose, onDone }: { t: any; onClose: () => void; onDone: (m: string) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    if (!reason.trim()) return setErr('Write a reason. The buyer will see it.');
    setBusy(true); setErr('');
    try { await api.post(`/tickets/${t.id}/cancel`, { reason: reason.trim() }); onDone('Ticket cancelled'); }
    catch (e: any) { setErr(friendly(e.message)); setBusy(false); }
  };
  return (
    <Modal title="Cancel this ticket?" onClose={onClose}>
      <div className="stack">
        <div><b>{t.serial}</b> for {t.holder}, {t.type}</div>
        <Note>The buyer is told and the ticket stops working. If they paid, arrange the refund through Payment help.</Note>
        <Field label="Why is it cancelled?" hint="The buyer will see this."><textarea rows={3} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row"><Button kind="danger" disabled={busy} onClick={go}>{busy ? 'Cancelling...' : 'Cancel ticket'}</Button><Button kind="ghost" onClick={onClose}>Keep ticket</Button></div>
      </div>
    </Modal>
  );
}

function Attendees({ event, types, toast }: { event: any; types: any[]; toast: (m: string, tone?: 'good' | 'bad') => void }) {
  const s = useSession();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [cancelling, setCancelling] = useState<any>(null);
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const list = useAsync<any[]>(() => api.get(`/events/${event.id}/attendees` + s.qs({ branch: undefined, q: dq || undefined, status: status || undefined, type: type || undefined })), [event.id, dq, status, type]);
  const resend = async (t: any) => {
    try { await api.post(`/tickets/orders/${t.orderId}/resend`); toast('Tickets sent again'); } catch (e: any) { toast(friendly(e.message), 'bad'); }
  };
  const csv = () => window.open(api.url(`/events/${event.id}/attendees?format=csv`), '_blank');
  return (
    <div className="stack">
      <div className="row between"><h3 style={{ margin: 0 }}>Attendees</h3><Button small kind="ghost" onClick={csv}>Download CSV</Button></div>
      <input aria-label="Search attendees" placeholder="Search by name, ticket number or order" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="chips">
        {([['', 'All'], ['valid', 'Valid'], ['used', 'Checked in'], ['cancelled', 'Cancelled']] as const).map(([k, t]) => (
          <button key={k} type="button" className={`chip ${status === k ? 'on' : ''}`} onClick={() => setStatus(k)}>{t}</button>
        ))}
      </div>
      {types.length > 1 && (
        <select aria-label="Ticket type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All ticket types</option>
          {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      )}
      <Load loading={list.loading} error={list.error} hasData={!!list.data}>
        {list.data && (list.data.length === 0 ? <Empty>No tickets match.</Empty> : (
          <div className="tk-scroll">
            <Table head={['Ticket', 'Name', 'Type', 'Status', 'Order', '']}>
              {list.data.map((t) => {
                const st = STATUS[t.status] ?? { text: t.status, tone: 'info' as const };
                return (
                  <tr key={t.id}>
                    <td className="mono">{t.serial}</td>
                    <td>{t.holder}<div className="tiny">{t.email}</div></td>
                    <td>{t.type}</td>
                    <td>
                      <Badge tone={st.tone}>{st.text}</Badge>
                      {t.checkedInAt && <div className="tiny">{when(t.checkedInAt)}{t.checkedInBy ? ` by ${t.checkedInBy}` : ''}</div>}
                      {t.cancelReason && <div className="tiny">{t.cancelReason}</div>}
                    </td>
                    <td className="mono">{t.orderCode}</td>
                    <td>
                      <div className="row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                        {t.status === 'valid' && <Button small kind="ghost" onClick={() => setCancelling(t)}>Cancel ticket</Button>}
                        <Button small kind="ghost" onClick={() => resend(t)}>Send tickets again</Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </Table>
          </div>
        ))}
      </Load>
      {cancelling && <CancelTicket t={cancelling} onClose={() => setCancelling(null)} onDone={(m) => { setCancelling(null); toast(m); list.reload(); }} />}
    </div>
  );
}

export function TicketPanel({ event, onClose }: { event: any; onClose: () => void }) {
  const s = useSession();
  const toast = useToast();
  const d = useAsync<any>(() => api.get(`/events/${event.id}/tickets` + s.qs({ branch: undefined })), [event.id]);
  const copy = async (url: string) => {
    try { await navigator.clipboard.writeText(url); toast.show('Link copied'); } catch { toast.show('Could not copy. Select the link and copy it.', 'bad'); }
  };
  const t = d.data;
  return (
    <Modal title={`Tickets and sales: ${event.title}`} onClose={onClose}>
      <div className="stack">
        <Load loading={d.loading} error={d.error} hasData={!!t}>
          {t && (
            <>
              {!t.ticketed && <Note tone="warn">This event does not sell tickets at the moment.</Note>}
              <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
                {t.hasPoster && <div className="tk-thumb" style={{ backgroundImage: `url("${api.url(t.posterUrl)}")` }} role="img" aria-label="Poster" />}
                <div className="stack" style={{ gap: 4 }}>
                  <div><b>{t.totals.sold}</b> sold{t.totals.held > 0 ? `, ${t.totals.held} held while people pay` : ''}</div>
                  <div>Takings: <b>{kes(t.totals.takings)}</b> <span className="tiny">from {t.totals.orders} {t.totals.orders === 1 ? 'order' : 'orders'}. Service fees paid by buyers are not included.</span></div>
                  <div>Checked in {t.totals.checkedIn} of {t.totals.sold}</div>
                </div>
              </div>
              {t.shareUrl && (
                <div className="stack" style={{ gap: 6 }}>
                  <div className="tiny">Share this link to sell tickets to anyone, or use it in an advert. Code: <b>{t.code}</b></div>
                  <div className="tk-link"><code>{t.shareUrl}</code><Button small kind="ghost" onClick={() => copy(t.shareUrl)}>Copy</Button></div>
                </div>
              )}
              <div className="stack" style={{ gap: 12 }}>
                {t.types.map((x: any) => {
                  const pct = Math.min(100, Math.round(((x.sold + x.held) / Math.max(1, x.quantity)) * 100));
                  return (
                    <div className="tk-type" key={x.id}>
                      <div className="row between">
                        <b>{x.name} <span className="tiny">{x.price > 0 ? kes(x.price) : 'Free'}</span></b>
                        <span className="row" style={{ gap: 6 }}>{!x.active && <Badge tone="muted">Off</Badge>}{x.active && !x.onSale && <Badge tone="warn">Not on sale now</Badge>}</span>
                      </div>
                      <div className="progress" aria-label={`${pct}% taken`}><i style={{ width: `${Math.max(pct, 2)}%` }} /></div>
                      <div className="tiny">{x.sold} sold{x.held > 0 ? `, ${x.held} held` : ''} of {x.quantity}. {x.left} left. Takings {kes(x.takings)}. Checked in {x.checkedIn} of {x.sold}.</div>
                    </div>
                  );
                })}
              </div>
              <Attendees event={event} types={t.types} toast={toast.show} />
            </>
          )}
        </Load>
      </div>
      {toast.node}
    </Modal>
  );
}
