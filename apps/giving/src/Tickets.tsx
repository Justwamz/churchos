import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, API_URL, Button, Card, ErrorNote, Field, Note, Spinner, createApi, kes } from '@churchos/ui';
import { networkMismatch, phoneHint } from '@churchos/shared';
import './tickets.css';

const api = createApi('churchos:giving:tickets');

interface TType { id: string; name: string; description?: string | null; price: number; perOrderMax: number; onSale: boolean; soldOut: boolean; left?: number | null }
interface EventInfo { code: string; title: string; description?: string | null; location?: string | null; startsAt: string; endsAt?: string | null; church: string; status: string; cancelReason?: string | null; over: boolean; posterUrl?: string | null; types: TType[] }
interface Quote { count: number; subtotal: number; serviceFee: number; total: number; free: boolean }
interface OrderTicket { id: string; serial: string; type: string; holder: string; status: string; url: string; token: string }
interface Order { id: string; secret: string; code: string; status: string; subtotal: number; serviceFee: number; total: number; method?: string; payUrl?: string | null; message?: string; event?: { title: string; code: string }; tickets: OrderTicket[] }
interface TicketView { serial: string; type: string; holder: string; status: 'valid' | 'used' | 'cancelled'; usedAt?: string | null; url: string; qrSvg: string; event: { code: string; title: string; startsAt: string; endsAt?: string | null; location?: string | null; church: string; cancelled: boolean; posterUrl?: string | null } }

const METHODS: [string, string][] = [['mpesa', 'M-Pesa'], ['airtel', 'Airtel Money'], ['tkash', 'T-Kash'], ['card', 'Card']];
const eat = (d: string, o: Intl.DateTimeFormatOptions) => new Date(d).toLocaleString('en-GB', { timeZone: 'Africa/Nairobi', ...o });
const day = (d: string) => eat(d, { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
const clock = (d: string) => eat(d, { hour: '2-digit', minute: '2-digit', hour12: false });
const sameDay = (a: string, b: string) => day(a) === day(b);
const when = (s: string, e?: string | null) => (e ? (sameDay(s, e) ? `${day(s)}, ${clock(s)} to ${clock(e)}` : `${day(s)}, ${clock(s)} to ${day(e)}, ${clock(e)}`) : `${day(s)}, ${clock(s)}`);
const errMsg = (e: unknown) => (e instanceof ApiError && e.message ? e.message : 'Something went wrong. Please try again.');
const posterSrc = (u?: string | null) => (u ? `${API_URL}${u}` : null);

function TkShell({ children }: { children: ReactNode }) {
  return (
    <div className="mobile giving tk">
      <div className="tk-brand no-print">Event tickets</div>
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
    api.post<Quote>('/public/tickets/quote', { code, method, lines })
      .then((q) => alive && setQuote(q))
      .catch(() => alive && setQuote(undefined));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, method, linesKey]);

  if (ev === undefined) return <TkShell><Spinner /></TkShell>;
  if (!ev) return <TkShell><Card><Note tone="warn">We could not find that event. Please check the link you were given.</Note></Card></TkShell>;

  const closed = ev.over || ev.status === 'cancelled';
  const free = quote?.free ?? false;
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
    if (busy || !count || !nameOk || !emailOk || !phoneOk || mismatch) return;
    setBusy(true); setError(undefined);
    try {
      const o = await api.post<Order>('/public/tickets/orders', { code, name: name.trim(), email: email.trim(), phone: phone.trim() || undefined, method: free ? 'mpesa' : method, lines });
      nav(`/tickets/${encodeURIComponent(o.secret)}`);
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  return (
    <TkShell>
      <div className="stack">
        <Poster url={ev.posterUrl} title={ev.title} />
        <div>
          <div className="tiny">{ev.church}</div>
          <h1>{ev.title}</h1>
        </div>
        <div className="tk-meta">
          <div><b>{when(ev.startsAt, ev.endsAt)}</b></div>
          {ev.location && <div>{ev.location}</div>}
        </div>
        {ev.description && <p className="tk-desc">{ev.description}</p>}

        {ev.status === 'cancelled' && <Note tone="bad">This event was cancelled.{ev.cancelReason ? ` ${ev.cancelReason}` : ''} Tickets can no longer be bought.</Note>}
        {ev.status !== 'cancelled' && ev.over && <Note tone="warn">This event has already happened. Tickets can no longer be bought.</Note>}

        {!closed && (
          <form onSubmit={submit} noValidate className="stack" aria-label="Buy tickets">
            <h2 style={{ margin: '6px 0 0' }}>Tickets</h2>
            {ev.types.map((t) => {
              const can = t.onSale && !t.soldOut;
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
              </div>
            </Card>

            <div aria-live="polite">
              {count > 0 && quote && (
                <div className="tk-sum">
                  {quote.free ? <div className="tk-total">Free</div> : (
                    <>
                      <div className="tk-row"><span>{quote.count} {quote.count === 1 ? 'ticket' : 'tickets'}</span><span>{kes(quote.subtotal)}</span></div>
                      <div className="tk-row"><span>Service fee</span><span>{kes(quote.serviceFee)}</span></div>
                      <div className="tk-row tk-total"><span>Total</span><span>{kes(quote.total)}</span></div>
                    </>
                  )}
                </div>
              )}
              {count === 0 && touched && <Note tone="warn">Choose at least one ticket</Note>}
              {error && <ErrorNote>{error}</ErrorNote>}
            </div>

            <Button type="submit" disabled={busy || count === 0}>
              {busy ? 'One moment...' : !quote ? 'Choose your tickets' : quote.free ? 'Get free tickets' : `Pay ${kes(quote.total)}`}
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
  }, [secret]);

  if (o === undefined) return <TkShell><Spinner /></TkShell>;
  if (o === null) return <TkShell><Card><Note tone="warn">We could not find that order. Please check the link we emailed you.</Note></Card></TkShell>;

  const title = o.event?.title ?? 'the event';
  const back = `/?event=${encodeURIComponent(o.event?.code ?? o.code ?? '')}`;
  const cardUrl = o.payUrl ? `${o.payUrl}${o.payUrl.includes('?') ? '&' : '?'}return=${encodeURIComponent(`${location.origin}/tickets/${secret}`)}` : null;

  return (
    <TkShell>
      <div className="stack">
        {o.status === 'paid' && (
          <Card>
            <div className="center stack">
              <div className="tk-tick">✓</div>
              <h1>You are going to {title}</h1>
              <p className="muted" style={{ margin: 0 }}>We have emailed your tickets. You can also open them here.</p>
            </div>
          </Card>
        )}
        {o.status === 'paid' && (
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
    <TkShell>
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
    </TkShell>
  );
}
