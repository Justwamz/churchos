import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorNote, Field, Note, Spinner, Table, kes, phonePretty, shortDate, useAsync, useToast } from '@churchos/ui';
import { api, friendly, methodLabel, useSession, type Session } from './session';
import { Load, PageHead } from './bits';

/** Only send ?org= for people who belong to several churches, like the other pages. */
export const orgQs = (s: Session) => (s.orgs.length > 1 ? `?org=${s.grant.org.id}` : '');

export type WalletInfo = {
  id: string; branchId: string | null; channel: 'sms' | 'whatsapp'; scope: string; label: string; balance: number; rate: number;
  messagesLeft: number; threshold: number; state: 'ok' | 'low' | 'empty'; paybillReference: string; canTopUp: boolean; canManage: boolean;
};

const STATE: Record<string, { text: string; tone: 'good' | 'warn' | 'bad' }> = {
  ok: { text: 'Healthy', tone: 'good' }, low: { text: 'Running low', tone: 'warn' }, empty: { text: 'Empty', tone: 'bad' },
};
const CH = { sms: 'SMS', whatsapp: 'WhatsApp' } as const;

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal" style={{ maxHeight: 'calc(100vh - 32px)', overflowY: 'auto' }}>
        <div className="row between" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <Button kind="ghost" small onClick={onClose}>Close</Button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------- top-up journey ----------

const PRESETS = [100, 500, 1000, 5000];

function TopUp({ wallet, onClose, onDone }: { wallet: WalletInfo; onClose: () => void; onDone: () => void }) {
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
  useEffect(() => () => { alive.current = false; }, []);
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
            const r: any = await api.get('/wallets' + orgQs(sessionRef.current));
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
  const sessionRef = useRef(useSession());
  sessionRef.current = useSession();

  const pay = async () => {
    setError(''); setPhase('starting'); setPopupBlocked(false);
    try {
      const r: any = await api.post(`/wallets/${wallet.id}/topup`, { amount, method, phone: method === 'mpesa' ? phone : undefined });
      setTopup(r); setPhase('waiting');
      if (method === 'card' && r.checkoutUrl) {
        const w = window.open(r.checkoutUrl, '_blank', 'noopener');
        if (!w) setPopupBlocked(true);
      }
      poll(r.id);
    } catch (e: any) { setError(friendly(e.message)); setPhase('idle'); }
  };

  return (
    <Modal title={`Top up ${wallet.label}`} onClose={onClose}>
      {step === 1 && (
        <>
          <p className="muted">How much credit would you like to add? At {kes(wallet.rate)} per message, KES 1,000 buys about {Math.floor(100000 / wallet.rate)} messages.</p>
          <div className="chips" style={{ marginBottom: 12 }}>
            {PRESETS.map((p) => (
              <button key={p} type="button" className={`chip ${!custom && amount === p ? 'on' : ''}`} onClick={() => { setAmount(p); setCustom(''); }}>KES {p.toLocaleString('en-KE')}</button>
            ))}
          </div>
          <Field label="Or enter another amount (KES)" hint="From KES 100 to KES 50,000">
            <input inputMode="numeric" placeholder="e.g. 2500" value={custom} onChange={(e) => { const v = e.target.value.replace(/[^\d]/g, ''); setCustom(v); if (v) setAmount(Number(v)); }} />
          </Field>
          {!amountOk && <Note tone="warn">Enter an amount between KES 100 and KES 50,000.</Note>}
          <Button disabled={!amountOk} onClick={() => setStep(2)}>Continue with KES {amount.toLocaleString('en-KE')}</Button>
        </>
      )}
      {step === 2 && (
        <>
          <p className="muted">How would you like to pay KES {amount.toLocaleString('en-KE')}?</p>
          <div style={{ display: 'grid', gap: 10, marginBottom: 12 }}>
            {(['mpesa', 'card'] as const).map((m) => (
              <button key={m} type="button" onClick={() => setMethod(m)} aria-pressed={method === m}
                style={{ textAlign: 'left', padding: 16, borderRadius: 12, border: `2px solid ${method === m ? 'var(--brand)' : 'var(--line)'}`, background: method === m ? 'var(--brand-tint)' : 'var(--surface)', color: 'var(--ink)', font: 'inherit', cursor: 'pointer' }}>
                <b style={{ fontSize: 17 }}>{m === 'mpesa' ? 'M-Pesa' : 'Card'}</b>
                <div className="tiny">{m === 'mpesa' ? 'We send a prompt to your phone. Enter your PIN.' : 'Pay on the payment provider\'s secure page.'}</div>
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
            <Button disabled={method === 'mpesa' && phone.replace(/\D/g, '').length < 9} onClick={() => { setStep(3); pay(); }}>Pay KES {amount.toLocaleString('en-KE
