import { useEffect, useState } from 'react';
import { Button, ErrorNote, Field, Note, kes, phonePretty, useAsync } from '@churchos/ui';
import { api, errText } from './api';
import { Icon, Sheet, Skeleton } from './ui';

const TZ = 'Africa/Nairobi';
const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ }) : '');
const bell = () => window.dispatchEvent(new Event('churchos:credit-changed'));

/** Tell the shell to open the credit screen. */
export const openCredit = () => window.dispatchEvent(new Event('churchos:open-credit'));
export const openEventsList = () => window.dispatchEvent(new Event('churchos:open-events'));

/** Whole shillings as a plain number for an input box (cents in, KES out). */
const toKes = (cents: number) => String(Math.floor(cents / 100));
const num = (s: string) => { const n = Number(String(s).replace(/,/g, '').trim()); return Number.isFinite(n) ? n : NaN; };

function useCredit() {
  const credit = useAsync<any>(() => api.get('/me/credit'));
  useEffect(() => { const f = () => credit.reload(); window.addEventListener('churchos:credit-changed', f); return () => window.removeEventListener('churchos:credit-changed', f); }, []); // eslint-disable-line
  return credit;
}

/** A small line shown above event and ticket lists. */
export function CreditNote() {
  const credit = useCredit();
  const total = Number(credit.data?.total ?? 0);
  if (total <= 0) return null;
  return <p className="crd-line"><Icon name="coin" size={18} /><span>Your credit <strong>{kes(total)}</strong> will be used at checkout.</span></p>;
}

// ---------------- the screen ----------------

function statusChip(r: any) {
  switch (r.status) {
    case 'pending': return { tone: 'warn', label: 'Waiting for the church' };
    case 'approved': return { tone: 'info', label: 'Approved, waiting to be paid' };
    case 'paid': return { tone: 'good', label: `Paid on ${day(r.paidAt)}${r.paidReference ? `, reference ${r.paidReference}` : ''}` };
    case 'declined': return { tone: 'bad', label: `Declined${r.decisionNote ? `: ${r.decisionNote}` : ''}` };
    default: return { tone: 'muted', label: 'Cancelled' };
  }
}

export function CreditPage({ user, onEvents }: { user: any; onEvents: () => void }) {
  const credit = useCredit();
  const hist = useAsync<any>(() => api.get('/me/credit/history'));
  const [sheet, setSheet] = useState<'refund' | 'send' | null>(null);
  const [orgId, setOrgId] = useState<string | undefined>();
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState('');
  useEffect(() => { const f = () => hist.reload(); window.addEventListener('churchos:credit-changed', f); return () => window.removeEventListener('churchos:credit-changed', f); }, []); // eslint-disable-line

  if (credit.loading && !credit.data) return <div className="card"><Skeleton lines={4} tall /></div>;
  if (credit.error && !credit.data) return <div className="stack"><ErrorNote>{credit.error}</ErrorNote><Button kind="ghost" onClick={credit.reload}>Try again</Button></div>;

  const d = credit.data ?? {};
  const churches: any[] = d.churches ?? [];
  const many = churches.length > 1;
  const cur = churches.find((c) => c.orgId === orgId) ?? churches[0];
  const balance = Number(cur?.balance ?? d.total ?? 0);
  const credits: any[] = (d.credits ?? []).filter((c: any) => !many || !cur || c.church === cur.church);
  const spent: any[] = d.spent ?? [];
  const refunds: any[] = hist.data?.refunds ?? [];
  const transfers: any[] = hist.data?.transfers ?? [];
  const activity = refunds.length + transfers.length;
  const hasOpen = refunds.some((r) => r.status === 'pending');

  const cancel = async (id: string) => {
    setErr(''); setBusyId(id);
    try { await api.post(`/me/credit/refund-request/${id}/cancel`, {}); bell(); } catch (e) { setErr(errText(e)); }
    setBusyId('');
  };
  const done = () => { bell(); credit.reload(); hist.reload(); };

  return (
    <div className="stack crd-page">
      {many && (
        <div className="chips" role="group" aria-label="Church">
          {churches.map((c) => <button key={c.orgId} type="button" className={`chip ${c.orgId === (cur?.orgId) ? 'on' : ''}`} aria-pressed={c.orgId === cur?.orgId} onClick={() => setOrgId(c.orgId)}>{c.church}</button>)}
        </div>
      )}
      <section className="crd-hero">
        <span className="tiny">Your event credit</span>
        <strong className="crd-big">{kes(balance)}</strong>
        <span className="crd-hero-sub">{cur?.church ? `event credit at ${cur.church}` : 'event credit'}</span>
        <p className="tiny">Used automatically when you buy tickets from this church. It never expires.</p>
      </section>

      {err && <ErrorNote>{err}</ErrorNote>}

      <div className="crd-actions">
        <Button onClick={onEvents}>Use it</Button>
        <Button kind="ghost" disabled={balance <= 0} onClick={() => setSheet('send')}>Send to someone</Button>
        <Button kind="ghost" disabled={balance <= 0} onClick={() => setSheet('refund')}>Ask for a refund</Button>
      </div>
      {balance <= 0 && <p className="tiny">You have no credit to send or ask back right now.</p>}

      <section className="crd-sec">
        <h3 className="agenda-month">Where it came from</h3>
        {credits.length === 0 ? <p className="mini-empty">Nothing yet</p> : (
          <ul className="tk-credit-list">
            {credits.map((c) => (
              <li key={c.id}>
                <span>
                  <strong>{c.kind === 'transfer' ? (c.reason || 'Sent by another member') : c.kind === 'church' ? (c.reason || 'Added by the church') : (c.event || c.reason || 'Event credit')}</strong>
                  <span className="tiny">{many ? `${c.church} · ` : ''}{day(c.at)} · was {kes(c.amount)}</span>
                </span>
                <strong>{kes(c.balance)}</strong>
              </li>
            ))}
          </ul>
        )}
      </section>

      {spent.length > 0 && (
        <section className="crd-sec">
          <h3 className="agenda-month">Used</h3>
          <ul className="tk-credit-list">
            {spent.map((c, i) => <li key={i}><span><strong>{c.event ?? 'Tickets'}</strong><span className="tiny">{day(c.at)}</span></span><span>-{kes(c.amount)}</span></li>)}
          </ul>
        </section>
      )}

      <section className="crd-sec">
        <h3 className="agenda-month">Requests and transfers</h3>
        {hist.loading && !hist.data ? <Skeleton lines={2} /> : activity === 0 ? <p className="mini-empty">No refund requests or transfers yet</p> : (
          <ul className="crd-hist">
            {refunds.map((r) => {
              const s = statusChip(r);
              return (
                <li key={r.id}>
                  <div className="crd-hist-top"><strong>Refund request</strong><strong>{kes(r.amount)}</strong></div>
                  <span className={`badge ${s.tone} crd-chip`}>{s.label}</span>
                  <span className="tiny">Asked on {day(r.requestedAt)}{r.reason ? ` · ${r.reason}` : ''}</span>
                  {r.status === 'pending' && <div><Button kind="ghost" small disabled={busyId === r.id} onClick={() => cancel(r.id)}>{busyId === r.id ? 'One moment…' : 'Cancel request'}</Button></div>}
                </li>
              );
            })}
            {transfers.map((t) => (
              <li key={t.id}>
                <div className="crd-hist-top"><strong>{t.direction === 'sent' ? `Sent to ${t.other}` : `Received from ${t.other}`}</strong><strong className={t.direction === 'sent' ? '' : 'crd-in'}>{t.direction === 'sent' ? '-' : '+'}{kes(t.amount)}</strong></div>
                <span className="tiny">{day(t.at)}{t.note ? ` · “${t.note}”` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <RefundSheet open={sheet === 'refund'} onClose={() => setSheet(null)} balance={balance} orgId={cur?.orgId} phone={user?.phone} hasOpen={hasOpen} onDone={done} />
      <SendSheet open={sheet === 'send'} onClose={() => setSheet(null)} balance={balance} orgId={cur?.orgId} onDone={done} />
    </div>
  );
}

// ---------------- amount input shared by both sheets ----------------

function AmountField({ value, onChange, balance, min, all, onAll, label = 'Amount in KES' }: { value: string; onChange: (v: string) => void; balance: number; min: number; all: boolean; onAll: () => void; label?: string }) {
  return (
    <Field label={label} hint={`You have ${kes(balance)}. The smallest amount is KES ${min}.`}>
      <div className="crd-amt">
        <input type="text" inputMode="numeric" placeholder="0" value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))} aria-label={label} />
        <button type="button" className={`chip ${all ? 'on' : ''}`} aria-pressed={all} onClick={onAll}>All of it</button>
      </div>
    </Field>
  );
}

function amountProblem(value: string, balance: number, min: number): string {
  const n = num(value);
  if (!value.trim() || !(n > 0)) return 'Enter how much.';
  if (n < min) return `The smallest amount is KES ${min}.`;
  if (Math.round(n * 100) > balance) return `You only have ${kes(balance)}.`;
  return '';
}

// ---------------- ask for a refund ----------------

function RefundSheet({ open, onClose, balance, orgId, phone, hasOpen, onDone }: { open: boolean; onClose: () => void; balance: number; orgId?: string; phone?: string; hasOpen: boolean; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [all, setAll] = useState(false);
  const [reason, setReason] = useState('');
  const [step, setStep] = useState<'form' | 'confirm' | 'done'>('form');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(0);
  useEffect(() => { if (open) { setAmount(''); setAll(false); setReason(''); setStep('form'); setError(''); setBusy(false); } }, [open]);

  const problem = amountProblem(amount, balance, 100);
  const shown = all ? balance : Math.round(num(amount) * 100);
  const who = phone ? phonePretty(phone) : 'your phone number';

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const body: any = { reason: reason.trim() || undefined, orgId };
      if (all) body.all = true; else body.amount = num(amount);
      const r = await api.post('/me/credit/refund-request', body);
      setSent(Number(r?.amount ?? shown)); setStep('done'); onDone();
    } catch (e: any) { setError(errText(e)); setStep('form'); }
    setBusy(false);
  };

  return (
    <Sheet open={open} onClose={() => { if (!busy) onClose(); }} title="Ask for a refund">
      <div className="stack">
        {step === 'done' ? (
          <>
            <Note tone="good"><strong>Your request for {kes(sent)} was sent to the church.</strong></Note>
            <p>The church will look at it and pay you itself. We will tell you here and in your messages when it is decided. The credit is held until then. You can cancel the request while it is waiting.</p>
            <Button onClick={onClose}>Done</Button>
          </>
        ) : step === 'confirm' ? (
          <>
            <p>Ask the church to pay you back <strong>{kes(shown)}</strong>?</p>
            <Note>The church looks at each request and pays you itself, for example by M-Pesa to {who}. {kes(shown)} is held until it is decided.</Note>
            {reason.trim() && <p className="tiny">Your reason: {reason.trim()}</p>}
            {error && <ErrorNote>{error}</ErrorNote>}
            <Button disabled={busy} onClick={submit}>{busy ? 'One moment…' : `Yes, ask for ${kes(shown)}`}</Button>
            <Button kind="ghost" disabled={busy} onClick={() => setStep('form')}>Go back</Button>
          </>
        ) : (
          <>
            <p>Ask your church to give your event credit back as money.</p>
            <Note>The church looks at each request and pays you itself, for example by M-Pesa to {who}. The credit is held until it is decided. If the church says no, or you cancel, it comes back to your credit.</Note>
            {hasOpen && <Note tone="warn">You already have a request waiting. You can only have one at a time, so cancel it first if you want to change the amount.</Note>}
            <AmountField value={all ? toKes(balance) : amount} onChange={(v) => { setAll(false); setAmount(v); }} balance={balance} min={100} all={all} onAll={() => { setAll(true); setAmount(toKes(balance)); }} />
            <Field label="Reason (optional)"><textarea rows={3} maxLength={300} placeholder="For example: I can no longer come" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            {error && <ErrorNote>{error}</ErrorNote>}
            {amount && problem && !all && <p className="field-error">{problem}</p>}
            <Button disabled={busy || (!all && !!problem) || (all && balance < 10000)} onClick={() => { setError(''); setStep('confirm'); }}>Continue</Button>
            {all && balance < 10000 && <p className="field-error">The smallest amount is KES 100.</p>}
          </>
        )}
      </div>
    </Sheet>
  );
}

// ---------------- send to someone ----------------

function SendSheet({ open, onClose, balance, orgId, onDone }: { open: boolean; onClose: () => void; balance: number; orgId?: string; onDone: () => void }) {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [checking, setChecking] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [amount, setAmount] = useState('');
  const [all, setAll] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lookErr, setLookErr] = useState('');
  const [sent, setSent] = useState<{ amount: number; to: string } | null>(null);
  useEffect(() => { if (open) { setPhone(''); setName(''); setConfirmed(false); setAmount(''); setAll(false); setNote(''); setError(''); setLookErr(''); setSent(null); setBusy(false); } }, [open]);

  const changePhone = (v: string) => { setPhone(v); setName(''); setConfirmed(false); setLookErr(''); setError(''); };
  const check = async () => {
    setChecking(true); setLookErr(''); setName(''); setConfirmed(false);
    try {
      const r = await api.post('/me/credit/transfer/lookup', { phone: phone.trim(), orgId });
      setName(r.name);
    } catch (e: any) {
      setLookErr(e?.code === 'recipient_not_found' ? 'We could not find another member of your church with that number. Please check it and try again.' : e?.code === 'rate_limited' ? 'You have checked a lot of numbers. Please wait a little and try again.' : errText(e));
    }
    setChecking(false);
  };

  const problem = amountProblem(amount, balance, 50);
  const shown = all ? balance : Math.round(num(amount) * 100);
  const send = async () => {
    setBusy(true); setError('');
    try {
      const body: any = { phone: phone.trim(), note: note.trim() || undefined, orgId };
      if (all) body.all = true; else body.amount = num(amount);
      const r = await api.post('/me/credit/transfer', body);
      setSent({ amount: Number(r?.amount ?? shown), to: r?.to ?? name }); onDone();
    } catch (e: any) {
      setError(e?.code === 'recipient_not_found' ? 'We could not find another member of your church with that number.' : e?.code === 'too_many' ? 'You can send credit up to 10 times a day. Please try again tomorrow.' : errText(e));
    }
    setBusy(false);
  };

  return (
    <Sheet open={open} onClose={() => { if (!busy) onClose(); }} title="Send to someone">
      <div className="stack">
        {sent ? (
          <>
            <Note tone="good"><strong>{kes(sent.amount)} sent to {sent.to}</strong></Note>
            <p>They can use it straight away when they buy tickets from your church.</p>
            <Button onClick={onClose}>Done</Button>
          </>
        ) : (
          <>
            <p>Send some of your event credit to another member of your church. It arrives at once and cannot be taken back.</p>
            <Field label="Their phone number" hint="We check the number to make sure it is a member of your church.">
              <input type="tel" inputMode="tel" autoComplete="off" placeholder="07XX XXX XXX" value={phone} onChange={(e) => changePhone(e.target.value)} />
            </Field>
            {!name && <Button kind="ghost" disabled={checking || phone.trim().length < 9} onClick={check}>{checking ? 'Checking…' : 'Check'}</Button>}
            {lookErr && <ErrorNote>{lookErr}</ErrorNote>}
            {name && !confirmed && (
              <div className="crd-who">
                <strong>Send to {name}?</strong>
                <span className="tiny">Make sure this is the person you mean.</span>
                <Button onClick={() => setConfirmed(true)}>Yes, that is right</Button>
                <Button kind="ghost" onClick={() => changePhone('')}>No, use another number</Button>
              </div>
            )}
            {name && confirmed && (
              <>
                <Note tone="good">Sending to <strong>{name}</strong></Note>
                <AmountField value={all ? toKes(balance) : amount} onChange={(v) => { setAll(false); setAmount(v); }} balance={balance} min={50} all={all} onAll={() => { setAll(true); setAmount(toKes(balance)); }} />
                <Field label="Message (optional)" hint={`${note.length} of 120`}><input type="text" maxLength={120} placeholder="For example: for the youth camp" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
                {amount && problem && !all && <p className="field-error">{problem}</p>}
                {error && <ErrorNote>{error}</ErrorNote>}
                <Button disabled={busy || (!all && !!problem) || (all && balance < 5000)} onClick={send}>{busy ? 'Sending…' : all || !problem ? `Send ${kes(shown)} to ${name}` : 'Send'}</Button>
              </>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
