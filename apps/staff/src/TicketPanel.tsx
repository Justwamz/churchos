import { useEffect, useState } from 'react';
import { Button, ErrorNote, Field, Note, Table, kes, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Modal } from './MemberForm';
import { CreditOrder, RefundRequests, RefundsToArrange } from './Refunds';
import { EmptyState, SidePanel, Skeleton, Stat, StatTiles, StatusChip } from './ui';
import './tickets.css';
import './worship.css';

function Load({ loading, error, hasData, children }: { loading: boolean; error?: string; hasData: boolean; children: React.ReactNode }) {
  if (error && !hasData) return <ErrorNote>{friendly(error)}</ErrorNote>;
  if (loading && !hasData) return <Skeleton rows={3} height={72} />;
  return <>{error && <ErrorNote>{friendly(error)}</ErrorNote>}{children}</>;
}

const STATUS: Record<string, { text: string; tone: 'done' | 'bad' | 'info' }> = { valid: { text: 'Valid', tone: 'info' }, used: { text: 'Checked in', tone: 'done' }, cancelled: { text: 'Cancelled', tone: 'bad' } };
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

function Attendees({ event, types, toast, canCredit, onChanged }: { event: any; types: any[]; canCredit: boolean; onChanged: () => void; toast: (m: string, tone?: 'good' | 'bad') => void }) {
  const s = useSession();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [cancelling, setCancelling] = useState<any>(null);
  const [crediting, setCrediting] = useState<any>(null);
  const [cnote, setCnote] = useState('');
  const [cbusy, setCbusy] = useState(false);
  const [cerr, setCerr] = useState('');
  const moveToCredit = async () => {
    setCbusy(true); setCerr('');
    try {
      const r: any = await api.post(`/events/${event.id}/orders/${crediting.orderId}/credit`, cnote.trim() ? { note: cnote.trim() } : {});
      toast(`Turned into credit: ${kes(r?.amount ?? 0)}`); setCrediting(null); setCnote(''); list.reload(); onChanged();
    } catch (e: any) { setCerr(friendly(e.message)); } finally { setCbusy(false); }
  };
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const list = useAsync<any[]>(() => api.get(`/events/${event.id}/attendees` + s.qs({ branch: undefined, q: dq || undefined, status: status || undefined, type: type || undefined })), [event.id, dq, status, type]);
  const resend = async (t: any) => {
    try { await api.post(`/tickets/orders/${t.orderId}/resend`); toast('Tickets sent again'); } catch (e: any) { toast(friendly(e.message), 'bad'); }
  };
  const csv = () => window.open(api.url(`/events/${event.id}/attendees?format=csv`), '_blank');
  return (
    <div className="stack">
      <div className="row between" style={{ marginTop: 8 }}><h3 style={{ margin: 0 }}>Attendees</h3><Button small kind="ghost" onClick={csv}>Download CSV</Button></div>
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
        {list.data && (list.data.length === 0 ? <EmptyState icon="receipt" title="No tickets match" /> : (
          <div className="tk-scroll">
            <Table className="tk-att" head={['Ticket', 'Name', 'Type', 'Status', 'Order', '']}>
              {list.data.map((t) => {
                const st = STATUS[t.status] ?? { text: t.status, tone: 'info' as const };
                return (
                  <tr key={t.id}>
                    <td className="mono">{t.serial}</td>
                    <td>{t.holder}<div className="tiny">{t.email}</div></td>
                    <td>{t.type}</td>
                    <td>
                      <StatusChip tone={st.tone}>{st.text}</StatusChip>
                      {t.checkedInAt && <div className="tiny">{when(t.checkedInAt)}{t.checkedInBy ? ` by ${t.checkedInBy}` : ''}</div>}
                      {t.cancelReason && <div className="tiny">{t.cancelReason}</div>}
                    </td>
                    <td className="mono">{t.orderCode}</td>
                    <td>
                      <div className="row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                        {t.status === 'valid' && <Button small kind="ghost" onClick={() => setCancelling(t)}>Cancel ticket</Button>}
                        {canCredit && t.status === 'valid' && <Button small kind="ghost" onClick={() => { setCerr(''); setCnote(''); setCrediting(t); }}>Move to credit</Button>}
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
      {crediting && <CreditOrder o={{ buyer: crediting.holder, code: crediting.orderCode }} note={cnote} setNote={setCnote} busy={cbusy} err={cerr} onClose={() => setCrediting(null)} onGo={moveToCredit} />}
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
  const cr = useAsync<any>(() => api.get(`/events/${event.id}/credit` + s.qs({ branch: undefined })), [event.id]);
  const [ver, setVer] = useState(0);
  const reloadAll = () => { d.reload(); cr.reload(); setVer((n) => n + 1); };
  const t = d.data;
  const ci = cr.data?.issued, cp = cr.data?.paidWithCredit;
  return (
    <SidePanel title={event.title} subtitle="Tickets and sales" onClose={onClose} width={720}>
      <div className="stack">
        <Load loading={d.loading} error={d.error} hasData={!!t}>
          {t && (
            <>
              {!t.ticketed && <Note tone="warn">This event does not sell tickets at the moment.</Note>}
              {t.status === 'cancelled' && (
                <Note tone="warn">This event was cancelled{t.cancelReason ? `: ${t.cancelReason}` : ''}. Buyers have been told.</Note>
              )}
              {t.status === 'postponed' && (
                <Note tone="warn"><b>Postponed. Date to be confirmed.</b>{t.postponed?.note ? ` ${t.postponed.note}` : ''} Buyers keep their tickets. Check-in is closed until you set a new date.{t.postponed?.refundUntil ? ` Buyers can ask for a refund until ${when(t.postponed.refundUntil)}.` : ''}</Note>
              )}
              {t.status === 'scheduled' && t.postponed && (
                <Note tone="warn"><b>Postponed{t.postponed.from ? `, moved from ${when(t.postponed.from)}` : ''}.</b>{t.postponed.note ? ` ${t.postponed.note}` : ''}{t.postponed.refundUntil ? ` Buyers can ask for a refund until ${when(t.postponed.refundUntil)}.` : ''}</Note>
              )}
              {t.status !== 'cancelled' && <RefundRequests event={event} toast={toast.show} onChanged={reloadAll} />}
              {t.status === 'cancelled' && <RefundsToArrange event={event} refunds={t.refunds ?? []} toast={toast.show} onChanged={reloadAll} />}
              {cr.data && (ci?.orders > 0 || cp?.orders > 0) && (
                <div className="tk-req"><b>Event credit</b>
                  <div className="tiny">{ci?.orders > 0 ? `${ci.orders} ${ci.orders === 1 ? 'order' : 'orders'} turned into credit (${kes(ci.amount)}), ${kes(ci.spent)} of it already spent. ` : ''}{cp?.orders > 0 ? `${cp.orders} ${cp.orders === 1 ? 'order was' : 'orders were'} paid with credit (${kes(cp.amount)}).` : ''}</div>
                </div>
              )}
              {t.ticketed && t.status !== 'cancelled' && <div className="tiny">{t.refundDaysBefore != null ? `Buyers can ask for a refund until ${t.refundDaysBefore} ${t.refundDaysBefore === 1 ? 'day' : 'days'} before.` : 'No refunds before the event.'}</div>}
              {t.hasPoster && <div className="tk-thumb" style={{ backgroundImage: `url("${api.url(t.posterUrl)}")` }} role="img" aria-label="Poster" />}
              <StatTiles>
                <Stat label="Sold" value={t.totals.sold} hint={t.totals.held > 0 ? `${t.totals.held} held while people pay` : undefined} />
                <Stat label="Takings" value={kes(t.totals.takings)} hint={`From ${t.totals.orders} ${t.totals.orders === 1 ? 'order' : 'orders'}. Service fees paid by buyers are not included.`} />
                <Stat label="Checked in" value={`${t.totals.checkedIn} of ${t.totals.sold}`} />
              </StatTiles>
              {t.shareUrl && t.status !== 'cancelled' && (
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
                        <span className="row" style={{ gap: 6 }}>{!x.active && <StatusChip tone="off">Off</StatusChip>}{x.active && !x.onSale && <StatusChip tone="wait">Not on sale now</StatusChip>}</span>
                      </div>
                      <div className="progress" aria-label={`${pct}% taken`}><i style={{ width: `${Math.max(pct, 2)}%` }} /></div>
                      <div className="tiny">{x.sold} sold{x.held > 0 ? `, ${x.held} held` : ''} of {x.quantity}. {x.left} left. Takings {kes(x.takings)}. Checked in {x.checkedIn} of {x.sold}.</div>
                    </div>
                  );
                })}
              </div>
              <Attendees key={ver} event={event} types={t.types} toast={toast.show} canCredit={t.status === 'scheduled' || t.status === 'postponed'} onChanged={reloadAll} />
            </>
          )}
        </Load>
      </div>
      {toast.node}
    </SidePanel>
  );
}
