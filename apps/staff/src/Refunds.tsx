import { useState } from 'react';
import { Button, ErrorNote, Field, Note, kes, useAsync } from '@churchos/ui';
import { api, friendly, methodLabel, useSession } from './session';
import { Modal } from './MemberForm';
import { Skeleton, StatusChip } from './ui';
import './tickets.css';

const when = (iso: string) => new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const KIND: Record<string, string> = { buyer: 'Cancelled by buyer', postponed: 'After postponement', church: 'Church refund' };
const STATE: Record<string, { text: string; tone: 'done' | 'bad' | 'info' | 'wait' }> = {
  pending: { text: 'Waiting', tone: 'wait' }, approved: { text: 'Approved', tone: 'info' }, refunded: { text: 'Refunded', tone: 'done' }, declined: { text: 'Declined', tone: 'bad' }, failed: { text: 'Failed', tone: 'bad' },
};

function Decide({ r, approve, onClose, onDone }: { r: any; approve: boolean; onClose: () => void; onDone: (m: string) => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    if (!approve && !note.trim()) return setErr('Write why you are declining. The buyer will see it.');
    setBusy(true); setErr('');
    try { await api.post(`/refund-requests/${r.id}/decide`, { approve, ...(note.trim() ? { note: note.trim() } : {}) }); onDone(approve ? 'Approved. ChurchOS will send the money back.' : 'Request declined. The buyer is told.'); }
    catch (e: any) { setErr(friendly(e.message)); setBusy(false); }
  };
  return (
    <Modal title={approve ? 'Approve this refund?' : 'Decline this refund?'} onClose={onClose}>
      <div className="stack">
        <div><b>{r.buyer}</b>, order <span className="mono">{r.orderCode}</span>, {r.tickets} {r.tickets === 1 ? 'ticket' : 'tickets'}, {kes(r.total)}</div>
        {r.reason && <div className="tiny">Their reason: {r.reason}</div>}
        {approve
          ? <Note tone="warn">This cancels their tickets and asks ChurchOS to send {kes(r.total)} back to the buyer. You cannot undo this.</Note>
          : <Field label="Why are you declining?" hint="The buyer will see this."><textarea rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>}
        {approve && <Field label="Note to the buyer" hint="Optional"><textarea rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>}
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row"><Button kind={approve ? 'primary' : 'danger'} disabled={busy} onClick={go}>{busy ? 'Saving...' : approve ? `Approve and refund ${kes(r.total)}` : 'Decline request'}</Button><Button kind="ghost" onClick={onClose}>Back</Button></div>
      </div>
    </Modal>
  );
}

/** Pending requests on top, earlier ones collapsed. */
export function RefundRequests({ event, onChanged, toast }: { event: any; onChanged: () => void; toast: (m: string, tone?: 'good' | 'bad') => void }) {
  const s = useSession();
  const d = useAsync<any>(() => api.get(`/events/${event.id}/refund-requests` + s.qs({ branch: undefined })), [event.id]);
  const [dec, setDec] = useState<{ r: any; approve: boolean } | null>(null);
  const list: any[] = d.data?.requests ?? [];
  const pending = list.filter((r) => r.status === 'pending');
  const earlier = list.filter((r) => r.status !== 'pending');
  if (!d.data) return d.loading ? <Skeleton height={56} /> : d.error ? <ErrorNote>{friendly(d.error)}</ErrorNote> : null;
  if (list.length === 0) return null;
  const done = (m: string) => { setDec(null); toast(m); d.reload(); onChanged(); };
  return (
    <div className="stack">
      {event.status === 'postponed' && <div className="tiny">Buyers see the choice to keep their money as event credit above the refund option.</div>}
      {pending.length > 0 && (
        <div className="stack tk-refunds">
          <div className="row"><h3 style={{ margin: 0 }}>Refund requests</h3><span className="tk-count" aria-label={`${pending.length} waiting`}>{pending.length}</span></div>
          {pending.map((r) => (
            <div className="tk-req" key={r.id}>
              <div className="row between" style={{ alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}><b style={{ overflowWrap: 'anywhere' }}>{r.buyer}</b> <span className="tiny mono">{r.orderCode}</span></div>
                <b>{kes(r.total)}</b>
              </div>
              <div className="row"><StatusChip tone={r.kind === 'postponed' ? 'wait' : 'info'}>{KIND[r.kind] ?? r.kind}</StatusChip><span className="tiny">{r.tickets} {r.tickets === 1 ? 'ticket' : 'tickets'}. {methodLabel(r.method)}. Asked {when(r.requestedAt)}</span></div>
              {r.reason && <div style={{ overflowWrap: 'anywhere' }}>&ldquo;{r.reason}&rdquo;</div>}
              <div className="row"><Button small onClick={() => setDec({ r, approve: true })}>Approve</Button><Button small kind="ghost" onClick={() => setDec({ r, approve: false })}>Decline</Button></div>
            </div>
          ))}
        </div>
      )}
      {earlier.length > 0 && (
        <details className="tk-earlier">
          <summary><b>Earlier requests ({earlier.length})</b></summary>
          <div className="stack" style={{ marginTop: 8 }}>
            {earlier.map((r) => {
              const st = STATE[r.status] ?? { text: r.status, tone: 'info' as const };
              return (
                <div className="tk-req" key={r.id}>
                  <div className="row between" style={{ alignItems: 'flex-start' }}><div style={{ minWidth: 0 }}><b style={{ overflowWrap: 'anywhere' }}>{r.buyer}</b> <span className="tiny mono">{r.orderCode}</span></div><b>{kes(r.total)}</b></div>
                  <div className="row"><StatusChip tone={st.tone}>{st.text}</StatusChip><StatusChip tone="off">{KIND[r.kind] ?? r.kind}</StatusChip><span className="tiny">{r.decidedAt ? `${r.decidedBy ? `${r.decidedBy}, ` : ''}${when(r.decidedAt)}` : when(r.requestedAt)}</span></div>
                  {r.money && <div className="tiny"><b>{r.money}</b></div>}
                  {r.note && <div className="tiny">Note: {r.note}</div>}
                </div>
              );
            })}
          </div>
        </details>
      )}
      {dec && <Decide r={dec.r} approve={dec.approve} onClose={() => setDec(null)} onDone={done} />}
    </div>
  );
}

export function CreditOrder({ o, note, setNote, busy, err, onClose, onGo }: { o: { buyer?: string; code?: string; tickets?: number; total?: number }; note: string; setNote: (v: string) => void; busy: boolean; err: string; onClose: () => void; onGo: () => void }) {
  return (
    <Modal title="Give credit for this order?" onClose={onClose}>
      <div className="stack">
        <div>{o.buyer && <b>{o.buyer}</b>}{o.code && <>, order <span className="mono">{o.code}</span></>}{o.tickets != null && <>, {o.tickets} {o.tickets === 1 ? 'ticket' : 'tickets'}</>}</div>
        <Note>The ticket money (not the service fee) becomes event credit for the buyer, kept by the church, with no expiry. Their tickets are cancelled and nobody is charged or refunded. You cannot undo this.</Note>
        <Field label="Note to the buyer" hint="Optional"><textarea rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row"><Button disabled={busy} onClick={onGo}>{busy ? 'Working...' : 'Give credit'}</Button><Button kind="ghost" onClick={onClose}>Back</Button></div>
      </div>
    </Modal>
  );
}

/** For a cancelled event: orders still to refund, one by one or all together. */
export function RefundsToArrange({ event, refunds, onChanged, toast }: { event: any; refunds: any[]; onChanged: () => void; toast: (m: string, tone?: 'good' | 'bad') => void }) {
  const s = useSession();
  const [busy, setBusy] = useState('');
  const [confirmAll, setConfirmAll] = useState(false);
  const [one, setOne] = useState<any>(null);
  const [results, setResults] = useState<{ refunded: number; failed: { orderId: string; message: string }[] } | null>(null);
  const [err, setErr] = useState('');
  const [creditAll, setCreditAll] = useState(false);
  const [creditOne, setCreditOne] = useState<any>(null);
  const [cnote, setCnote] = useState('');
  const [cresult, setCresult] = useState<{ credited: number; amount: number; skipped: { orderId: string; message: string }[] } | null>(null);
  const credit = async (key: string, path: string, body: any) => {
    setBusy(key); setErr('');
    try {
      const r: any = await api.post(path + s.qs({ branch: undefined }), body);
      if (key === 'all') { setCresult({ credited: r?.credited ?? 0, amount: r?.amount ?? 0, skipped: r?.skipped ?? [] }); toast(`${r?.credited ?? 0} ${(r?.credited ?? 0) === 1 ? 'order' : 'orders'} turned into credit`); }
      else toast(`Turned into credit: ${kes(r?.amount ?? 0)}`);
      setCreditAll(false); setCreditOne(null); setCnote('');
      onChanged();
    } catch (e: any) { setErr(friendly(e.message)); } finally { setBusy(''); }
  };
  const total = refunds.reduce((a, r) => a + Number(r.total ?? 0), 0);
  const run = async (key: string, path: string) => {
    setBusy(key); setErr('');
    try {
      const r: any = await api.post(path + s.qs({ branch: undefined }), {});
      setResults({ refunded: r?.refunded ?? 0, failed: r?.failed ?? [] });
      toast(r?.failed?.length ? `${r.refunded ?? 0} refunded, ${r.failed.length} failed` : `${r?.refunded ?? 1} ${(r?.refunded ?? 1) === 1 ? 'order' : 'orders'} refunded`, r?.failed?.length ? 'bad' : 'good');
      setConfirmAll(false); setOne(null);
      onChanged();
    } catch (e: any) { setErr(friendly(e.message)); } finally { setBusy(''); }
  };
  return (
    <div className="stack tk-refunds">
      <h3 style={{ margin: 0 }}>Refunds to arrange</h3>
      {refunds.length > 0 && (
        <>
          <Note>Buyers are told they can keep their money as credit. Wait a few days for their choice before refunding everyone if you prefer. Amounts below include the service fee; credit is the ticket money only.</Note>
          <div className="row">
            <Button disabled={!!busy} onClick={() => { setErr(''); setCreditAll(true); }}>Give everyone credit ({refunds.length} {refunds.length === 1 ? 'order' : 'orders'})</Button>
            <Button kind="danger" disabled={!!busy} onClick={() => { setErr(''); setConfirmAll(true); }}>Refund everyone instead</Button>
          </div>
        </>
      )}
      {cresult && (
        <Note tone={cresult.skipped.length ? 'warn' : undefined}>
          {cresult.credited} {cresult.credited === 1 ? 'order' : 'orders'} turned into credit, {kes(cresult.amount)}.
          {cresult.skipped.length > 0 && <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{cresult.skipped.map((f, i) => <li key={i}>{f.message}</li>)}</ul>}
        </Note>
      )}
      {refunds.length === 0 && <div className="tiny">No paid orders are waiting for a refund.</div>}
      {refunds.map((r) => (
        <div className="tk-req" key={r.orderId}>
          <div className="row between" style={{ alignItems: 'flex-start' }}><div style={{ minWidth: 0 }}><b style={{ overflowWrap: 'anywhere' }}>{r.buyer}</b> <span className="tiny mono">{r.code}</span></div><b>{kes(r.total)}</b></div>
          <div className="row between"><span className="tiny">{r.tickets} {r.tickets === 1 ? 'ticket' : 'tickets'}. Paid with {methodLabel(r.method)}</span><span className="row" style={{ gap: 6 }}><Button small disabled={!!busy} onClick={() => { setErr(''); setCnote(''); setCreditOne(r); }}>Give credit</Button><Button small kind="ghost" disabled={!!busy} onClick={() => setOne(r)}>Refund</Button></span></div>
        </div>
      ))}
      {results && (
        <Note tone={results.failed.length ? 'warn' : undefined}>
          {results.refunded} {results.refunded === 1 ? 'order' : 'orders'} sent to ChurchOS to pay back.
          {results.failed.length > 0 && <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{results.failed.map((f, i) => <li key={i}>{f.message}</li>)}</ul>}
        </Note>
      )}
      {err && !confirmAll && !one && !creditAll && !creditOne && <ErrorNote>{err}</ErrorNote>}
      {creditAll && (
        <Modal title="Give everyone credit?" onClose={() => setCreditAll(false)}>
          <div className="stack">
            <Note>Turn {refunds.length} paid {refunds.length === 1 ? 'order' : 'orders'} into event credit? The service fee is not part of credit. Buyers keep their money with the church and can use it on any event. Nobody is charged and no refund is sent. Orders already refunded are left alone.</Note>
            {err && <ErrorNote>{err}</ErrorNote>}
            <div className="row"><Button disabled={!!busy} onClick={() => credit('all', `/events/${event.id}/credit-all`, {})}>{busy ? 'Working...' : 'Give credit'}</Button><Button kind="ghost" onClick={() => setCreditAll(false)}>Back</Button></div>
          </div>
        </Modal>
      )}
      {creditOne && (
        <CreditOrder o={creditOne} note={cnote} setNote={setCnote} busy={!!busy} err={err} onClose={() => setCreditOne(null)} onGo={() => credit(creditOne.orderId, `/events/${event.id}/orders/${creditOne.orderId}/credit`, cnote.trim() ? { note: cnote.trim() } : {})} />
      )}
      {confirmAll && (
        <Modal title="Refund everyone?" onClose={() => setConfirmAll(false)}>
          <div className="stack">
            <Note tone="warn">This asks ChurchOS to send {kes(total)} back to {refunds.length} {refunds.length === 1 ? 'buyer' : 'buyers'}. You cannot undo this.</Note>
            {err && <ErrorNote>{err}</ErrorNote>}
            <div className="row"><Button kind="danger" disabled={!!busy} onClick={() => run('all', `/events/${event.id}/refund-all`)}>{busy ? 'Refunding...' : `Refund ${refunds.length} ${refunds.length === 1 ? 'order' : 'orders'}`}</Button><Button kind="ghost" onClick={() => setConfirmAll(false)}>Back</Button></div>
          </div>
        </Modal>
      )}
      {one && (
        <Modal title="Refund this order?" onClose={() => setOne(null)}>
          <div className="stack">
            <div><b>{one.buyer}</b>, order <span className="mono">{one.code}</span>, {one.tickets} {one.tickets === 1 ? 'ticket' : 'tickets'}</div>
            <Note tone="warn">This asks ChurchOS to send {kes(one.total)} back to the buyer. You cannot undo this.</Note>
            {err && <ErrorNote>{err}</ErrorNote>}
            <div className="row"><Button kind="danger" disabled={!!busy} onClick={() => run(one.orderId, `/events/${event.id}/orders/${one.orderId}/refund`)}>{busy ? 'Refunding...' : `Refund ${kes(one.total)}`}</Button><Button kind="ghost" onClick={() => setOne(null)}>Back</Button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}
