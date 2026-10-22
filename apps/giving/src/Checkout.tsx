import { useEffect, useState, type FormEvent } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { safeReturn } from './safeReturn';
import { ApiError, Button, ErrorNote, Field, Note, Spinner, createApi, kes } from '@churchos/ui';

const api = createApi('churchos:giving:checkout');

const groups4 = (v: string) => v.replace(/\D/g, '').slice(0, 19).replace(/(.{4})/g, '$1 ').trim();
const expiryFmt = (v: string) => { const d = v.replace(/\D/g, '').slice(0, 4); return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d; };

const EXPIRED = 'This payment link has expired or was already used.';

/** Stands in for a payment provider's hosted card page. Card details stay in component state only. */
export function Checkout() {
  const { id = '' } = useParams();
  const [search] = useSearchParams();
  const gift = search.get('gift') ?? '';
  // Where to send the person afterwards. Only this origin, a listed app origin, or (when run locally) the same host are allowed; the link is rebuilt from the parsed address.
  const back = safeReturn(search.get('return'), location, {
    allowedOrigins: String((import.meta as any).env?.VITE_RETURN_ORIGINS ?? '').split(',').map((s: string) => s.trim()).filter(Boolean),
    dev: !(import.meta as any).env?.PROD,
  });
  const [receipt, setReceipt] = useState<{ church: string; purpose: string; receipt: string | null } | undefined>();
  const [info, setInfo] = useState<{ amount: number; merchant: string } | undefined>();
  const [state, setState] = useState<'loading' | 'ready' | 'expired' | 'paid'>('loading');
  const [number, setNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvc, setCvc] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let alive = true;
    setState('loading');
    api.get<{ amount: number; merchant: string }>(`/public/checkout/${encodeURIComponent(id)}`)
      .then((r) => { if (alive) { setInfo(r); setState('ready'); } })
      .catch(() => alive && setState('expired'));
    return () => { alive = false; };
  }, [id]);

  const clear = () => { setNumber(''); setExpiry(''); setCvc(''); setName(''); };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      await api.post(`/public/checkout/${encodeURIComponent(id)}/pay`, { number: number.replace(/\s/g, ''), expiry, cvc });
      clear();
      setState('paid');
      if (gift) {
        // The gift is recorded a moment after the card is accepted, so look for the receipt for a few seconds.
        for (let i = 0; i < 8; i++) {
          try {
            const g = await api.get<any>(`/public/give/${encodeURIComponent(gift)}`);
            if (g.status === 'completed') { setReceipt({ church: g.church, purpose: g.purpose, receipt: g.receipt }); break; }
          } catch { /* keep trying */ }
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 404) { clear(); setState('expired'); }
      else if (status === 400) setError('Check the card details and try again');
      else if (status === 402) setError('The card was declined. Try another card');
      else setError('Something went wrong. Please try again.');
    }
    setBusy(false);
  };

  const complete = number.replace(/\s/g, '').length >= 12 && /^\d{2}\/\d{2}$/.test(expiry) && cvc.length >= 3 && name.trim().length > 1;

  return (
    <div className="mobile giving">
      <style>{CSS}</style>
      <header className="co-head"><span aria-hidden="true">&#128274;</span> Secure payment</header>
      {state === 'loading' && <Spinner />}
      {state === 'expired' && <div className="co-card"><ErrorNote>{EXPIRED}</ErrorNote></div>}
      {state === 'paid' && (
        <div className="co-card center stack" aria-live="polite">
          <div className="tick" aria-hidden="true">&#10003;</div>
          <h2>Payment received</h2>
          {gift ? (
            <>
              <p className="muted">{receipt ? `Thank you. Your gift to ${receipt.church} has been received.` : 'Thank you. Your gift is being recorded.'}</p>
              {receipt?.receipt && <p className="tiny">Receipt reference <b className="mono">{receipt.receipt}</b></p>}
              <a className="btn primary" href={back}>Back to ChurchOS</a>
            </>
          ) : search.get('return') ? (
            <>
              <p className="muted">Payment received. Thank you.</p>
              <a className="btn primary" href={back}>Back to ChurchOS</a>
            </>
          ) : <p className="muted">Payment received. You can close this tab and return to ChurchOS.</p>}
        </div>
      )}
      {state === 'ready' && info && (
        <form onSubmit={submit} noValidate className="co-card stack" autoComplete="off">
          <div className="center">
            <div className="tiny">{info.merchant}</div>
            <div className="big-amount">{kes(info.amount)}</div>
          </div>
          <Field label="Card number">
            <input inputMode="numeric" autoComplete="off" placeholder="1234 5678 9012 3456" value={number} onChange={(e) => setNumber(groups4(e.target.value))} />
          </Field>
          <div className="co-two">
            <Field label="Expiry (MM/YY)">
              <input inputMode="numeric" autoComplete="off" placeholder="MM/YY" value={expiry} onChange={(e) => setExpiry(expiryFmt(e.target.value))} />
            </Field>
            <Field label="CVC">
              <input inputMode="numeric" autoComplete="off" placeholder="123" value={cvc} onChange={(e) => setCvc(e.target.value.replace(/\D/g, '').slice(0, 4))} />
            </Field>
          </div>
          <Field label="Name on card">
            <input autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div aria-live="polite">{error && <ErrorNote>{error}</ErrorNote>}</div>
          <Button type="submit" disabled={busy || !complete}>{busy ? 'Paying...' : `Pay ${kes(info.amount)}`}</Button>
          <Note tone="info">Test page. Use card 4242 4242 4242 4242 with any future date and any 3 digits. Use 4000 0000 0000 0002 to see a declined card.</Note>
        </form>
      )}
    </div>
  );
}

const CSS = `
.giving .co-head { padding: 18px 4px; font-weight: 700; font-size: 1.1rem; border-bottom: 1px solid var(--line); margin-bottom: 18px; }
.giving .co-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px; }
.giving .co-two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.giving .center { text-align: center; }
.giving { padding-bottom: 60px; }
.giving .btn { width: 100%; min-height: 50px; font-size: 1.05rem; }
.giving .tick { width: 56px; height: 56px; margin: 0 auto 10px; border-radius: 50%; background: var(--good-tint); color: var(--good); font-size: 28px; display: grid; place-items: center; }
`;
