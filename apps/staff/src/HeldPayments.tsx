import { useEffect, useState } from 'react';
import { Button, ErrorNote, Field, kes, shortDate, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Card, EmptyState, PageHeader, StatusChip } from './ui';
import { Loaded } from './money-bits';
import { Modal } from './MemberForm';
import { useLinkParams } from './links';
import './money.css';

type Held = { id: string; kind: 'underpaid' | 'overpaid'; reference: string; transactionCode: string; branch: string; orderType: string; what: string; expected: number; received: number; difference: number; at: string; status: 'open' | 'resolved'; resolutionLabel: string | null; note: string | null; resolvedBy: string | null; resolvedAt: string | null };

const ACTIONS = [
  { id: 'refunded_outside', label: 'Refunded outside ChurchOS', hint: 'The money was sent back by M-Pesa or bank.' },
  { id: 'kept_as_gift', label: 'Kept as a gift', hint: 'The payer meant it as a gift or agreed to leave it.' },
  { id: 'order_completed', label: 'Order completed another way', hint: 'For example the rest was paid in cash.' },
  { id: 'other', label: 'Something else', hint: 'Say what was done in the note.' },
];

/** Payments that did not match their order. Resolving only records what was done: no money moves here. */
export function HeldPayments() {
  const s = useSession();
  const toast = useToast();
  const [tab, setTab] = useState<'open' | 'resolved'>('open');
  const d = useAsync<{ rows: Held[]; openCount: number }>(() => api.get('/payments/held' + s.qs({ status: tab })), [s.qs(), tab]);
  const [acting, setActing] = useState<Held | null>(null);
  const link = useLinkParams('held-payments');
  const focus = link?.id;
  useEffect(() => { if (focus) setTab('open'); }, [focus]);
  const x = d.data;
  return (
    <>
      <PageHeader
        title="Payments to review"
        subtitle="A payment that did not match what it was for. The money is safe in your books; mark each one once you have dealt with it."
        tabs={[{ id: 'open', label: 'To review', badge: x && tab === 'open' ? x.openCount : undefined }, { id: 'resolved', label: 'Dealt with' }]}
        tab={tab}
        onTab={(t) => setTab(t as 'open' | 'resolved')}
      />
      <Loaded loading={d.loading} error={d.error} hasData={!!x} rows={3} height={72}>
        {x && (x.rows.length === 0 ? (
          <Card>
            <EmptyState icon="shield" title={tab === 'open' ? 'Nothing to review' : 'Nothing dealt with yet'} text={tab === 'open' ? 'Every payment has matched what it was for. If one comes in too small or too large, it will appear here.' : 'Payments you mark as dealt with are kept here.'} />
          </Card>
        ) : (
          <Card pad={false} className="mn-wrap">
            <div className="mn-scroll">
              <table className="mn-table">
                <thead><tr><th>What it was for</th><th>Reference</th><th className="num">Expected</th><th className="num">Received</th><th className="num">Difference</th><th>When</th><th>Status</th>{tab === 'open' && <th />}</tr></thead>
                <tbody>
                  {x.rows.map((r) => (
                    <tr key={r.id} style={focus === r.id ? { background: 'var(--accent-tint)' } : undefined}>
                      <td className="mn-first" data-l="What it was for"><span><b>{r.what}</b><span className="mn-sub">{r.orderType} · {r.branch}</span></span></td>
                      <td data-l="Reference"><span className="mono">{r.reference}</span><span className="mn-sub">{r.transactionCode}</span></td>
                      <td className="num" data-l="Expected">{kes(r.expected)}</td>
                      <td className="num" data-l="Received">{kes(r.received)}</td>
                      <td className="num" data-l="Difference"><b>{r.difference > 0 ? '+' : ''}{kes(r.difference)}</b></td>
                      <td data-l="When">{shortDate(r.at)}</td>
                      <td data-l="Status">
                        <StatusChip tone={r.status === 'open' ? 'wait' : 'done'}>{r.status === 'open' ? (r.kind === 'underpaid' ? 'Too small' : 'Too large') : 'Dealt with'}</StatusChip>
                        {r.status === 'resolved' && <span className="mn-sub">{r.resolutionLabel}{r.resolvedBy ? ` · ${r.resolvedBy}` : ''}{r.note ? ` · ${r.note}` : ''}</span>}
                      </td>
                      {tab === 'open' && <td><Button small kind="ghost" onClick={() => setActing(r)}>Mark as dealt with</Button></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))}
      </Loaded>
      {toast.node}
      {acting && <Resolve held={acting} onClose={() => setActing(null)} onDone={() => { setActing(null); toast.show('Marked as dealt with'); d.reload(); }} />}
    </>
  );
}

function Resolve({ held, onClose, onDone }: { held: Held; onClose: () => void; onDone: () => void }) {
  const s = useSession();
  const [action, setAction] = useState('refunded_outside');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try { await api.post(`/payments/held/${held.id}/resolve` + s.qs({ branch: undefined }), { action, note }); onDone(); } catch (e: any) { setErr(friendly(e.message)); setBusy(false); }
  };
  const pick = ACTIONS.find((a) => a.id === action)!;
  return (
    <Modal title="Mark as dealt with" onClose={onClose}>
      <div className="stack">
        <p style={{ margin: 0 }}>{held.what}: {kes(held.received)} received, {kes(held.expected)} expected. This only records what you did. To send money back through ChurchOS, use Payment help.</p>
        <Field label="What was done?" hint={pick.hint}>
          <select value={action} onChange={(e) => setAction(e.target.value)}>{ACTIONS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select>
        </Field>
        <Field label={action === 'other' ? 'Note' : 'Note (optional)'}>
          <textarea rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row"><Button disabled={busy || (action === 'other' && !note.trim())} onClick={go}>{busy ? 'Saving...' : 'Save'}</Button><Button kind="ghost" disabled={busy} onClick={onClose}>Cancel</Button></div>
      </div>
    </Modal>
  );
}
