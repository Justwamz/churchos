import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { ApiError, Button, Card, ErrorNote, Field, Note, Spinner, createApi, kes } from '@churchos/ui';

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
interface Intent { status: string; church: string; purpose: string; amountPaid: number | string; receipt: string | null }

const validPhone = (p: string) => /^(?:0[17]\d{8}|(?:\+?254)[17]\d{8})$/.test(p.replace(/[\s-]/g, ''));
const parseAmount = (s: string) => (/^\d+(\.\d{1,2})?$/.test(s.trim()) ? Number(s) : NaN);
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
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

function Home() {
  const nav = useNavigate();
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
  const nav = useNavigate();
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

  if (loading) return <Shell title="One moment"><Spinner /></Shell>;
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
      <GiveForm church={church} />
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

function GiveForm({ church }: { church: Church }) {
  const [purpose, setPurpose] = useState('OFFERING');
  const [phone, setPhone] = useState(() => store.get(PHONE_KEY) ?? '');
  const [amountText, setAmountText] = useState('');
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
    if (busy || !phoneOk || !amountOk) return;
    setBusy(true); setApiError(undefined);
    try {
      const r = await api.post('/public/give', { code: church.code, purpose, phone: phone.replace(/[\s-]/g, ''), amount, method });
      store.set(PHONE_KEY, phone);
      setPhase({ t: 'waiting', id: r.intentId, message: r.message, slow: false, amount, purpose });
    } catch (err) {
      setApiError(errMsg(err));
    }
    setBusy(false);
  };

  const reset = () => { setPhase({ t: 'form' }); setAmountText(''); setApiError(undefined); setTouched(false); setBusy(false); };
  const purposeLabel = (k: string) => church.purposes.find((p) => p.key === k)?.label ?? k;

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
            <h2>Thank you, gift received</h2>
            <p className="muted">May it bless many.</p>
          </div>
          <dl className="rcpt">
            <dt>Church</dt><dd>{i.church}</dd>
            <dt>Purpose</dt><dd>{purposeLabel(i.purpose)}</dd>
            <dt>Amount</dt><dd className="mono">{kes(i.amountPaid)}</dd>
            <dt>Receipt</dt><dd className="mono">{i.receipt}</dd>
            <dt>Time</dt><dd>{phase.at.toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</dd>
          </dl>
          <Button onClick={reset}>Give again</Button>
        </div>
      </Card>
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
        <Field label="Phone number" hint="The number that will receive the payment prompt" error={touched || phone ? phoneErr : undefined}>
          <input type="tel" inputMode="tel" autoComplete="tel" placeholder="0712 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} aria-invalid={!!phoneErr} />
        </Field>
      </Card>

      <div aria-live="polite">{apiError && <ErrorNote>{apiError}</ErrorNote>}</div>
      <Button type="submit" disabled={busy || (touched && (!phoneOk || !amountOk))}>
        {busy ? 'Sending request...' : amountOk ? `Give ${kes(amount * 100)}` : 'Give'}
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

const CSS = `
.giving .g-head { padding: 22px 4px 18px; border-bottom: 1px solid var(--line); margin-bottom: 18px; }
.giving .g-head .brand { font-size: .95rem; margin-bottom: 6px; }
.giving .g-head h1 { font-size: 2rem; }
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
