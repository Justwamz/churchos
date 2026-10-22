import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Empty, ErrorNote, Field, Note, Spinner, Table, kes, openExternal, phonePretty, shortDate, useAsync } from '@churchos/ui';
import { api, friendly, methodLabel, useSession, type Session } from './session';
import { Load } from './bits';
import { Card as UCard, EmptyState, PageHeader, SidePanel, Skeleton, Stat, StatTiles, StatusChip } from './ui';
import './comm.css';

/** Only send ?org= for people who belong to several churches, like the other pages. */
export const orgQs = (s: Session) => (s.orgs.length > 1 ? `?org=${s.grant.org.id}` : '');

export type WalletInfo = {
  id: string; branchId: string | null; channel: 'sms' | 'whatsapp'; scope: string; label: string; balance: number; rate: number;
  messagesLeft: number; threshold: number; state: 'ok' | 'low' | 'empty'; paybillReference: string; canTopUp: boolean; canManage: boolean;
  price?: { current: number; next: number | null; unitsLeftInBand: number | null; usedThisMonth: number; month: string };
};

const STATE: Record<string, { text: string; tone: 'done' | 'wait' | 'bad' }> = {
  ok: { text: 'Healthy', tone: 'done' }, low: { text: 'Running low', tone: 'wait' }, empty: { text: 'Empty', tone: 'bad' },
};
const CH = { sms: 'SMS', whatsapp: 'WhatsApp' } as const;

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <SidePanel title={title} onClose={onClose} width={460}><div className="stack">{children}</div></SidePanel>;
}

// ---------- top-up journey ----------

const PRESETS = [100, 500, 1000, 5000];
const fmt = (n: number) => n.toLocaleString('en-KE');

function TopUp({ wallet, onClose, onDone }: { wallet: WalletInfo; onClose: () => void; onDone: () => void }) {
  const session = useSession();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [amount, setAmount] = useState<number>(500);
  const [custom, setCustom] = useState('');
  const [method, setMethod] = useState<'mpesa' | 'card'>('mpesa');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [topup, setTopup] = useState<any>();
  const [phase, setPhase] = useState<'idle' | 'starting' | 'waiting' | 'done' | 'timeout' | 'failed'>('idle');
  const [newBalance, setNewBalance] = useState<number | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    api.get('/me/profile').then((p: any) => { if (alive.current && p?.phone) setPhone(phonePretty(p.phone)); }).catch(() => {});
  }, []);

  const amountOk = Number.isFinite(amount) && amount >= 100 && amount <= 50000;

  const poll = (id: string) => {
    const started = Date.now();
    const tick = async () => {
      if (!alive.current) return;
      try {
        const t: any = await api.get(`/wallets/topups/${id}`);
        if (!alive.current) return;
        if (t.status === 'completed') {
          try {
            const r: any = await api.get('/wallets' + orgQs(session));
            const w = (r.wallets as WalletInfo[]).find((x) => x.id === wallet.id);
            if (w && alive.current) setNewBalance(w.balance);
          } catch { /* the success screen still shows */ }
          if (alive.current) { setPhase('done'); onDone(); }
          return;
        }
        if (t.status === 'failed') { setPhase('failed'); return; }
      } catch { /* keep trying until the time is up */ }
      if (Date.now() - started > 180_000) { if (alive.current) setPhase('timeout'); return; }
      setTimeout(tick, 1500);
    };
    setTimeout(tick, 1500);
  };

  const pay = async () => {
    setError(''); setPhase('starting'); setPopupBlocked(false);
    try {
      const r: any = await api.post(`/wallets/${wallet.id}/topup`, { amount, method, phone: method === 'mpesa' ? phone : undefined });
      setTopup(r); setPhase('waiting');
      if (method === 'card' && r.checkoutUrl) {
        if (!openExternal(r.checkoutUrl)) setPopupBlocked(true);
      }
      poll(r.id);
    } catch (e: any) { setError(friendly(e.message)); setPhase('idle'); }
  };

  return (
    <Modal title={`Top up ${wallet.label}`} onClose={onClose}>
      {step === 1 && (
        <>
          <p className="muted">How much credit would you like to add? Messages cost {kes(wallet.price?.current ?? wallet.rate)} each right now. The price drops as you send more in a month.</p>
          <div className="chips" style={{ marginBottom: 12 }}>
            {PRESETS.map((p) => (
              <button key={p} type="button" className={`chip ${!custom && amount === p ? 'on' : ''}`} onClick={() => { setAmount(p); setCustom(''); }}>KES {fmt(p)}</button>
            ))}
          </div>
          <Field label="Or enter another amount (KES)" hint="From KES 100 to KES 50,000">
            <input inputMode="numeric" placeholder="e.g. 2500" value={custom} onChange={(e) => { const v = e.target.value.replace(/[^\d]/g, ''); setCustom(v); if (v) setAmount(Number(v)); }} />
          </Field>
          {!amountOk && <Note tone="warn">Enter an amount between KES 100 and KES 50,000.</Note>}
          <Button disabled={!amountOk} onClick={() => setStep(2)}>{`Continue with KES ${fmt(amount)}`}</Button>
        </>
      )}
      {step === 2 && (
        <>
          <p className="muted">How would you like to pay KES {fmt(amount)}?</p>
          <div className="comm-pay">
            {(['mpesa', 'card'] as const).map((m) => (
              <button key={m} type="button" onClick={() => setMethod(m)} aria-pressed={method === m}
                className={`comm-choice ${method === m ? 'on' : ''}`}>
                <b style={{ fontSize: 17 }}>{m === 'mpesa' ? 'M-Pesa' : 'Card'}</b>
                <div className="tiny">{m === 'mpesa' ? 'We send a prompt to your phone. Enter your PIN.' : "Pay on the payment provider's secure page."}</div>
                {m === 'card' && <div className="tiny" style={{ marginTop: 4 }}>Development build: use 4242 4242 4242 4242</div>}
              </button>
            ))}
          </div>
          {method === 'mpesa' && (
            <Field label="M-Pesa phone number" hint="The number that will get the prompt">
              <input inputMode="tel" placeholder="07XX XXX XXX" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
          )}
          <div className="row">
            <Button kind="ghost" onClick={() => setStep(1)}>Back</Button>
            <Button disabled={method === 'mpesa' && phone.replace(/\D/g, '').length < 9} onClick={() => { setStep(3); pay(); }}>{`Pay KES ${fmt(amount)}`}</Button>
          </div>
        </>
      )}
      {step === 3 && (
        <>
          {phase === 'starting' && <div style={{ padding: 16 }}><Spinner /><p className="muted" style={{ textAlign: 'center' }}>Starting your payment…</p></div>}
          {error && <><ErrorNote>{error}</ErrorNote><Button kind="ghost" onClick={() => { setError(''); setPhase('idle'); setStep(2); }}>Go back</Button></>}
          {phase === 'waiting' && (
            <div style={{ textAlign: 'center' }}>
              <Spinner />
              {method === 'mpesa' ? (
                <>
                  <h3>Check your phone and enter your PIN</h3>
                  <p className="muted">{topup?.message ?? `We sent a prompt to ${phone}.`}</p>
                </>
              ) : (
                <>
                  <h3>Complete the payment on the secure page, then come back here</h3>
                  {popupBlocked && topup?.checkoutUrl && <p><a href={topup.checkoutUrl} target="_blank" rel="noreferrer noopener"><b>Open the secure card page</b></a></p>}
                  {!popupBlocked && topup?.checkoutUrl && <p className="tiny">Page did not open? <a href={topup.checkoutUrl} target="_blank" rel="noreferrer noopener">Open the secure card page</a></p>}
                </>
              )}
              <p className="tiny">This screen updates by itself when the payment arrives.</p>
            </div>
          )}
          {phase === 'done' && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 40, color: 'var(--good)' }} aria-hidden>✓</div>
              <h3>Top-up received</h3>
              <p className="muted">KES {fmt(amount)} was added to {wallet.label}.</p>
              {newBalance !== null && <p>New balance<br /><b style={{ fontSize: '2rem' }}>{kes(newBalance)}</b></p>}
              <Button onClick={onClose}>Done</Button>
            </div>
          )}
          {phase === 'timeout' && (
            <>
              <Note>Still waiting. If you have paid, your balance will update shortly.</Note>
              <Button onClick={onClose}>Close</Button>
            </>
          )}
          {phase === 'failed' && (
            <>
              <Note tone="warn">This payment was not completed, so no credit was added. You can try again.</Note>
              <div className="row"><Button onClick={() => { setStep(2); setPhase('idle'); }}>Try again</Button><Button kind="ghost" onClick={onClose}>Close</Button></div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

// ---------- move credit, warning level, activity ----------

function MoveCredit({ wallet, all, onClose, onDone }: { wallet: WalletInfo; all: WalletInfo[]; onClose: () => void; onDone: () => void }) {
  const targets = all.filter((w) => w.channel === wallet.channel && w.id !== wallet.id && w.canManage);
  const [to, setTo] = useState(targets[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true); setError('');
    try {
      await api.post('/wallets/transfer', { fromWalletId: wallet.id, toWalletId: to, amount: Number(amount) });
      onDone(); onClose();
    } catch (e: any) { setError(friendly(e.message)); }
    setBusy(false);
  };
  return (
    <Modal title="Move credit" onClose={onClose}>
      <p className="muted">Move {CH[wallet.channel]} credit from <b>{wallet.label}</b> (balance {kes(wallet.balance)}) to another {CH[wallet.channel]} wallet in your church.</p>
      {targets.length === 0 ? <Empty>There is no other {CH[wallet.channel]} wallet you can move credit to.</Empty> : (
        <>
          <Field label="Move to">
            <select value={to} onChange={(e) => setTo(e.target.value)}>{targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
          </Field>
          <Field label="Amount (KES)"><input inputMode="decimal" placeholder="e.g. 500" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          {error && <ErrorNote>{error}</ErrorNote>}
          <Button disabled={busy || !to || !(Number(amount) > 0)} onClick={go}>{busy ? 'Moving…' : 'Move credit'}</Button>
        </>
      )}
    </Modal>
  );
}

function Threshold({ wallet, onClose, onDone }: { wallet: WalletInfo; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState(String(wallet.threshold / 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ok = v !== '' && Number(v) >= 0 && Number(v) <= 50000;
  const save = async () => {
    setBusy(true); setError('');
    try { await api.put(`/wallets/${wallet.id}/threshold`, { threshold: Number(v) }); onDone(); onClose(); } catch (e: any) { setError(friendly(e.message)); }
    setBusy(false);
  };
  return (
    <Modal title="Warning level" onClose={onClose}>
      <p className="muted">When {wallet.label} drops below this amount, everyone who can see it is told that credit is running low.</p>
      <Field label="Warn me below (KES)" hint="Between KES 0 and KES 50,000"><input inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} /></Field>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button disabled={busy || !ok} onClick={save}>{busy ? 'Saving…' : 'Save warning level'}</Button>
    </Modal>
  );
}

function Activity({ wallet }: { wallet: WalletInfo }) {
  const { data, error, loading } = useAsync<any>(() => api.get(`/wallets/${wallet.id}/activity`), [wallet.id]);
  return (
    <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <Load loading={loading} error={error} hasData={!!data}>
        {data && (
          <div className="stack">
            <div>
              <h3 style={{ marginBottom: 6 }}>Top-ups</h3>
              {data.topups.length === 0 ? <Empty>No top-ups yet.</Empty> : (
                <Table head={['Date', 'How', 'Amount', 'Status']}>
                  {data.topups.map((t: any) => (
                    <tr key={t.id}><td>{shortDate(t.created_at)}</td><td>{methodLabel(t.method)}</td><td className="mono">{kes(t.amount)}</td>
                      <td><StatusChip tone={t.status === 'completed' ? 'done' : t.status === 'failed' ? 'bad' : 'wait'}>{t.status === 'completed' ? 'Received' : t.status === 'failed' ? 'Not completed' : 'Waiting'}</StatusChip></td></tr>
                  ))}
                </Table>
              )}
            </div>
            <div>
              <h3 style={{ marginBottom: 6 }}>What messages cost</h3>
              {data.spent.length === 0 ? <Empty>No messages have been paid from this wallet yet.</Empty> : (
                <Table head={['Message', 'Sent', 'Channel', 'Delivered', 'Cost']}>
                  {data.spent.map((m: any) => (
                    <tr key={`${m.message_id}:${m.channel}`}><td>{m.title || 'Message'}</td><td>{shortDate(m.sent_at)}</td><td>{CH[m.channel as 'sms' | 'whatsapp'] ?? m.channel}</td><td>{Number(m.sent)}</td><td className="mono">{kes(m.cost)}</td></tr>
                  ))}
                </Table>
              )}
            </div>
          </div>
        )}
      </Load>
    </div>
  );
}

// ---------- the cards ----------

function WalletCard({ w, all, reload }: { w: WalletInfo; all: WalletInfo[]; reload: () => void }) {
  const [modal, setModal] = useState<'' | 'topup' | 'move' | 'level'>('');
  const [showAct, setShowAct] = useState(false);
  const [copied, setCopied] = useState(false);
  const st = STATE[w.state] ?? STATE.ok;
  const copy = async () => {
    try { await navigator.clipboard.writeText(w.paybillReference); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* ignore */ }
  };
  return (
    <section className="u-card comm-wallet">
      <div className="comm-wallet-top">
        <div><StatusChip tone="info">{CH[w.channel]}</StatusChip> <b>{w.label}</b></div>
        <StatusChip tone={st.tone}>{st.text}</StatusChip>
      </div>
      <div className={`comm-balance s-${w.state}`}>{kes(w.balance)}</div>
      <div className="muted">About {fmt(w.messagesLeft)} messages left</div>
      {w.state === 'low' && <div className="comm-calm low">Credit is getting low. Top up when you can so messages keep going out.</div>}
      {w.state === 'empty' && <div className="comm-calm out"><b>No credit left.</b> {CH[w.channel]} messages are paused until you top up. In-app messages still go out.</div>}
      {w.price && (
        <div className="tiny">
          Costs {kes(w.price.current)} per {w.channel === 'sms' ? 'SMS' : 'message'} now.
          {w.price.unitsLeftInBand !== null && w.price.next !== null && <> {fmt(w.price.unitsLeftInBand)} more at this price, then {kes(w.price.next)} per {w.channel === 'sms' ? 'SMS' : 'message'}.</>}
          {w.price.unitsLeftInBand === null && <> This is the lowest price.</>}
          {' '}Used this month: {fmt(w.price.usedThisMonth)}.
        </div>
      )}
      <div className="tiny">Warning level {kes(w.threshold)}</div>
      <div className="comm-ref">
        <div><div className="tiny">Or top up by paybill with this reference</div><b className="mono">{w.paybillReference}</b></div>
        <Button kind="ghost" small onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
      <div className="comm-actions">
        {w.canTopUp && <Button onClick={() => setModal('topup')}>Top up</Button>}
        {w.canManage && <Button kind="ghost" onClick={() => setModal('move')}>Move credit</Button>}
        {w.canManage && <Button kind="ghost" onClick={() => setModal('level')}>Warning level</Button>}
        <Button kind="ghost" onClick={() => setShowAct((v) => !v)}>{showAct ? 'Hide activity' : 'Activity'}</Button>
      </div>
      {showAct && <Activity wallet={w} />}
      {modal === 'topup' && <TopUp wallet={w} onClose={() => setModal('')} onDone={reload} />}
      {modal === 'move' && <MoveCredit wallet={w} all={all} onClose={() => setModal('')} onDone={reload} />}
      {modal === 'level' && <Threshold wallet={w} onClose={() => setModal('')} onDone={reload} />}
    </section>
  );
}

export function Wallets() {
  const s = useSession();
  const { data, error, loading, reload } = useAsync<any>(() => api.get('/wallets' + orgQs(s)), [s.grant.org.id]);
  const wallets: WalletInfo[] = data?.wallets ?? [];
  const org = wallets.filter((w) => w.scope === 'organisation');
  const branch = wallets.filter((w) => w.scope === 'branch');
  const perBranch = data?.mode === 'per_branch';
  const rates = data?.rates;
  const cards = (list: WalletInfo[]) => (
    <div className="comm-wallets">{list.map((w) => <WalletCard key={w.id} w={w} all={wallets} reload={reload} />)}</div>
  );
  const sum = (ch: 'sms' | 'whatsapp') => wallets.filter((w) => w.channel === ch).reduce((n, w) => n + w.balance, 0);
  const attention = wallets.filter((w) => w.state !== 'ok').length;
  return (
    <div>
      <PageHeader title="Messaging wallets" subtitle="Credit that pays for SMS and WhatsApp messages. In-app messages are always free."
        actions={s.can('integrations.manage') ? <Button kind="ghost" onClick={() => s.go('integrations')}>Messaging settings</Button> : undefined} />
      <Load loading={false} error={error} hasData={!!data}>
        {!data && !error && <Skeleton rows={2} height={220} />}
        {data && (
          <div className="stack">
            {wallets.length > 0 && (
              <StatTiles>
                <Stat label="SMS credit" value={kes(sum('sms'))} />
                <Stat label="WhatsApp credit" value={kes(sum('whatsapp'))} />
                <Stat label="Need a top-up" value={attention} tone={attention ? 'wait' : 'good'} hint={attention ? 'Running low or empty' : 'All healthy'} />
              </StatTiles>
            )}
            <div className="comm-calm">
              {perBranch ? 'Each branch pays for its own messages.' : 'All branches share these wallets.'}
              {rates && <> Right now SMS costs {kes(rates.sms)} per message part and WhatsApp costs {kes(rates.whatsapp)} per message. Prices are set by ChurchOS and get cheaper the more you send in a month.</>}
            </div>
            {wallets.length === 0 && <UCard><EmptyState icon="wallet" title="No wallets yet" text="There are no wallets you can see yet." /></UCard>}
            {org.length > 0 && <div><h2 style={{ marginBottom: 10 }}>Church-wide</h2>{cards(org)}</div>}
            {perBranch && branch.length > 0 && <div><h2 style={{ marginBottom: 10 }}>By branch</h2>{cards(branch)}</div>}
          </div>
        )}
      </Load>
    </div>
  );
}
