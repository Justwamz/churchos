import { networkMismatch, phoneHint } from '@churchos/shared';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, ErrorNote, Field, Note, phonePretty, useAsync } from '@churchos/ui';
import { api, errText } from './api';
import { Sheet, Skeleton } from './ui';
import { AnonSwitch } from './GivingRecord';

// ---------------- helpers ----------------

const TZ = 'Africa/Nairobi';
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAYS3 = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const METHODS = [{ key: 'mpesa', label: 'M-Pesa' }, { key: 'airtel', label: 'Airtel Money' }, { key: 'tkash', label: 'T-Kash' }];
const METHOD_LABEL: Record<string, string> = { mpesa: 'M-Pesa', airtel: 'Airtel Money', tkash: 'T-Kash' };

/** Cents to "KES 1,000" (cents shown only when there are some). */
export const kesCents = (c: number | null | undefined) => {
  const v = Number(c ?? 0) / 100;
  return `KES ${v.toLocaleString('en-KE', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`;
};
const kesNum = (v: number) => `KES ${v.toLocaleString('en-KE', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`;
const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dayShort = (iso: string) => new Date(iso).toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
const dayOf = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const timeText = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-KE', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TZ }).replace(/\s?([ap])\.?m\.?/i, (_, x) => ` ${x.toLowerCase()}m`);
const ordinal = (n: number) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
const TIMES = Array.from({ length: 31 }, (_, i) => { const mins = 360 + i * 30; return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`; });

const freqText = (frequency: string, weekday: number | null, monthDay: number | null) => {
  if (frequency === 'weekly') return `weekly on ${DAYS[(weekday ?? 1) - 1]}s`;
  if (frequency === 'fortnightly') return `every two weeks on ${DAYS[(weekday ?? 1) - 1]}s`;
  return monthDay === 0 || monthDay == null ? 'monthly on the last day' : `monthly on the ${ordinal(monthDay)}`;
};
const planTitle = (p: any) => `${kesCents(p.amount)} ${p.purposeLabel}, ${freqText(p.frequency, p.weekday, p.monthDay)}`;

const ERR: Record<string, string> = {
  card_not_supported: 'Cards cannot be charged automatically yet. Please choose M-Pesa, Airtel Money or T-Kash.',
  amount_too_small: 'The smallest regular gift is KES 10.',
  amount_too_large: 'The largest regular gift is KES 150,000.',
  too_many: 'You can have up to 5 regular gifts. Stop one before adding another.',
};
const planErr = (e: any) => ERR[e?.code] ?? errText(e);

async function patch(path: string, body: unknown) {
  let res: Response;
  try {
    res = await fetch(`${api.API_URL}${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-churchos-app': 'member', authorization: `Bearer ${api.getToken() ?? ''}` }, body: JSON.stringify(body) });
  } catch { throw Object.assign(new Error('Cannot reach the server. Check your connection and try again.'), { code: 'network' }); }
  const data: any = await res.json().catch(() => undefined);
  if (!res.ok) throw Object.assign(new Error(data?.error ?? `Request failed (${res.status})`), { code: data?.code });
  return data;
}

/** Loads the member's regular gifts. */
export function usePlans() {
  const q = useAsync<any>(() => api.get('/me/giving-plans'));
  return { ...q, plans: (q.data?.plans ?? []) as any[] };
}

function StatusChip({ p }: { p: any }) {
  return p.status === 'active' ? <Badge tone="good">Active</Badge> : p.status === 'paused' ? <Badge tone="warn">Paused</Badge> : <Badge tone="muted">Ended</Badge>;
}
const waiting = (p: any) => p.status !== 'ended' && (p.runs ?? [])[0]?.status === 'prompted';


// ---------------- The screen ----------------

export function RegularGiving({ me, user, online }: { me: any; user: any; online: boolean }) {
  const q = usePlans();
  const [open, setOpen] = useState<string | null>(null);
  const [setup, setSetup] = useState(false);
  const [done, setDone] = useState<string | undefined>();
  const memberships: any[] = (me?.memberships ?? []).filter((m: any) => m.category !== 'child' && m.category !== 'Child');
  const several = new Set(q.plans.map((p) => p.church)).size > 1 || memberships.length > 1;
  const live = q.plans.filter((p) => p.status !== 'ended').length;
  const sel = q.plans.find((p) => p.id === open) ?? null;

  // refresh while a prompt is waiting, so the result shows without leaving the screen
  const anyWaiting = q.plans.some(waiting);
  useEffect(() => {
    if (!anyWaiting) return;
    const t = setInterval(q.reload, 4000);
    return () => clearInterval(t);
  }, [anyWaiting]); // eslint-disable-line

  if (q.loading && !q.data) return <div className="card"><Skeleton lines={3} /></div>;
  if (q.error && !q.data) return <div className="stack"><ErrorNote>{q.error}</ErrorNote><Button kind="ghost" onClick={q.reload}>Try again</Button></div>;

  return (
    <div className="stack">
      {!online && <Note tone="warn">You are offline. You need a connection to change your regular gifts.</Note>}
      {done && <Note tone="good">{done}</Note>}
      {q.plans.length === 0 ? (
        <Card title="Give regularly">
          <div className="stack">
            <p className="rg-intro">Set a tithe or offering once. We send a prompt to your phone on the day, you enter your PIN. You are never charged without doing something, and you can pause or stop any time.</p>
            <Button disabled={!online || !memberships.length} onClick={() => { setDone(undefined); setSetup(true); }}>Set up a regular gift</Button>
          </div>
        </Card>
      ) : (
        <>
          <ul className="plain-list rg-list">
            {q.plans.map((p) => (
              <li key={p.id}>
                <button type="button" className="card rg-card" onClick={() => setOpen(p.id)}>
                  <span className="rg-card-top"><strong className="rg-title">{planTitle(p)}</strong><span className="gr-chips">{p.anonymous && <Badge tone="info">Anonymous</Badge>}<StatusChip p={p} /></span></span>
                  {several && <span className="tiny">{p.church}{p.branch ? ` · ${p.branch}` : ''}</span>}
                  {waiting(p) ? <span className="rg-line warn">A gift is waiting for your PIN. Check your phone.</span>
                    : p.status === 'active' && p.nextRunAt ? <span className="rg-line">{p.skipNext ? 'Skipping the next gift' : `Next prompt: ${dayShort(p.nextRunAt)}, ${timeOf(p.nextRunAt)}`}</span>
                      : p.status === 'paused' ? <span className="rg-line">Paused. No prompts are sent.</span> : <span className="rg-line">This regular gift has ended.</span>}
                  <span className="tiny">Given so far {kesCents(p.totalGiven)} ({p.completed} {p.completed === 1 ? 'gift' : 'gifts'})</span>
                  {p.missed > 0 && <span className="rg-line warn">{p.missed} missed {p.missed === 1 ? 'gift' : 'gifts'}</span>}
                </button>
              </li>
            ))}
          </ul>
          {live < 5
            ? <Button disabled={!online || !memberships.length} onClick={() => { setDone(undefined); setSetup(true); }}>Set up a regular gift</Button>
            : <p className="tiny">You have 5 regular gifts, the most we allow. Stop one to add another.</p>}
        </>
      )}

      <Setup open={setup} onClose={() => setSetup(false)} memberships={memberships} user={user} onDone={(msg) => { setSetup(false); setDone(msg); q.reload(); }} />
      <Detail plan={sel} onClose={() => setOpen(null)} reload={q.reload} online={online} user={user} several={several} />
    </div>
  );
}

// ---------------- Detail ----------------

function runLine(r: any) {
  const when = dayShort(r.scheduledFor ?? r.dueDate);
  if (r.status === 'completed') return { tone: 'good', label: 'Completed', note: r.kind === 'first' ? 'First gift' : undefined, when };
  if (r.status === 'missed') return { tone: 'warn', label: 'Missed', note: r.note, when };
  if (r.status === 'skipped') return { tone: 'muted', label: 'Skipped', note: r.note, when };
  return { tone: 'info', label: 'Waiting for your PIN', note: `Prompt ${Math.min(Number(r.attempt) || 1, 4)} of 4`, when };
}

function Detail({ plan, onClose, reload, online, user, several }: { plan: any | null; onClose: () => void; reload: () => void; online: boolean; user: any; several: boolean }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'stop'>('view');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [all, setAll] = useState<any[] | null>(null);
  useEffect(() => { setMode('view'); setError(undefined); setAll(null); }, [plan?.id]);

  const act = async (fn: () => Promise<any>, after?: () => void) => {
    setBusy(true); setError(undefined);
    try { await fn(); reload(); after?.(); } catch (e) { setError(planErr(e)); }
    setBusy(false);
  };
  const showAll = async () => {
    try { const r = await api.get(`/me/giving-plans/${plan.id}/runs`); setAll(r.runs ?? []); } catch (e) { setError(planErr(e)); }
  };

  const runs: any[] = all ?? plan?.runs ?? [];
  return (
    <Sheet open={!!plan} onClose={onClose} title={mode === 'edit' ? 'Change this gift' : mode === 'stop' ? 'Stop this regular gift?' : 'Regular gift'}>
      {plan && mode === 'view' && (
        <div className="stack">
          <div className="bk-sum">
            <strong>{planTitle(plan)}</strong>
            {several && <span>{plan.church}</span>}
            <span>{METHOD_LABEL[plan.method] ?? plan.method} · {plan.phone} · at {timeText(plan.time)}</span>
            {plan.youPay !== plan.amount && <span>You pay {kesCents(plan.youPay)} each time, with the service fee</span>}
            {plan.endDate && <span>Ends {dayOf(plan.endDate)}</span>}
          </div>
          <div className="rg-line-row"><StatusChip p={plan} />{plan.anonymous && <Badge tone="info">Anonymous</Badge>}
            {plan.status === 'active' && plan.nextRunAt && <span className="tiny">{plan.skipNext ? 'Skipping the next gift' : `Next prompt: ${dayShort(plan.nextRunAt)}, ${timeOf(plan.nextRunAt)}`}</span>}
          </div>
          {plan.anonymous && <p className="tiny" style={{ margin: 0 }}>Anonymous regular gifts never count toward a pledge, and your church cannot see who gave.</p>}
          {waiting(plan) && <Note tone="warn">A gift is waiting for your PIN. Check your phone.</Note>}
          <p className="tiny" style={{ margin: 0 }}>Given so far {kesCents(plan.totalGiven)} ({plan.completed} {plan.completed === 1 ? 'gift' : 'gifts'}){plan.missed > 0 ? ` · ${plan.missed} missed` : ''}</p>

          <div>
            <div className="field-label">History</div>
            {!runs.length ? <p className="tiny">Nothing yet. Your gifts will show here.</p> : (
              <ul className="plain-list rg-runs">
                {runs.map((r) => { const l = runLine(r); return (
                  <li key={r.id} className="rg-run">
                    <span className="rg-run-main"><strong>{l.when}</strong>{l.note && <span className="tiny">{l.note}</span>}</span>
                    <span className="rg-run-amt">{r.status === 'completed' && <span className="tiny">{kesCents(r.amount)}</span>}<Badge tone={l.tone as any}>{l.label}</Badge></span>
                  </li>); })}
              </ul>
            )}
            {!all && plan.runs?.length >= 6 && <button type="button" className="link-btn" onClick={showAll}>Show all</button>}
          </div>

          {error && <ErrorNote>{error}</ErrorNote>}
          {plan.status !== 'ended' && (
            <div className="rg-actions">
              <Button kind="ghost" disabled={!online || busy} onClick={() => { setError(undefined); setMode('edit'); }}>Change</Button>
              {plan.status === 'active' && <Button kind="ghost" disabled={!online || busy} onClick={() => act(() => api.post(`/me/giving-plans/${plan.id}/skip-next`, { skip: !plan.skipNext }))}>{plan.skipNext ? "Don't skip" : 'Skip next gift'}</Button>}
              {plan.status === 'active'
                ? <Button kind="ghost" disabled={!online || busy} onClick={() => act(() => api.post(`/me/giving-plans/${plan.id}/pause`))}>Pause</Button>
                : <Button disabled={!online || busy} onClick={() => act(() => api.post(`/me/giving-plans/${plan.id}/resume`))}>Resume</Button>}
              <Button kind="danger" disabled={!online || busy} onClick={() => { setError(undefined); setMode('stop'); }}>Stop</Button>
            </div>
          )}
        </div>
      )}
      {plan && mode === 'edit' && <Edit plan={plan} user={user} onBack={() => setMode('view')} onSaved={() => { reload(); setMode('view'); }} />}
      {plan && mode === 'stop' && (
        <div className="stack">
          <Note tone="warn">This stops your regular gift for good. You can set up a new one any time.</Note>
          {error && <ErrorNote>{error}</ErrorNote>}
          <Button kind="danger" disabled={busy} onClick={() => act(() => api.post(`/me/giving-plans/${plan.id}/cancel`), onClose)}>{busy ? 'Stopping…' : 'Yes, stop this gift'}</Button>
          <Button kind="ghost" onClick={() => setMode('view')}>Keep it</Button>
        </div>
      )}
    </Sheet>
  );
}

function Edit({ plan, user, onBack, onSaved }: { plan: any; user: any; onBack: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState(String(plan.amount / 100));
  const [time, setTime] = useState(plan.time);
  const [method, setMethod] = useState(plan.method);
  const [phone, setPhone] = useState('');
  const [end, setEnd] = useState(plan.endDate ?? '');
  const [anon, setAnon] = useState(!!plan.anonymous);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const n = Number(amount);
  const valid = Number.isFinite(n) && n >= 10 && n <= 150000;
  const hint = phoneHint(method);
  const mismatch = phone ? networkMismatch(method, phone) : null;
  const save = async () => {
    setBusy(true); setError(undefined);
    const body: any = {};
    if (Math.round(n * 100) !== plan.amount) body.amount = n;
    if (time !== plan.time) body.time = time;
    if (method !== plan.method) body.method = method;
    if (phone.trim()) body.phone = phone.trim();
    if ((end || null) !== (plan.endDate ?? null)) body.endDate = end || null;
    if (anon !== !!plan.anonymous) body.anonymous = anon;
    if (method !== plan.method && !phone.trim()) body.phone = phonePretty(user?.phone);
    try {
      if (Object.keys(body).length) await patch(`/me/giving-plans/${plan.id}`, body);
      onSaved();
    } catch (e) { setError(planErr(e)); }
    setBusy(false);
  };
  return (
    <div className="stack">
      <Field label="Amount (KES)" hint="KES 10 to KES 150,000" error={amount && !valid ? 'Enter an amount between 10 and 150,000' : undefined}>
        <input className="amount-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />
      </Field>
      <Field label="Time of the prompt" hint="A new time starts from the next prompt">
        <select value={time} onChange={(e) => setTime(e.target.value)}>{TIMES.map((t) => <option key={t} value={t}>{timeText(t)}</option>)}</select>
      </Field>
      <div>
        <div className="field-label" id="rg-em">Pay with</div>
        <div className="chips" role="group" aria-labelledby="rg-em" style={{ marginTop: 8 }}>
          {METHODS.map((x) => <button key={x.key} type="button" className={`chip ${method === x.key ? 'on' : ''}`} aria-pressed={method === x.key} onClick={() => setMethod(x.key)}>{x.label}</button>)}
        </div>
        <p className="tiny rg-muted">Cards cannot be charged automatically yet.</p>
      </div>
      <Field label={hint.label} hint={`Now: ${plan.phone}. Leave empty to keep it.`} error={mismatch ?? undefined}>
        <input type="tel" inputMode="tel" placeholder={hint.placeholder} value={phone} onChange={(e) => setPhone(e.target.value)} />
      </Field>
      <Field label="Stop after (optional)"><input type="date" value={end} min={todayStr()} onChange={(e) => setEnd(e.target.value)} /></Field>
      <AnonSwitch on={anon} onChange={setAnon} />
      <p className="tiny rg-muted">Anonymous regular gifts never count toward a pledge.</p>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button disabled={busy || !valid || !!mismatch} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</Button>
      <Button kind="ghost" onClick={onBack}>Back</Button>
    </div>
  );
}

// ---------------- Set up ----------------

function Setup({ open, onClose, memberships, user, onDone }: { open: boolean; onClose: () => void; memberships: any[]; user: any; onDone: (msg: string) => void }) {
  const [mid, setMid] = useState('');
  const m = memberships.find((x) => x.id === mid) ?? memberships[0];
  const code: string | undefined = m?.branch_code;
  const church = useAsync<any>(() => (open && code ? api.get(`/public/church/${encodeURIComponent(code)}`) : Promise.resolve(undefined)), [code, open]);
  const purposes: any[] = church.data?.purposes ?? [];
  const [purpose, setPurpose] = useState('TITHE');
  const [amount, setAmount] = useState('');
  const [freq, setFreq] = useState<'weekly' | 'fortnightly' | 'monthly'>('monthly');
  const [weekday, setWeekday] = useState(7);
  const [monthDay, setMonthDay] = useState<string>('1');
  const [start, setStart] = useState(todayStr());
  const [time, setTime] = useState('10:00');
  const [method, setMethod] = useState('mpesa');
  const [phone, setPhone] = useState(phonePretty(user?.phone));
  const [end, setEnd] = useState('');
  const [firstNow, setFirstNow] = useState(false);
  const [anon, setAnon] = useState(false);
  const [fee, setFee] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => { if (open) { setError(undefined); setStart(todayStr()); setPhone(phonePretty(user?.phone)); } }, [open]); // eslint-disable-line
  useEffect(() => { if (purposes.length && !purposes.some((p) => p.key === purpose)) setPurpose(purposes[0].key); }, [purposes.length]); // eslint-disable-line

  const n = Number(amount);
  const valid = Number.isFinite(n) && n >= 10 && n <= 150000;
  const bearer = church.data?.feeBearer === 'member';
  const hint = phoneHint(method);
  const mismatch = networkMismatch(method, phone);
  useEffect(() => {
    setFee(0);
    if (!bearer || !valid || !code) return;
    let alive = true;
    api.get(`/public/fee?code=${encodeURIComponent(code)}&amount=${n}&method=${method}`).then((r) => alive && setFee(r.memberFee ?? 0)).catch(() => {});
    return () => { alive = false; };
  }, [bearer, valid, n, method, code]);

  const first = useMemo(() => {
    let d = start;
    if (freq === 'monthly') {
      for (let i = 0; i < 62; i++, d = addDays(d, 1)) {
        const dt = new Date(`${d}T12:00:00Z`);
        const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
        if (dt.getUTCDate() === (monthDay === 'last' ? last : Number(monthDay))) return d;
      }
      return start;
    }
    for (let i = 0; i < 7; i++, d = addDays(d, 1)) if (((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7) + 1 === weekday) return d;
    return start;
  }, [start, freq, weekday, monthDay]);

  const todayFirst = firstNow && start === todayStr();
  const what = purposes.find((p) => p.key === purpose)?.label ?? 'tithe';
  const whenText = freq === 'monthly' ? (monthDay === 'last' ? 'monthly on the last day' : `monthly on the ${ordinal(Number(monthDay))}`) : freqText(freq, weekday, null);
  const anonOk = purpose === 'TITHE' || purpose === 'OFFERING' || purpose.startsWith('PROJ-');
  const anonNow = anon && anonOk;
  const submit = async () => {
    setBusy(true); setError(undefined);
    try {
      const r = await api.post('/me/giving-plans', {
        membershipId: m.id, amount: n, purpose, frequency: freq,
        ...(freq === 'monthly' ? { monthDay: monthDay === 'last' ? 'last' : Number(monthDay) } : { weekday }),
        time, startDate: start, ...(end ? { endDate: end } : {}), method, phone: phone.trim(), firstNow, ...(anonNow ? { anonymous: true } : {}),
      });
      setAmount(''); setFirstNow(false); setEnd(''); setAnon(false);
      onDone(r?.firstGift?.prompted ? 'Your regular gift is set up. Check your phone for the prompt.' : 'Your regular gift is set up. We will send the first prompt on the day.');
    } catch (e) { setError(planErr(e)); }
    setBusy(false);
  };
  const ready = valid && phone.trim().length >= 9 && !mismatch && !!m && purposes.length > 0;

  return (
    <Sheet open={open} onClose={onClose} title="Set up a regular gift">
      {church.loading && !church.data ? <Skeleton lines={4} /> : church.error ? <ErrorNote>{church.error}</ErrorNote> : (
        <div className="stack">
          {memberships.length > 1 && (
            <Field label="Church">
              <select value={m?.id} onChange={(e) => setMid(e.target.value)}>{memberships.map((x) => <option key={x.id} value={x.id}>{x.branch_name} · {x.org_name}</option>)}</select>
            </Field>
          )}
          <div>
            <div className="field-label" id="rg-p">What is it for?</div>
            <div className="chips" role="group" aria-labelledby="rg-p" style={{ marginTop: 8 }}>
              {purposes.map((p) => <button key={p.key} type="button" className={`chip ${purpose === p.key ? 'on' : ''}`} aria-pressed={purpose === p.key} onClick={() => setPurpose(p.key)}>{p.label}</button>)}
            </div>
          </div>
          <Field label="Amount each time (KES)" hint="KES 10 to KES 150,000" error={amount && !valid ? 'Enter an amount between 10 and 150,000' : undefined}>
            <input className="amount-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="e.g. 1000" />
          </Field>
          {bearer && valid && fee > 0 && <Note tone="info">You will pay {kesNum(Math.round(n * 100 + fee) / 100)} including the service fee.</Note>}
          <div>
            <div className="field-label" id="rg-f">How often?</div>
            <div className="seg" role="group" aria-labelledby="rg-f" style={{ marginTop: 8 }}>
              {([['weekly', 'Weekly'], ['fortnightly', 'Every 2 weeks'], ['monthly', 'Monthly']] as const).map(([k, l]) => <button key={k} type="button" className={freq === k ? 'on' : ''} aria-pressed={freq === k} onClick={() => setFreq(k)}>{l}</button>)}
            </div>
          </div>
          {freq !== 'monthly' ? (
            <div>
              <div className="field-label" id="rg-d">On which day?</div>
              <div className="chips" role="group" aria-labelledby="rg-d" style={{ marginTop: 8 }}>
                {DAYS3.map((d, i) => <button key={d} type="button" className={`chip ${weekday === i + 1 ? 'on' : ''}`} aria-pressed={weekday === i + 1} onClick={() => setWeekday(i + 1)}>{d}</button>)}
              </div>
            </div>
          ) : (
            <Field label="On which day of the month?">
              <select value={monthDay} onChange={(e) => setMonthDay(e.target.value)}>
                {Array.from({ length: 28 }, (_, i) => <option key={i + 1} value={String(i + 1)}>{ordinal(i + 1)}</option>)}
                <option value="last">Last day of the month</option>
              </select>
            </Field>
          )}
          <Field label="Start date"><input type="date" value={start} min={todayStr()} max={addDays(todayStr(), 365)} onChange={(e) => setStart(e.target.value || todayStr())} /></Field>
          <Field label="Time of the prompt" hint="The prompt comes at this time, Nairobi time.">
            <select value={time} onChange={(e) => setTime(e.target.value)}>{TIMES.map((t) => <option key={t} value={t}>{timeText(t)}</option>)}</select>
          </Field>
          <div>
            <div className="field-label" id="rg-m">Pay with</div>
            <div className="chips" role="group" aria-labelledby="rg-m" style={{ marginTop: 8 }}>
              {METHODS.map((x) => <button key={x.key} type="button" className={`chip ${method === x.key ? 'on' : ''}`} aria-pressed={method === x.key} onClick={() => setMethod(x.key)}>{x.label}</button>)}
            </div>
            <p className="tiny rg-muted">Cards cannot be charged automatically yet.</p>
          </div>
          <Field label={hint.label} hint={hint.help} error={mismatch ?? undefined}><input type="tel" inputMode="tel" autoComplete="tel" placeholder={hint.placeholder} value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <Field label="Stop after (optional)"><input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} /></Field>
          <AnonSwitch on={anonNow} onChange={setAnon} disabled={!anonOk} note={anonOk ? undefined : 'Only tithe, offering and project gifts can be given anonymously.'} />
          {anonNow && <p className="tiny rg-muted">Anonymous regular gifts never count toward a pledge.</p>}
          <label className="rg-check"><input type="checkbox" checked={firstNow} onChange={(e) => setFirstNow(e.target.checked)} /><span>Give the first gift now</span></label>
          {todayFirst && <Note tone="info">Your first gift is sent now. The regular prompts start after today.</Note>}
          <div className="bk-sum">
            <strong>{valid ? kesNum(n) : 'Your gift'} {what.toLowerCase()}, {whenText}</strong>
            <span>The first prompt: {dayOf(todayFirst ? addDays(first, 0) : first)} at {timeText(time)}{todayFirst ? ' (after your gift now)' : ''}</span>
            <span>You enter your PIN each time. Nothing is taken without it.</span>
          </div>
          {error && <ErrorNote>{error}</ErrorNote>}
          <Button disabled={busy || !ready} onClick={submit}>{busy ? 'Setting up…' : 'Start regular giving'}</Button>
        </div>
      )}
    </Sheet>
  );
}
