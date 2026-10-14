import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Empty, Field, Note, Stat, Table, kes, phonePretty, shortDate, useAsync, useToast } from '@churchos/ui';
import { api, friendly, label, useSession } from './session';
import { Load, PageHead } from './bits';

type Phase = 'idle' | 'sending' | 'waiting' | 'done' | 'timeout';

function TopUp({ onDone }: { onDone: () => void }) {
  const s = useSession();
  const [amount, setAmount] = useState('');
  const [phone, setPhone] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [msg, setMsg] = useState<string>();
  const [error, setError] = useState<string>();
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const start = async () => {
    const n = Number(amount);
    if (!(n >= 100 && n <= 50000)) { setError('Enter an amount from KES 100 to KES 50,000.'); return; }
    setError(undefined); setPhase('sending');
    try {
      const r = await api.post('/sms/topup' + s.qs(), { amount: amount.trim(), phone: phone.trim() });
      setMsg(r.message); setPhase('waiting');
      const started = Date.now();
      const poll = async () => {
        try {
          const t = await api.get(`/sms/topup/${r.id}` + s.qs());
          if (t.status === 'completed') { setPhase('done'); onDone(); return; }
        } catch { /* keep trying */ }
        if (Date.now() - started > 90_000) { setPhase('timeout'); return; }
        timer.current = window.setTimeout(poll, 1500);
      };
      timer.current = window.setTimeout(poll, 1500);
    } catch (e: any) { setError(friendly(e.message)); setPhase('idle'); }
  };

  const busy = phase === 'sending' || phase === 'waiting';
  return (
    <Card title="Top up by M-Pesa">
      <form className="grid cols-3" onSubmit={(e) => { e.preventDefault(); start(); }}>
        <Field label="Amount (KES)" hint="100 to 50,000"><input inputMode="decimal" value={amount} disabled={busy} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="M-Pesa phone"><input inputMode="tel" value={phone} disabled={busy} onChange={(e) => setPhone(e.target.value)} placeholder="0712345678" /></Field>
        <div style={{ alignSelf: 'end', marginBottom: 12 }}><Button type="submit" disabled={busy || !amount || !phone.trim()}>{phase === 'sending' ? 'Sending…' : 'Top up'}</Button></div>
      </form>
      {error && <Note tone="bad">{error}</Note>}
      {phase === 'waiting' && <Note tone="info">{msg ?? 'Check your phone and enter your PIN.'} We will update this page as soon as the payment arrives.</Note>}
      {phase === 'done' && <Note tone="good">Top-up received. Your SMS wallet has been credited.</Note>}
      {phase === 'timeout' && <Note tone="warn">We have not seen the payment yet. If you entered your PIN, it may still arrive. You can refresh this page in a minute to check.</Note>}
    </Card>
  );
}

export function Sms() {
  const s = useSession();
  const d = useAsync<any>(() => api.get('/sms/wallet' + s.qs()), [s.qs()]);
  const toast = useToast();
  const w = d.data;

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast.show('Copied.'); } catch { toast.show('Could not copy. Please select it and copy by hand.', 'bad'); }
  };

  return (
    <>
      <PageHead title="SMS wallet" sub="Pays for receipts and reminders sent by text message." />
      <Load loading={d.loading} error={d.error} hasData={!!w}>
        {w && (
          <div className="stack">
            {w.empty ? <Note tone="bad">SMS is switched off: receipts and reminders go in-app only until you top up.</Note>
              : w.low ? <Note tone="warn">Your SMS wallet is running low. Top up soon so members keep receiving text messages.</Note> : null}
            <div className="grid cols-3">
              <Stat label="Balance" value={kes(w.balance)} tone={w.empty ? 'bad' : w.low ? 'warn' : undefined} />
              <Stat label="Messages left" value={Number(w.messagesLeft).toLocaleString()} />
              <Stat label="Per message" value={kes(w.rate)} />
            </div>
            <Note tone="info">The SMS wallet is separate from your collections. Topping it up or running it down never changes what is paid out to your church.</Note>
            <TopUp onDone={d.reload} />
            {w.paybillReference && (
              <Card title="Or pay by paybill">
                <p className="muted" style={{ marginTop: 0 }}>Pay to the ChurchOS paybill and use this as the account reference, exactly as written.</p>
                <div className="row"><b className="mono" style={{ fontSize: 18 }}>{w.paybillReference}</b><Button small kind="ghost" onClick={() => copy(w.paybillReference)}>Copy</Button></div>
              </Card>
            )}
            <Card title="Message log">
              {w.messages.length === 0 ? <Empty>No messages yet.</Empty> : (
                <Table head={['Time', 'Phone', 'Kind', 'Message', 'Cost', 'Status']}>
                  {w.messages.map((m: any) => (
                    <tr key={m.id}>
                      <td>{shortDate(m.created_at)}</td><td>{phonePretty(m.to_phone)}</td><td>{label(m.kind)}</td><td>{m.body}</td>
                      <td className="num">{kes(m.cost)}</td>
                      <td>{m.status === 'sent' ? <Badge tone="good">Sent</Badge> : <Badge tone="warn">Not sent, wallet empty</Badge>}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
            <Card title="Top-up history">
              {w.topups.length === 0 ? <Empty>No top-ups yet.</Empty> : (
                <Table head={['Time', 'Amount', 'Status']}>
                  {w.topups.map((t: any) => (
                    <tr key={t.id}><td>{shortDate(t.created_at)}</td><td className="num">{kes(t.amount)}</td><td>{t.status === 'completed' ? <Badge tone="good">Received</Badge> : <Badge tone="muted">Waiting for payment</Badge>}</td></tr>
                  ))}
                </Table>
              )}
            </Card>
          </div>
        )}
      </Load>
      {toast.node}
    </>
  );
}
