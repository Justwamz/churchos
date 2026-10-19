import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, ErrorNote, Field, Note, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { useWords } from './words';
import { Card, EmptyState, PageHeader, Section, SidePanel, Skeleton, StatusChip, Toolbar } from './ui';

function Load({ loading, error, hasData, children }: { loading: boolean; error?: string; hasData: boolean; children: React.ReactNode }) {
  if (error && !hasData) return <ErrorNote>{friendly(error)}</ErrorNote>;
  if (loading && !hasData) return <Skeleton rows={3} height={72} />;
  return <>{error && <ErrorNote>{friendly(error)}</ErrorNote>}{children}</>;
}
import { Modal } from './MemberForm';
import { PlaceFields, validPlace } from './Boundaries';
import './tickets.css';
import './services.css';
import './worship.css';

// ---------- time helpers (Nairobi, UTC+3, no daylight saving) ----------

const TZ = 'Africa/Nairobi';
const HOUR = 3600_000;
const pad = (n: number) => String(n).padStart(2, '0');
function parts(iso: string | Date, o: Intl.DateTimeFormatOptions) {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...o }).formatToParts(new Date(iso))) out[p.type] = p.value;
  return out;
}
/** "Sun 26 Oct, 10:30 am" */
function when(iso: string) {
  const p = parts(iso, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
  return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute} ${(p.dayPeriod ?? '').toLowerCase()}`;
}
function dayName(iso: string) {
  const p = parts(iso, { weekday: 'long', day: 'numeric', month: 'long' });
  return `${p.weekday} ${p.day} ${p.month}`;
}
function dayShort(iso: string) {
  const p = parts(iso, { weekday: 'short', day: 'numeric', month: 'short' });
  return `${p.weekday} ${p.day} ${p.month}`;
}
const dayKey = (iso: string) => new Date(new Date(iso).getTime() + 3 * HOUR).toISOString().slice(0, 10);
function clock(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'am' : 'pm'}`;
}
const todayKey = () => dayKey(new Date().toISOString());
const addDays = (key: string, n: number) => new Date(Date.parse(`${key}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
/** datetime-local text (read as Nairobi time) to an ISO instant */
const localToIso = (v: string) => new Date(Date.parse(`${v}:00Z`) - 3 * HOUR).toISOString();
/** ISO instant to datetime-local text in Nairobi time */
const isoToLocal = (iso: string) => new Date(new Date(iso).getTime() + 3 * HOUR).toISOString().slice(0, 16);
const DAYS = [[1, 'Mon', 'Mondays'], [2, 'Tue', 'Tuesdays'], [3, 'Wed', 'Wednesdays'], [4, 'Thu', 'Thursdays'], [5, 'Fri', 'Fridays'], [6, 'Sat', 'Saturdays'], [7, 'Sun', 'Sundays']] as const;
const RELEASES = [['now', 'Straight away'], ['day_before', 'A day before'], ['hour_before', 'An hour before'], ['minutes_20', '20 minutes before']] as const;
const RELEASE_MS: Record<string, number> = { now: 0, day_before: 24 * HOUR, hour_before: HOUR, minutes_20: 20 * 60_000 };
const publishDate = (startsAt: string, release: string) => new Date(new Date(startsAt).getTime() - (RELEASE_MS[release] ?? 0)).toISOString();
const errMsg = (e: any) => friendly(e?.message);

async function patch(path: string, body: unknown) {
  let res: Response;
  try {
    res = await fetch(`${api.API_URL}${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-churchos-app': 'staff', authorization: `Bearer ${api.getToken() ?? ''}` }, body: JSON.stringify(body) });
  } catch { throw new Error('Cannot reach the server. Check your connection and try again.'); }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}

async function copy(text: string, toast: { show: (m: string) => void }) {
  try { await navigator.clipboard.writeText(text); toast.show('Link copied'); }
  catch {
    const t = document.createElement('textarea');
    t.value = text; document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); toast.show('Link copied'); } catch { toast.show('Could not copy. Select the link and copy it.'); }
    t.remove();
  }
}

type Branch = { id: string; name: string };
const RANGES = [['week', 'This week'], ['month', 'This month'], ['year', 'The rest of this year'], ['until', 'Until a date']] as const;
type Range = 'week' | 'month' | 'year' | 'until';

/** Roughly how many services a range will create, and the date it ends. */
function planRange(range: Range, until: string, weekdays: number[]) {
  const t = todayKey();
  let end: string;
  if (range === 'week') end = addDays(t, (7 - new Date(`${t}T00:00:00Z`).getUTCDay()) % 7);
  else if (range === 'month') { const [y, m] = t.split('-').map(Number); end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }
  else if (range === 'year') end = `${t.slice(0, 4)}-12-31`;
  else end = until;
  if (!end || end < t) return { end, count: 0 };
  let count = 0;
  for (let d = t; d <= end; d = addDays(d, 1)) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay() || 7;
    if (weekdays.includes(wd)) count++;
  }
  return { end, count };
}
const prettyKey = (k: string) => (k ? `${dayShort(`${k}T09:00:00+03:00`)} ${k.slice(0, 4)}` : '');

function RangePicker({ range, setRange, until, setUntil }: { range: Range; setRange: (r: Range) => void; until: string; setUntil: (s: string) => void }) {
  const w = useWords();
  return (
    <div className="stack">
      <div className="chips" role="radiogroup" aria-label={`Create ${w.manyLower} for`}>
        {RANGES.map(([k, t]) => <button key={k} type="button" role="radio" aria-checked={range === k} className={`chip ${range === k ? 'on' : ''}`} onClick={() => setRange(k)}>{t}</button>)}
      </div>
      {range === 'until' && <Field label="Last day"><input type="date" value={until} min={todayKey()} onChange={(e) => setUntil(e.target.value)} /></Field>}
    </div>
  );
}

// ---------- schedule modals ----------

function ScheduleForm({ branches, defaultBranch, onClose, onDone }: { branches: Branch[]; defaultBranch: string; onClose: () => void; onDone: (msg: string) => void }) {
  const w = useWords();
  const [name, setName] = useState(`Sunday ${w.oneLower}`);
  const [branchId, setBranchId] = useState(defaultBranch || branches[0]?.id || '');
  const [days, setDays] = useState<number[]>([7]);
  const [startTime, setStartTime] = useState('10:30');
  const [duration, setDuration] = useState('90');
  const [stream, setStream] = useState('');
  const [opens, setOpens] = useState('20');
  const [closes, setCloses] = useState('120');
  const [range, setRange] = useState<Range>('month');
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const plan = planRange(range, until, days);
  const dayText = days.length ? DAYS.filter((d) => days.includes(d[0])).map((d) => d[2]).join(', ') : 'no days chosen';

  const submit = async () => {
    setError('');
    if (name.trim().length < 2) return setError(`Give the ${w.oneLower} a name, for example “Sunday ${w.oneLower}”.`);
    if (!branchId) return setError('Choose a branch.');
    if (!days.length) return setError('Choose at least one day of the week.');
    if (!startTime) return setError('Choose the start time.');
    if (range === 'until' && !until) return setError('Choose the last day.');
    setBusy(true);
    try {
      const r = await api.post<any>('/attendance/schedules', {
        branchId, name: name.trim(), weekdays: days, startTime, durationMin: Number(duration), streamUrl: stream.trim() || undefined,
        opensBeforeMin: Number(opens), closesAfterMin: Number(closes), range, until: range === 'until' ? until : undefined,
      });
      onDone(`Schedule set up. ${r.generated} ${r.generated === 1 ? w.oneLower : w.manyLower} created.`);
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title="Set up a schedule" onClose={onClose}>
      <form className="stack sv-modal" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
        {branches.length > 1 && <Field label="Branch"><select value={branchId} onChange={(e) => setBranchId(e.target.value)}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>}
        <div>
          <div className="field-label">Which days?</div>
          <div className="sv-days" role="group" aria-label="Days of the week">
            {DAYS.map(([n, short]) => (
              <button key={n} type="button" aria-pressed={days.includes(n)} className={`chip ${days.includes(n) ? 'on' : ''}`} onClick={() => setDays((d) => (d.includes(n) ? d.filter((x) => x !== n) : [...d, n]))}>{short}</button>
            ))}
          </div>
          {days.length > 1 && <div className="tiny">Each day becomes its own schedule with the same time.</div>}
        </div>
        <div className="sv-two">
          <Field label="Starts at"><input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></Field>
          <Field label="Length (minutes)"><input type="number" min={15} max={480} value={duration} onChange={(e) => setDuration(e.target.value)} /></Field>
        </div>
        <Field label="YouTube live link (optional)" hint="Paste your YouTube live link. We give members and visitors a link that counts who watches.">
          <input type="url" inputMode="url" placeholder="https://www.youtube.com/live/..." value={stream} onChange={(e) => setStream(e.target.value)} />
        </Field>
        <details className="sv-adv">
          <summary>Check-in window (advanced)</summary>
          <div className="stack">
            <div className="sv-two">
              <Field label="Opens (minutes before)"><input type="number" min={0} max={240} value={opens} onChange={(e) => setOpens(e.target.value)} /></Field>
              <Field label="Closes (minutes after start)"><input type="number" min={15} max={720} value={closes} onChange={(e) => setCloses(e.target.value)} /></Field>
            </div>
            <div className="tiny">People can check in from when it opens until it closes.</div>
          </div>
        </details>
        <div>
          <div className="field-label">Create {w.manyLower} for</div>
          <RangePicker range={range} setRange={setRange} until={until} setUntil={setUntil} />
        </div>
        <div className="sv-sentence">
          {plan.end && plan.count > 0
            ? <>This will create about <b>{plan.count} {plan.count === 1 ? w.oneLower : w.manyLower}</b> ({dayText} at {clock(startTime || '00:00')}) up to {prettyKey(plan.end)}.</>
            : range === 'until' && !until ? 'Choose the last day to see what will be created.' : `No ${w.manyLower} fall in that period yet. Try a longer one.`}
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <Button kind="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Creating...' : 'Create schedule'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function ScheduleChange({ sch, onClose, onDone }: { sch: any; onClose: () => void; onDone: (m: string) => void }) {
  const w = useWords();
  const [name, setName] = useState<string>(sch.name);
  const [startTime, setStartTime] = useState<string>(sch.startTime);
  const [duration, setDuration] = useState(String(sch.durationMin));
  const [stream, setStream] = useState<string>(sch.streamUrl ?? '');
  const [opens, setOpens] = useState(String(sch.opensBeforeMin));
  const [closes, setCloses] = useState(String(sch.closesAfterMin));
  const [future, setFuture] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setError('');
    if (name.trim().length < 2) return setError(`Give the ${w.oneLower} a name.`);
    setBusy(true);
    try {
      const r = await patch(`/attendance/schedules/${sch.id}`, { name: name.trim(), startTime, durationMin: Number(duration), streamUrl: stream.trim(), opensBeforeMin: Number(opens), closesAfterMin: Number(closes), applyToFuture: future });
      onDone(future ? `Saved. ${r.updated ?? 0} coming ${r.updated === 1 ? w.oneLower : w.manyLower} updated.` : 'Saved.');
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Change ${sch.name}`} onClose={onClose}>
      <form className="stack sv-modal" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
        <div className="sv-two">
          <Field label="Starts at"><input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></Field>
          <Field label="Length (minutes)"><input type="number" min={15} max={480} value={duration} onChange={(e) => setDuration(e.target.value)} /></Field>
        </div>
        <Field label="YouTube live link (optional)" hint="Leave empty for no live link."><input type="url" inputMode="url" value={stream} onChange={(e) => setStream(e.target.value)} placeholder="https://www.youtube.com/live/..." /></Field>
        <details className="sv-adv">
          <summary>Check-in window (advanced)</summary>
          <div className="sv-two" style={{ marginTop: 10 }}>
            <Field label="Opens (minutes before)"><input type="number" min={0} max={240} value={opens} onChange={(e) => setOpens(e.target.value)} /></Field>
            <Field label="Closes (minutes after start)"><input type="number" min={15} max={720} value={closes} onChange={(e) => setCloses(e.target.value)} /></Field>
          </div>
        </details>
        <label className="sv-check"><input type="checkbox" checked={future} onChange={(e) => setFuture(e.target.checked)} /> Apply to all coming {w.manyLower}</label>
        <div className="tiny">{future ? `Every coming ${w.oneLower} (${sch.upcoming}) gets the new details. ${w.many} in the past are not changed.` : `Only ${w.manyLower} created from now on use the new details.`}</div>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <Button kind="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function ScheduleExtend({ sch, onClose, onDone }: { sch: any; onClose: () => void; onDone: (m: string) => void }) {
  const w = useWords();
  const [range, setRange] = useState<Range>('month');
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setError('');
    if (range === 'until' && !until) return setError('Choose the last day.');
    setBusy(true);
    try {
      const r = await api.post<any>(`/attendance/schedules/${sch.id}/extend`, { range, until: range === 'until' ? until : undefined });
      onDone(r.generated ? `${r.generated} more ${r.generated === 1 ? w.oneLower : w.manyLower} added.` : `Nothing new to add: those ${w.manyLower} already exist.`);
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Add more ${w.manyLower} to ${sch.name}`} onClose={onClose}>
      <div className="stack sv-modal">
        <div className="muted">{sch.lastServiceAt ? `${w.many} are already planned up to ${dayShort(sch.lastServiceAt)}.` : `No ${w.manyLower} are planned yet.`} Choose how far to plan ahead.</div>
        <RangePicker range={range} setRange={setRange} until={until} setUntil={setUntil} />
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <Button kind="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? 'Adding...' : `Add ${w.manyLower}`}</Button>
        </div>
      </div>
    </Modal>
  );
}

function ScheduleStop({ sch, onClose, onDone }: { sch: any; onClose: () => void; onDone: (m: string) => void }) {
  const w = useWords();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true); setError('');
    try { const r = await api.post<any>(`/attendance/schedules/${sch.id}/stop`, {}); onDone(`Schedule stopped. ${r.cancelled ?? 0} coming ${r.cancelled === 1 ? w.oneLower : w.manyLower} cancelled.`); }
    catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Stop ${sch.name}?`} onClose={onClose}>
      <div className="stack">
        <Note tone="warn">Coming {w.manyLower} that nobody has checked in to will be cancelled, and no new ones are made. {w.many} that already have check-ins stay, and past records are kept.</Note>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <Button kind="ghost" onClick={onClose}>Keep it</Button>
          <Button kind="danger" onClick={go} disabled={busy}>{busy ? 'Stopping...' : 'Stop the schedule'}</Button>
        </div>
      </div>
    </Modal>
  );
}

function ScheduleTab({ branch, branches, canManage, reloadKey, onChanged, addNonce }: { branch: string; branches: Branch[]; canManage: boolean; reloadKey: number; onChanged: () => void; addNonce: number }) {
  const s = useSession();
  const w = useWords();
  const toast = useToast();
  const list = useAsync<any>(() => api.get('/attendance/schedules' + s.qs({ branch: undefined })), [reloadKey]);
  const [modal, setModal] = useState<{ kind: 'new' | 'change' | 'extend' | 'stop'; sch?: any } | null>(null);
  useEffect(() => { if (addNonce) setModal({ kind: 'new' }); }, [addNonce]);
  const rows: any[] = (list.data?.schedules ?? []).filter((x: any) => branch === 'all' || x.branchId === branch);
  const done = (m: string) => { setModal(null); toast.show(m); list.reload(); onChanged(); };
  const copyLink = async (sch: any) => {
    let link: string | undefined;
    try {
      const r = await api.get<any>('/attendance/services' + s.qs({ from: todayKey(), to: addDays(todayKey(), 400), branchId: sch.branchId, branch: undefined }));
      link = (r.services ?? []).find((x: any) => x.scheduleId === sch.id && x.liveLink && x.status !== 'cancelled')?.liveLink;
    } catch { /* message below */ }
    if (link) copy(link, toast); else toast.show(`No live link yet for the coming ${w.manyLower}.`);
  };
  return (
    <div>
      {toast.node}
      <Load loading={list.loading} error={list.error} hasData={!!list.data}>
        {rows.length === 0 ? (
          <Card><EmptyState icon="clock" title="No weekly schedule yet" text={canManage ? `Choose “Set up a schedule” to create your weekly ${w.manyLower}.` : `Your church has not set up weekly ${w.manyLower} yet.`} action={canManage ? <Button onClick={() => setModal({ kind: 'new' })}>Set up a schedule</Button> : undefined} /></Card>
        ) : (
          <div className="sv-cards">
            {rows.map((x) => (
              <div key={x.id} className={`u-card sv-card ${x.active ? '' : 'off'}`}>
                <h3>{x.name}</h3>
                <div><b>{x.weekdayName}s at {clock(x.startTime)}</b> <span className="muted">· {x.durationMin} minutes</span></div>
                <div className="tiny">{x.branch} · check-in opens {x.opensBeforeMin} min before, closes {x.closesAfterMin} min after the start</div>
                <div className="sv-badges">
                  <StatusChip tone={x.active ? 'done' : 'off'}>{x.active ? 'Active' : 'Stopped'}</StatusChip>
                  <StatusChip tone="info">{x.upcoming} coming</StatusChip>
                  {x.streamUrl ? <StatusChip tone="info">Live link on</StatusChip> : <StatusChip tone="off">No live link</StatusChip>}
                </div>
                {x.lastServiceAt && <div className="tiny">Planned up to {dayShort(x.lastServiceAt)}</div>}
                {canManage && (
                  <div className="sv-actions">
                    <Button small kind="ghost" onClick={() => setModal({ kind: 'change', sch: x })}>Change</Button>
                    <Button small kind="ghost" onClick={() => setModal({ kind: 'extend', sch: x })}>Extend</Button>
                    {x.streamUrl && <Button small kind="ghost" onClick={() => copyLink(x)}>Copy live link</Button>}
                    {x.active && <Button small kind="danger" onClick={() => setModal({ kind: 'stop', sch: x })}>Stop</Button>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Load>
      {modal?.kind === 'new' && <ScheduleForm branches={list.data?.branches ?? branches} defaultBranch={branch !== 'all' ? branch : ''} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'change' && <ScheduleChange sch={modal.sch} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'extend' && <ScheduleExtend sch={modal.sch} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'stop' && <ScheduleStop sch={modal.sch} onClose={() => setModal(null)} onDone={done} />}
    </div>
  );
}

// ---------- coming ----------

function ReadingModal({ svc, onClose, onDone }: { svc: any; onClose: () => void; onDone: (m: string) => void }) {
  const r = svc.reading;
  const [title, setTitle] = useState<string>(r?.title ?? '');
  const [ref, setRef] = useState<string>(r?.ref ?? '');
  const [body, setBody] = useState<string>(r?.body ?? '');
  const [release, setRelease] = useState<string>(r?.release ?? svc.readingRelease ?? 'day_before');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const at = publishDate(svc.startsAt, release);
  const already = release === 'now' || new Date(at).getTime() <= Date.now();
  const submit = async () => {
    setError('');
    if (!title.trim() && !ref.trim() && !body.trim()) return setError('Add a title, a Bible reference or some notices first.');
    setBusy(true);
    try {
      await api.put(`/attendance/services/${svc.id}/reading`, { title: title.trim() || undefined, ref: ref.trim() || undefined, body: body.trim() || undefined, release });
      onDone(already ? 'Saved. Members can see it now.' : `Saved. Members will see it on ${when(at)}.`);
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title="Reading and notices" onClose={onClose}>
      <form className="stack sv-modal" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="muted">{svc.name} · {when(svc.startsAt)} · {svc.branch}</div>
        {r?.lectionary && <div className="sv-sentence" role="note">Lectionary: {r.lectionary.title}{r.lectionary.readings?.length ? `: ${r.lectionary.readings.map((x: any) => x.ref).join('; ')}` : ''}</div>}
        <Field label="Title or theme"><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="For example: The Good Shepherd" /></Field>
        <Field label="Bible reading"><input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={80} placeholder="For example: John 10:1-18" /></Field>
        <Field label="Notices" hint={`${body.length} of 6000 characters`}><textarea rows={6} value={body} maxLength={6000} onChange={(e) => setBody(e.target.value)} placeholder="Announcements, what to bring, songs, anything members should know." /></Field>
        <div>
          <div className="field-label">Show to members</div>
          <div className="sv-radios" role="radiogroup" aria-label="Show to members">
            {RELEASES.map(([k, t]) => (
              <label key={k} className={`sv-radio ${release === k ? 'on' : ''}`}>
                <input type="radio" name="release" checked={release === k} onChange={() => setRelease(k)} /> {t}
              </label>
            ))}
          </div>
        </div>
        <div className="sv-sentence">{already ? 'Members will see it straight away.' : <>Members will see it on <b>{when(at)}</b>.</>}</div>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <Button kind="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save'}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** One service with its own place (a crusade ground), instead of the branch location. */
function PlaceForService({ svc, onDone }: { svc: any; onDone: (m: string) => void }) {
  const w = useWords();
  const cur = svc.place ?? svc.geo ?? null;
  const [lat, setLat] = useState<string>(cur?.lat != null ? String(cur.lat) : '');
  const [lng, setLng] = useState<string>(cur?.lng != null ? String(cur.lng) : '');
  const [radius, setRadius] = useState<string>(String(cur?.radiusM ?? 300));
  const [name, setName] = useState<string>(cur?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setError('');
    const v = validPlace(lat, lng, radius, 30, 5000);
    if (typeof v === 'string') return setError(v);
    if (name.trim().length < 2) return setError('Give the place a name, for example the name of the ground.');
    setBusy(true);
    try { await api.put(`/attendance/services/${svc.id}/place`, { ...v, name: name.trim() }); onDone(`Saved. This ${w.oneLower} now has its own place.`); }
    catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  const clear = async () => {
    setBusy(true); setError('');
    try { await api.put(`/attendance/services/${svc.id}/place`, { clear: true }); onDone(`This ${w.oneLower} now uses the branch location.`); }
    catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div className="stack sv-modal" style={{ marginTop: 12 }}>
      <p className="tiny" style={{ margin: 0 }}>Use this for a {w.oneLower} held somewhere else, such as a crusade ground. It replaces the branch location for this {w.oneLower} only.</p>
      <Field label="Name of the place"><input aria-label="Name of the place" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="For example: Uhuru Park" /></Field>
      <PlaceFields lat={lat} lng={lng} radius={radius} setLat={setLat} setLng={setLng} setRadius={setRadius} min={30} max={5000} />
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
        <Button kind="ghost" disabled={busy} onClick={clear}>Use the branch location instead</Button>
        <Button disabled={busy} onClick={save}>Save place</Button>
      </div>
    </div>
  );
}

/** mode 'edit' changes name/length/link, 'move' changes the time, 'new' adds a special service */
function ServiceForm({ mode, svc, branches, defaultBranch, onClose, onDone, bare }: { mode: 'edit' | 'move' | 'new'; svc?: any; branches: Branch[]; defaultBranch: string; onClose: () => void; onDone: (m: string) => void; bare?: boolean }) {
  const w = useWords();
  const [name, setName] = useState<string>(svc?.name ?? '');
  const [branchId, setBranchId] = useState(defaultBranch || branches[0]?.id || '');
  const [startsAt, setStartsAt] = useState(svc ? isoToLocal(svc.startsAt) : '');
  const [duration, setDuration] = useState(svc ? String(Math.round((new Date(svc.endsAt).getTime() - new Date(svc.startsAt).getTime()) / 60000)) : '90');
  const [stream, setStream] = useState<string>(svc?.streamUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setError('');
    if (mode !== 'move' && name.trim().length < 2) return setError(`Give the ${w.oneLower} a name.`);
    if (mode !== 'edit' && !startsAt) return setError('Choose the date and time.');
    setBusy(true);
    try {
      if (mode === 'new') {
        await api.post('/attendance/services', { branchId, name: name.trim(), startsAt: localToIso(startsAt), durationMin: Number(duration), streamUrl: stream.trim() || undefined });
        onDone(`Special ${w.oneLower} added.`);
      } else if (mode === 'move') {
        await patch(`/attendance/services/${svc.id}`, { startsAt: localToIso(startsAt) });
        onDone(`Moved to ${when(localToIso(startsAt))}.`);
      } else {
        await patch(`/attendance/services/${svc.id}`, { name: name.trim(), durationMin: Number(duration), streamUrl: stream.trim() });
        onDone('Saved.');
      }
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  const title = mode === 'new' ? `Add a special ${w.oneLower}` : mode === 'move' ? `Move this ${w.oneLower}` : `Change this ${w.oneLower}`;
  const form = (
      <form className="stack sv-modal" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {mode === 'move' && <div className="muted">{svc.name} is now on {when(svc.startsAt)}. The check-in window moves with it.</div>}
        {mode !== 'move' && <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={mode === 'new' ? 'For example: Easter celebration' : ''} /></Field>}
        {mode === 'new' && branches.length > 1 && <Field label="Branch"><select value={branchId} onChange={(e) => setBranchId(e.target.value)}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>}
        {mode !== 'edit' && <Field label={mode === 'move' ? 'New date and time' : 'Date and time'} hint="Nairobi time"><input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} /></Field>}
        {mode !== 'move' && <Field label="Length (minutes)"><input type="number" min={15} max={480} value={duration} onChange={(e) => setDuration(e.target.value)} /></Field>}
        {mode !== 'move' && <Field label="YouTube live link (optional)"><input type="url" inputMode="url" value={stream} onChange={(e) => setStream(e.target.value)} placeholder="https://www.youtube.com/live/..." /></Field>}
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <Button kind="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving...' : mode === 'new' ? `Add ${w.oneLower}` : mode === 'move' ? 'Move it' : 'Save'}</Button>
        </div>
      </form>
  );
  if (bare) return form;
  return (
    <Modal title={title} onClose={onClose}>
      {form}
      {mode === 'edit' && <PlaceForService svc={svc} onDone={onDone} />}
    </Modal>
  );
}

function CancelModal({ svc, onClose, onDone }: { svc: any; onClose: () => void; onDone: (m: string) => void }) {
  const w = useWords();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true); setError('');
    try { await patch(`/attendance/services/${svc.id}`, { status: 'cancelled' }); onDone(`${w.one} cancelled.`); }
    catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Cancel this ${w.oneLower}?`} onClose={onClose}>
      <div className="stack">
        <div>{svc.name} on <b>{when(svc.startsAt)}</b> will show as cancelled. You can restore it later.</div>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <Button kind="ghost" onClick={onClose}>Keep it</Button>
          <Button kind="danger" onClick={go} disabled={busy}>{busy ? 'Cancelling...' : `Cancel the ${w.oneLower}`}</Button>
        </div>
      </div>
    </Modal>
  );
}

const FILTERS = [['week', 'This week'], ['30', 'Next 30 days'], ['all', 'All coming']] as const;

function stateChip(x: any) {
  if (x.status === 'cancelled' || x.state === 'cancelled') return <StatusChip tone="off">Cancelled</StatusChip>;
  if (x.state === 'open') return <StatusChip tone="done">Open now</StatusChip>;
  if (x.state === 'closed') return <StatusChip tone="off">Finished</StatusChip>;
  return <StatusChip tone="wait">Check-in not open yet</StatusChip>;
}
function readingChip(x: any) {
  const r = x.reading;
  if (!r) return <StatusChip tone="off">No reading yet</StatusChip>;
  if (r.published) return <StatusChip tone="done">Published</StatusChip>;
  return <StatusChip tone="info">Reading ready, shows {dayShort(publishDate(x.startsAt, r.release))}</StatusChip>;
}

type Modals = { kind: 'edit' | 'move' | 'new' | 'cancel' | 'reading'; svc?: any };

/** Everything about one gathering, one calm section at a time. */
function ManagePanel({ svc, onClose, onDone, open, onRestore, toast }: { svc: any; onClose: () => void; onDone: (m: string) => void; open: (m: Modals) => void; onRestore: (x: any) => void; toast: { show: (m: string) => void } }) {
  const w = useWords();
  const cancelled = svc.status === 'cancelled';
  const r = svc.reading;
  return (
    <SidePanel title={svc.name} subtitle={`${when(svc.startsAt)} · ${svc.branch}`} onClose={onClose} width={520}>
      <div className="sv-chips">{stateChip(svc)}{readingChip(svc)}</div>
      {!cancelled && (
        <section className="sv-sec">
          <h3>Name and length</h3>
          <ServiceForm bare mode="edit" svc={svc} branches={[]} defaultBranch="" onClose={onClose} onDone={onDone} />
        </section>
      )}
      <section className="sv-sec">
        <h3>Reading and notices</h3>
        {r ? (
          <p className="muted" style={{ margin: 0 }}>{[r.title, r.ref].filter(Boolean).join(' · ') || 'Notices added.'}{r.lectionary ? ` Lectionary: ${r.lectionary.title}.` : ''}</p>
        ) : <p className="muted" style={{ margin: 0 }}>Nothing added yet. Members see the reading in their app.</p>}
        <div><Button kind="ghost" onClick={() => open({ kind: 'reading', svc })}>{r ? 'Edit reading and notices' : 'Add reading and notices'}</Button></div>
      </section>
      {!cancelled && (
        <section className="sv-sec">
          <h3>Date and time</h3>
          <p className="muted" style={{ margin: 0 }}>{when(svc.startsAt)}. Moving it moves the check-in window too.</p>
          <div><Button kind="ghost" onClick={() => open({ kind: 'move', svc })}>Move to another time</Button></div>
        </section>
      )}
      <section className="sv-sec">
        <h3>Live link</h3>
        {svc.liveLink ? (
          <>
            <p className="muted" style={{ margin: 0 }}>Members and visitors who watch through this link are counted as online.</p>
            <div><Button kind="ghost" onClick={() => copy(svc.liveLink, toast)}>Copy live link</Button></div>
          </>
        ) : <p className="muted" style={{ margin: 0 }}>No live link. Add a YouTube link under Name and length.</p>}
      </section>
      {!cancelled && (
        <details className="sv-adv">
          <summary>Place for this {w.oneLower}</summary>
          <PlaceForService svc={svc} onDone={onDone} />
        </details>
      )}
      <section className="sv-sec sv-danger">
        <h3>{cancelled ? `This ${w.oneLower} is cancelled` : `Cancel this ${w.oneLower}`}</h3>
        {cancelled
          ? <div><Button kind="ghost" onClick={() => onRestore(svc)}>Restore</Button></div>
          : <div><Button kind="danger" onClick={() => open({ kind: 'cancel', svc })}>Cancel the {w.oneLower}</Button></div>}
      </section>
    </SidePanel>
  );
}

function ServicesTab({ branch, branches, canManage, reloadKey, onChanged, addNonce }: { branch: string; branches: Branch[]; canManage: boolean; reloadKey: number; onChanged: () => void; addNonce: number }) {
  const s = useSession();
  const w = useWords();
  const toast = useToast();
  const [filter, setFilter] = useState<'week' | '30' | 'all'>('30');
  const q = useMemo(() => {
    const t = todayKey();
    const to = filter === 'week' ? addDays(t, (7 - new Date(`${t}T00:00:00Z`).getUTCDay()) % 7) : filter === '30' ? addDays(t, 30) : addDays(t, 400);
    return { from: t, to };
  }, [filter]);
  const list = useAsync<any>(() => api.get('/attendance/services' + s.qs({ from: q.from, to: q.to, branchId: branch !== 'all' ? branch : undefined, branch: undefined })), [q.from, q.to, branch, reloadKey]);
  const [modal, setModal] = useState<Modals | null>(null);
  const [panel, setPanel] = useState<any>(null);
  useEffect(() => { if (addNonce) setModal({ kind: 'new' }); }, [addNonce]);
  const done = (m: string) => { setModal(null); setPanel(null); toast.show(m); list.reload(); onChanged(); };
  const restore = async (x: any) => {
    try { await patch(`/attendance/services/${x.id}`, { status: 'scheduled' }); setPanel(null); toast.show(`${w.one} restored.`); list.reload(); onChanged(); }
    catch (e: any) { toast.show(errMsg(e)); }
  };
  const openModal = (m: Modals) => { setPanel(null); setModal(m); };
  const days = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const x of (list.data?.services ?? []) as any[]) { const k = dayKey(x.startsAt); if (!m.has(k)) m.set(k, []); m.get(k)!.push(x); }
    return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  }, [list.data]);
  return (
    <div>
      {toast.node}
      <Toolbar>
        <div className="chips" role="radiogroup" aria-label="Show">
          {FILTERS.map(([k, t]) => <button key={k} type="button" role="radio" aria-checked={filter === k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{t}</button>)}
        </div>
      </Toolbar>
      <Load loading={list.loading} error={list.error} hasData={!!list.data}>
        {days.length === 0 ? (
          <Card><EmptyState icon="worship" title={`No ${w.manyLower} in this period`} text={`Set up a weekly schedule, or add a special ${w.oneLower}.`} action={canManage ? <Button onClick={() => setModal({ kind: 'new' })}>Add a special {w.oneLower}</Button> : undefined} /></Card>
        ) : days.map(([k, items]) => (
          <Section key={k} title={dayName(items[0].startsAt)}>
            <Card pad={false}>
              <div className="sv-list">
                {items.map((x) => {
                  const c = x.counts ?? {};
                  const cancelled = x.status === 'cancelled';
                  const total = (c.members ?? 0) + (c.visitors ?? 0);
                  return (
                    <div key={x.id} className={`sv-row ${cancelled ? 'cancelled' : ''}`}>
                      <div className="sv-main">
                        <div className="sv-name"><span className="sv-title">{x.name}</span> {stateChip(x)} {readingChip(x)}</div>
                        <div className="sv-meta">
                          <span>{when(x.startsAt)}</span>{branches.length > 1 && <span>{x.branch}</span>}
                          {x.streamUrl && <span>Live link on</span>}
                          <span>{total === 0 ? 'No check-ins yet' : `${total} checked in (${c.members ?? 0} members, ${c.visitors ?? 0} visitors)`}{c.online ? `, ${c.online} online` : ''}</span>
                        </div>
                      </div>
                      {canManage && (
                        <div className="sv-btns">
                          <Button small kind="ghost" onClick={() => setModal({ kind: 'reading', svc: x })}>Reading and notices</Button>
                          <Button small kind="ghost" onClick={() => setPanel(x)}>Manage</Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          </Section>
        ))}
      </Load>
      {panel && <ManagePanel svc={panel} onClose={() => setPanel(null)} onDone={done} open={openModal} onRestore={restore} toast={toast} />}
      {modal?.kind === 'reading' && <ReadingModal svc={modal.svc} onClose={() => setModal(null)} onDone={done} />}
      {(modal?.kind === 'edit' || modal?.kind === 'move' || modal?.kind === 'new') && <ServiceForm mode={modal.kind} svc={modal.svc} branches={branches} defaultBranch={branch !== 'all' ? branch : ''} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'cancel' && <CancelModal svc={modal.svc} onClose={() => setModal(null)} onDone={done} />}
    </div>
  );
}

// ---------- welcome message ----------

const SAMPLE: Record<string, string> = { name: 'Amina', church: 'Grace Church', branch: 'Grace Nairobi', service: 'Sunday service' };
const VARS = ['name', 'church', 'branch', 'service'] as const;
const fill = (t: string) => t.replace(/\{(name|church|branch|service)\}/g, (_, k) => SAMPLE[k]);

function WelcomeTab() {
  const s = useSession();
  const w = useWords();
  const toast = useToast();
  const st = useAsync<any>(() => api.get('/attendance/settings' + s.qs({ branch: undefined })), []);
  const [text, setText] = useState<string | null>(null);
  const [on, setOn] = useState<boolean | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const d = st.data;
  const value = text ?? d?.welcomeTemplate ?? '';
  const enabled = on ?? d?.welcomeEnabled ?? false;
  const can = !!d?.canManage;
  const insert = (v: string) => {
    const el = area.current;
    const tag = `{${v}}`;
    const a = el?.selectionStart ?? value.length;
    const b = el?.selectionEnd ?? value.length;
    setText(value.slice(0, a) + tag + value.slice(b));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(a + tag.length, a + tag.length); });
  };
  const save = async (template: string, enable: boolean, msg: string) => {
    setError('');
    if (template.trim().length < 10 || template.length > 320) return setError('The message must be between 10 and 320 characters.');
    setBusy(true);
    try {
      await api.put('/attendance/settings', { welcomeEnabled: enable, welcomeTemplate: template });
      toast.show(msg);
      const r = await api.get<any>('/attendance/settings' + s.qs({ branch: undefined }));
      setSaved(r.preview ?? null);
      setText(null); setOn(null);
      st.reload();
    } catch (e: any) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  const len = value.length;
  return (
    <div className="sv-welcome">
      {toast.node}
      <Load loading={st.loading} error={st.error} hasData={!!d}>
        {d && (
          <Section title="Welcome message to visitors" hint="Sent by SMS to every first-time visitor.">
            <Card>
              <div className="stack">
                <label className="sv-switch">
                  <input type="checkbox" role="switch" checked={enabled} disabled={!can || busy} onChange={(e) => setOn(e.target.checked)} />
                  <span className="sv-track" aria-hidden="true" />
                  <span><b>{enabled ? 'On' : 'Off'}</b> · Send a welcome SMS to every first-time visitor automatically</span>
                </label>
                <div>
                  <div className="field-label">Message</div>
                  <textarea ref={area} value={value} readOnly={!can} rows={5} maxLength={400} onChange={(e) => setText(e.target.value)} aria-label="Welcome message" />
                  <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className={`tiny sv-count ${len > 160 ? 'over' : ''}`}>{len} characters{len > 160 ? ': over 160 characters costs more than one SMS' : ''}</span>
                    <span className="tiny">Up to 320 characters</span>
                  </div>
                </div>
                {can && (
                  <div>
                    <div className="tiny" style={{ marginBottom: 6 }}>Tap to add a detail that is filled in for each person:</div>
                    <div className="sv-vars">{VARS.map((v) => <button key={v} type="button" className="chip" onClick={() => insert(v)}>{`{${v}}`}</button>)}</div>
                    <div className="tiny" style={{ marginTop: 6 }}>{'{name}'} is the visitor’s first name, {'{church}'} the church, {'{branch}'} the branch they visited, {'{service}'} the {w.oneLower}.</div>
                  </div>
                )}
                <div>
                  <div className="field-label">What a visitor will get</div>
                  <div className="sv-preview">{fill(value) || ' '}</div>
                  {text == null && (saved ?? d.preview) && <div className="tiny" style={{ marginTop: 6 }}>Saved version: {saved ?? d.preview}</div>}
                </div>
                {error && <ErrorNote>{error}</ErrorNote>}
                {can ? (
                  <div className="wo-actions">
                    <Button onClick={() => save(value, enabled, 'Welcome message saved.')} disabled={busy}>{busy ? 'Saving...' : 'Save'}</Button>
                    <Button kind="ghost" onClick={() => setText(d.defaultTemplate)} disabled={busy}>Use the standard message</Button>
                  </div>
                ) : <div className="tiny">You can read this but not change it.</div>}
              </div>
            </Card>
          </Section>
        )}
      </Load>
    </div>
  );
}

// ---------- page ----------

export function Services() {
  const s = useSession();
  const w = useWords();
  const [tab, setTab] = useState<'schedule' | 'coming' | 'welcome'>('coming');
  const [branch, setBranch] = useState<string>(s.scope);
  const [key, setKey] = useState(0);
  const [nonce, setNonce] = useState(0);
  const meta = useAsync<any>(() => api.get('/attendance/schedules' + s.qs({ branch: undefined })), [key]);
  const branches: Branch[] = meta.data?.branches ?? s.branches;
  const canManage = meta.data ? !!meta.data.canManage : s.can('attendance.manage');
  const bump = () => setKey((k) => k + 1);
  const action = canManage && tab === 'coming' ? <Button onClick={() => setNonce((n) => n + 1)}>Add a special {w.oneLower}</Button>
    : canManage && tab === 'schedule' ? <Button onClick={() => setNonce((n) => n + 1)}>Set up a schedule</Button> : undefined;
  return (
    <div>
      <PageHeader title={w.many} subtitle={`Your weekly ${w.manyLower}, what is read, and the welcome message for visitors.`} actions={action}
        tabs={[{ id: 'coming', label: 'Upcoming' }, { id: 'schedule', label: 'Weekly schedule' }, { id: 'welcome', label: 'Settings' }]} tab={tab} onTab={(t) => { setNonce(0); setTab(t as any); }} />
      <div className="sv">
        {branches.length > 1 && tab !== 'welcome' && (
          <Toolbar>
            <select aria-label="Branch" value={branch} onChange={(e) => setBranch(e.target.value)}>
              <option value="all">All branches</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Toolbar>
        )}
        {tab === 'schedule' && <ScheduleTab branch={branch} branches={branches} canManage={canManage} reloadKey={key} onChanged={bump} addNonce={nonce} />}
        {tab === 'coming' && <ServicesTab branch={branch} branches={branches} canManage={canManage} reloadKey={key} onChanged={bump} addNonce={nonce} />}
        {tab === 'welcome' && <WelcomeTab />}
      </div>
    </div>
  );
}
