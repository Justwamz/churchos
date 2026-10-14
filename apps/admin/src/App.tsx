import { useState, type ReactNode } from 'react';
import { computeFee, DEFAULT_FEE_SCHEDULE, type FeeSchedule, type PaymentMethod } from '@churchos/shared';
import {
  Badge, Button, Card, Empty, ErrorNote, Field, LoginGate, Note, Spinner, Stat, StatusBadge, Table,
  createApi, kes, phonePretty, shortDate, useAsync, useToast,
} from '@churchos/ui';

const api = createApi('churchos:admin-token');
const num = (v: unknown) => Number(v ?? 0);
const errText = (e: any) => (e && typeof e.message === 'string' && !e.message.trim().startsWith('{') ? e.message : 'Something went wrong. Please try again.');

type Page = 'overview' | 'tenants' | 'suspense' | 'reversals' | 'payments' | 'settlements' | 'tools' | 'audit';
const PAGES: { id: Page; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'tenants', label: 'Tenants and fees' },
  { id: 'suspense', label: 'Suspense queue' },
  { id: 'reversals', label: 'Reversal requests' },
  { id: 'payments', label: 'Payments' },
  { id: 'settlements', label: 'Settlements' },
  { id: 'tools', label: 'Test tools' },
  { id: 'audit', label: 'Audit log' },
];

export function App() {
  return (
    <LoginGate api={api} title="Platform Admin" subtitle="For ChurchOS staff only. Sign in with your admin phone number." allow={(u) => !!u.isAdmin}>
      {({ user, signOut }) => <Shell user={user} signOut={signOut} />}
    </LoginGate>
  );
}

function Shell({ user, signOut }: { user: any; signOut: () => void }) {
  const [page, setPage] = useState<Page>('overview');
  const toast = useToast();
  const p = { toast: toast.show, user };
  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">ChurchOS<div className="tiny">Platform admin</div></div>
        {PAGES.map((x) => (
          <button key={x.id} className={`nav-link ${page === x.id ? 'active' : ''}`} onClick={() => setPage(x.id)}>{x.label}</button>
        ))}
        <div style={{ flex: 1 }} />
        <div className="tiny" style={{ padding: '0 12px' }}>{user.name ?? phonePretty(user.phone)}</div>
        <button className="nav-link" onClick={signOut}>Sign out</button>
      </nav>
      <main className="content">
        {page === 'overview' && <Overview />}
        {page === 'tenants' && <Tenants {...p} />}
        {page === 'suspense' && <Suspense {...p} />}
        {page === 'reversals' && <Reversals {...p} />}
        {page === 'payments' && <Payments />}
        {page === 'settlements' && <Settlements {...p} />}
        {page === 'tools' && <Tools {...p} />}
        {page === 'audit' && <Audit />}
      </main>
      {toast.node}
    </div>
  );
}

type PageProps = { toast: (t: string, tone?: 'good' | 'bad') => void; user: any };

function Head({ title, sub, action }: { title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
      {action}
    </div>
  );
}

function Load<T>({ s, children }: { s: { data?: T; error?: string; loading: boolean }; children: (d: T) => ReactNode }) {
  if (s.error) return <ErrorNote>{s.error}</ErrorNote>;
  if (s.data === undefined) return <Spinner />;
  return <>{children(s.data)}</>;
}

// ---------------- Overview ----------------

function Overview() {
  const rec = useAsync(() => api.get('/admin/reconcile'));
  const rev = useAsync(() => api.get('/admin/revenue'));
  const sus = useAsync(() => api.get('/admin/suspense'));
  const rr = useAsync(() => api.get('/admin/reversal-requests?status=pending,awaiting_second'));
  const reload = () => { rec.reload(); rev.reload(); sus.reload(); rr.reload(); };
  const ACC: Record<string, string> = {
    suspense: 'Unmatched payments (suspense)', fee_revenue: 'Platform fees earned', psp_cost_payable: 'Owed to payment providers',
    in_transit: 'Payouts in transit', branch_pending: 'Churches: in 48h hold', branch_available: 'Churches: ready to pay out',
    branch_receivable: 'Churches: owed to us', branch_paused: 'Churches: paused',
  };
  return (
    <>
      <Head title="Overview" sub="Is the money where it should be?" action={<Button kind="ghost" onClick={reload}>Refresh</Button>} />
      <Load s={rec}>
        {(r: any) => (
          <Card className={`integrity ${r.ok ? 'ok' : 'bad'}`}>
            <div className="row between">
              <div>
                <div className="tiny" style={{ textTransform: 'uppercase', letterSpacing: '.06em' }}>Money integrity</div>
                <div style={{ fontFamily: 'var(--serif)', fontSize: '2.6rem', color: r.ok ? 'var(--good)' : 'var(--bad)' }}>{r.ok ? 'Balanced' : 'Mismatch'}</div>
                <div className="muted">{r.ok ? 'Our ledger agrees with the payment provider wallet to the cent.' : 'Our ledger and the provider wallet disagree. Investigate before running settlement.'}</div>
              </div>
              <div className="grid cols-3" style={{ minWidth: 360, flex: 1 }}>
                <Stat label="Ledger wallet" value={kes(r.ledgerWallet)} />
                <Stat label="Provider wallet" value={kes(r.pspWallet)} />
                <Stat label="Difference" value={kes(r.difference)} tone={num(r.difference) === 0 ? 'good' : 'bad'} hint={r.zeroSum ? 'Ledger entries sum to zero' : 'Ledger entries do NOT sum to zero'} />
              </div>
            </div>
          </Card>
        )}
      </Load>
      <div style={{ height: 16 }} />
      <div className="grid cols-4">
        <Load s={rev}>
          {(v: any) => (<>
            <Stat label="Platform fees earned" value={kes(v.platform_fee)} hint={`${num(v.n)} payments`} tone="good" />
            <Stat label="Provider cost payable" value={kes(v.psp_cost)} hint="Third-party charges" />
            <Stat label="Platform clock" value={shortDate(v.now)} hint={num(v.clockOffsetHours) ? `Skipped ahead ${num(v.clockOffsetHours)} hours` : 'Real time (no offset)'} />
          </>)}
        </Load>
        <Load s={sus}>{(v: any[]) => <Stat label="Open suspense items" value={v.length} tone={v.length ? 'warn' : 'good'} hint="Unmatched payments" />}</Load>
        <Load s={rr}>{(v: any[]) => <Stat label="Pending reversals" value={v.length} tone={v.length ? 'warn' : 'good'} hint="Need a decision" />}</Load>
      </div>
      <div style={{ height: 16 }} />
      <Card title="Account balances">
        <Load s={rec}>
          {(r: any) => {
            const entries = Object.entries(r.accounts ?? {});
            return entries.length === 0 ? <Empty>No balances yet.</Empty> : (
              <Table head={['Account', 'Balance']}>
                {entries.map(([k, v]) => (
                  <tr key={k}><td>{ACC[k] ?? k.replace(/_/g, ' ')}</td><td className="num">{kes(v as number)}</td></tr>
                ))}
              </Table>
            );
          }}
        </Load>
      </Card>
    </>
  );
}

// ---------------- Tenants and fees ----------------

const METHODS: PaymentMethod[] = ['mpesa', 'airtel', 'tkash', 'card', 'cash'];
const METHOD_LABEL: Record<string, string> = { mpesa: 'M-Pesa', airtel: 'Airtel Money', tkash: 'T-Kash', card: 'Card', cash: 'Cash' };
const centsOf = (kesStr: string) => Math.round(Number(kesStr || 0) * 100);

function Tenants({ toast }: PageProps) {
  const t = useAsync(() => api.get<any[]>('/admin/tenants'));
  return (
    <>
      <Head title="Tenants and fees" sub="Churches on the platform, their balances, and what each one is charged." />
      <Note>Percentages are in basis points: 100 bps = 1%, so 150 = 1.5%. Fixed amounts and tier limits are entered in KES.</Note>
      <div style={{ height: 16 }} />
      <Load s={t}>
        {(orgs) => orgs.length === 0 ? <Empty>No organisations yet.</Empty> : (
          <div className="grid" style={{ gap: 20 }}>
            {orgs.map((o) => <TenantCard key={o.id} org={o} toast={toast} onSaved={t.reload} />)}
          </div>
        )}
      </Load>
    </>
  );
}

function TenantCard({ org, toast, onSaved }: { org: any; toast: PageProps['toast']; onSaved: () => void }) {
  const init: FeeSchedule = org.feeSchedule ?? DEFAULT_FEE_SCHEDULE;
  const [open, setOpen] = useState(false);
  const [bearer, setBearer] = useState<'church' | 'member'>(org.feeBearer ?? 'church');
  const [kind, setKind] = useState<'flat' | 'tiered'>(init.platform.type);
  const [flat, setFlat] = useState(String(init.platform.type === 'flat' ? init.platform.bps : 150));
  const [tiers, setTiers] = useState<{ upTo: string; bps: string }[]>(
    init.platform.type === 'tiered'
      ? init.platform.tiers.map((x) => ({ upTo: x.upTo === null ? '' : String(num(x.upTo) / 100), bps: String(x.bps) }))
      : [{ upTo: '10000', bps: '200' }, { upTo: '', bps: '150' }],
  );
  const [psp, setPsp] = useState<Record<string, { bps: string; fixed: string }>>(
    Object.fromEntries(METHODS.map((m) => [m, { bps: String(init.psp?.[m]?.bps ?? 0), fixed: String((num(init.psp?.[m]?.fixed)) / 100) }])),
  );
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);

  const schedule: FeeSchedule = {
    platform: kind === 'flat'
      ? { type: 'flat', bps: Number(flat) }
      : { type: 'tiered', tiers: tiers.map((x, i) => ({ upTo: i === tiers.length - 1 ? null : centsOf(x.upTo), bps: Number(x.bps) })) },
    psp: Object.fromEntries(METHODS.map((m) => [m, { bps: Number(psp[m].bps), fixed: centsOf(psp[m].fixed) }])) as FeeSchedule['psp'],
  };

  const save = async () => {
    setBusy(true); setErr(undefined);
    try {
      await api.put(`/admin/tenants/${org.id}/fees`, { feeBearer: bearer, feeSchedule: schedule });
      toast(`Fees saved for ${org.name}`);
      onSaved();
    } catch (e: any) { setErr(errText(e)); }
    setBusy(false);
  };

  const preview = (m: PaymentMethod, amountKes: number) => {
    try { return computeFee(schedule, m, amountKes * 100, bearer); } catch { return null; }
  };

  return (
    <Card title={org.name} action={<div className="row"><Badge tone="info">{org.feeBearer === 'member' ? 'Member pays on top' : 'Church absorbs'}</Badge><Button kind="ghost" small onClick={() => setOpen(!open)}>{open ? 'Hide fee editor' : 'Edit fees'}</Button></div>}>
      <Table head={['Branch', 'Code', 'In 48h hold', 'Ready to pay out', 'Owed to us', 'Payouts']}>
        {org.branches.map((b: any) => (
          <tr key={b.id}>
            <td>{b.name}<div className="tiny">{b.region}</div></td><td>{b.code}</td>
            <td className="num">{kes(b.pending)}</td><td className="num">{kes(b.available)}</td><td className="num">{kes(b.receivable)}</td>
            <td>{b.payout_paused ? <Badge tone="bad">Paused</Badge> : <Badge tone="good">Active</Badge>}</td>
          </tr>
        ))}
      </Table>
      {open && (
        <div style={{ marginTop: 18, borderTop: '1px solid var(--line)', paddingTop: 16 }}>
          <div className="grid cols-2">
            <div>
              <h3>Who pays the fee?</h3>
              <div className="col" style={{ display: 'grid', gap: 6, margin: '8px 0 16px' }}>
                <label><input type="radio" style={{ width: 'auto', minHeight: 0 }} checked={bearer === 'church'} onChange={() => setBearer('church')} /> Church absorbs (member pays the gift amount, church receives less)</label>
                <label><input type="radio" style={{ width: 'auto', minHeight: 0 }} checked={bearer === 'member'} onChange={() => setBearer('member')} /> Member pays on top (church receives the full gift)</label>
              </div>
              <h3>Platform fee (what ChurchOS earns)</h3>
              <div className="row" style={{ margin: '8px 0' }}>
                <label><input type="radio" style={{ width: 'auto', minHeight: 0 }} checked={kind === 'flat'} onChange={() => setKind('flat')} /> Flat</label>
                <label><input type="radio" style={{ width: 'auto', minHeight: 0 }} checked={kind === 'tiered'} onChange={() => setKind('tiered')} /> Tiered by amount</label>
              </div>
              {kind === 'flat' ? (
                <Field label="Platform fee (bps)" hint={`${(Number(flat) / 100).toFixed(2)}% of each gift`}><input inputMode="numeric" value={flat} onChange={(e) => setFlat(e.target.value)} /></Field>
              ) : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {tiers.map((x, i) => {
                    const last = i === tiers.length - 1;
                    return (
                      <div key={i} className="row">
                        <div style={{ width: 170 }}>
                          {last ? <input disabled value="and above" /> : <input inputMode="decimal" placeholder="Up to (KES)" value={x.upTo} onChange={(e) => setTiers(tiers.map((y, j) => j === i ? { ...y, upTo: e.target.value } : y))} />}
                        </div>
                        <div style={{ width: 110 }}><input inputMode="numeric" placeholder="bps" value={x.bps} onChange={(e) => setTiers(tiers.map((y, j) => j === i ? { ...y, bps: e.target.value } : y))} /></div>
                        <span className="tiny">bps</span>
                        {tiers.length > 1 && <Button kind="ghost" small onClick={() => setTiers(tiers.filter((_, j) => j !== i))}>Remove</Button>}
                      </div>
                    );
                  })}
                  <div><Button kind="ghost" small onClick={() => setTiers([...tiers.slice(0, -1), { upTo: '', bps: '150' }, tiers[tiers.length - 1]])}>Add a tier</Button></div>
                  <div className="tiny">Each row applies to gifts up to that amount. The last row covers everything above.</div>
                </div>
              )}
            </div>
            <div>
              <h3>Provider cost (what the payment provider charges)</h3>
              <Table head={['Method', 'bps', 'Fixed (KES)']}>
                {METHODS.map((m) => (
                  <tr key={m}>
                    <td>{METHOD_LABEL[m]}</td>
                    <td style={{ width: 100 }}><input inputMode="numeric" value={psp[m].bps} onChange={(e) => setPsp({ ...psp, [m]: { ...psp[m], bps: e.target.value } })} /></td>
                    <td style={{ width: 110 }}><input inputMode="decimal" value={psp[m].fixed} onChange={(e) => setPsp({ ...psp, [m]: { ...psp[m], fixed: e.target.value } })} /></td>
                  </tr>
                ))}
              </Table>
            </div>
          </div>

          <h3 style={{ marginTop: 18 }}>Live preview</h3>
          <Table head={['Method', 'Gift', 'Member pays', 'Platform fee', 'Provider cost', 'Church receives']}>
            {METHODS.flatMap((m) => [100, 1000, 10000].map((a) => {
              const r = preview(m, a);
              return (
                <tr key={m + a}>
                  <td>{METHOD_LABEL[m]}</td><td className="num">{kes(a * 100)}</td>
                  {r ? (<><td className="num">{kes(r.amountPaid)}</td><td className="num">{kes(r.platformFee)}</td><td className="num">{kes(r.pspCost)}</td><td className="num"><b>{kes(r.netToChurch)}</b></td></>)
                    : <td colSpan={4} className="tiny">Enter valid numbers to preview</td>}
                </tr>
              );
            }))}
          </Table>
          {err && <div style={{ marginTop: 12 }}><ErrorNote>{err}</ErrorNote></div>}
          <div className="row" style={{ marginTop: 14 }}>
            <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save fees'}</Button>
            <span className="tiny">Applies to new payments only.</span>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------- Suspense ----------------

function countdown(ms: number) {
  if (ms <= 0) return 'Due for auto-refund';
  const h = Math.floor(ms / 3600_000); const m = Math.floor((ms % 3600_000) / 60_000);
  return `${h}h ${m}m left`;
}

function Suspense({ toast }: PageProps) {
  const s = useAsync(() => api.get<any[]>('/admin/suspense'));
  const rev = useAsync(() => api.get('/admin/revenue'));
  const t = useAsync(() => api.get<any[]>('/admin/tenants'));
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>();
  const branches = (t.data ?? []).flatMap((o) => o.branches.map((b: any) => ({ ...b, org: o.name })));
  const now = rev.data ? new Date(rev.data.now).getTime() : Date.now();

  const claim = async (id: string) => {
    setBusy(id);
    try { await api.post(`/admin/suspense/${id}/claim`, { branchId: pick[id] }); toast('Payment assigned to the branch'); s.reload(); }
    catch (e: any) { toast(errText(e), 'bad'); }
    setBusy(undefined);
  };
  return (
    <>
      <Head title="Suspense queue" sub="Payments we received but could not match to a branch." />
      <Note tone="warn">After 48 hours, unclaimed funds are refunded to the sender automatically (net of third-party charges) the next time settlement runs.</Note>
      <div style={{ height: 16 }} />
      <Card>
        <Load s={s}>
          {(rows) => rows.length === 0 ? <Empty>Nothing in suspense. Every payment found its branch.</Empty> : (
            <Table head={['Reference typed', 'Phone', 'Amount', 'Received', 'Auto-refund', 'Assign to branch']}>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.reference ? <code>{r.reference}</code> : <span className="tiny">(empty)</span>}<div className="tiny">{r.provider_tx_id}</div></td>
                  <td>{phonePretty(r.payer_phone)}</td>
                  <td className="num">{kes(r.amount_paid)}</td>
                  <td>{shortDate(r.received_at)}</td>
                  <td><Badge tone={new Date(r.expiresAt).getTime() <= now ? 'bad' : 'warn'}>{countdown(new Date(r.expiresAt).getTime() - now)}</Badge><div className="tiny">{shortDate(r.expiresAt)}</div></td>
                  <td>
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <select value={pick[r.id] ?? ''} onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })} style={{ minWidth: 190 }}>
                        <option value="">Choose a branch…</option>
                        {branches.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.code}) · {b.org}</option>)}
                      </select>
                      <Button small disabled={!pick[r.id] || busy === r.id} onClick={() => claim(r.id)}>Assign</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Load>
      </Card>
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

function Reversals({ toast, user }: PageProps) {
  const [tab, setTab] = useState('pending');
  const q = TABS.find((x) => x.id === tab)!.q;
  const r = useAsync(() => api.get<any[]>(`/admin/reversal-requests?status=${q}`), [q]);
  const [confirm, setConfirm] = useState<{ id: string; approve: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Record<string, string>>({});

  const decide = async (row: any, approve: boolean) => {
    setBusy(true);
    try {
      const out = await api.post(`/admin/reversal-requests/${row.id}/decide`, { approve });
      toast(out.status === 'awaiting_second' ? 'First approval recorded. A different admin must give the second approval.' : approve ? 'Reversal approved and refund started' : 'Request rejected');
      setConfirm(null); r.reload();
    } catch (e: any) {
      const text = e.code === 'same_person' ? 'You gave the first approval. A different admin must approve this one.' : errText(e);
      setMsg((m) => ({ ...m, [row.id]: text })); toast(text, 'bad'); setConfirm(null);
    }
    setBusy(false);
  };

  return (
    <>
      <Head title="Reversal requests" sub="Members and church staff asking for a payment to be returned." />
      <Note>Refund rules: the platform fee is returned to the sender. Third-party mobile money charges are not returned. Amounts above {kes(SECOND_ABOVE)} need two different admins: the first approval parks the request and a second admin completes it.</Note>
      <div className="row" style={{ margin: '16px 0' }}>
        {TABS.map((x) => <Button key={x.id} kind={tab === x.id ? 'primary' : 'ghost'} small onClick={() => setTab(x.id)}>{x.label}</Button>)}
      </div>
      <Load s={r}>
        {(rows) => rows.length === 0 ? <Empty>No requests here.</Empty> : (
          <div className="grid" style={{ gap: 12 }}>
            {rows.map((x) => {
              const needsTwo = num(x.amount_paid) > SECOND_ABOVE;
              const open = x.status === 'pending' || x.status === 'awaiting_second';
              const mine = x.status === 'awaiting_second' && x.first_approver === user.id;
              return (
                <Card key={x.id}>
                  <div className="row between">
                    <div>
                      <div className="row"><b style={{ fontSize: '1.1rem' }}>{kes(x.amount_paid)}</b><code>{x.provider_tx_id}</code><StatusBadge status={x.status} />{needsTwo && <Badge tone="warn">Needs two admins</Badge>}</div>
                      <div className="muted" style={{ marginTop: 4 }}>{STAGE_WHERE[x.payment_stage] ?? x.payment_stage}{x.branch_name ? ` · ${x.branch_name}` : ''}</div>
                    </div>
                    {open && (
                      <div className="row">
                        <Button kind="danger" small onClick={() => setConfirm({ id: x.id, approve: false })}>Reject</Button>
                        <Button small disabled={mine} onClick={() => setConfirm({ id: x.id, approve: true })}>{x.status === 'awaiting_second' ? 'Give second approval' : 'Approve'}</Button>
                      </div>
                    )}
                  </div>
                  <div className="grid cols-3" style={{ marginTop: 10 }}>
                    <div><div className="tiny">Reason</div>{x.reason}</div>
                    <div><div className="tiny">Asked by</div>{x.requested_by_name ?? phonePretty(x.payer_phone)} <Badge tone="muted">{x.source === 'staff' ? 'Church staff' : 'Member'}</Badge></div>
                    <div><div className="tiny">Asked on</div>{shortDate(x.created_at)}</div>
                  </div>
                  {x.message && <details style={{ marginTop: 8 }}><summary className="tiny" style={{ cursor: 'pointer' }}>Pasted confirmation message</summary><pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: 'var(--paper)', padding: 10, borderRadius: 8 }}>{x.message}</pre></details>}
                  {x.failure && <div style={{ marginTop: 8 }}><ErrorNote>{x.failure}</ErrorNote></div>}
                  {mine && <div style={{ marginTop: 8 }}><Note tone="warn">You gave the first approval. A different admin must give the second approval.</Note></div>}
                  {msg[x.id] && <div style={{ marginTop: 8 }}><ErrorNote>{msg[x.id]}</ErrorNote></div>}
                  {confirm && confirm.id === x.id && ((cf) => (
                    <div style={{ marginTop: 10 }}>
                      <Note tone={cf.approve ? 'warn' : 'info'}>
                        <div className="row between">
                          <span>{cf.approve
                            ? `Approve returning ${kes(x.amount_paid)}? The platform fee is returned; third-party mobile money charges are not.${needsTwo && x.status === 'pending' ? ' A second admin must still approve.' : ''}`
                            : 'Reject this request? The payment stays where it is.'}</span>
                          <span className="row"><Button kind="ghost" small onClick={() => setConfirm(null)}>Cancel</Button><Button small kind={cf.approve ? 'primary' : 'danger'} disabled={busy} onClick={() => decide(x, cf.approve)}>{busy ? 'Working…' : cf.approve ? 'Yes, approve' : 'Yes, reject'}</Button></span>
                        </div>
                      </Note>
                    </div>
                  ))(confirm)}
                </Card>
              );
            })}
          </div>
        )}
      </Load>
    </>
  );
}

// ---------------- Payments ----------------

function Payments() {
  const [stage, setStage] = useState('');
  const p = useAsync(() => api.get<any[]>(`/admin/payments${stage ? `?stage=${stage}` : ''}`), [stage]);
  return (
    <>
      <Head title="Payments" sub="The fee split below is visible only in this console." action={
        <select value={stage} onChange={(e) => setStage(e.target.value)} style={{ width: 220 }}>
          <option value="">All stages</option>
          {['suspense', 'pending', 'available', 'paid_out', 'reversed', 'refunded'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>} />
      <Card>
        <Load s={p}>
          {(rows) => rows.length === 0 ? <Empty>No payments at this stage.</Empty> : (
            <Table head={['Received', 'Code', 'Branch', 'Method', 'Reference', 'Paid', 'Platform fee', 'Provider cost', 'Church net', 'Stage']}>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{shortDate(r.received_at)}</td><td><code>{r.provider_tx_id}</code></td>
                  <td>{r.branch_name ?? <span className="tiny">Unmatched</span>}</td><td>{METHOD_LABEL[r.method] ?? r.method}</td>
                  <td>{r.reference}</td>
                  <td className="num">{kes(r.amount_paid)}</td><td className="num">{kes(r.platform_fee)}</td><td className="num">{kes(r.psp_cost)}</td><td className="num">{kes(r.net)}</td>
                  <td><StatusBadge status={r.stage} /></td>
                </tr>
              ))}
            </Table>
          )}
        </Load>
      </Card>
    </>
  );
}

// ---------------- Settlements ----------------

function Settlements({ toast }: PageProps) {
  const po = useAsync(() => api.get<any[]>('/admin/payouts'));
  const t = useAsync(() => api.get<any[]>('/admin/tenants'));
  const [run, setRun] = useState<any>();
  const [busy, setBusy] = useState(false);
  const branches = (t.data ?? []).flatMap((o) => o.branches);
  const nameOf = (id: string) => branches.find((b) => b.id === id)?.name ?? id;
  const paused = branches.filter((b) => b.payout_paused);
  const TONE: Record<string, any> = { paid: 'good', carried: 'info', paused: 'bad', failed: 'bad', nothing: 'muted', skipped: 'warn' };

  const go = async () => {
    setBusy(true);
    try { const r = await api.post('/admin/settlement/run'); setRun(r); toast('Settlement finished'); po.reload(); t.reload(); }
    catch (e: any) { toast(errText(e), 'bad'); }
    setBusy(false);
  };
  const resume = async (id: string) => {
    try { await api.post(`/admin/branches/${id}/resume`); toast('Payouts resumed'); t.reload(); } catch (e: any) { toast(errText(e), 'bad'); }
  };
  const failNext = async () => {
    try { await api.post('/admin/provider/fail-next-payout'); toast('The next payout will fail (test)'); } catch (e: any) { toast(errText(e), 'bad'); }
  };
  return (
    <>
      <Head title="Settlements" sub="Pay churches the money that has cleared the 48 hour hold." action={<Button onClick={go} disabled={busy}>{busy ? 'Running…' : 'Run settlement now'}</Button>} />
      {run && (
        <Card title="Latest run" className="">
          <p className="muted" style={{ marginTop: 0 }}>Expired suspense payments refunded: <b>{num(run.expiredSuspense)}</b></p>
          {run.results.length === 0 ? <Empty>No branches to settle.</Empty> : (
            <Table head={['Branch', 'Result', 'Amount', 'Detail']}>
              {run.results.map((r: any, i: number) => (
                <tr key={i}><td>{nameOf(r.branchId)}</td><td><Badge tone={TONE[r.status]}>{r.status}</Badge></td><td className="num">{r.amount != null ? kes(r.amount) : ''}</td><td className="muted">{r.reason ?? (r.netted ? `${kes(r.netted)} netted against debt` : '')}</td></tr>
              ))}
            </Table>
          )}
        </Card>
      )}
      <div style={{ height: 16 }} />
      {paused.length > 0 && (
        <Card title="Paused branches">
          <Table head={['Branch', '']}>
            {paused.map((b) => <tr key={b.id}><td>{b.name}</td><td><Button small onClick={() => resume(b.id)}>Resume payouts</Button></td></tr>)}
          </Table>
        </Card>
      )}
      {paused.length > 0 && <div style={{ height: 16 }} />}
      <Card title="Payouts">
        <Load s={po}>
          {(rows) => rows.length === 0 ? <Empty>No payouts yet. Run settlement once funds are ready.</Empty> : (
            <Table head={['Created', 'Branch', 'Gross', 'Netted', 'Paid out', 'Status']}>
              {rows.map((r) => (
                <tr key={r.id}><td>{shortDate(r.created_at)}</td><td>{r.branch_name}</td><td className="num">{kes(r.gross)}</td><td className="num">{kes(r.netted)}</td><td className="num">{kes(r.amount)}</td><td><StatusBadge status={r.status} />{r.failure && <div className="tiny">{r.failure}</div>}</td></tr>
              ))}
            </Table>
          )}
        </Load>
      </Card>
      <div style={{ height: 16 }} />
      <Card title="Development only: payout failure test" action={<Button kind="ghost" small onClick={failNext}>Make next payout fail</Button>}>
        <p className="muted" style={{ margin: 0 }}>Funds are never lost when a payout fails. They stay with the church and the payout is retried on the next settlement run.</p>
      </Card>
    </>
  );
}

// ---------------- Test tools ----------------

const PRESETS = [
  { label: 'GRC001#TITHE', ref: 'GRC001#TITHE' }, { label: 'GRC002#OFFERING', ref: 'GRC002#OFFERING' }, { label: 'HPC001#TITHE', ref: 'HPC001#TITHE' },
  { label: 'GRC999#TITHE (wrong code)', ref: 'GRC999#TITHE' }, { label: 'Empty reference', ref: '' },
];

function Tools({ toast }: PageProps) {
  const [phone, setPhone] = useState('0712345678');
  const [amount, setAmount] = useState('1000');
  const [reference, setReference] = useState('GRC001#TITHE');
  const [dup, setDup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<any>();
  const [clock, setClock] = useState<any>();
  const [err, setErr] = useState<string>();

  const send = async () => {
    setBusy(true); setErr(undefined);
    const p = phone.replace(/\s+/g, '').replace(/^0/, '254').replace(/^\+/, '');
    try { const r = await api.post('/admin/simulate/paybill', { phone: p, amount: Number(amount), reference, duplicate: dup }); setOut(r); toast('Payment simulated'); }
    catch (e: any) { setErr(errText(e)); }
    setBusy(false);
  };
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Could not copy. Select the code and copy it by hand.', 'bad'); }
  };
  const advance = async (hours: number) => {
    try { const r = await api.post('/admin/clock/advance', { hours }); setClock(r); toast(`Clock moved forward ${hours} hours`); } catch (e: any) { toast(errText(e), 'bad'); }
  };
  return (
    <>
      <Head title="Test tools" sub={<Badge tone="warn">Development only: simulated PSP</Badge>} />
      <div className="grid cols-2">
        <Card title="Paybill simulator">
          <div className="grid" style={{ gap: 12 }}>
            <Field label="Payer phone"><input value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
            <Field label="Amount (KES)"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
            <Field label="Account reference"><input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
            <div className="row">{PRESETS.map((p) => <Button key={p.label} kind="ghost" small onClick={() => setReference(p.ref)}>{p.label}</Button>)}</div>
            <label><input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={dup} onChange={(e) => setDup(e.target.checked)} /> Send twice (duplicate delivery). The second copy must be ignored.</label>
            <div><Button onClick={send} disabled={busy || !amount}>{busy ? 'Sending…' : 'Send payment'}</Button></div>
            {err && <ErrorNote>{err}</ErrorNote>}
            {out && (
              <Note tone="good">
                <div className="row between">
                  <span>Transaction code <b><code>{out.providerTxId}</code></b>. Members can paste it in an SMS to test reversal requests.</span>
                  <Button small kind="ghost" onClick={() => copy(out.providerTxId)}>Copy</Button>
                </div>
              </Note>
            )}
          </div>
        </Card>
        <Card title="Platform clock">
          <p className="muted" style={{ marginTop: 0 }}>Skip the 48 hour hold and the 72 hour reversal window. Money past the hold becomes ready to pay out.</p>
          <div className="row">{[1, 24, 49, 72].map((h) => <Button key={h} kind="ghost" onClick={() => advance(h)}>Advance {h}h</Button>)}</div>
          {clock && <p style={{ marginBottom: 0 }}>Clock now reads <b>{shortDate(clock.now)}</b> (skipped {num(clock.offsetHours)} hours in total).</p>}
        </Card>
      </div>
    </>
  );
}

// ---------------- Audit ----------------

function Audit() {
  const a = useAsync(() => api.get<any[]>('/admin/audit'));
  const metaText = (m: any) => {
    if (!m) return '';
    const o = typeof m === 'string' ? (() => { try { return JSON.parse(m); } catch { return m; } })() : m;
    return typeof o === 'object' ? Object.entries(o).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ') : String(o);
  };
  return (
    <>
      <Head title="Audit log" sub="The last 100 actions on the platform." action={<Button kind="ghost" onClick={a.reload}>Refresh</Button>} />
      <Card>
        <Load s={a}>
          {(rows) => rows.length === 0 ? <Empty>No activity yet.</Empty> : (
            <Table head={['Time', 'Actor', 'Action', 'Entity', 'Details']}>
              {rows.map((r) => (
                <tr key={r.id}><td>{shortDate(r.at)}</td><td className="tiny">{r.actor ?? 'system'}</td><td><b>{r.action}</b></td><td className="tiny">{r.entity ? `${r.entity} ${r.entity_id ?? ''}` : ''}</td><td className="muted">{metaText(r.meta)}</td></tr>
              ))}
            </Table>
          )}
        </Load>
      </Card>
    </>
  );
}
