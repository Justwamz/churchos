import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { BrandInfo } from '@churchos/ui';
import { usePageBranding } from './brand';
import { BrandMark, ApiError, API_URL, Button, Card, ErrorNote, Field, Note, Spinner, createApi, kes } from '@churchos/ui';
import { networkMismatch, phoneHint } from '@churchos/shared';
import './tickets.css';

const api = createApi('churchos:giving:tickets');

interface TType { id: string; name: string; description?: string | null; price: number; perOrderMax: number; onSale: boolean; soldOut: boolean; left?: number | null }
interface EventInfo { code: string; title: string; description?: string | null; location?: string | null; startsAt: string; endsAt?: string | null; church: string; status: string; refundDaysBefore?: number | null; postponed?: Postponed | null; cancelReason?: string | null; over: boolean; posterUrl?: string | null; types: TType[]; branding?: BrandInfo | null }
interface Postponed { note?: string | null; from?: string | null; startsAt?: string | null; refundUntil?: string | null }
interface Refund { allowed: boolean; freeCancel: boolean; until?: string | null; why?: string | null; request: null | { id: string; status: 'pending' | 'approved' | 'refunded' | 'declined' | 'failed'; note?: string | null; at?: string } }
interface Quote { count: number; subtotal: number; serviceFee: number; total: number; free: boolean; credit?: number; creditUsed?: number; covered?: boolean }
interface CreditInfo { allowed: boolean; amount: number; why?: string | null }
interface OrderTicket { id: string; serial: string; type: string; holder: string; status: string; url: string; token: string }
interface Order { id: string; secret: string; code: string; status: string; subtotal: number; serviceFee: number; total: number; method?: string; payUrl?: string | null; message?: string; event?: { title: string; code: string }; eventStatus?: string; refund?: Refund; credit?: CreditInfo; creditUsed?: number; creditIssued?: number; covered?: boolean; tickets: OrderTicket[] }
interface TicketView { serial: string; type: string; holder: string; status: 'valid' | 'used' | 'cancelled'; usedAt?: string | null; url: string; qrSvg: string; event: { code: string; title: string; startsAt: string; endsAt?: string | null; location?: string | null; church: string; cancelled: boolean; postponed?: boolean; movedFrom?: string | null; posterUrl?: string | null; branding?: BrandInfo | null }; order?: { code: string } }

const METHODS: [string, string][] = [['mpesa', 'M-Pesa'], ['airtel', 'Airtel Money'], ['tkash', 'T-Kash'], ['card', 'Card']];
const eat = (d: string, o: Intl.DateTimeFormatOptions) => new Date(d).toLocaleString('en-GB', { timeZone: 'Africa/Nairobi', ...o });
const day = (d: string) => eat(d, { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
const clock = (d: string) => eat(d, { hour: '2-digit', minute: '2-digit', hour12: false });
const sameDay = (a: string, b: string) => day(a) === day(b);
const when = (s: string, e?: string | null) => (e ? (sameDay(s, e) ? `${day(s)}, ${clock(s)} to ${clock(e)}` : `${day(s)}, ${clock(s)} to ${day(e)}, ${clock(e)}`) : `${day(s)}, ${clock(s)}`);
const errMsg = (e: unknown) => (e instanceof ApiError && e.message ? e.message : 'Something went wrong. Please try again.');
const posterSrc = (u?: string | null) => (u ? `${API_URL}${u}` : null);

const dayTime = (d: string) => `${day(d)}, ${clock(d)}`;

function PostponedBanner({ p, title }: { p?: Postponed | null; title?: string }) {
  return (
    <div className="tk-postponed" role="status">
      <b>Postponed</b>
      {title && <div>{title}</div>}
      {p?.note && <div>{p.note}</div>}
      {p?.startsAt
        ? <div>New date: <b>{dayTime(p.startsAt)}</b>{p.from ? ` (was ${dayTime(p.from)})` : ''}</div>
        : <div>The new date will be announced.</div>}
    </div>
  );
}

const EXPLAIN = 'The church will look at your request and tell you by email. Your tickets still work until then. Money goes back to the number or card you paid with, less any charge the payment provider keeps.';

/** Refund state and the cancel / ask-for-refund button. Works with the order secret only. */
function RefundBox({ refund, secret, onDone, creditUsed = 0, covered = false }: { refund?: Refund; secret: string; onDone: () => void; creditUsed?: number; covered?: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  if (!refund) return null;
  const r = refund.request;
  const send = async () => {
    setBusy(true); setError(undefined);
    try {
      await api.post(`/public/tickets/orders/${encodeURIComponent(secret)}/refund-request`, { reason: reason.trim() || undefined });
      setOpen(false); setReason(''); onDone();
    } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };
  return (
    <div className="stack">
      {r?.status === 'pending' && <Note tone="info"><b>Refund requested:</b> waiting for the church to decide. Your tickets still work until then.</Note>}
      {r?.status === 'declined' && <Note tone="warn">The church could not approve a refund{r.note ? `: ${r.note}` : '.'}</Note>}
      {(r?.status === 'approved' || r?.status === 'refunded') && <Note tone="good"><b>Refunded.</b> The money goes back to the number or card you paid with.</Note>}
      {r?.status === 'failed' && <Note tone="warn">The refund could not be sent to your number or card. The church will be in touch.</Note>}
      {refund.allowed && (!r || r.status === 'declined') && (
        <Card>
          <div className="stack">
            <h2 style={{ margin: 0 }}>{covered ? 'Changed your mind?' : 'Or ask for your money back'}</h2>
            {creditUsed > 0 && <div className="tiny">{covered ? `You paid with ${kes(creditUsed)} of event credit. Cancelling puts it back on your credit code.` : `${kes(creditUsed)} of this order was paid with event credit. It goes back on your credit code. Only what you paid by phone or card is refunded.`}</div>}
            {refund.until && !refund.freeCancel && <div className="tiny">You can ask until {dayTime(refund.until)}.</div>}
            <Button kind="ghost" onClick={() => setOpen(true)}>{refund.freeCancel ? (covered ? 'Cancel and get my credit back' : 'Cancel my tickets') : 'Cancel and ask for a refund'}</Button>
          </div>
        </Card>
      )}
      {!refund.allowed && !r && refund.why && <div className="tiny tk-muted">{refund.why}</div>}
      {open && (
        <div className="tk-modal" role="dialog" aria-modal="true" aria-label={refund.freeCancel ? 'Cancel my tickets' : 'Ask for a refund'} onClick={(e) => { if (e.target === e.currentTarget && !busy) setOpen(false); }}>
          <div className="tk-sheet stack">
            <h2 style={{ margin: 0 }}>{refund.freeCancel ? 'Cancel my tickets?' : 'Cancel and ask for a refund'}</h2>
            {refund.freeCancel ? <p className="muted" style={{ margin: 0 }}>{covered ? 'The tickets are cancelled right away and your event credit goes back on your credit code.' : 'These tickets are free, so they are cancelled right away.'}</p> : (
              <>
                <p className="muted" style={{ margin: 0 }}>{EXPLAIN}</p>
                <Field label="Reason (optional)"><textarea rows={3} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></Field>
              </>
            )}
            {error && <ErrorNote>{error}</ErrorNote>}
            <Button onClick={send} disabled={busy}>{busy ? 'One moment...' : refund.freeCancel ? 'Yes, cancel my tickets' : 'Send my request'}</Button>
            <Button kind="ghost" onClick={() => setOpen(false)} disabled={busy}>Keep my tickets</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Keep the money of a paid order as event credit (shown above the refund option). */
function CreditBox({ credit, issued, secret, onDone }: { credit?: CreditInfo; issued: number; secret: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<{ amount: number; code: string } | null>(null);
  const [copied, setCopied] = useState(false);
  if (result) {
    const copy = async () => { try { await navigator.clipboard.writeText(result.code); setCopied(true); } catch { setCopied(false); } };
    return (
      <div className="tk-creditdone" role="status">
        <b>{kes(result.amount)} is now event credit.</b>
        <div>Your credit code:</div>
        <div className="tk-code" data-testid="credit-code">{result.code}</div>
        <div>Keep it safe: anyone with this code can use it. We have also emailed it to you.</div>
        <Button kind="ghost" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
    );
  }
  if (issued > 0) return <Note tone="info">This order was turned into credit.</Note>;
  if (!credit) return null;
  if (!credit.allowed) return credit.why ? <div className="tiny tk-muted">{credit.why}</div> : null;
  const send = async () => {
    setBusy(true); setError(undefined);
    try {
      const r = await api.post<{ amount: number; code: string }>(`/public/tickets/orders/${encodeURIComponent(secret)}/credit`, {});
      setResult({ amount: r.amount, code: r.code }); setOpen(false); onDone();
    } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };
  return (
    <Card>
      <div className="stack">
        <h2 style={{ margin: 0 }}>Not able to come? Keep your money as event credit</h2>
        <div className="tk-creditamt">{kes(credit.amount)}</div>
        <p className="muted" style={{ margin: 0 }}>Use it on any event at this church, any time. It never expires. The service fee is not included.</p>
        {!open ? <Button onClick={() => setOpen(true)}>Keep as event credit</Button> : (
          <div className="stack">
            <Note tone="warn">This cancels all the tickets on this order and cannot be undone. You will get a credit code.</Note>
            {error && <ErrorNote>{error}</ErrorNote>}
            <Button onClick={send} disabled={busy}>{busy ? 'One moment...' : `Yes, turn it into ${kes(credit.amount)} credit`}</Button>
            <Button kind="ghost" onClick={() => setOpen(false)} disabled={busy}>No, keep my tickets</Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function TkShell({ children, branding, church }: { children: ReactNode; branding?: BrandInfo | null; church?: string }) {
  usePageBranding(branding, church);
  return (
    <div className="mobile giving tk">
      <div className="tk-brand no-print" style={branding?.hasLogo ? { display: 'flex', alignItems: 'center', gap: 10 } : undefined}>{branding?.hasLogo && <BrandMark brand={{ ...branding, name: church }} size={36} />}<span>Event tickets</span></div>
      {children}
    </div>
  );
}

function Poster({ url, title }: { url?: string | null; title: string }) {
  const src = posterSrc(url);
  return src ? <img className="tk-poster" src={src} alt={`Poster for ${title}`} /> : <div className="tk-poster ph" aria-hidden="true">{title.slice(0, 1)}</div>;
}

// ---------------------------------------------------------------- buy page

export function EventPage({ code }: { code: string }) {
  const nav = useNavigate();
  const [ev, setEv] = useState<EventInfo | null | undefined>(undefined);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [method, setMethod] = useState('mpesa');
  const [quote, setQuote] = useState<Quote | undefined>();
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [creditOpen, setCreditOpen] = useState(false);
  const [creditText, setCreditText] = useState('');
  const [creditCode, setCreditCode] = useState('');
  const [creditNote, setCreditNote] = useState<{ ok: boolean; text: string } | undefined>();
  const [creditBusy, setCreditBusy] = useState(false);
  const [quoteErr, setQuoteErr] = useState<string | undefined>();
  // Credit to use, in KES as typed. null = as much as possible (All).
  const [useKes, setUseKes] = useState<number | null>(null);
  const [sentKes, setSentKes] = useState<number | null>(null);
  const [creditBal, setCreditBal] = useState(0);

  useEffect(() => {
    if (useKes === sentKes) return;
    const t = setTimeout(() => setSentKes(useKes), 300);
    return () => clearTimeout(t);
  }, [useKes, sentKes]);

  useEffect(() => {
    let alive = true;
    setEv(undefined);
    api.get<EventInfo>(`/public/event/${encodeURIComponent(code)}`).then((e) => alive && setEv(e)).catch(() => alive && setEv(null));
    return () => { alive = false; };
  }, [code]);

  const lines = useMemo(() => Object.entries(qty).filter(([, n]) => n > 0).map(([typeId, n]) => ({ typeId, qty: n })), [qty]);
  const count = lines.reduce((s, l) => s + l.qty, 0);
  const linesKey = JSON.stringify(lines);

  useEffect(() => {
    if (!count) { setQuote(undefined); return; }
    let alive = true;
    api.post<Quote>('/public/tickets/quote', { code, method, lines, creditCode: creditCode || undefined, creditAmount: creditCode && sentKes != null ? sentKes : undefined })
      .then((q) => { if (alive) { setQuote(q); setQuoteErr(undefined); } })
      .catch((e) => { if (alive) { setQuote(undefined); setQuoteErr(creditCode ? errMsg(e) : undefined); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, method, linesKey, creditCode, sentKes]);

  const applyCredit = async () => {
    const t = creditText.trim();
    if (!t || creditBusy) return;
    setCreditBusy(true); setCreditNote(undefined);
    try {
      const r = await api.get<{ balance: number; church: string }>(`/public/credit/${encodeURIComponent(t)}`);
      if (r.balance <= 0) { setCreditCode(''); setCreditNote({ ok: false, text: 'That credit has been used up.' }); setCreditBusy(false); return; }
      setCreditCode(t); setCreditBal(r.balance); setUseKes(null); setSentKes(null);
      setCreditNote({ ok: true, text: `Credit ${kes(r.balance)} at ${r.church}` });
    } catch (e) { setCreditCode(''); setCreditNote({ ok: false, text: errMsg(e) }); }
    setCreditBusy(false);
  };
  const removeCredit = () => { setCreditCode(''); setUseKes(null); setSentKes(null); setCreditText(''); setCreditNote(undefined); setQuoteErr(undefined); setCreditOpen(false); };

  if (ev === undefined) return <TkShell><Spinner /></TkShell>;
  if (!ev) return <TkShell><Card><Note tone="warn">We could not find that event. Please check the link you were given.</Note></Card></TkShell>;

  const postponed = ev.status === 'postponed';
  const closed = (ev.over && !postponed) || ev.status === 'cancelled';
  const covered = !!quote?.covered && !!creditCode;
  const avail = quote?.credit ?? creditBal;
  const maxKes = Math.floor(Math.min(avail, quote?.subtotal ?? avail) / 100);
  const shownKes = useKes == null ? Math.floor((quote?.creditUsed ?? maxKes * 100) / 100) : Math.min(useKes, maxKes);
  const pending = !!creditCode && useKes !== sentKes;
  const pickKes = (n: number | null) => setUseKes(n == null ? null : Math.max(0, Math.min(maxKes, Math.floor(n))));
  const free = (quote?.free ?? false) || covered;
  const mobile = method !== 'card';
  const hint = phoneHint(method);
  const emailOk = /^\S+@\S+\.\S+$/.test(email.trim());
  const phoneOk = !mobile || free || phone.replace(/[\s-]/g, '').length >= 9;
  const mismatch = mobile && !free && phone ? networkMismatch(method, phone) : null;
  const nameOk = name.trim().length > 1;
  const setType = (t: TType, n: number) => { setQty((q) => ({ ...q, [t.id]: Math.max(0, Math.min(t.perOrderMax, n)) })); setError(undefined); };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (busy || pending || !count || !nameOk || !emailOk || !phoneOk || mismatch) return;
    setBusy(true); setError(undefined);
    try {
      const o = await api.post<Order>('/public/tickets/orders', { code, name: name.trim(), email: email.trim(), phone: phone.trim() || undefined, method: free ? 'mpesa' : method, lines, creditCode: creditCode || undefined, creditAmount: creditCode && useKes != null ? Math.min(useKes, maxKes) : undefined });
      nav(`/tickets/${encodeURIComponent(o.secret)}`);
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  return (
    <TkShell branding={ev.branding} church={ev.church}>
      <div className="stack">
        <Poster url={ev.posterUrl} title={ev.title} />
        <div>
          <div className="tiny">{ev.church}</div>
          <h1>{ev.title}</h1>
        </div>
        <div className="tk-meta">
          <div><b>{postponed ? (ev.postponed?.startsAt ? when(ev.postponed.startsAt) : 'Date to be announced') : when(ev.startsAt, ev.endsAt)}</b></div>
          {ev.location && <div>{ev.location}</div>}
        </div>
        {ev.description && <p className="tk-desc">{ev.description}</p>}

        {ev.status === 'cancelled' && <Note tone="bad">This event was cancelled.{ev.cancelReason ? ` ${ev.cancelReason}` : ''} Tickets can no longer be bought.</Note>}
        {(postponed || ev.postponed) && ev.status !== 'cancelled' && <PostponedBanner p={ev.postponed} />}
        {ev.status !== 'cancelled' && !postponed && ev.over && <Note tone="warn">This event has already happened. Tickets can no longer be bought.</Note>}

        {!closed && ev.refundDaysBefore != null && <div className="tiny">You can cancel and ask for a refund until {ev.refundDaysBefore} {ev.refundDaysBefore === 1 ? 'day' : 'days'} before the event.</div>}
        {!closed && ev.refundDaysBefore == null && !postponed && <div className="tiny">Tickets are not refundable.</div>}
        {!closed && (
          <form onSubmit={submit} noValidate className="stack" aria-label="Buy tickets">
            {postponed && <Note tone="warn">Tickets are paused until the new date is announced</Note>}
            <h2 style={{ margin: '6px 0 0' }}>Tickets</h2>
            {ev.types.map((t) => {
              const can = t.onSale && !t.soldOut && !postponed;
              const n = qty[t.id] ?? 0;
              return (
                <Card key={t.id} className={`tk-type ${can ? '' : 'off'}`}>
                  <div style={{ minWidth: 0 }}>
                    <h3>{t.name}</h3>
                    <div className="tk-price">{t.price ? kes(t.price) : 'Free'}</div>
                    {t.description && <div className="tiny">{t.description}</div>}
                    {t.soldOut ? <div className="tk-left">Sold out</div> : !t.onSale ? <div className="tk-left">Not on sale</div> : t.left ? <div className="tk-left">Only {t.left} left</div> : null}
                  </div>
                  {can && (
                    <div className="tk-step" role="group" aria-label={`${t.name} quantity`}>
                      <button type="button" aria-label={`Fewer ${t.name}`} disabled={n <= 0} onClick={() => setType(t, n - 1)}>-</button>
                      <output aria-live="polite">{n}</output>
                      <button type="button" aria-label={`More ${t.name}`} disabled={n >= Math.min(t.perOrderMax, t.left ?? t.perOrderMax)} onClick={() => setType(t, n + 1)}>+</button>
                    </div>
                  )}
                </Card>
              );
            })}

            <Card title="Your details">
              <div className="stack">
                <Field label="Full name" hint="The ticket is in this name." error={touched && !nameOk ? 'Please enter your full name' : undefined}>
                  <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="Jane Wanjiru" aria-invalid={touched && !nameOk} />
                </Field>
                <Field label="Email" hint="We email your tickets here" error={touched && !emailOk ? 'Please enter a valid email address' : undefined}>
                  <input type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" aria-invalid={touched && !emailOk} />
                </Field>
                {count > 0 && !free && (
                  <>
                    <div>
                      <div className="field-label" id="lbl-tkmethod" style={{ marginBottom: 8 }}>Pay with</div>
                      <div className="chips" role="group" aria-labelledby="lbl-tkmethod">
                        {METHODS.map(([m, l]) => <button key={m} type="button" className={`chip ${method === m ? 'on' : ''}`} aria-pressed={method === m} onClick={() => { setMethod(m); setError(undefined); }}>{l}</button>)}
                      </div>
                    </div>
                    {mobile && (
                      <Field label={hint.label} hint={hint.help} error={touched && !phoneOk ? 'Please enter your phone number' : mismatch ?? undefined}>
                        <input type="tel" inputMode="tel" autoComplete="tel" placeholder={hint.placeholder} value={phone} onChange={(e) => setPhone(e.target.value)} aria-invalid={!!mismatch || (touched && !phoneOk)} />
                      </Field>
                    )}
                  </>
                )}
                <div className="tk-creditbox">
                  {!creditOpen && !creditCode
                    ? <button type="button" className="tk-linkbtn" onClick={() => setCreditOpen(true)}>Have event credit? Enter your code</button>
                    : (
                      <div className="stack">
                        <Field label="Event credit code" hint="Four groups of four letters and numbers">
                          <div className="tk-creditrow">
                            <input value={creditText} onChange={(e) => setCreditText(e.target.value)} placeholder="3F9A-02BC-77D1-A4E0" autoCapitalize="characters" autoComplete="off" spellCheck={false} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyCredit(); } }} />
                            <Button type="button" kind="ghost" onClick={applyCredit} disabled={creditBusy || !creditText.trim()}>{creditBusy ? '...' : 'Apply'}</Button>
                          </div>
                        </Field>
                        {creditNote && <div className={creditNote.ok ? 'tk-credit-ok' : 'tk-credit-bad'} role="status">{creditNote.text}</div>}
                        {creditCode && avail > 0 && maxKes > 0 && (
                          <div className="tk-usecredit" role="group" aria-label="How much credit to use">
                            <div className="tk-usetitle">Use KES <b>{shownKes.toLocaleString('en-KE')}</b> of your {kes(avail)} credit</div>
                            <div className="chips">
                              <button type="button" className={`chip ${useKes == null ? 'on' : ''}`} aria-pressed={useKes == null} onClick={() => pickKes(null)}>All</button>
                              <button type="button" className={`chip ${useKes != null && useKes === Math.floor(maxKes / 2) && maxKes > 1 ? 'on' : ''}`} onClick={() => pickKes(Math.floor(maxKes / 2))}>Half</button>
                              <button type="button" className={`chip ${useKes === 0 ? 'on' : ''}`} aria-pressed={useKes === 0} onClick={() => pickKes(0)}>None</button>
                            </div>
                            <div className="tk-usebox">
                              <span>KES</span>
                              <input type="number" inputMode="numeric" min={0} max={maxKes} step={1} aria-label="Credit to use in KES" value={shownKes} onChange={(e) => { const v = e.target.value; pickKes(v === '' ? 0 : Number(v)); }} />
                            </div>
                            <input type="range" className="tk-useslider" min={0} max={maxKes} step={1} aria-label="Credit to use" value={shownKes} onChange={(e) => pickKes(Number(e.target.value))} />
                          </div>
                        )}
                        <button type="button" className="tk-linkbtn" onClick={removeCredit}>Remove code</button>
                      </div>
                    )}
                </div>
              </div>
            </Card>

            <div aria-live="polite">
              {count > 0 && quote && (
                <div className="tk-sum">
                  {covered ? (
                    <>
                      <div className="tk-row"><span>{quote.count} {quote.count === 1 ? 'ticket' : 'tickets'}</span><span>{kes(quote.subtotal)}</span></div>
                      <div className="tk-row tk-credit-ok"><span>Credit used</span><span>-{kes(quote.creditUsed ?? quote.subtotal)}</span></div>
                      <div className="tk-row tk-total"><span>To pay now</span><span>{kes(0)}</span></div>
                    </>
                  ) : quote.free ? <div className="tk-total">Free</div> : (
                    <>
                      <div className="tk-row"><span>{quote.count} {quote.count === 1 ? 'ticket' : 'tickets'}</span><span>{kes(quote.subtotal)}</span></div>
                      <div className="tk-row"><span>Service fee</span><span>{kes(quote.serviceFee)}</span></div>
                      {creditCode && (quote.creditUsed ?? 0) > 0
                        ? (
                          <>
                            <div className="tk-row tk-credit-ok"><span>Credit used</span><span>-{kes(quote.creditUsed ?? 0)}</span></div>
                            <div className="tk-row tk-total"><span>To pay now</span><span>{kes(quote.total)}</span></div>
                          </>
                        )
                        : <div className="tk-row tk-total"><span>Total</span><span>{kes(quote.total)}</span></div>}
                    </>
                  )}
                </div>
              )}
              {count === 0 && touched && <Note tone="warn">Choose at least one ticket</Note>}
              {quoteErr && <ErrorNote>{quoteErr}</ErrorNote>}
              {error && <ErrorNote>{error}</ErrorNote>}
            </div>

            <Button type="submit" disabled={busy || pending || count === 0 || postponed || (!!creditCode && !!quoteErr)}>
              {busy ? 'One moment...' : !quote ? 'Choose your tickets' : covered ? 'Get tickets with my credit' : quote.free ? 'Get free tickets' : `Pay ${kes(quote.total)}`}
            </Button>
          </form>
        )}
      </div>
    </TkShell>
  );
}

// ---------------------------------------------------------------- order page

export function OrderPage() {
  const { secret = '' } = useParams();
  const [o, setO] = useState<Order | null | undefined>(undefined);
  const [timedOut, setTimedOut] = useState(false);
  const [tick, setTick] = useState(0);
  const [pp, setPp] = useState<Postponed | null>(null);
  const evCode = o?.event?.code;
  useEffect(() => {
    if (!evCode) return;
    let alive = true;
    api.get<EventInfo>(`/public/event/${encodeURIComponent(evCode)}`).then((e) => alive && setPp(e.postponed ?? null)).catch(() => undefined);
    return () => { alive = false; };
  }, [evCode]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const load = () => {
      api.get<Order>(`/public/tickets/orders/${encodeURIComponent(secret)}`)
        .then((r) => {
          if (!alive) return;
          setO(r);
          if (r.status === 'awaiting_payment') {
            if (Date.now() - started > 180_000) setTimedOut(true);
            else timer = setTimeout(load, 2000);
          }
        })
        .catch((e) => {
          if (!alive) return;
          if (e instanceof ApiError && e.status === 404) setO(null);
          else timer = setTimeout(load, 3000);
        });
    };
    load();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [secret, tick]);

  if (o === undefined) return <TkShell><Spinner /></TkShell>;
  if (o === null) return <TkShell><Card><Note tone="warn">We could not find that order. Please check the link we emailed you.</Note></Card></TkShell>;

  const title = o.event?.title ?? 'the event';
  const gone = o.tickets.length > 0 && o.tickets.every((t) => t.status === 'cancelled');
  const eventCancelled = o.eventStatus === 'cancelled' && !gone;
  const back = `/?event=${encodeURIComponent(o.event?.code ?? o.code ?? '')}`;
  const cardUrl = o.payUrl ? `${o.payUrl}${o.payUrl.includes('?') ? '&' : '?'}return=${encodeURIComponent(`${location.origin}/tickets/${secret}`)}` : null;

  return (
    <TkShell>
      <div className="stack">
        {o.status === 'paid' && gone && (
          <Card>
            <div className="center stack">
              <h1>Your tickets were cancelled</h1>
              <p className="muted" style={{ margin: 0 }}>These tickets for {title} no longer work.</p>
            </div>
          </Card>
        )}
        {o.status === 'paid' && eventCancelled && (
          <Card>
            <div className="center stack">
              <h1>This event was cancelled</h1>
              <p className="muted" style={{ margin: 0 }}>{title} will not take place, so your tickets no longer work. You can keep your money as event credit or get a refund.</p>
            </div>
          </Card>
        )}
        {o.status === 'paid' && !gone && !eventCancelled && (
          <Card>
            <div className="center stack">
              <div className="tk-tick">✓</div>
              <h1>You are going to {title}</h1>
              <p className="muted" style={{ margin: 0 }}>We have emailed your tickets. You can also open them here.</p>
            </div>
          </Card>
        )}
        {o.status === 'paid' && (o.eventStatus === 'postponed' || pp) && <PostponedBanner p={pp} title={title} />}
        {o.status === 'paid' && <CreditBox credit={o.credit} issued={o.creditIssued ?? 0} secret={secret} onDone={() => setTick((n) => n + 1)} />}
        {o.status === 'paid' && !((o.creditIssued ?? 0) > 0) && <RefundBox refund={gone && !o.refund?.request ? undefined : o.refund} secret={secret} creditUsed={o.creditUsed ?? 0} covered={o.total === 0 && (o.creditUsed ?? 0) > 0} onDone={() => setTick((n) => n + 1)} />}
        {o.status === 'paid' && !gone && !eventCancelled && (
          <Card title="Your tickets">
            {o.tickets.map((t) => (
              <div key={t.id} className="tk-ticketrow">
                <div>
                  <div><b>{t.type}</b> for {t.holder}</div>
                  <div className="tk-mono">{t.serial}</div>
                </div>
                <Link className="tk-link" to={`/t/${encodeURIComponent(t.token)}`}>Open ticket</Link>
              </div>
            ))}
          </Card>
        )}

        {o.status === 'awaiting_payment' && o.method !== 'card' && (
          <Card>
            <div className="center stack">
              <h1>Check your phone and enter your PIN</h1>
              <div className="tk-spin"><Spinner /></div>
              <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{kes(o.total)}</div>
              <p className="muted" style={{ margin: 0 }}>{timedOut ? 'We are still waiting for the payment. If you have paid, refresh this page in a moment.' : `Tickets for ${title} are held for 15 minutes while you pay.`}</p>
            </div>
          </Card>
        )}
        {o.status === 'awaiting_payment' && o.method === 'card' && (
          <Card>
            <div className="center stack">
              <h1>Pay by card</h1>
              <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{kes(o.total)}</div>
              {cardUrl && <a className="btn primary" href={cardUrl}>Open the card page</a>}
              <p className="muted" style={{ margin: 0 }}>Your tickets are held for 15 minutes. When you are done you will come back to this page.</p>
            </div>
          </Card>
        )}

        {o.status === 'lapsed' && (
          <Card>
            <div className="center stack">
              <h1>Not paid in time</h1>
              <Note tone="warn">This order was not paid in time. The tickets were released. Please start again.</Note>
              <Link className="tk-link" to={back}>Back to the tickets</Link>
            </div>
          </Card>
        )}
        {o.status !== 'paid' && o.status !== 'awaiting_payment' && o.status !== 'lapsed' && (
          <Card><Note tone="warn">This order is {o.status.replace(/_/g, ' ')}. <Link className="tk-link" to={back}>Back to the tickets</Link></Note></Card>
        )}
      </div>
    </TkShell>
  );
}

// ---------------------------------------------------------------- ticket page

const icsEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsTime = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function downloadIcs(t: TicketView) {
  const s = new Date(t.event.startsAt);
  const e = t.event.endsAt ? new Date(t.event.endsAt) : new Date(s.getTime() + 2 * 3600_000);
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ChurchOS//Tickets//EN', 'BEGIN:VEVENT', `UID:${t.serial}@churchos`, `DTSTAMP:${icsTime(new Date())}`, `DTSTART:${icsTime(s)}`, `DTEND:${icsTime(e)}`,
    `SUMMARY:${icsEsc(t.event.title)}`, `LOCATION:${icsEsc(t.event.location ?? '')}`, `DESCRIPTION:${icsEsc(`${t.event.church}. Ticket ${t.serial}: ${t.url}`)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  const a = document.createElement('a');
  a.href = url; a.download = `${t.event.code}.ics`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function TicketPage() {
  const { token = '' } = useParams();
  const [t, setT] = useState<TicketView | null | undefined>(undefined);
  const [err, setErr] = useState<string | undefined>();

  useEffect(() => {
    let alive = true;
    setT(undefined);
    api.get<TicketView>(`/public/tickets/${encodeURIComponent(token)}`)
      .then((r) => alive && setT(r))
      .catch((e) => { if (!alive) return; if (e instanceof ApiError && e.status !== 404) setErr(errMsg(e)); setT(null); });
    return () => { alive = false; };
  }, [token]);

  if (t === undefined) return <TkShell><Spinner /></TkShell>;
  if (!t) return <TkShell><Card><Note tone="warn">{err ?? 'We could not find that ticket'}</Note></Card></TkShell>;

  const cancelled = t.status === 'cancelled' || t.event.cancelled;
  const used = t.status === 'used' && !cancelled;
  const dim = cancelled || used;
  return (
    <TkShell branding={t.event.branding} church={t.event.church}>
      <article className="tk-ticket" aria-label={`Ticket for ${t.event.title}`}>
        <Poster url={t.event.posterUrl} title={t.event.title} />
        <div className="tk-body">
          <div>
            <div className="tiny">{t.event.church}</div>
            <h1>{t.event.title}</h1>
            <div className="tk-meta" style={{ marginTop: 6 }}>
              <div><b>{when(t.event.startsAt, t.event.endsAt)}</b></div>
              {t.event.location && <div>{t.event.location}</div>}
            </div>
          </div>
          {t.event.postponed && !cancelled && <div className="tk-postponed" role="status"><b>This event was postponed</b><div>The new date will be announced. It was {dayTime(t.event.startsAt)}.</div></div>}
          {t.event.movedFrom && !t.event.postponed && !cancelled && <Note tone="warn">Moved from {dayTime(t.event.movedFrom)}</Note>}
          <div className="tk-cut" />
          <div className={`tk-qrwrap ${dim ? 'dim' : ''}`}>
            <div role="img" aria-label="Ticket QR code" dangerouslySetInnerHTML={{ __html: t.qrSvg }} />
            {used && <div className="tk-stamp"><span>USED</span></div>}
            {cancelled && <div className="tk-stamp"><span>VOID</span></div>}
          </div>
          <div className="tk-holder">
            <div className="name">{t.holder}</div>
            <div>{t.type}</div>
            <div className="tk-mono">{t.serial}</div>
          </div>
          {cancelled
            ? <Note tone="bad">{t.event.cancelled ? 'This event was cancelled' : 'This ticket was cancelled'}</Note>
            : used
              ? <Note tone="warn">Used at {t.usedAt ? `${day(t.usedAt)}, ${clock(t.usedAt)}` : 'the door'}</Note>
              : <Note tone="good">Valid. Show this at the door. It works once.</Note>}
        </div>
      </article>
      <div className="tk-actions no-print">
        <Button kind="ghost" onClick={() => window.print()}>Print ticket</Button>
        <Button kind="ghost" onClick={() => downloadIcs(t)}>Add to calendar</Button>
      </div>
      <p className="tiny no-print" style={{ textAlign: 'center', marginTop: 8 }}>To change or cancel your order, use the link in your confirmation email.</p>
    </TkShell>
  );
}
