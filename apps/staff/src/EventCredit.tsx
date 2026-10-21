import { useEffect, useState } from 'react';
import { useLinkParams } from './links';
import { Button, ErrorNote, Field, Note, kes, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Modal } from './MemberForm';
import { Card, EmptyState, PageHeader, Section, SidePanel, Stat, StatTiles, StatusChip, Toolbar } from './ui';
import { Loaded } from './money-bits';
import './event-credit.css';

const kw = (c: number) => kes(c).replace(/\.00$/, '');
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const dayOnly = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', year: 'numeric' }) : '');
const STATE: Record<string, { text: string; tone: 'wait' | 'done' | 'bad' | 'info' | 'off' }> = {
  pending: { text: 'Waiting for you', tone: 'wait' }, approved: { text: 'To pay', tone: 'info' }, paid: { text: 'Paid', tone: 'done' }, declined: { text: 'Declined', tone: 'bad' }, cancelled: { text: 'Cancelled', tone: 'off' },
};
const FILTERS: [string, string][] = [['pending,approved', 'Waiting and to pay'], ['pending', 'Waiting for you'], ['approved', 'To pay'], ['paid', 'Paid'], ['declined', 'Declined'], ['cancelled', 'Cancelled'], ['pending,approved,paid,declined,cancelled', 'All']];

function Decide({ r, approve, onClose, onDone }: { r: any; approve: boolean; onClose: () => void; onDone: (m: string) => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    if (!approve && !note.trim()) return setErr('Write why you are declining. The member will see it.');
    setBusy(true); setErr('');
    try {
      await api.post(`/credit/refunds/${r.id}/decide`, { approve, ...(note.trim() ? { note: note.trim() } : {}) });
      onDone(approve ? 'Approved. Now pay the member and record the payment.' : 'Declined. The credit is back in their balance.');
    } catch (e: any) { setErr(friendly(e.message)); setBusy(false); }
  };
  return (
    <Modal title={approve ? 'Approve this request?' : 'Decline this request?'} onClose={onClose}>
      <div className="stack">
        <div><b>{r.member}</b> asks for {kes(r.amount)} back as money.</div>
        {r.reason && <div className="tiny">Their reason: {r.reason}</div>}
        {approve
          ? <Note>After you approve, pay the member yourself and record the payment here. ChurchOS does not send money.</Note>
          : <Note>The {kes(r.amount)} goes back into their event credit balance.</Note>}
        <Field label={approve ? 'Note to the member' : 'Why are you declining?'} hint={approve ? 'Optional' : 'The member will see this.'}>
          <textarea rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row"><Button kind={approve ? 'primary' : 'danger'} disabled={busy} onClick={go}>{busy ? 'Saving...' : approve ? 'Approve request' : 'Decline request'}</Button><Button kind="ghost" onClick={onClose}>Back</Button></div>
      </div>
    </Modal>
  );
}

function Paid({ r, onClose, onDone }: { r: any; onClose: () => void; onDone: (m: string) => void }) {
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    if (!ref.trim()) return setErr('Enter the payment reference, for example the M-Pesa code.');
    setBusy(true); setErr('');
    try { await api.post(`/credit/refunds/${r.id}/paid`, { reference: ref.trim() }); onDone('Recorded as paid.'); }
    catch (e: any) { setErr(friendly(e.message)); setBusy(false); }
  };
  return (
    <Modal title="Record the payment" onClose={onClose}>
      <div className="stack">
        <div><b>{r.member}</b>, {kes(r.amount)}</div>
        <Note>Pay the member yourself, for example by M-Pesa to <b>{r.phone}</b>, then record the reference here. ChurchOS does not send the money.</Note>
        <Field label="Payment reference"><input value={ref} maxLength={60} onChange={(e) => setRef(e.target.value)} placeholder="For example QKL7X2ABCD" autoFocus /></Field>
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row"><Button disabled={busy} onClick={go}>{busy ? 'Saving...' : 'Mark as paid'}</Button><Button kind="ghost" onClick={onClose}>Back</Button></div>
      </div>
    </Modal>
  );
}

type Act = 'approve' | 'decline' | 'paid';

function Detail({ r, onClose, act }: { r: any; onClose: () => void; act: (kind: Act, r: any) => void }) {
  const st = STATE[r.status] ?? { text: r.status, tone: 'off' as const };
  return (
    <SidePanel title={r.member} subtitle={`${kes(r.amount)} requested ${dayOnly(r.requestedAt)}`} onClose={onClose} width={480}
      footer={r.status === 'pending' ? <div className="row"><Button onClick={() => act('approve', r)}>Approve</Button><Button kind="ghost" onClick={() => act('decline', r)}>Decline</Button></div>
        : r.status === 'approved' ? <Button onClick={() => act('paid', r)}>Mark as paid</Button> : undefined}>
      <div className="stack">
        <div><StatusChip tone={st.tone}>{st.text}</StatusChip></div>
        <div className="ec-grid">
          <div><span className="k">Amount</span><b>{kes(r.amount)}</b></div>
          <div><span className="k">Phone</span>{r.phone || '-'}</div>
          <div><span className="k">Asked</span>{when(r.requestedAt)}</div>
          {r.decidedAt && <div><span className="k">{r.status === 'declined' ? 'Declined' : 'Decided'}</span>{when(r.decidedAt)}{r.decidedBy ? ` by ${r.decidedBy}` : ''}</div>}
        </div>
        {r.reason && <div><span className="tiny">Their reason</span><div>{r.reason}</div></div>}
        {r.decisionNote && <div><span className="tiny">Note from the church</span><div>{r.decisionNote}</div></div>}
        {r.status === 'approved' && <Note>Pay the member yourself, for example by M-Pesa to <b>{r.phone}</b>, then record the reference. ChurchOS does not send the money.</Note>}
        {r.status === 'paid' && <div className="ec-grid"><div><span className="k">Paid</span>{when(r.paidAt)}{r.paidBy ? ` by ${r.paidBy}` : ''}</div><div><span className="k">Reference</span><span className="mono">{r.paidReference}</span></div></div>}
      </div>
    </SidePanel>
  );
}

function Requests({ toast, onChanged }: { toast: (m: string, tone?: 'good' | 'bad') => void; onChanged: () => void }) {
  const [filter, setFilter] = useState('pending,approved');
  const d = useAsync<any>(() => api.get(`/credit/refunds?status=${filter}`), [filter]);
  const [open, setOpen] = useState<any>(null);
  const [dlg, setDlg] = useState<{ kind: Act; r: any } | null>(null);
  const list: any[] = d.data?.refunds ?? [];
  const act = (kind: Act, r: any) => setDlg({ kind, r });
  const done = (m: string) => { setDlg(null); setOpen(null); toast(m); d.reload(); onChanged(); };
  return (
    <>
      <Toolbar>
        <div className="ec-chips">
          {FILTERS.map(([k, l]) => <button key={k} type="button" className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{l}</button>)}
        </div>
      </Toolbar>
      <Loaded loading={d.loading} error={d.error} hasData={!!d.data} rows={3} height={96}>
        {list.length === 0 ? (
          <Card><EmptyState icon="check" title="Nothing here" text={filter === 'pending,approved' ? 'No refund requests are waiting for you.' : 'No requests match this filter.'} /></Card>
        ) : (
          <div className="ec-list">
            {list.map((r) => {
              const st = STATE[r.status] ?? { text: r.status, tone: 'off' as const };
              return (
                <div className="ec-row tap" key={r.id} onClick={() => setOpen(r)}>
                  <div className="top">
                    <div><b>{r.member}</b><div className="tiny">Asked {when(r.requestedAt)}</div></div>
                    <b className="amt">{kes(r.amount)}</b>
                  </div>
                  <div className="ec-chips"><StatusChip tone={st.tone}>{st.text}</StatusChip></div>
                  {r.reason && <div style={{ overflowWrap: 'anywhere' }}>&ldquo;{r.reason}&rdquo;</div>}
                  {r.status === 'paid' && <div className="tiny">Paid {r.paidBy ? `by ${r.paidBy}, ` : ''}{dayOnly(r.paidAt)}. Reference <span className="mono">{r.paidReference}</span></div>}
                  {r.status === 'declined' && r.decisionNote && <div className="tiny">Declined: {r.decisionNote}</div>}
                  {(r.status === 'pending' || r.status === 'approved') && (
                    <div className="acts" onClick={(e) => e.stopPropagation()}>
                      {r.status === 'pending' && <><Button small onClick={() => act('approve', r)}>Approve</Button><Button small kind="ghost" onClick={() => act('decline', r)}>Decline</Button></>}
                      {r.status === 'approved' && <Button small onClick={() => act('paid', r)}>Mark as paid</Button>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Loaded>
      {open && <Detail r={open} onClose={() => setOpen(null)} act={act} />}
      {dlg && (dlg.kind === 'paid'
        ? <Paid r={dlg.r} onClose={() => setDlg(null)} onDone={done} />
        : <Decide r={dlg.r} approve={dlg.kind === 'approve'} onClose={() => setDlg(null)} onDone={done} />)}
    </>
  );
}

function Holders({ top }: { top?: any[] }) {
  if (!top || top.length === 0) return <Card><EmptyState icon="people" title="No one holds credit" text="When a buyer turns a ticket order into credit, they appear here." /></Card>;
  return (
    <>
      <Card pad={false}>
        {top.map((t, i) => (
          <div className="ec-hold" key={i}>
            <div><b>{t.name}</b><div className="tiny">Holding since {dayOnly(t.since)}</div></div>
            <b className="v">{kes(t.balance)}</b>
          </div>
        ))}
      </Card>
      <p className="tiny" style={{ marginTop: 12 }}>Only people who manage events can see names. The biggest balances are shown first.</p>
    </>
  );
}

export function EventCredit() {
  const s = useSession();
  const manage = s.can('events.manage');
  const [tab, setTab] = useState('overview');
  const d = useAsync<any>(() => api.get('/credit/summary'), []);
  const toast = useToast();
  const x = d.data;
  const todo = x ? Number(x.refunded.toDecide) + Number(x.refunded.toPay) : 0;
  const link = useLinkParams('credit');
  useEffect(() => { if (link?.tab && (link.tab === 'overview' || (manage && (link.tab === 'refunds' || link.tab === 'holders')))) setTab(link.tab); }, [link]); // eslint-disable-line react-hooks/exhaustive-deps
  const tabs = [
    { id: 'overview', label: 'Overview' },
    ...(manage ? [{ id: 'refunds', label: 'Refund requests', badge: todo }, { id: 'holders', label: 'Who holds credit' }] : []),
  ];
  const total = x ? Math.max(1, x.aging.under30 + x.aging.from30to90 + x.aging.over90) : 1;
  return (
    <>
      <PageHeader title="Event credit" subtitle="Credit your church is holding for buyers." tabs={tabs} tab={tab} onTab={setTab} />
      {toast.node}
      {tab === 'refunds' && manage ? <Requests toast={toast.show} onChanged={d.reload} />
        : tab === 'holders' && manage ? <Loaded loading={d.loading} error={d.error} hasData={!!x} rows={3}><Holders top={x?.top} /></Loaded>
        : (
          <Loaded loading={d.loading} error={d.error} hasData={!!x} rows={4} height={96}>
            {x && (
              <>
                {todo > 0 && manage && (
                  <div className="ec-banner">
                    <span>
                      {x.refunded.toDecide > 0 && <b>{x.refunded.toDecide} {x.refunded.toDecide === 1 ? 'request is' : 'requests are'} waiting for your decision. </b>}
                      {x.refunded.toPay > 0 && <b>{x.refunded.toPay} {x.refunded.toPay === 1 ? 'is' : 'are'} approved and still to pay.</b>}
                    </span>
                    <Button small onClick={() => setTab('refunds')}>Open refund requests</Button>
                  </div>
                )}
                <StatTiles>
                  <Stat label="Outstanding credit" value={kw(x.outstanding)} hint="Held for buyers right now" tone="info" />
                  <Stat label="People holding credit" value={x.holders} />
                  <Stat label="Issued so far" value={kw(x.issued.total)} hint={`From ${x.issued.orders} ${x.issued.orders === 1 ? 'order' : 'orders'}`} />
                  <Stat label="Used so far" value={kw(x.used)} hint="Spent on event tickets" />
                  <Stat label="Paid back as refunds" value={kw(x.refunded.paid)} hint={x.refunded.open > 0 ? `${kw(x.refunded.open)} still open` : undefined} />
                </StatTiles>
                <Section title="Age of credit" hint="How long the credit has been held">
                  <Card>
                    <div className="ec-bar" aria-hidden="true">
                      <i className="a" style={{ width: `${(x.aging.under30 / total) * 100}%` }} /><i className="b" style={{ width: `${(x.aging.from30to90 / total) * 100}%` }} /><i className="c" style={{ width: `${(x.aging.over90 / total) * 100}%` }} />
                    </div>
                    <div className="ec-ages">
                      <div className="ec-age"><b>{kw(x.aging.under30)}</b><span>Under 30 days</span></div>
                      <div className="ec-age"><b>{kw(x.aging.from30to90)}</b><span>30 to 90 days</span></div>
                      <div className="ec-age"><b>{kw(x.aging.over90)}</b><span>Over 90 days</span></div>
                    </div>
                  </Card>
                </Section>
                <p className="ec-calm">{x.note || 'This is money the church already received and holds for buyers. It is not income until the credit is spent.'}</p>
              </>
            )}
          </Loaded>
        )}
    </>
  );
}
