import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, CertificateCard, Empty, ErrorNote, Field, HelpButton, LoginGate, Note, Spinner, Stat, StatusBadge, Table, createApi, dateOnly, kes, phonePretty, printCertificate, shortDate, useAsync, useToast } from '@churchos/ui';
import type { CertificatePayload } from '@churchos/ui';

const api = createApi('churchos:member-token');

type Tab = 'home' | 'give' | 'history' | 'church' | 'help';
const TABS: { key: Tab; label: string; ico: string }[] = [
  { key: 'home', label: 'Home', ico: '⌂' },
  { key: 'give', label: 'Give', ico: '♡' },
  { key: 'history', label: 'History', ico: '☰' },
  { key: 'church', label: 'Church', ico: '⛪' },
  { key: 'help', label: 'Help', ico: '?' },
];

const METHODS = [
  { key: 'mpesa', label: 'M-Pesa' },
  { key: 'airtel', label: 'Airtel Money' },
  { key: 'tkash', label: 'T-Kash' },
  { key: 'card', label: 'Card' },
];
const QUICK = [100, 500, 1000, 2000, 5000];

/** Friendly words for payment statuses. 'pending' is the 48 hour hold, which the member sees simply as received. */
function friendlyStatus(s: string) {
  if (s === 'pending' || s === 'available' || s === 'paid_out') return <Badge tone="good">Received</Badge>;
  if (s === 'reversed' || s === 'refunded') return <Badge tone="bad">Refunded</Badge>;
  if (s === 'suspense') return <Badge tone="warn">Under review</Badge>;
  return <StatusBadge status={s} />;
}

const errText = (e: any) => (e && typeof e.message === 'string' && e.message ? e.message : 'Something went wrong. Please try again.');

function Loading() { return <Spinner />; }
function Failed({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="stack">
      <ErrorNote>{error}</ErrorNote>
      <Button kind="ghost" onClick={retry}>Try again</Button>
    </div>
  );
}

export function App() {
  return (
    <LoginGate api={api} title="ChurchOS Member" subtitle="Give, follow your giving and stay connected to your church. Sign in with your phone number.">
      {({ user, signOut }) => <Shell user={user} signOut={signOut} />}
    </LoginGate>
  );
}

function Shell({ user, signOut }: { user: any; signOut: () => void }) {
  const initial = (): Tab => {
    const h = location.hash.replace('#', '') as Tab;
    return TABS.some((t) => t.key === h) ? h : 'home';
  };
  const [tab, setTab] = useState<Tab>(initial);
  const me = useAsync<any>(() => api.get('/me'));
  const go = (t: Tab) => { setTab(t); try { history.replaceState(null, '', `#${t}`); } catch { /* ignore */ } window.scrollTo(0, 0); };

  useEffect(() => { if (!api.getToken()) signOut(); }, [me.error]); // eslint-disable-line

  const m = me.data?.memberships?.[0];
  return (
    <>
      <main className="mobile">
        {!navigator.onLine && <Note tone="warn">You are offline. Some things may not load until you are connected.</Note>}
        {me.loading && !me.data ? <Loading /> : me.error && !me.data ? <Failed error={me.error} retry={me.reload} /> : (
          <>
            {tab === 'home' && <Home me={me.data} user={user} go={go} />}
            {tab === 'give' && <Give me={me.data} user={user} />}
            {tab === 'history' && <History />}
            {tab === 'church' && <Church me={me.data} reload={me.reload} />}
            {tab === 'help' && <Help />}
          </>
        )}
        <p className="tiny no-print" style={{ textAlign: 'center', marginTop: 24 }}>
          {m ? `${m.branch_name} · ` : ''}{phonePretty(user?.phone)} ·{' '}
          <a href="#signout" onClick={(e) => { e.preventDefault(); signOut(); }}>Sign out</a>
        </p>
      </main>
      <style>{`.mobile { padding-bottom: 150px; } .notif-unread { background: rgba(127,127,127,0.1); border-left: 3px solid var(--brand); padding-left: 10px; }`}</style>
      <HelpButton api={api} audience="member" screen={`member.${tab}`} />
      <nav className="tabbar" aria-label="Main">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'active' : ''} aria-current={tab === t.key ? 'page' : undefined} onClick={() => go(t.key)}>
            <span className="ico" aria-hidden="true">{t.ico}</span>{t.label}
          </button>
        ))}
      </nav>
    </>
  );
}

// ---------------- Home ----------------

function Home({ me, user, go }: { me: any; user: any; go: (t: Tab) => void }) {
  const m = me?.memberships?.[0];
  const giving = useAsync<any>(() => api.get('/me/giving'));
  const pledges = useAsync<any[]>(() => api.get('/me/pledges'));
  const first = String(m?.full_name ?? user?.name ?? '').split(' ')[0];
  return (
    <div className="stack">
      <div className="hero">
        <h1>Hello{first ? `, ${first}` : ''}</h1>
        {m ? (
          <div className="sub">{m.branch_name} · {m.org_name}<br />Member no. {m.member_number}</div>
        ) : (
          <div className="sub">You are not linked to a church yet. Ask your church to add you, or request a move in the Church tab.</div>
        )}
        <Button onClick={() => go('give')}>Give now</Button>
      </div>

      <Notifications />

      {giving.loading ? <Loading /> : giving.error ? <Failed error={giving.error} retry={giving.reload} /> : (
        <Stat label="Total given" value={kes(giving.data?.total ?? 0)} hint={giving.data?.rows?.length ? `${giving.data.rows.length} gift${giving.data.rows.length === 1 ? '' : 's'}` : 'Your first gift will show here'} />
      )}

      <Card title="My pledges">
        {pledges.loading ? <Loading /> : pledges.error ? <Failed error={pledges.error} retry={pledges.reload} /> : !pledges.data?.length ? (
          <Empty>No pledges yet. You can pledge to a church project from the Give tab.</Empty>
        ) : (
          <ul className="list">
            {pledges.data.map((p) => {
              const pct = p.amount > 0 ? Math.min(100, Math.round((p.paid / p.amount) * 100)) : 0;
              return (
                <li key={p.id}>
                  <div className="row"><strong>{p.project}</strong><span className="tiny">{pct}%</span></div>
                  <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${p.project} pledge progress`}><i style={{ width: `${pct}%` }} /></div>
                  <div className="tiny">{kes(p.paid)} given of {kes(p.amount)} pledged</div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Notifications() {
  const n = useAsync<any>(() => api.get('/me/notifications'));
  const [busy, setBusy] = useState(false);
  const reloadRef = useRef(n.reload);
  reloadRef.current = n.reload;

  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') reloadRef.current(); };
    const timer = setInterval(tick, 20000);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('churchos:gift-done', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); window.removeEventListener('churchos:gift-done', tick); };
  }, []);

  const markAll = async () => {
    setBusy(true);
    try { await api.post('/me/notifications/read', {}); } catch { /* the refresh shows the truth */ }
    setBusy(false);
    n.reload();
  };

  const rows: any[] = n.data?.rows ?? [];
  const unread = Number(n.data?.unread ?? 0);
  return (
    <Card title="Notifications">
      {n.loading && !n.data ? <Loading /> : n.error && !n.data ? <Failed error={n.error} retry={n.reload} /> : !rows.length ? (
        <Empty>Nothing new yet. Receipts and reminders from your church will appear here.</Empty>
      ) : (
        <div className="stack">
          <div className="row">
            {unread > 0 ? <Badge tone="warn">{unread} unread</Badge> : <span className="tiny">All caught up</span>}
            <Button kind="ghost" small disabled={busy || unread === 0} onClick={markAll}>Mark all as read</Button>
          </div>
          <ul className="list">
            {rows.map((r) => (
              <li key={r.id} className={r.read ? '' : 'notif-unread'}>
                <div className="row"><strong>{r.title}</strong><span className="tiny">{shortDate(r.created_at)}</span></div>
                <div className="muted">{r.body}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

// ---------------- Give ----------------

type Receipt = { status: string; church: string; purpose: string; amountPaid: number; receipt: string | null };

function Give({ me, user }: { me: any; user: any }) {
  const m = me?.memberships?.[0];
  const code: string | undefined = m?.branch_code;
  const church = useAsync<any>(() => (code ? api.get(`/public/church/${encodeURIComponent(code)}`) : Promise.resolve(undefined)), [code]);
  const [purpose, setPurpose] = useState('TITHE');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('mpesa');
  const [phone, setPhone] = useState(phonePretty(user?.phone));
  const [fee, setFee] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [intent, setIntent] = useState<{ id: string; message: string } | null>(null);
  const [result, setResult] = useState<Receipt | null>(null);
  const [slow, setSlow] = useState(false);
  const [pledgeOpen, setPledgeOpen] = useState(false);
  const toast = useToast();

  const n = Number(amount);
  const valid = Number.isFinite(n) && n >= 10 && n <= 150000;
  const bearerMember = church.data?.feeBearer === 'member';

  useEffect(() => {
    setFee(0);
    if (!bearerMember || !valid || !code) return;
    let alive = true;
    api.get(`/public/fee?code=${encodeURIComponent(code)}&amount=${n}&method=${method}`).then((r) => alive && setFee(r.memberFee ?? 0)).catch(() => {});
    return () => { alive = false; };
  }, [bearerMember, valid, n, method, code]);

  // poll the gift until it settles; after 90s stop without claiming failure
  useEffect(() => {
    if (!intent) return;
    let alive = true;
    const started = Date.now();
    const timer = setInterval(async () => {
      try {
        const r: Receipt = await api.get(`/public/give/${intent.id}`);
        if (!alive) return;
        if (r.status === 'completed' || r.status === 'failed') { clearInterval(timer); setResult(r); setIntent(null); window.dispatchEvent(new Event('churchos:gift-done')); return; }
      } catch { /* keep trying until the time is up */ }
      if (alive && Date.now() - started > 90000) { clearInterval(timer); setSlow(true); setIntent(null); }
    }, 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [intent]);

  const reset = () => { setResult(null); setSlow(false); setAmount(''); setError(undefined); setIntent(null); };

  const give = async () => {
    setBusy(true); setError(undefined);
    try {
      const r = await api.post('/public/give', { code, phone, amount: n, method, purpose });
      setIntent({ id: r.intentId, message: r.message });
    } catch (e) { setError(errText(e)); }
    setBusy(false);
  };

  if (!m) return <Card title="Give"><Empty>You are not linked to a church yet, so we cannot show where to give. Visit the Church tab to request a move.</Empty></Card>;
  if (church.loading) return <Loading />;
  if (church.error || !church.data) return <Failed error={church.error ?? 'We could not load your church.'} retry={church.reload} />;

  if (result) {
    const ok = result.status === 'completed';
    return (
      <Card className="receipt">
        <div className="big-amount">{kes(result.amountPaid)}</div>
        {ok ? (
          <>
            <Note tone="good">Thank you. Your gift to {result.church} was received.</Note>
            <p className="muted">Receipt code <strong>{result.receipt}</strong></p>
          </>
        ) : (
          <Note tone="warn">The payment did not go through, so nothing was taken. You can try again when you are ready.</Note>
        )}
        <Button onClick={reset}>{ok ? 'Give again' : 'Try again'}</Button>
      </Card>
    );
  }
  if (slow) {
    return (
      <Card>
        <Note tone="info">We are still waiting for the confirmation from your phone company. If you entered your PIN, your gift will appear in History shortly. Please do not pay twice.</Note>
        <div style={{ height: 12 }} />
        <Button kind="ghost" onClick={reset}>Back</Button>
      </Card>
    );
  }
  if (intent) {
    return (
      <Card>
        <Spinner />
        <p style={{ textAlign: 'center' }}><strong>{intent.message}</strong></p>
        <p className="tiny" style={{ textAlign: 'center' }}>Waiting for confirmation…</p>
      </Card>
    );
  }

  const projects: any[] = church.data.projects ?? [];
  return (
    <div className="stack">
      <Card title={`Give to ${church.data.name}`}>
        <div className="stack">
          <div>
            <div className="field-label" id="purpose-l">What is it for?</div>
            <div className="chips" role="group" aria-labelledby="purpose-l" style={{ marginTop: 6 }}>
              {church.data.purposes.map((p: any) => (
                <button key={p.key} type="button" className={`chip ${purpose === p.key ? 'on' : ''}`} aria-pressed={purpose === p.key} onClick={() => setPurpose(p.key)}>{p.label}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="field-label" id="amt-l">Amount (KES)</div>
            <div className="chips" role="group" aria-labelledby="amt-l" style={{ margin: '6px 0' }}>
              {QUICK.map((q) => (
                <button key={q} type="button" className={`chip ${n === q ? 'on' : ''}`} aria-pressed={n === q} onClick={() => setAmount(String(q))}>{q.toLocaleString('en-KE')}</button>
              ))}
            </div>
            <Field label="Other amount" hint="KES 10 to KES 150,000" error={amount && !valid ? 'Enter an amount between 10 and 150,000' : undefined}>
              <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="e.g. 750" />
            </Field>
          </div>
          <div>
            <div className="field-label" id="meth-l">Pay with</div>
            <div className="chips" role="group" aria-labelledby="meth-l" style={{ marginTop: 6 }}>
              {METHODS.map((x) => (
                <button key={x.key} type="button" className={`chip ${method === x.key ? 'on' : ''}`} aria-pressed={method === x.key} onClick={() => setMethod(x.key)}>{x.label}</button>
              ))}
            </div>
          </div>
          <Field label="Phone to pay from"><input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          {bearerMember && valid && fee > 0 && <Note tone="info">A service fee of {kes(fee)} is added. You will pay {kes(Math.round(n * 100) + fee)} in total.</Note>}
          {error && <ErrorNote>{error}</ErrorNote>}
          <Button disabled={busy || !valid || phone.trim().length < 9} onClick={give}>{busy ? 'Sending…' : valid ? `Give ${kes(Math.round(n * 100))}` : 'Give'}</Button>
        </div>
      </Card>

      <Card title="Make a pledge">
        {!projects.length ? <Empty>There are no open projects to pledge to right now.</Empty> : pledgeOpen ? (
          <PledgeForm church={church.data} projects={projects} onDone={() => { setPledgeOpen(false); toast.show('Pledge saved. Thank you.'); }} />
        ) : (
          <div className="stack">
            <p className="muted" style={{ margin: 0 }}>Promise a gift to a church project and track your progress on the Home tab.</p>
            <Button kind="ghost" onClick={() => setPledgeOpen(true)}>Pledge to a project</Button>
          </div>
        )}
      </Card>
      {toast.node}
    </div>
  );
}

function PledgeForm({ church, projects, onDone }: { church: any; projects: any[]; onDone: () => void }) {
  const [proj, setProj] = useState(projects[0].code);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const n = Number(amount);
  const submit = async () => {
    setBusy(true); setError(undefined);
    try { await api.post('/me/pledges', { churchCode: church.code, projectCode: proj, amount: n }); onDone(); }
    catch (e) { setError(errText(e)); }
    setBusy(false);
  };
  return (
    <div className="stack">
      <div className="chips" role="group" aria-label="Project">
        {projects.map((p) => <button key={p.code} type="button" className={`chip ${proj === p.code ? 'on' : ''}`} aria-pressed={proj === p.code} onClick={() => setProj(p.code)}>{p.name}</button>)}
      </div>
      <Field label="Pledge amount (KES)"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="e.g. 20000" /></Field>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button disabled={busy || !(n > 0)} onClick={submit}>{busy ? 'Saving…' : 'Save pledge'}</Button>
    </div>
  );
}

// ---------------- History ----------------

function purposeLabel(p: string | null) {
  if (!p) return 'Gift';
  if (p.startsWith('PROJ-')) return `Project ${p.slice(5)}`;
  return p.charAt(0) + p.slice(1).toLowerCase();
}

function History() {
  const g = useAsync<any>(() => api.get('/me/giving'));
  const [statement, setStatement] = useState(false);
  if (g.loading) return <Loading />;
  if (g.error) return <Failed error={g.error} retry={g.reload} />;
  const rows: any[] = g.data?.rows ?? [];

  if (statement) {
    return (
      <div className="stack">
        <div className="row no-print">
          <Button kind="ghost" small onClick={() => setStatement(false)}>Back</Button>
          <Button small onClick={() => window.print()}>Print</Button>
        </div>
        <h1>Giving statement</h1>
        <p className="muted">Prepared {dateOnly(new Date().toISOString())}</p>
        <Table head={['Date', 'Church', 'Purpose', 'Amount', 'Receipt']}>
          {rows.map((r) => (
            <tr key={r.id}><td>{dateOnly(r.date)}</td><td>{r.church}</td><td>{purposeLabel(r.purpose)}</td><td>{kes(r.amount)}</td><td>{r.receipt}</td></tr>
          ))}
        </Table>
        <p><strong>Total: {kes(g.data?.total ?? 0)}</strong></p>
        <p className="tiny">Refunded gifts are not counted in the total.</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <Stat label="Total given" value={kes(g.data?.total ?? 0)} />
      <Button kind="ghost" onClick={() => setStatement(true)} disabled={!rows.length}>Giving statement</Button>
      <Card title="My giving">
        {!rows.length ? <Empty>No gifts yet. When you give, your receipts will appear here.</Empty> : (
          <ul className="list">
            {rows.map((r) => (
              <li key={r.id}>
                <div className="row"><strong>{purposeLabel(r.purpose)}</strong><span className="amt">{kes(r.amount)}</span></div>
                <div className="row"><span className="tiny">{shortDate(r.date)} · {r.church ?? 'Church'}</span>{friendlyStatus(r.status)}</div>
                {r.receipt && <div className="tiny">Receipt {r.receipt}</div>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------------- Church ----------------

const REL: Record<string, string> = { Adult: 'Adult', Child: 'Child' };

function Church({ me, reload }: { me: any; reload: () => void }) {
  const ms: any[] = me?.memberships ?? [];
  const household: any[] = me?.household ?? [];
  const transfers: any[] = me?.transfers ?? [];
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const toast = useToast();

  const request = async () => {
    setBusy(true); setError(undefined);
    try {
      const r = await api.post('/me/transfer-request', { toChurchCode: code });
      toast.show(`Request sent to ${r.to}`);
      setCode('');
      reload();
    } catch (e) { setError(errText(e)); }
    setBusy(false);
  };

  return (
    <div className="stack">
      <Card title="My membership">
        {!ms.length ? <Empty>You are not linked to a church yet.</Empty> : (
          <ul className="list">
            {ms.map((m) => (
              <li key={m.id}>
                <div className="row"><strong>{m.branch_name}</strong><Badge tone="good">Active</Badge></div>
                <div className="tiny">{m.org_name} · Member no. {m.member_number}{m.joined_at ? ` · Joined ${dateOnly(m.joined_at)}` : ''}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <MyRecords />

      <Card title="My household">
        {!household.length ? <Empty>No household recorded yet.</Empty> : (
          <ul className="list">
            {household.map((h) => (
              <li key={h.id}>
                <div className="row"><strong>{h.full_name}</strong><span className="tiny">{h.member_number}</span></div>
                <div className="tiny">{REL[h.relationship] ?? h.relationship ?? 'Member'}{h.is_primary_contact ? ' · primary contact' : ''}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Moving to a new church?">
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>
            The new church must approve your request. You keep your own record: in the same church you keep your member number, in a different church you get a new one, and your old church keeps its own history.
          </p>
          <Field label="New church code" hint="For example GRC002 or HPC001">
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="GRC002" autoCapitalize="characters" />
          </Field>
          {error && <ErrorNote>{error}</ErrorNote>}
          <Button disabled={busy || code.trim().length < 3} onClick={request}>{busy ? 'Sending…' : 'Request to move'}</Button>
        </div>
      </Card>

      {transfers.length > 0 && (
        <Card title="My requests">
          <ul className="list">
            {transfers.map((t) => (
              <li key={t.id}>
                <div className="row"><strong>{t.from_name} to {t.to_name}</strong><StatusBadge status={t.status} /></div>
                <div className="tiny">{dateOnly(t.created_at)}</div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {toast.node}
    </div>
  );
}

// ---------------- Records ----------------

const CARD_WIDTH = 1040;

/** Draws the certificate card at its fixed width, scaled down to fit the screen. */
function ScaledCard({ c }: { c: CertificatePayload }) {
  const ref = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(() => Math.min(1, (Math.min(window.innerWidth, 480) - 32) / CARD_WIDTH));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => { const w = el.clientWidth; if (w > 0) setZoom(Math.min(1, w / CARD_WIDTH)); };
    measure();
    if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure); }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ width: '100%', overflow: 'hidden' }}>
      <div style={{ zoom } as any}><CertificateCard c={c} /></div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { baptism: 'Baptism', marriage: 'Marriage' };
type CopyResult = { status: string; fee: number; purpose?: string; churchCode: string; render: CertificatePayload | null };

function MyRecords() {
  const recs = useAsync<any[]>(() => api.get('/me/records'));
  const [open, setOpen] = useState<any | null>(null);

  if (open) return <RecordView rec={open} onBack={() => setOpen(null)} />;
  const rows = recs.data ?? [];
  return (
    <Card title="My records">
      {recs.loading && !recs.data ? <Loading /> : recs.error && !recs.data ? <Failed error={recs.error} retry={recs.reload} /> : !rows.length ? (
        <Empty>Baptism and marriage records appear here once your church has approved them.</Empty>
      ) : (
        <ul className="list">
          {rows.map((r) => (
            <li key={r.id}>
              <div className="row"><strong>{KIND_LABEL[r.kind] ?? r.kind}</strong><span className="tiny">{dateOnly(r.event_date)}</span></div>
              <div>{r.subject_name}</div>
              <div className="tiny">{r.place}</div>
              <div className="tiny">Held by {r.church}</div>
              {r.held_elsewhere && <div className="tiny">This record stays with the church that holds it</div>}
              <div style={{ marginTop: 8 }}>
                <Button kind="ghost" small onClick={() => setOpen(r)}>{r.can_print ? 'View card' : 'View details'}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RecordView({ rec, onBack }: { rec: any; onBack: () => void }) {
  const preview = useAsync<CertificatePayload | undefined>(() => (rec.can_print ? api.get(`/me/records/${encodeURIComponent(rec.id)}/render`) : Promise.resolve(undefined)), [rec.id]);
  const [copy, setCopy] = useState<CopyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [checked, setChecked] = useState(false);

  const ask = async () => {
    setBusy(true); setError(undefined);
    try { setCopy(await api.post(`/me/records/${encodeURIComponent(rec.id)}/copy`, {})); setChecked(true); }
    catch (e) { setError(errText(e)); }
    setBusy(false);
  };

  const issued = copy?.status === 'issued' && copy.render;
  const waiting = copy?.status === 'awaiting_payment';
  const serial = copy?.purpose ? copy.purpose.replace(/^CERT-/, '') : '';
  const payUrl = waiting && copy ? `${location.protocol}//${location.hostname}:3001/${encodeURIComponent(copy.churchCode)}?cert=${encodeURIComponent(serial)}` : '';

  return (
    <div className="stack">
      <div className="row no-print"><Button kind="ghost" small onClick={onBack}>Back</Button></div>
      <Card title={`${KIND_LABEL[rec.kind] ?? rec.kind} record`} className="no-print">
        <div className="stack">
          <div><strong>{rec.subject_name}</strong></div>
          <div className="tiny">{dateOnly(rec.event_date)} · {rec.place}</div>
          <div className="tiny">Held by {rec.church}</div>
          {rec.held_elsewhere && <div className="tiny">This record stays with the church that holds it</div>}
          {!rec.can_print && <Note tone="info">A marriage certificate is a legal document. Ask your church office or the registry for a copy.</Note>}
        </div>
      </Card>

      {rec.can_print && (
        <>
          {issued ? (
            <>
              <ScaledCard c={copy!.render!} />
              <div className="no-print"><Button onClick={() => printCertificate()}>Print / Save as PDF</Button></div>
            </>
          ) : preview.loading ? <Loading /> : preview.error ? <Failed error={preview.error} retry={preview.reload} /> : preview.data ? (
            <ScaledCard c={preview.data} />
          ) : null}

          {!issued && (
            <div className="stack no-print">
              {waiting && copy && (
                <Note tone="info">
                  A copy of this certificate costs {kes(copy.fee)}. Pay through your church's giving page and it will appear here.
                </Note>
              )}
              {checked && waiting && <p className="tiny" style={{ margin: 0 }}>We have not seen the payment yet. It can take a minute to arrive.</p>}
              {error && <ErrorNote>{error}</ErrorNote>}
              {waiting && copy ? (
                <>
                  <a className="btn" href={payUrl} target="_blank" rel="noopener noreferrer" style={{ textAlign: 'center', textDecoration: 'none' }}>Pay for my copy</a>
                  <Button kind="ghost" disabled={busy} onClick={ask}>{busy ? 'Checking…' : 'I have paid, check again'}</Button>
                </>
              ) : (
                <>
                  <Button disabled={busy} onClick={ask}>{busy ? 'One moment…' : 'Get my card'}</Button>
                  <p className="tiny" style={{ margin: 0 }}>Your first card is free. Later copies follow your church's price.</p>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------- Help ----------------

function Help() {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [found, setFound] = useState<any>(null);

  const send = async () => {
    setBusy(true); setError(undefined);
    try { setFound(await api.post('/me/reversal-request', { message })); setMessage(''); }
    catch (e) { setError(errText(e)); }
    setBusy(false);
  };

  return (
    <div className="stack">
      <Card title="Help articles">
        <p className="muted" style={{ margin: 0 }}>Browse help articles: tap the Help button at the bottom right of any screen.</p>
      </Card>
      <Card title="Payment help">
        <div className="stack">
          <h3 style={{ fontSize: '1.05rem' }}>I paid the wrong church or the wrong amount</h3>
          {found ? (
            <>
              <Note tone="good">
                We found your payment <strong>{found.found?.transactionCode}</strong> of {kes(found.found?.amount)}. It is {found.found?.where}.
              </Note>
              <p className="muted" style={{ margin: 0 }}>A ChurchOS agent will review your request. A refund returns the church fee, but charges made by the mobile money company are not refunded.</p>
              <Button kind="ghost" onClick={() => setFound(null)}>Report another payment</Button>
            </>
          ) : (
            <>
              <p className="muted" style={{ margin: 0 }}>Paste the whole M-Pesa or Airtel confirmation message you received, including the transaction code.</p>
              <Field label="Confirmation message">
                <textarea rows={5} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="QK12ABC34D Confirmed. Ksh500.00 sent to ..." />
              </Field>
              {error && <ErrorNote>{error}</ErrorNote>}
              <Button disabled={busy || message.trim().length < 10} onClick={send}>{busy ? 'Sending…' : 'Send'}</Button>
              <p className="tiny" style={{ margin: 0 }}>This is a rule-based helper, not a person. A real agent reviews every request.</p>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
