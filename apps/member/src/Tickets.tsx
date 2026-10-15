import { networkMismatch, phoneHint } from '@churchos/shared';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Button, ErrorNote, Field, Note, kes, phonePretty, useAsync } from '@churchos/ui';
import { api, errText } from './api';
import { Icon, Sheet, Skeleton } from './ui';

// ---------------- helpers ----------------

const TZ = 'Africa/Nairobi';
const dateLong = (iso: string) => new Date(iso).toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ });
const dateShort = (iso: string) => new Date(iso).toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-KE', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
const when = (iso: string) => `${dateLong(iso)}, ${timeOf(iso)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The signed-in user, so buy sheets anywhere can default the phone number. */
export const UserCtx = createContext<any>(null);
export const TICKET_PENDING_KEY = 'churchos:ticket-pending';
/** Tell the shell to open the My tickets page. */
export const openMyTickets = () => window.dispatchEvent(new Event('churchos:open-tickets'));
const returnUrl = (payUrl: string) => `${payUrl}${payUrl.includes('?') ? '&' : '?'}return=${encodeURIComponent(`${location.origin}/`)}`;

const METHODS = [
  { key: 'mpesa', label: 'M-Pesa' },
  { key: 'airtel', label: 'Airtel Money' },
  { key: 'tkash', label: 'T-Kash' },
  { key: 'card', label: 'Card' },
];

const ERR: Record<string, string> = {
  sold_out: 'Sorry, those tickets just sold out. Please pick fewer tickets or another type.',
  too_many: 'You can order up to 20 tickets at a time, and you can have 3 orders waiting for payment. Please lower the number or finish your waiting orders first.',
  not_on_sale: 'These tickets are not on sale right now.',
  free_limit: 'Free tickets are limited per person. Please lower the number.',
  wrong_network: 'That phone number does not match the payment method you chose. Please check it.',
  bad_phone: 'Please enter the phone number to send the payment prompt to.',
  bad_method: 'Please choose M-Pesa, Airtel Money, T-Kash or Card.',
  cancelled: 'This event was cancelled, so tickets are no longer sold.',
  over: 'This event is over, so tickets are no longer sold.',
};

const TILE = ['#0e5a52', '#b9832a', '#25598f', '#8a4f7d', '#b3322d', '#1d7a4a'];

/** Poster picture, or a coloured tile with the first letter when there is no poster. */
export function Poster({ url, title, className = '' }: { url?: string | null; title: string; className?: string }) {
  const sum = [...title].reduce((s, c) => s + c.charCodeAt(0), 0);
  return url
    ? <img className={`tk-poster ${className}`} src={api.url(url)} alt="" loading="lazy" draggable={false} />
    : <span className={`tk-poster tk-poster-tile ${className}`} style={{ background: TILE[sum % TILE.length] }} aria-hidden="true">{(title.trim()[0] ?? '?').toUpperCase()}</span>;
}

/** The little price line shown on event cards. */
export const priceLine = (e: { ticketFrom?: number; soldOut?: boolean }) => (e.soldOut ? 'Sold out' : !e.ticketFrom ? 'Free tickets' : `Tickets from ${kes(e.ticketFrom).replace(/\.00$/, '')}`);

function Qr({ svg, size, used }: { svg: string; size: number; used?: boolean }) {
  return <div className={`tk-qr ${used ? 'used' : ''}`} style={{ width: size, height: size }} role="img" aria-label="Ticket QR code" dangerouslySetInnerHTML={{ __html: svg }} />;
}

// ---------------- buying ----------------

type Type = { id: string; name: string; description?: string | null; price: number; perOrderMax: number; onSale: boolean; soldOut: boolean; left?: number };

/** The purchase sheet. Opened from an event, or from an advert that sells tickets. */
export function TicketBuy({ code, eventId, advertId, onClose }: { code: string; eventId: string; advertId?: string; onClose: () => void }) {
  const user = useContext(UserCtx);
  const ev = useAsync<any>(() => api.get(`/public/event/${encodeURIComponent(code)}`), [code]);
  const e = ev.data;
  const types: Type[] = e?.types ?? [];
  const [qty, setQty] = useState<Record<string, number>>({});
  const [method, setMethod] = useState('mpesa');
  const [phone, setPhone] = useState(phonePretty(user?.phone));
  const [quote, setQuote] = useState<{ count: number; subtotal: number; serviceFee: number; total: number; free: boolean } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [phase, setPhase] = useState<'form' | 'waiting' | 'done' | 'slow' | 'lapsed'>('form');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [order, setOrder] = useState<any>(null);
  const [tickets, setTickets] = useState<any[]>([]);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const lines = useMemo(() => Object.entries(qty).filter(([, n]) => n > 0).map(([typeId, n]) => ({ typeId, qty: n })), [qty]);
  const count = lines.reduce((s, l) => s + l.qty, 0);
  const closed = !!e && (e.status === 'cancelled' || e.over);

  // live price, a moment after the last change
  useEffect(() => {
    if (!count) { setQuote(null); setQuoting(false); return; }
    setQuoting(true);
    let live = true;
    const t = setTimeout(() => {
      api.post('/public/tickets/quote', { code, method, lines })
        .then((r: any) => { if (live) { setQuote(r); setQuoting(false); } })
        .catch(() => { if (live) setQuoting(false); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [JSON.stringify(lines), method, code]); // eslint-disable-line react-hooks/exhaustive-deps

  const maxFor = (t: Type) => {
    const others = count - (qty[t.id] ?? 0);
    return Math.max(0, Math.min(t.perOrderMax, t.left ?? t.perOrderMax, 20 - others));
  };
  const set = (t: Type, n: number) => { setError(''); setQty((q) => ({ ...q, [t.id]: Math.max(0, Math.min(maxFor(t), n)) })); };

  const free = !!quote?.free;
  const hint = phoneHint(method);
  const mismatch = free || method === 'card' ? null : networkMismatch(method, phone);
  const ready = count > 0 && !!quote && !quoting && (free || method === 'card' || (phone.trim().length >= 9 && !mismatch));

  const loadTickets = async (o: any) => {
    try {
      const r = await api.get('/me/tickets');
      const ids = new Set((o.tickets ?? []).map((t: any) => t.id));
      setTickets((r.tickets ?? []).filter((t: any) => ids.has(t.id)));
    } catch { /* the success screen still works without the codes */ }
  };
  const finish = async (o: any) => {
    await loadTickets(o);
    if (!alive.current) return;
    setOrder(o); setPhase('done');
    window.dispatchEvent(new Event('churchos:gift-done')); // the confirmation message arrives a moment later
  };

  const pay = async () => {
    setBusy(true); setError('');
    try {
      const o = await api.post('/me/tickets/orders', { eventId, method, phone: free || method === 'card' ? undefined : phone, lines, advertId });
      if (!alive.current) return;
      if (o.status === 'paid') { await finish(o); return; }
      if (method === 'card' && o.payUrl) {
        try { localStorage.setItem(TICKET_PENDING_KEY, JSON.stringify({ orderId: o.id })); } catch { /* ignore */ }
        window.location.assign(returnUrl(o.payUrl));
        return;
      }
      setOrder(o); setPhase('waiting');
      const started = Date.now();
      while (alive.current && Date.now() - started < 180_000) {
        await sleep(2000);
        if (!alive.current) return;
        try {
          const now = await api.get(`/public/tickets/orders/${encodeURIComponent(o.secret)}`);
          if (now.status === 'paid') { await finish(now); return; }
          if (now.status !== 'awaiting_payment') { setPhase('lapsed'); return; }
        } catch { /* keep trying */ }
      }
      if (alive.current) setPhase('slow');
    } catch (err: any) {
      setError(ERR[err?.code] ?? errText(err));
    } finally { if (alive.current) setBusy(false); }
  };

  const cancel = async () => {
    if (order) { try { await api.post(`/me/tickets/orders/${order.id}/cancel`); } catch { /* may already be paid */ } }
    alive.current = false;
    onClose();
  };

  const title = phase === 'done' ? 'Your tickets' : phase === 'waiting' || phase === 'slow' ? 'Pay for your tickets' : e?.title ?? 'Tickets';
  return (
    <Sheet open onClose={phase === 'waiting' ? cancel : onClose} title={title}>
      {phase === 'form' && (
        ev.loading && !e ? <Skeleton lines={4} tall />
        : ev.error && !e ? <div className="stack"><ErrorNote>{ev.error}</ErrorNote><Button kind="ghost" onClick={ev.reload}>Try again</Button></div>
        : e && (
          <div className="stack tk-buy">
            <Poster url={e.posterUrl} title={e.title} className="wide" />
            <div className="event-facts">
              <span><Icon name="calendar" size={18} /> {when(e.startsAt)}</span>
              {e.location && <span><Icon name="pin" size={18} /> {e.location}</span>}
              <span className="tiny">{e.church}</span>
            </div>
            {e.description && <p className="full-text clamp4">{e.description}</p>}
            {e.status === 'cancelled' && <Note tone="bad">This event was cancelled.{e.cancelReason ? ` Reason: ${e.cancelReason}` : ''}</Note>}
            {e.status !== 'cancelled' && e.over && <Note tone="info">This event is over, so tickets are no longer sold.</Note>}
            {!closed && (
              <>
                <div className="field-label">Choose your tickets</div>
                <ul className="tk-types">
                  {types.map((t) => {
                    const off = t.soldOut || !t.onSale;
                    const max = maxFor(t);
                    return (
                      <li key={t.id} className={`tk-type ${off ? 'off' : ''}`}>
                        <span className="tk-type-main">
                          <strong>{t.name}</strong>
                          {t.description && <span className="tiny">{t.description}</span>}
                          <span className="tk-type-price">{t.price ? kes(t.price) : 'Free'}</span>
                          {!off && t.left != null && <span className="shop-left inline">Only {t.left} left</span>}
                        </span>
                        {off ? <span className="badge muted">{t.soldOut ? 'Sold out' : 'Not on sale'}</span> : (
                          <div className="stepper" role="group" aria-label={`Number of ${t.name} tickets`}>
                            <button type="button" aria-label={`One less ${t.name}`} disabled={(qty[t.id] ?? 0) <= 0} onClick={() => set(t, (qty[t.id] ?? 0) - 1)}>{'−'}</button>
                            <output aria-live="polite">{qty[t.id] ?? 0}</output>
                            <button type="button" aria-label={`One more ${t.name}`} disabled={(qty[t.id] ?? 0) >= max} onClick={() => set(t, (qty[t.id] ?? 0) + 1)}>+</button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {!types.some((t) => t.onSale && !t.soldOut) && <Note tone="warn">Tickets are sold out or no longer on sale.</Note>}

                {count > 0 && (
                  <div className="tk-sum" aria-live="polite">
                    {!quote ? <span className="tiny">Working out the price…</span> : free ? (
                      <div className="tk-sum-row grand"><span>{count} {count === 1 ? 'ticket' : 'tickets'}</span><strong>Free</strong></div>
                    ) : (
                      <>
                        <div className="tk-sum-row"><span>{quote.count} {quote.count === 1 ? 'ticket' : 'tickets'}</span><span>{kes(quote.subtotal)}</span></div>
                        <div className="tk-sum-row"><span>Service fee</span><span>{kes(quote.serviceFee)}</span></div>
                        <div className="tk-sum-row grand"><span>Total</span><strong>{kes(quote.total)}</strong></div>
                      </>
                    )}
                  </div>
                )}

                {count > 0 && !free && (
                  <>
                    <div>
                      <div className="field-label" id="tk-meth">Pay with</div>
                      <div className="chips" role="group" aria-labelledby="tk-meth" style={{ marginTop: 8 }}>
                        {METHODS.map((x) => <button key={x.key} type="button" className={`chip ${method === x.key ? 'on' : ''}`} aria-pressed={method === x.key} onClick={() => setMethod(x.key)}>{x.label}</button>)}
                      </div>
                    </div>
                    {method !== 'card' && (
                      <Field label={hint.label} hint={hint.help} error={mismatch ?? undefined}>
                        <input type="tel" inputMode="tel" autoComplete="tel" placeholder={hint.placeholder} value={phone} onChange={(ev2) => setPhone(ev2.target.value)} aria-invalid={!!mismatch} />
                      </Field>
                    )}
                  </>
                )}
                <p className="tiny tk-name">The tickets will be in your name.</p>
                {error && <ErrorNote>{error}</ErrorNote>}
                <Button disabled={busy || !ready} onClick={pay}>
                  {busy ? (method === 'card' && !free ? 'Opening card page…' : 'One moment…') : !count ? 'Choose your tickets' : free ? 'Get free tickets' : quote ? `Pay ${kes(quote.total)}` : 'Pay'}
                </Button>
              </>
            )}
          </div>
        )
      )}

      {phase === 'waiting' && order && (
        <div className="stack shop-wait">
          <div className="spinner" role="status" aria-label="Waiting for payment" />
          <h3>Check your phone and enter your PIN</h3>
          <p>We sent a payment request for <strong>{kes(order.total)}</strong>. This screen updates by itself once you have paid.</p>
          <p className="tiny">Your tickets are held for 15 minutes.</p>
          <button type="button" className="link-btn" onClick={cancel}>Cancel</button>
        </div>
      )}

      {phase === 'slow' && order && (
        <div className="stack">
          <Note tone="info">We are still waiting for your payment to come through. If you entered your PIN, your tickets will show in My tickets shortly. Please do not pay twice.</Note>
          <Button onClick={() => { onClose(); openMyTickets(); }}>View my tickets</Button>
          <button type="button" className="link-btn" onClick={cancel}>Cancel these tickets</button>
        </div>
      )}

      {phase === 'lapsed' && (
        <div className="stack">
          <Note tone="warn">These tickets were not paid for, so they have been released. You can try again.</Note>
          <Button onClick={onClose}>Close</Button>
        </div>
      )}

      {phase === 'done' && order && (
        <div className="stack tk-done">
          <svg className="bigcheck" viewBox="0 0 80 80" width="96" height="96" aria-hidden="true">
            <circle className="bc-ring" cx="40" cy="40" r="36" fill="none" strokeWidth="5" />
            <path className="bc-tick" d="M24 41.5 35 52.5 57 29" fill="none" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <h3>You are going to {e?.title ?? order.event?.title}</h3>
          {e?.startsAt && <p className="tiny">{when(e.startsAt)}{e.location ? ` · ${e.location}` : ''}</p>}
          <ul className="tk-done-list">
            {(tickets.length ? tickets : order.tickets).map((t: any) => (
              <li key={t.id}>
                {t.qrSvg ? <Qr svg={t.qrSvg} size={220} /> : <div className="tk-qr missing">QR code in My tickets</div>}
                <strong>{t.type}</strong>
                <span className="tiny">{t.holder}</span>
                <code className="tk-serial">{t.serial}</code>
              </li>
            ))}
          </ul>
          <p className="tiny">We have also saved them in My tickets.</p>
          <Button onClick={() => { onClose(); openMyTickets(); }}>View my tickets</Button>
          <Button kind="ghost" onClick={onClose}>Done</Button>
        </div>
      )}
    </Sheet>
  );
}

// ---------------- my tickets ----------------

const isUpcoming = (ev: any) => !ev.cancelled && new Date(ev.endsAt ?? ev.startsAt).getTime() + (ev.endsAt ? 0 : 3 * 3600_000) >= Date.now();

function statusOf(t: any): { label: string; tone: string } {
  if (t.event.cancelled) return { label: 'Event cancelled', tone: 'bad' };
  if (t.status === 'used') return { label: 'Used', tone: 'muted' };
  return { label: 'Valid', tone: 'good' };
}

function TicketView({ t, onClose }: { t: any | null; onClose: () => void }) {
  const s = t ? statusOf(t) : null;
  const dead = !!t && (t.status === 'used' || t.event.cancelled);
  return (
    <Sheet open={!!t} onClose={onClose} full title={t?.event.title} label="Your ticket">
      {t && s && (
        <div className="tk-view">
          <h3>{t.event.title}</h3>
          <span className={`badge ${s.tone}`}>{s.label}</span>
          <Qr svg={t.qrSvg} size={280} used={dead} />
          <code className="tk-serial">{t.serial}</code>
          <div className="event-facts tk-view-facts">
            <span><Icon name="calendar" size={18} /> {when(t.event.startsAt)}</span>
            {t.event.location && <span><Icon name="pin" size={18} /> {t.event.location}</span>}
            <span><Icon name="ticket" size={18} /> {t.type} · {t.holder}</span>
          </div>
          {t.event.cancelled ? <Note tone="bad">This event was cancelled.</Note>
            : t.status === 'used' ? <p className="tk-door used">Used{t.usedAt ? ` at ${timeOf(t.usedAt)} on ${dateShort(t.usedAt)}` : ''}</p>
            : <p className="tk-door"><strong>Show this at the door.</strong> It works once.</p>}
          <Button kind="ghost" onClick={onClose}>Close</Button>
        </div>
      )}
    </Sheet>
  );
}

export function TicketsPage({ onEvents }: { onEvents: () => void }) {
  const q = useAsync<any>(() => api.get('/me/tickets'));
  const [open, setOpen] = useState<any | null>(null);
  const [err, setErr] = useState('');
  const tickets: any[] = q.data?.tickets ?? [];
  const pending: any[] = q.data?.pending ?? [];
  const reload = useRef(q.reload);
  reload.current = q.reload;

  // coming back from the card page: forget the reminder and look for the new tickets
  useEffect(() => { try { localStorage.removeItem(TICKET_PENDING_KEY); } catch { /* ignore */ } }, []);
  useEffect(() => {
    if (!pending.length) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') reload.current(); }, 4000);
    return () => clearInterval(t);
  }, [pending.length]);

  const groups = useMemo(() => {
    const m = new Map<string, { ev: any; items: any[] }>();
    for (const t of tickets) { const g = m.get(t.event.id); if (g) g.items.push(t); else m.set(t.event.id, { ev: t.event, items: [t] }); }
    const all = [...m.values()];
    const up = all.filter((g) => isUpcoming(g.ev)).sort((a, b) => +new Date(a.ev.startsAt) - +new Date(b.ev.startsAt));
    const past = all.filter((g) => !isUpcoming(g.ev)).sort((a, b) => +new Date(b.ev.startsAt) - +new Date(a.ev.startsAt));
    return { up, past };
  }, [tickets]);

  const cancel = async (o: any) => {
    setErr('');
    try { await api.post(`/me/tickets/orders/${o.id}/cancel`); } catch (e) { setErr(errText(e)); }
    q.reload();
  };

  if (q.loading && !q.data) return <div className="card"><Skeleton lines={4} tall /></div>;
  if (q.error && !q.data) return <div className="stack"><ErrorNote>{q.error}</ErrorNote><Button kind="ghost" onClick={q.reload}>Try again</Button></div>;

  const section = (label: string, list: { ev: any; items: any[] }[]) => list.length > 0 && (
    <section className="tk-group-wrap">
      <h3 className="agenda-month">{label}</h3>
      <div className="tk-groups">
        {list.map((g) => (
          <div key={g.ev.id} className="tk-group">
            <div className="tk-group-head">
              <Poster url={g.ev.posterUrl} title={g.ev.title} className="strip" />
              <div className="tk-group-title">
                <strong>{g.ev.title}</strong>
                <span className="tiny"><Icon name="calendar" size={14} /> {when(g.ev.startsAt)}</span>
                {g.ev.location && <span className="tiny"><Icon name="pin" size={14} /> {g.ev.location}</span>}
              </div>
            </div>
            <ul className="tk-list">
              {g.items.map((t) => {
                const s = statusOf(t);
                return (
                  <li key={t.id}>
                    <button type="button" className={`tk-card ${t.status === 'used' || t.event.cancelled ? 'dim' : ''}`} onClick={() => setOpen(t)} aria-label={`${t.type} ticket for ${t.event.title}, ${s.label}`}>
                      <span className="tk-card-ico"><Icon name="ticket" size={22} /></span>
                      <span className="tk-card-main"><strong>{t.type}</strong><span className="tiny ell">{t.holder} · {t.serial}</span></span>
                      <span className={`badge ${s.tone}`}>{s.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );

  return (
    <div className="stack tk-page">
      {err && <ErrorNote>{err}</ErrorNote>}
      {pending.length > 0 && (
        <section className="tk-group-wrap">
          <h3 className="agenda-month">Waiting for payment</h3>
          <ul className="tk-pending">
            {pending.map((o) => (
              <li key={o.id} className="order-card awaiting_payment">
                <div className="order-top"><span className="badge warn">Waiting for payment</span><span className="tiny">{o.code}</span></div>
                <strong>{o.event?.title}</strong>
                <ul className="order-items">{(o.lines ?? []).map((l: any, i: number) => <li key={i}><span>{l.qty} x {l.name}</span><span>{kes(l.qty * l.unitPrice)}</span></li>)}</ul>
                <div className="order-total"><span>Total</span><strong>{kes(o.total)}</strong></div>
                <div className="order-actions">
                  {o.payUrl
                    ? <button type="button" className="btn primary small" onClick={() => { try { localStorage.setItem(TICKET_PENDING_KEY, JSON.stringify({ orderId: o.id })); } catch { /* ignore */ } window.location.assign(returnUrl(o.payUrl)); }}>Pay now</button>
                    : <span className="tiny">Check your phone and enter your PIN.</span>}
                  <button type="button" className="link-btn" onClick={() => cancel(o)}>Cancel</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!tickets.length && !pending.length ? (
        <div className="empty-state"><Icon name="ticket" size={40} /><strong>No tickets yet</strong><span>When you buy tickets to an event, they show here with a QR code to scan at the door.</span><Button small onClick={onEvents}>See events</Button></div>
      ) : (
        <>
          {section('Coming up', groups.up)}
          {section('Past events', groups.past)}
        </>
      )}
      <TicketView t={open} onClose={() => setOpen(null)} />
    </div>
  );
}

// ---------------- Home card ----------------

export function HomeTickets({ onOpen }: { onOpen: () => void }) {
  const q = useAsync<any>(() => api.get('/me/tickets'));
  const next = useMemo(() => {
    const valid = (q.data?.tickets ?? []).filter((t: any) => t.status === 'valid' && isUpcoming(t.event));
    valid.sort((a: any, b: any) => +new Date(a.event.startsAt) - +new Date(b.event.startsAt));
    const first = valid[0];
    return first ? { ev: first.event, n: valid.filter((t: any) => t.event.id === first.event.id).length } : null;
  }, [q.data]);
  if (!next) return null;
  return (
    <section className="block tk-home">
      <div className="block-head"><h3>Tickets</h3></div>
      <div className="tk-home-body">
        <Poster url={next.ev.posterUrl} title={next.ev.title} className="strip" />
        <div className="tk-home-text">
          <strong>Your next event: {next.ev.title}</strong>
          <span className="tiny">{dateShort(next.ev.startsAt)}, {timeOf(next.ev.startsAt)} · {next.n} {next.n === 1 ? 'ticket' : 'tickets'}</span>
        </div>
      </div>
      <Button onClick={onOpen}>Show tickets</Button>
    </section>
  );
}
