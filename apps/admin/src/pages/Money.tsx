import { useState } from 'react';
import { Badge, Button, ErrorNote, Field, Note, StatusBadge, Table, kes, shortDate, useAsync } from '@churchos/ui';
import { Card, Dialog, EmptyState, PageHeader, Section, SidePanel, Stat, StatTiles, Toolbar } from '../ui';
import { Load, METHOD_LABEL, RevealPhone, api, errText, num, type PageProps } from '../common';

// ---------------- Payments ----------------

const STAGES = ['suspense', 'pending', 'available', 'paid_out', 'reversed', 'refunded'];

export function Payments({ toast }: PageProps) {
  const [stage, setStage] = useState('');
  const [q, setQ] = useState('');
  const [method, setMethod] = useState('');
  const [branch, setBranch] = useState('');
  const [more, setMore] = useState(false);
  const [sel, setSel] = useState<any>();
  const p = useAsync(() => api.get<any[]>(`/admin/payments${stage ? `?stage=${stage}` : ''}`), [stage]);
  const needle = q.trim().toLowerCase();
  const rows = (p.data ?? []).filter((r) =>
    (!needle || `${r.provider_tx_id} ${r.reference} ${r.branch_name ?? ''}`.toLowerCase().includes(needle))
    && (!method || r.method === method) && (!branch || (branch === '_none' ? !r.branch_name : r.branch_name === branch)));
  const branches = Array.from(new Set((p.data ?? []).map((r) => r.branch_name).filter(Boolean))) as string[];
  const extra = [method, branch].filter(Boolean).length;
  const clear = () => { setQ(''); setMethod(''); setBranch(''); };

  return (
    <>
      <PageHeader title="Payments" subtitle="The fee split below is visible only in this console."
        actions={<Button kind="ghost" onClick={p.reload}>Refresh</Button>} />
      <Toolbar end={<Button kind="ghost" small onClick={() => setMore((m) => !m)}>{more ? 'Fewer filters' : `More filters${extra ? ` (${extra})` : ''}`}</Button>}>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search code, reference or branch" aria-label="Search payments" />
        <select value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Stage">
          <option value="">All stages</option>
          {STAGES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
        {more && (
          <>
            <select value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Method">
              <option value="">All methods</option>
              {Object.entries(METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select value={branch} onChange={(e) => setBranch(e.target.value)} aria-label="Branch">
              <option value="">All branches</option>
              <option value="_none">Unmatched</option>
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </>
        )}
      </Toolbar>
      <Card pad={false}>
        <Load s={p} rows={6}>
          {(all) => all.length === 0 ? <EmptyState icon="receipt" title="No payments at this stage" text="Pick another stage to see more." />
            : rows.length === 0 ? <EmptyState icon="search" title="No payments match" text="Try fewer filters." action={<Button kind="ghost" small onClick={clear}>Clear filters</Button>} /> : (
            <Table head={['Received', 'Code', 'Branch', 'Paid', 'Platform fee', 'Provider cost', 'Church net', 'Stage']}>
              {rows.map((r) => (
                <tr key={r.id} className="row-open" onClick={() => setSel(r)}>
                  <td>{shortDate(r.received_at)}</td>
                  <td><button type="button" className="linkish" onClick={(e) => { e.stopPropagation(); setSel(r); }}><code>{r.provider_tx_id}</code></button></td>
                  <td>{r.branch_name ?? <span className="tiny">Unmatched</span>}</td>
                  <td className="num">{kes(r.amount_paid)}</td><td className="num">{kes(r.platform_fee)}</td><td className="num">{kes(r.psp_cost)}</td><td className="num"><b>{kes(r.net)}</b></td>
                  <td><StatusBadge status={r.stage} /></td>
                </tr>
              ))}
            </Table>
          )}
        </Load>
      </Card>
      {!p.error && p.data && p.data.length > 0 && <p className="tiny pa-count">{rows.length} of {p.data.length} payments shown</p>}
      {sel && (
        <SidePanel title={kes(sel.amount_paid)} subtitle={<><code>{sel.provider_tx_id}</code> · {shortDate(sel.received_at)}</>} onClose={() => setSel(undefined)}>
          <dl className="pa-dl">
            <div><dt>Stage</dt><dd><StatusBadge status={sel.stage} /></dd></div>
            <div><dt>Branch</dt><dd>{sel.branch_name ?? 'Unmatched'}</dd></div>
            <div><dt>Method</dt><dd>{METHOD_LABEL[sel.method] ?? sel.method}</dd></div>
            <div><dt>Reference</dt><dd>{sel.reference || <span className="tiny">(empty)</span>}</dd></div>
            <div><dt>Payer</dt><dd><RevealPhone paymentId={sel.id} masked={sel.payer_phone} anonymous={sel.anonymous} toast={toast} /></dd></div>
          </dl>
          <h3 className="pa-sub">Fee split</h3>
          <dl className="pa-dl">
            <div><dt>Paid</dt><dd>{kes(sel.amount_paid)}</dd></div>
            <div><dt>Platform fee</dt><dd>{kes(sel.platform_fee)}</dd></div>
            <div><dt>Provider cost</dt><dd>{kes(sel.psp_cost)}</dd></div>
            <div><dt>Church receives</dt><dd><b>{kes(sel.net)}</b></dd></div>
          </dl>
        </SidePanel>
      )}
    </>
  );
}

// ---------------- Settlements ----------------

export function Settlements({ toast }: PageProps) {
  const po = useAsync(() => api.get<any[]>('/admin/payouts'));
  const t = useAsync(() => api.get<any[]>('/admin/tenants'));
  const [run, setRun] = useState<any>();
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<'run' | 'fail' | null>(null);
  const branches = (t.data ?? []).flatMap((o) => o.branches);
  const nameOf = (id: string) => branches.find((b) => b.id === id)?.name ?? id;
  const paused = branches.filter((b) => b.payout_paused);
  const sum = (k: string) => branches.reduce((n, b) => n + num(b[k]), 0);
  const TONE: Record<string, any> = { paid: 'good', carried: 'info', paused: 'bad', failed: 'bad', nothing: 'muted', skipped: 'warn' };

  const go = async () => {
    setBusy(true);
    try { const r = await api.post('/admin/settlement/run'); setRun(r); toast('Settlement finished'); po.reload(); t.reload(); }
    catch (e: any) { toast(errText(e), 'bad'); }
    setBusy(false); setAsk(null);
  };
  const resume = async (id: string) => {
    try { await api.post(`/admin/branches/${id}/resume`); toast('Payouts resumed'); t.reload(); } catch (e: any) { toast(errText(e), 'bad'); }
  };
  const failNext = async () => {
    try { await api.post('/admin/provider/fail-next-payout'); toast('The next payout will fail (test)'); } catch (e: any) { toast(errText(e), 'bad'); }
    setAsk(null);
  };
  return (
    <>
      <PageHeader title="Settlements" subtitle="Pay churches the money that has cleared the 48 hour hold."
        actions={<Button onClick={() => setAsk('run')} disabled={busy}>{busy ? 'Running…' : 'Run settlement now'}</Button>} />

      {t.data && (
        <Section>
          <StatTiles>
            <Stat label="Ready to pay out" value={kes(sum('available'))} tone="good" hint="Cleared the 48h hold" />
            <Stat label="In 48h hold" value={kes(sum('pending'))} hint="Not yet payable" />
            <Stat label="Owed to us" value={kes(sum('receivable'))} hint="Netted against future payouts" />
            <Stat label="Paused branches" value={paused.length} tone={paused.length ? 'wait' : 'good'} hint={paused.length ? 'Resume below' : 'All payouts active'} />
          </StatTiles>
        </Section>
      )}

      {run && (
        <Section title="Latest run" hint={`Expired suspense payments refunded: ${num(run.expiredSuspense)}`}>
          <Card pad={false}>
            {run.results.length === 0 ? <EmptyState icon="wallet" title="No branches to settle" text="Nothing was ready to pay out." /> : (
              <Table head={['Branch', 'Result', 'Amount', 'Detail']}>
                {run.results.map((r: any, i: number) => (
                  <tr key={i}><td>{nameOf(r.branchId)}</td><td><Badge tone={TONE[r.status]}>{r.status}</Badge></td><td className="num">{r.amount != null ? kes(r.amount) : ''}</td><td className="muted">{r.reason ?? (r.netted ? `${kes(r.netted)} netted against debt` : '')}</td></tr>
                ))}
              </Table>
            )}
          </Card>
          <Note>Branches with status 'skipped' are not verified yet, funds are held safely.</Note>
        </Section>
      )}

      {paused.length > 0 && (
        <Section title="Paused branches">
          <Card pad={false}>
            <Table head={['Branch', '']}>
              {paused.map((b) => <tr key={b.id}><td>{b.name}</td><td><Button small onClick={() => resume(b.id)}>Resume payouts</Button></td></tr>)}
            </Table>
          </Card>
        </Section>
      )}

      <Section title="Payouts">
        <Card pad={false}>
          <Load s={po} rows={4}>
            {(rows) => rows.length === 0 ? <EmptyState icon="wallet" title="No payouts yet" text="Run settlement once funds are ready." /> : (
              <Table head={['Created', 'Branch', 'Gross', 'Netted', 'Paid out', 'Status']}>
                {rows.map((r) => (
                  <tr key={r.id}><td>{shortDate(r.created_at)}</td><td>{r.branch_name}</td><td className="num">{kes(r.gross)}</td><td className="num">{kes(r.netted)}</td><td className="num">{kes(r.amount)}</td><td><StatusBadge status={r.status} />{r.failure && <div className="tiny">{r.failure}</div>}</td></tr>
                ))}
              </Table>
            )}
          </Load>
        </Card>
      </Section>

      <Section title="Development only: payout failure test">
        <Card>
          <div className="row between">
            <p className="muted" style={{ margin: 0, flex: '1 1 260px' }}>Funds are never lost when a payout fails. They stay with the church and the payout is retried on the next settlement run.</p>
            <Button kind="ghost" small onClick={() => setAsk('fail')}>Make next payout fail</Button>
          </div>
        </Card>
      </Section>

      {ask === 'run' && (
        <Dialog title="Run settlement now?" onClose={() => setAsk(null)}
          footer={<><Button kind="ghost" onClick={() => setAsk(null)}>Cancel</Button><Button onClick={go} disabled={busy}>{busy ? 'Running…' : 'Run settlement'}</Button></>}>
          <p className="muted">This pays every verified branch the money that has cleared the 48 hour hold, and refunds suspense payments older than 48 hours. It cannot be undone.</p>
        </Dialog>
      )}
      {ask === 'fail' && (
        <Dialog title="Make the next payout fail?" onClose={() => setAsk(null)}
          footer={<><Button kind="ghost" onClick={() => setAsk(null)}>Cancel</Button><Button kind="danger" onClick={failNext}>Yes, make it fail</Button></>}>
          <p className="muted">For testing only. The next payout is refused by the simulated provider and retried on the following settlement run.</p>
        </Dialog>
      )}
    </>
  );
}

// ---------------- Suspense ----------------

function countdown(ms: number) {
  if (ms <= 0) return 'Due for auto-refund';
  const h = Math.floor(ms / 3600_000); const m = Math.floor((ms % 3600_000) / 60_000);
  return `${h}h ${m}m left`;
}

export function Suspense({ toast }: PageProps) {
  const s = useAsync(() => api.get<any[]>('/admin/suspense'));
  const rev = useAsync(() => api.get('/admin/revenue'));
  const t = useAsync(() => api.get<any[]>('/admin/tenants'));
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>();
  const [confirm, setConfirm] = useState<any>();
  const branches = (t.data ?? []).flatMap((o) => o.branches.map((b: any) => ({ ...b, org: o.name })));
  const now = rev.data ? new Date(rev.data.now).getTime() : Date.now();

  const claim = async (id: string) => {
    setBusy(id);
    try { await api.post(`/admin/suspense/${id}/claim`, { branchId: pick[id] }); toast('Payment assigned to the branch'); s.reload(); }
    catch (e: any) { toast(errText(e), 'bad'); }
    setBusy(undefined); setConfirm(undefined);
  };
  const branchName = (id: string) => { const b = branches.find((x) => x.id === id); return b ? `${b.name} (${b.code})` : ''; };
  return (
    <>
      <PageHeader title="Suspense queue" subtitle="Payments we received but could not match to a branch." actions={<Button kind="ghost" onClick={s.reload}>Refresh</Button>} />
      <Note tone="warn">After 48 hours, unclaimed funds are refunded to the sender automatically (net of third-party charges) the next time settlement runs.</Note>
      <div style={{ height: 16 }} />
      <Card pad={false}>
        <Load s={s} rows={4}>
          {(rows) => rows.length === 0 ? <EmptyState icon="check" title="Nothing in suspense" text="Every payment found its branch." /> : (
            <Table head={['Reference typed', 'Phone', 'Amount', 'Received', 'Auto-refund', 'Assign to branch']}>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.reference ? <code>{r.reference}</code> : <span className="tiny">(empty)</span>}<div className="tiny">{r.provider_tx_id}</div></td>
                  <td><RevealPhone paymentId={r.id} masked={r.payer_phone} anonymous={r.anonymous} toast={toast} /></td>
                  <td className="num">{kes(r.amount_paid)}</td>
                  <td>{shortDate(r.received_at)}</td>
                  <td><Badge tone={new Date(r.expiresAt).getTime() <= now ? 'bad' : 'warn'}>{countdown(new Date(r.expiresAt).getTime() - now)}</Badge><div className="tiny">{shortDate(r.expiresAt)}</div></td>
                  <td>
                    <div className="pa-assign">
                      <select value={pick[r.id] ?? ''} aria-label="Branch to assign" onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })}>
                        <option value="">Choose a branch…</option>
                        {branches.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.code}) · {b.org}</option>)}
                      </select>
                      <Button small disabled={!pick[r.id] || busy === r.id} onClick={() => setConfirm(r)}>Assign</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Load>
      </Card>
      {confirm && (
        <Dialog title="Assign this payment?" onClose={() => setConfirm(undefined)}
          footer={<><Button kind="ghost" onClick={() => setConfirm(undefined)}>Cancel</Button><Button disabled={busy === confirm.id} onClick={() => claim(confirm.id)}>{busy === confirm.id ? 'Assigning…' : 'Yes, assign'}</Button></>}>
          <p className="muted">{kes(confirm.amount_paid)} ({confirm.provider_tx_id}) will be credited to <b>{branchName(pick[confirm.id])}</b>.</p>
        </Dialog>
      )}
    </>
  );
}

// ---------------- Reversals ----------------

const SECOND_ABOVE = 5_000_000;
const TABS = [
  { id: 'pending', label: 'Pending', q: 'pending' },
  { id: 'second', label: 'Awaiting second approval', q: 'awaiting_second' },
  { id: 'done', label: 'Done', q: 'approved,rejected,failed' },
];
const STAGE_WHERE: Record<string, string> = {
  suspense: 'Held in suspense (not credited to a church)', pending: 'Church balance, in 48h hold', available: 'Church balance, ready to pay out',
  paid_out: 'Already paid out to the church', reversed: 'Already reversed', refunded: 'Already refunded',
};

export function Reversals({ toast, user }: PageProps) {
  const [tab, setTab] = useState('pending');
  const q = TABS.find((x) => x.id === tab)!.q;
  const r = useAsync(() => api.get<any[]>(`/admin/reversal-requests?status=${q}`), [q]);
  const [confirm, setConfirm] = useState<{ row: any; approve: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [why, setWhy] = useState('');

  const decide = async (row: any, approve: boolean) => {
    if (!approve && !why.trim()) { toast('Please give a reason for rejecting this request.', 'bad'); return; }
    setBusy(true);
    try {
      const out = await api.post(`/admin/reversal-requests/${row.id}/decide`, { approve, reason: why.trim() || undefined });
      toast(out.status === 'awaiting_second' ? 'First approval recorded. A different admin must give the second approval.' : approve ? 'Reversal approved and refund started' : 'Request rejected');
      setConfirm(null); setWhy(''); r.reload();
    } catch (e: any) {
      const text = e.code === 'same_person' ? 'You gave the first approval. A different admin must approve this one.' : errText(e);
      setMsg((m) => ({ ...m, [row.id]: text })); toast(text, 'bad'); setConfirm(null);
    }
    setBusy(false);
  };

  const cf = confirm;
  const cfTwo = cf ? num(cf.row.amount_paid) > SECOND_ABOVE : false;
  return (
    <>
      <PageHeader title="Reversal requests" subtitle="Members and church staff asking for a payment to be returned."
        tabs={TABS.map((x) => ({ id: x.id, label: x.label }))} tab={tab} onTab={setTab} />
      <Note>Refund rules: the platform fee is returned to the sender. Third-party mobile money charges are not returned. Amounts above {kes(SECOND_ABOVE)} need two different admins: the first approval parks the request and a second admin completes it.</Note>
      <div style={{ height: 16 }} />
      <Load s={r} rows={3}>
        {(rows) => rows.length === 0 ? <Card><EmptyState icon="check" title="No requests here" text={tab === 'done' ? 'Decided requests will be listed here.' : 'Nothing is waiting for a decision.'} /></Card> : (
          <div className="pa-stack">
            {rows.map((x) => {
              const needsTwo = num(x.amount_paid) > SECOND_ABOVE;
              const open = x.status === 'pending' || x.status === 'awaiting_second';
              const mine = x.status === 'awaiting_second' && x.first_approver === user.id;
              return (
                <Card key={x.id} className="pa-req">
                  <div className="pa-req-head">
                    <b className="pa-req-amount">{kes(x.amount_paid)}</b>
                    <code>{x.provider_tx_id}</code>
                    <StatusBadge status={x.status} />
                    {needsTwo && <Badge tone="warn">Needs two admins</Badge>}
                  </div>
                  <div className="muted">{STAGE_WHERE[x.payment_stage] ?? x.payment_stage}{x.branch_name ? ` · ${x.branch_name}` : ''}</div>
                  <dl className="pa-dl cols">
                    <div><dt>Reason</dt><dd>{x.reason}</dd></div>
                    <div><dt>Asked by</dt><dd>{x.requested_by_name ?? 'Unknown'} <Badge tone="muted">{x.source === 'staff' ? 'Church staff' : 'Member'}</Badge></dd></div>
                    <div><dt>Asked on</dt><dd>{shortDate(x.created_at)}</dd></div>
                    {x.payment_id && <div><dt>Payer phone</dt><dd><RevealPhone paymentId={x.payment_id} masked={x.payer_phone} anonymous={x.anonymous} toast={toast} /></dd></div>}
                  </dl>
                  {x.message && <details className="pa-details"><summary>Pasted confirmation message</summary><pre className="outbox-text">{x.message}</pre></details>}
                  {x.failure && <ErrorNote>{x.failure}</ErrorNote>}
                  {mine && <Note tone="warn">You gave the first approval. A different admin must give the second approval.</Note>}
                  {msg[x.id] && <ErrorNote>{msg[x.id]}</ErrorNote>}
                  {open && (
                    <div className="pa-actions">
                      <Button kind="danger" small onClick={() => { setWhy(''); setConfirm({ row: x, approve: false }); }}>Reject</Button>
                      <Button small disabled={mine} onClick={() => { setWhy(''); setConfirm({ row: x, approve: true }); }}>{x.status === 'awaiting_second' ? 'Give second approval' : 'Approve'}</Button>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </Load>
      {cf && (
        <Dialog title={cf.approve ? 'Approve this reversal?' : 'Reject this request?'} onClose={() => setConfirm(null)}
          footer={<><Button kind="ghost" onClick={() => setConfirm(null)}>Cancel</Button><Button kind={cf.approve ? 'primary' : 'danger'} disabled={busy} onClick={() => decide(cf.row, cf.approve)}>{busy ? 'Working…' : cf.approve ? 'Yes, approve' : 'Yes, reject'}</Button></>}>
          <Note tone={cf.approve ? 'warn' : 'info'}>{cf.approve
            ? `Approve returning ${kes(cf.row.amount_paid)}? The platform fee is returned; third-party mobile money charges are not.${cfTwo && cf.row.status === 'pending' ? ' A second admin must still approve.' : ''}`
            : 'Reject this request? The payment stays where it is.'}</Note>
          <Field label={cf.approve ? 'Reason (optional, but helpful for the record)' : 'Reason (required)'}><input value={why} maxLength={300} onChange={(e) => setWhy(e.target.value)} placeholder={cf.approve ? 'e.g. Sent to the wrong paybill' : 'e.g. The payment was already refunded'} /></Field>
        </Dialog>
      )}
    </>
  );
}
