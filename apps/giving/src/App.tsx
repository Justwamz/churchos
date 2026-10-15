import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Checkout } from './Checkout';
import { EventPage, OrderPage, TicketPage } from './Tickets';
import { ApiError, Button, Card, ErrorNote, Field, HelpButton, Note, Spinner, createApi, kes } from '@churchos/ui';
import { networkMismatch, phoneHint } from '@churchos/shared';

const api = createApi('churchos:giving:token');

const CHURCH_KEY = 'churchos:church';
const PHONE_KEY = 'churchos:phone';
const store = {
  get(k: string): string | null {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k: string, v: string) {
    try { localStorage.setItem(k, v); } catch { /* storage blocked */ }
  },
  del(k: string) {
    try { localStorage.removeItem(k); } catch { /* storage blocked */ }
  },
};

const MIN_KES = 10;
const MAX_KES = 150_000;
const QUICK = [100, 500, 1000, 5000];
const METHOD_LABEL: Record<string, string> = { mpesa: 'M-Pesa', airtel: 'Airtel Money', tkash: 'T-Kash', card: 'Card' };

interface Church {
  code: string;
  name: string;
  organisation: string;
  feeBearer: string;
  purposes: { key: string; label: string }[];
  projects: { code: string; name: string; description?: string; target: number | string | null; raised: number | string }[];
  methods: string[];
  paybill: { number: string; accountReference: string };
}
interface CertInfo { serial: string; kind: string; price: number; churchCode: string; church: string; purpose: string }
interface AdInfo { code: string; title: string; advertiser: string; price: number; startsAt: string; endsAt: string | null; churchCode: string; church: string; purpose: string }
interface BookingInfo { code: string; title: string; price: number; startsAt: string; endsAt: string; holdUntil: string; resources: string[]; churchCode: string; church: string; purpose: string }
const eat = (d: string, o: Intl.DateTimeFormatOptions) => new Date(d).toLocaleString('en-GB', { timeZone: 'Africa/Nairobi', ...o });
const eatDay = (d: string) => eat(d, { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
const eatTime = (d: string) => eat(d, { hour: '2-digit', minute: '2-digit', hour12: false });
interface Intent { status: string; church: string; purpose: string; amountPaid: number | string; receipt: string | null }

function PhoneField({ method, phone, setPhone, error }: { method: string; phone: string; setPhone: (v: string) => void; error?: string }) {
  const h = phoneHint(method);
  return (
    <Field label={h.label} hint={h.help} error={error}>
      <input type="tel" inputMode="tel" autoComplete="tel" placeholder={h.placeholder} value={phone} onChange={(e) => setPhone(e.target.value)} aria-invalid={!!error} />
    </Field>
  );
}

const validPhone = (p: string) => /^(?:0[17]\d{8}|(?:\+?254)[17]\d{8})$/.test(p.replace(/[\s-]/g, ''));
const parseAmount = (s: string) => (/^\d+(\.\d{1,2})?$/.test(s.trim()) ? Number(s) : NaN);
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/verify/:serial" element={<Verify />} />
        <Route path="/checkout/:id" element={<Checkout />} />
        <Route path="/t/:token" element={<TicketPage />} />
        <Route path="/tickets/:secret" element={<OrderPage />} />
        <Route path="/:code" element={<GivePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

function Shell({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="mobile giving">
      <style>{CSS}</style>
      <HelpButton api={api} audience="member" screen="giving.home" />
      <header className="g-head">
        <div className="brand">{sub ?? 'Giving'}</div>
        <h1>{title}</h1>
      </header>
      {children}
      <footer className="tiny g-foot">Secure giving by ChurchOS. We never see your M-Pesa PIN.</footer>
    </div>
  );
}

function CodeBox({ onGo, initial = '', error }: { onGo: (c: string) => void; initial?: string; error?: string }) {
  const [code, setCode] = useState(initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (c) onGo(c);
  };
  return (
    <form onSubmit={submit} className="stack">
      <Field label="Church code" hint="You can find it on your church notice board or bulletin.">
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="GRC001, GRC002 or HPC001" autoCapitalize="characters" autoComplete="off" autoFocus />
      </Field>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button type="submit" disabled={!code.trim()}>Continue</Button>
    </form>
  );
}

function AdPage() {
  const [search] = useSearchParams();
  const adCode = search.get('ad') ?? '';
  const [ad, setAd] = useState<AdInfo | null | undefined>(undefined);
  const [church, setChurch] = useState<Church | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setAd(undefined); setChurch(undefined);
    api.get<AdInfo>(`/public/ad/${encodeURIComponent(adCode)}`)
      .then((a) => {
        if (!alive) return;
        setAd(a);
        return api.get<Church>(`/public/church/${encodeURIComponent(a.churchCode)}`)
          .then((c) => alive && setChurch(c))
          .catch(() => alive && setChurch(null));
      })
      .catch(() => alive && setAd(null));
    return () => { alive = false; };
  }, [adCode]);

  if (ad === undefined || (ad && church === undefined)) return <Shell title="One moment"><Spinner /></Shell>;
  if (!ad || !church) {
    return (
      <Shell title="Advert payment">
        <Card>
          <Note tone="warn">There is no advert waiting for payment under this link. It may already be paid, or the church may need to send you a new link.</Note>
        </Card>
      </Shell>
    );
  }
  return (
    <Shell title={church.name} sub={church.organisation}>
      <GiveForm church={church} ad={ad} />
    </Shell>
  );
}

function BookingPage() {
  const [search] = useSearchParams();
  const code = search.get('booking') ?? '';
  const [booking, setBooking] = useState<BookingInfo | null | undefined>(undefined);
  const [church, setChurch] = useState<Church | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setBooking(undefined); setChurch(undefined);
    api.get<BookingInfo>(`/public/booking/${encodeURIComponent(code)}`)
      .then((b) => {
        if (!alive) return;
        setBooking(b);
        return api.get<Church>(`/public/church/${encodeURIComponent(b.churchCode)}`)
          .then((c) => alive && setChurch(c))
          .catch(() => alive && setChurch(null));
      })
      .catch(() => alive && setBooking(null));
    return () => { alive = false; };
  }, [code]);

  if (booking === undefined || (booking && church === undefined)) return <Shell title="One moment"><Spinner /></Shell>;
  if (!booking || !church) {
    return (
      <Shell title="Booking payment">
        <Card>
          <Note tone="warn">There is no booking waiting for payment under this link. It may already be paid, or the time may have been released because payment did not arrive within 24 hours. Please book again in the app.</Note>
        </Card>
      </Shell>
    );
  }
  return (
    <Shell title={church.name} sub={church.organisation}>
      <GiveForm church={church} booking={booking} />
    </Shell>
  );
}

function Home() {
  const nav = useNavigate();
  const [homeSearch] = useSearchParams();
  if (homeSearch.get('event')) return <EventPage code={homeSearch.get('event')!} />;
  if (homeSearch.get('ad')) return <AdPage />;
  if (homeSearch.get('booking')) return <BookingPage />;
  const saved = store.get(CHURCH_KEY);
  if (saved) return <Navigate to={`/${encodeURIComponent(saved)}`} replace />;
  return (
    <Shell title="Find your church">
      <Card>
        <p className="muted">Enter your church code to give your tithe, offering or support a project.</p>
        <CodeBox onGo={(c) => nav(`/${encodeURIComponent(c)}`)} />
      </Card>
    </Shell>
  );
}

function GivePage() {
  const { code = '' } = useParams();
  const [search] = useSearchParams();
  const certSerial = search.get('cert') ?? '';
  const nav = useNavigate();
  const [cert, setCert] = useState<CertInfo | null | undefined>(certSerial ? undefined : null);
  const [church, setChurch] = useState<Church | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(undefined); setChurch(undefined);
    api.get<Church>(`/public/church/${encodeURIComponent(code)}`)
      .then((c) => {
        if (!alive) return;
        setChurch(c);
        store.set(CHURCH_KEY, c.code);
      })
      .catch((e) => alive && setError(errMsg(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [code]);

  useEffect(() => {
    if (!certSerial) { setCert(null); return; }
    let alive = true;
    setCert(undefined);
    api.get<CertInfo>(`/public/cert/${encodeURIComponent(certSerial)}`)
      .then((c) => alive && setCert(c))
      .catch(() => alive && setCert(null));
    return () => { alive = false; };
  }, [certSerial]);

  if (loading || cert === undefined) return <Shell title="One moment"><Spinner /></Shell>;
  if (!church) {
    return (
      <Shell title="Find your church">
        <Card>
          <ErrorNote>{error ?? 'We could not load this church.'}</ErrorNote>
          <p className="muted">Check the code and try again.</p>
          <CodeBox onGo={(c) => nav(`/${encodeURIComponent(c)}`)} />
        </Card>
      </Shell>
    );
  }
  return (
    <Shell title={church.name} sub={church.organisation}>
      {certSerial && !cert && <Note tone="warn">There is no certificate copy waiting to be paid for under that link</Note>}
      <GiveForm church={church} cert={cert && cert.churchCode === church.code ? cert : undefined} />
      <p className="tiny center">
        Not your church?{' '}
        <a href="/" onClick={(e) => { e.preventDefault(); store.del(CHURCH_KEY); nav('/'); }}>Change</a>
      </p>
    </Shell>
  );
}

type Phase =
  | { t: 'form' }
  | { t: 'waiting'; id: string; message: string; slow: boolean; amount: number; purpose: string }
  | { t: 'done'; intent: Intent; at: Date }
  | { t: 'failed' };

function GiveForm({ church, cert, ad, booking }: { church: Church; cert?: CertInfo; ad?: AdInfo; booking?: BookingInfo }) {
  const [purpose, setPurpose] = useState(cert ? cert.purpose : ad ? ad.purpose : booking ? booking.purpose : 'OFFERING');
  const [phone, setPhone] = useState(() => store.get(PHONE_KEY) ?? '');
  const [amountText, setAmountText] = useState(cert ? String(cert.price / 100) : ad ? String(ad.price / 100) : booking ? String(booking.price / 100) : '');
  const [method, setMethod] = useState('mpesa');
  const [phase, setPhase] = useState<Phase>({ t: 'form' });
  const [busy, setBusy] = useState(false);
  const [apiError, setApiError] = useState<string | undefined>();
  const [touched, setTouched] = useState(false);
  const [fee, setFee] = useState<{ memberFee: number; amountPaid: number } | null>(null);
  const [copied, setCopied] = useState<string | undefined>();

  const amount = parseAmount(amountText);
  const amountOk = Number.isFinite(amount) && amount >= MIN_KES && amount <= MAX_KES;
  const phoneOk = validPhone(phone);
  const amountErr = amountText && !amountOk ? (Number.isFinite(amount) ? `Enter an amount between KES ${MIN_KES} and KES ${MAX_KES.toLocaleString('en-KE')}` : 'Enter the amount as a number, for example 500') : undefined;
  const phoneErr = phone && !phoneOk ? 'Enter a Kenyan number like 0712 345 678' : undefined;
  const mismatch = phoneOk ? networkMismatch(method, phone) : null;

  const project = purpose.startsWith('PROJ-') ? church.projects.find((p) => `PROJ-${p.code}` === purpose) : undefined;
  const methods = church.methods.length ? church.methods : Object.keys(METHOD_LABEL);

  // Fee preview, only meaningful when the member bears the fee.
  useEffect(() => {
    setFee(null);
    if (!amountOk || church.feeBearer !== 'member') return;
    let alive = true;
    const t = setTimeout(() => {
      api.get(`/public/fee?code=${encodeURIComponent(church.code)}&amount=${amount}&method=${method}`)
        .then((r) => alive && r.memberFee > 0 && setFee({ memberFee: r.memberFee, amountPaid: r.amountPaid }))
        .catch(() => { /* fee preview is best effort */ });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [amount, amountOk, method, church.code, church.feeBearer]);

  // Poll the gift status while waiting.
  const waitId = phase.t === 'waiting' ? phase.id : undefined;
  useEffect(() => {
    if (!waitId) return;
    let alive = true;
    const started = Date.now();
    const timer = setInterval(async () => {
      try {
        const i = await api.get<Intent>(`/public/give/${waitId}`);
        if (!alive) return;
        if (i.status === 'completed') { clearInterval(timer); setPhase({ t: 'done', intent: i, at: new Date() }); return; }
        if (i.status === 'failed') { clearInterval(timer); setPhase({ t: 'failed' }); return; }
      } catch { /* transient, keep polling */ }
      if (alive && Date.now() - started > 90_000) {
        clearInterval(timer);
        setPhase((p) => (p.t === 'waiting' ? { ...p, slow: true } : p));
      }
    }, 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [waitId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (busy || !phoneOk || !amountOk || mismatch) return;
    setBusy(true); setApiError(undefined);
    try {
      const r = await api.post('/public/give', { code: church.code, purpose, phone: phone.replace(/[\s-]/g, ''), amount, method });
      store.set(PHONE_KEY, phone);
      // A card is paid on the payment provider's own page, then that page brings the person back with their receipt.
      if (r.checkoutUrl) { window.location.assign(r.checkoutUrl); return; }
      setPhase({ t: 'waiting', id: r.intentId, message: r.message, slow: false, amount, purpose });
    } catch (err) {
      setApiError(errMsg(err));
    }
    setBusy(false);
  };

  const reset = () => { setPhase({ t: 'form' }); if (!cert && !ad && !booking) setAmountText(''); setApiError(undefined); setTouched(false); setBusy(false); };
  const purposeLabel = (k: string) => k.startsWith('CERT-') ? 'Certificate copy' : k.startsWith('AD-') ? 'Advert payment' : k.startsWith('BK-') ? 'Booking payment' : church.purposes.find((p) => p.key === k)?.label ?? k;

  const reference = `${church.code}#${purpose}`;
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(`${what} copied`);
    } catch {
      setCopied('Copy is not available here, please select the text');
    }
    setTimeout(() => setCopied(undefined), 2500);
  };

  if (phase.t === 'waiting') {
    return (
      <Card>
        <div aria-live="polite" className="center stack">
          {!phase.slow && <Spinner />}
          <h2>{phase.slow ? 'Still waiting' : 'Check your phone'}</h2>
          {phase.slow ? (
            <p className="muted">We have not heard back yet. This does not mean the gift failed. Check your M-Pesa messages; if money was sent, your receipt will appear in your giving history.</p>
          ) : (
            <p className="muted">{phase.message || 'Enter your PIN to complete the gift.'}</p>
          )}
          <div className="big-amount">{kes(phase.amount * 100)}</div>
          <p className="tiny">{purposeLabel(phase.purpose)} at {church.name}</p>
          {phase.slow && <Button kind="ghost" onClick={reset}>Start again</Button>}
        </div>
      </Card>
    );
  }

  if (phase.t === 'done') {
    const i = phase.intent;
    return (
      <Card className="receipt">
        <div aria-live="polite" className="stack">
          <div className="center">
            <div className="tick" aria-hidden="true">&#10003;</div>
            <h2>{cert || ad || booking ? 'Payment received' : 'Thank you, gift received'}</h2>
            <p className="muted">{booking ? 'Payment received. Your booking is confirmed. We have also sent a message to the app.' : ad ? `Payment received. Your advert will appear on the member app of ${church.name} shortly.` : cert ? 'Payment received. Your certificate copy is ready: open the member app or ask your church office to print it.' : 'May it bless many.'}</p>
          </div>
          <dl className="rcpt">
            <dt>Church</dt><dd>{i.church}</dd>
            <dt>Purpose</dt><dd>{purposeLabel(i.purpose)}</dd>
            <dt>Amount</dt><dd className="mono">{kes(i.amountPaid)}</dd>
            <dt>Receipt</dt><dd className="mono">{i.receipt}</dd>
            <dt>Time</dt><dd>{phase.at.toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</dd>
          </dl>
          {!cert && !ad && !booking && <Button onClick={reset}>Give again</Button>}
        </div>
      </Card>
    );
  }

  if (booking) {
    return (
      <form onSubmit={submit} noValidate className="stack" aria-label="Pay to confirm your booking">
        {phase.t === 'failed' && <ErrorNote>The payment did not go through. No money was taken. Please check your details and try again.</ErrorNote>}
        <Card>
          <h2>Pay to confirm your booking</h2>
          <dl className="rcpt">
            <dt>Booked</dt><dd>{booking.title}{booking.resources.length ? `, ${booking.resources.join(', ')}` : ''}</dd>
            <dt>Church</dt><dd>{church.name}</dd>
            <dt>When</dt><dd>{eatDay(booking.startsAt)}, {eatTime(booking.startsAt)} to {eatTime(booking.endsAt)}</dd>
          </dl>
          <div className="big-amount" aria-label="Amount">{kes(booking.price)}</div>
          <p className="tiny">The price is fixed and cannot be changed.</p>
          <p className="tiny">Your time is held until {eatDay(booking.holdUntil)}, {eatTime(booking.holdUntil)}</p>
          <div aria-live="polite">{fee && <Note tone="info">Fee {kes(fee.memberFee)}, you pay {kes(fee.amountPaid)}</Note>}</div>
        </Card>
        <Card>
          <div className="field-label g-label" id="lbl-method-b">Pay with</div>
          <div className="chips" role="group" aria-labelledby="lbl-method-b">
            {methods.map((m) => (
              <button key={m} type="button" className={`chip ${method === m ? 'on' : ''}`} aria-pressed={method === m} onClick={() => setMethod(m)}>{METHOD_LABEL[m] ?? m}</button>
            ))}
          </div>
          <div className="g-gap" />
          <PhoneField method={method} phone={phone} setPhone={setPhone} error={touched || phone ? phoneErr ?? mismatch ?? undefined : undefined} />
        </Card>
        <div aria-live="polite">{apiError && <ErrorNote>{apiError}</ErrorNote>}</div>
        <Button type="submit" disabled={busy || (touched && (!phoneOk || !!mismatch))}>{busy ? 'Sending request...' : `Pay ${kes(booking.price)}`}</Button>
      </form>
    );
  }

  if (ad) {
    const fmt = (d: string) => new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
    const period = ad.endsAt ? `${fmt(ad.startsAt)} to ${fmt(ad.endsAt)}` : `From ${fmt(ad.startsAt)}, until further notice`;
    return (
      <form onSubmit={submit} noValidate className="stack" aria-label="Pay for your advert">
        {phase.t === 'failed' && <ErrorNote>The payment did not go through. No money was taken. Please check your details and try again.</ErrorNote>}
        <Card>
          <h2>Pay for your advert</h2>
          <dl className="rcpt">
            <dt>Advert</dt><dd>{ad.title}</dd>
            <dt>Advertiser</dt><dd>{ad.advertiser}</dd>
            <dt>Church</dt><dd>{church.name}</dd>
            <dt>Run period</dt><dd>{period}</dd>
          </dl>
          <div className="big-amount" aria-label="Amount">{kes(ad.price)}</div>
          <p className="tiny">The price is fixed and cannot be changed.</p>
          <div aria-live="polite">{fee && <Note tone="info">Fee {kes(fee.memberFee)}, you pay {kes(fee.amountPaid)}</Note>}</div>
        </Card>
        <Card>
          <div className="field-label g-label" id="lbl-method-a">Pay with</div>
          <div className="chips" role="group" aria-labelledby="lbl-method-a">
            {methods.map((m) => (
              <button key={m} type="button" className={`chip ${method === m ? 'on' : ''}`} aria-pressed={method === m} onClick={() => setMethod(m)}>{METHOD_LABEL[m] ?? m}</button>
            ))}
          </div>
          <div className="g-gap" />
          <PhoneField method={method} phone={phone} setPhone={setPhone} error={touched || phone ? phoneErr ?? mismatch ?? undefined : undefined} />
        </Card>
        <div aria-live="polite">{apiError && <ErrorNote>{apiError}</ErrorNote>}</div>
        <Button type="submit" disabled={busy || (touched && (!phoneOk || !!mismatch))}>{busy ? 'Sending request...' : `Pay ${kes(ad.price)}`}</Button>
      </form>
    );
  }

  if (cert) {
    return (
      <form onSubmit={submit} noValidate className="stack" aria-label="Pay for a certificate copy">
        {phase.t === 'failed' && <ErrorNote>The payment did not go through. No money was taken. Please check your details and try again.</ErrorNote>}
        <Card>
          <h2>Pay for a certificate copy</h2>
          <p className="muted">{church.name}</p>
          <div className="big-amount">{kes(cert.price)}</div>
          <p className="tiny">The price is set by your church.</p>
          <div aria-live="polite">{fee && <Note tone="info">Fee {kes(fee.memberFee)}, you pay {kes(fee.amountPaid)}</Note>}</div>
        </Card>
        <Card>
          <div className="field-label g-label" id="lbl-method-c">Pay with</div>
          <div className="chips" role="group" aria-labelledby="lbl-method-c">
            {methods.map((m) => (
              <button key={m} type="button" className={`chip ${method === m ? 'on' : ''}`} aria-pressed={method === m} onClick={() => setMethod(m)}>{METHOD_LABEL[m] ?? m}</button>
            ))}
          </div>
          <div className="g-gap" />
          <PhoneField method={method} phone={phone} setPhone={setPhone} error={touched || phone ? phoneErr ?? mismatch ?? undefined : undefined} />
        </Card>
        <div aria-live="polite">{apiError && <ErrorNote>{apiError}</ErrorNote>}</div>
        <Button type="submit" disabled={busy || (touched && (!phoneOk || !!mismatch))}>{busy ? 'Sending request...' : `Pay ${kes(cert.price)}`}</Button>
      </form>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="stack" aria-label="Give">
      {phase.t === 'failed' && <ErrorNote>The payment did not go through. No money was taken. Please check your details and try again.</ErrorNote>}
      <Card>
        <div className="field-label g-label" id="lbl-purpose">What are you giving for?</div>
        <div className="chips" role="group" aria-labelledby="lbl-purpose">
          {church.purposes.map((p) => (
            <button key={p.key} type="button" className={`chip ${purpose === p.key ? 'on' : ''}`} aria-pressed={purpose === p.key} onClick={() => setPurpose(p.key)}>{p.label}</button>
          ))}
        </div>
        {project && (
          <div className="g-project">
            {project.description && <p className="muted">{project.description}</p>}
            {Number(project.target) > 0 && (
              <>
                <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round((Number(project.raised) / Number(project.target)) * 100))}>
                  <i style={{ width: `${Math.min(100, (Number(project.raised) / Number(project.target)) * 100)}%` }} />
                </div>
                <p className="tiny">{kes(project.raised)} raised of {kes(project.target)}</p>
              </>
            )}
          </div>
        )}
      </Card>

      <Card>
        <Field label="Amount (KES)" error={touched || amountText ? amountErr : undefined}>
          <input inputMode="decimal" placeholder="500" value={amountText} onChange={(e) => setAmountText(e.target.value)} aria-invalid={!!amountErr} />
        </Field>
        <div className="chips" role="group" aria-label="Quick amounts">
          {QUICK.map((q) => (
            <button key={q} type="button" className={`chip ${amount === q ? 'on' : ''}`} aria-pressed={amount === q} onClick={() => setAmountText(String(q))}>{q.toLocaleString('en-KE')}</button>
          ))}
        </div>
        <div aria-live="polite">
          {fee && amountOk && (
            <Note tone="info">Fee {kes(fee.memberFee)}, you pay {kes(fee.amountPaid)}</Note>
          )}
        </div>
      </Card>

      <Card>
        <div className="field-label g-label" id="lbl-method">Pay with</div>
        <div className="chips" role="group" aria-labelledby="lbl-method">
          {methods.map((m) => (
            <button key={m} type="button" className={`chip ${method === m ? 'on' : ''}`} aria-pressed={method === m} onClick={() => setMethod(m)}>{METHOD_LABEL[m] ?? m}</button>
          ))}
        </div>
        <div className="g-gap" />
        <PhoneField method={method} phone={phone} setPhone={setPhone} error={touched || phone ? phoneErr ?? mismatch ?? undefined : undefined} />
      </Card>

      <div aria-live="polite">{apiError && <ErrorNote>{apiError}</ErrorNote>}</div>
      <Button type="submit" disabled={busy || (touched && (!phoneOk || !amountOk || !!mismatch))}>
        {busy ? (method === 'card' ? 'Opening card page...' : 'Sending request...') : amountOk ? `${method === 'card' ? 'Pay by card' : 'Give'} ${kes(amount * 100)}` : 'Give'}
      </Button>

      <details className="paybill">
        <summary>Prefer to pay by paybill?</summary>
        <div className="stack">
          <p className="muted">Use your M-Pesa menu: Lipa na M-Pesa, Paybill.</p>
          <div className="row between"><span>Paybill number</span><b className="mono">{church.paybill.number}</b><Button small kind="ghost" onClick={() => copy(church.paybill.number, 'Paybill number')}>Copy</Button></div>
          <div className="row between"><span>Account</span><b className="mono">{reference}</b><Button small kind="ghost" onClick={() => copy(reference, 'Account')}>Copy</Button></div>
          <div aria-live="polite" className="tiny">{copied}</div>
        </div>
      </details>
    </form>
  );
}

interface Verified {
  kind: string; serial: string; subject: string; eventDate: string; place: string;
  church: string; organisation: string; approvedAt: string;
}
const longDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Nairobi' }) : '');
const KIND_LABEL: Record<string, string> = { baptism: 'Baptism', marriage: 'Marriage' };

function Verify() {
  const { serial = '' } = useParams();
  const [search] = useSearchParams();
  const k = search.get('k') ?? '';
  const [data, setData] = useState<Verified | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(undefined); setData(undefined);
    api.get<Verified>(`/public/verify/${encodeURIComponent(serial)}?k=${encodeURIComponent(k)}`)
      .then((r) => alive && setData(r))
      .catch((e) => alive && setError(e instanceof ApiError && e.message ? e.message : 'We could not check this certificate right now.'))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [serial, k]);

  if (loading) return <Shell title="Checking" sub="Certificate"><Spinner /></Shell>;
  if (!data) {
    return (
      <Shell title="We could not verify this certificate" sub="Certificate">
        <Card>
          <div className="stack">
            <ErrorNote>{error}</ErrorNote>
            <p className="muted">Please check that the link or QR code is the one printed on the certificate. If you are still unsure, contact the church that issued it.</p>
          </div>
        </Card>
      </Shell>
    );
  }
  return (
    <Shell title="Certificate verified" sub="Certificate">
      <Card>
        <div aria-live="polite" className="stack">
          <div className="center">
            <div className="tick" aria-hidden="true">&#10003;</div>
            <p className="muted">This certificate was issued by the church below.</p>
          </div>
          <dl className="rcpt">
            <dt>Type</dt><dd>{KIND_LABEL[data.kind] ?? data.kind}</dd>
            <dt>Name</dt><dd>{data.subject}</dd>
            <dt>Date</dt><dd>{longDate(data.eventDate)}</dd>
            <dt>Place</dt><dd>{data.place}</dd>
            <dt>Church</dt><dd>{data.church}</dd>
            <dt>Organisation</dt><dd>{data.organisation}</dd>
            <dt>Serial number</dt><dd className="mono">{data.serial}</dd>
          </dl>
          <p className="tiny center">Approved on {longDate(data.approvedAt)}</p>
          <Note tone="info">Always check that the name on the certificate matches.</Note>
        </div>
      </Card>
    </Shell>
  );
}

const CSS = `
.giving .g-head { padding: 22px 4px 18px; border-bottom: 1px solid var(--line); margin-bottom: 18px; }
.giving .g-head .brand { font-size: .95rem; margin-bottom: 6px; }
.giving .g-head h1 { font-size: 2rem; }
.giving { padding-bottom: 96px; }
.giving .center { text-align: center; }
.giving .g-label { margin-bottom: 8px; }
.giving .g-gap { height: 14px; }
.giving .g-project { margin-top: 14px; }
.giving .g-foot { text-align: center; margin-top: 24px; }
.giving .chip[aria-pressed='true'] { box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand) 25%, transparent); }
.giving .chip:focus-visible { outline: 3px solid color-mix(in srgb, var(--brand) 45%, transparent); outline-offset: 2px; }
.giving .btn { width: 100%; min-height: 50px; font-size: 1.05rem; }
.giving .btn.small { width: auto; min-height: 34px; font-size: 13px; }
.giving .paybill { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 16px; }
.giving .paybill summary { cursor: pointer; font-weight: 600; color: var(--ink-2); min-height: 28px; }
.giving .paybill .stack { margin-top: 12px; gap: 10px; }
.giving .tick { width: 56px; height: 56px; margin: 0 auto 10px; border-radius: 50%; background: var(--good-tint); color: var(--good); font-size: 28px; display: grid; place-items: center; }
.giving .rcpt { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; margin: 0; padding: 14px; background: var(--paper); border-radius: 10px; }
.giving .rcpt dt { color: var(--ink-3); font-size: 13px; }
.giving .rcpt dd { margin: 0; text-align: right; overflow-wrap: anywhere; font-weight: 600; }
`;
