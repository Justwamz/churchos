import { useState } from 'react';
import { API_URL, Button, Note, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { useWords } from './words';
import { Card, EmptyState, PageHeader, Section, Skeleton, Stat, StatTiles, StatusChip, Toolbar } from './ui';
import './attendance.css';

/** Loading / error wrapper that shows a skeleton instead of a spinner. */
function Load({ loading, error, hasData, children, rows = 3 }: { loading: boolean; error?: string; hasData: boolean; children: React.ReactNode; rows?: number }) {
  if (error && !hasData) return <Note tone="bad">{friendly(error)}</Note>;
  if (loading && !hasData) return <Skeleton rows={rows} height={64} />;
  return <>{error && <Note tone="bad">{friendly(error)}</Note>}{children}</>;
}

const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi', weekday: 'short', day: 'numeric', month: 'short' }) : '-');
const dayTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '-');
const wk = (ymd: string) => new Date(ymd + 'T12:00:00').toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
const plural = (n: number, a: string, b: string) => `${n} ${n === 1 ? a : b}`;
type Toast = (t: string, tone?: 'good' | 'bad') => void;

type Totals = { services: number; members: number; firstVisitors: number; returningVisitors: number; online: number; headcount: number | null };

function Tile({ label, k, t, prev, avg, good }: { label: string; k: 'members' | 'firstVisitors' | 'returningVisitors' | 'online'; t: Totals; prev?: Totals; avg?: Totals; good?: boolean }) {
  const v = t[k];
  const diff = prev ? v - prev[k] : 0;
  const usual = avg ? Math.round(avg[k]) : null;
  const text = !prev ? '' : diff === 0 ? 'Same as the week before' : `${diff > 0 ? 'Up' : 'Down'} ${Math.abs(diff)} from the week before`;
  const hint = [text && `${diff > 0 ? '↑ ' : diff < 0 ? '↓ ' : ''}${text}`, usual !== null && `Usual: ${usual}`, good && diff > 0 && 'More new faces, thank God.'].filter(Boolean).join('. ');
  return <Stat label={label} value={v} hint={hint || undefined} tone={good && diff > 0 ? 'good' : undefined} />;
}

function Chart({ weeks, lastWeekStart }: { weeks: any[]; lastWeekStart?: string }) {
  const wd = useWords();
  const [sel, setSel] = useState<number>(Math.max(0, weeks.findIndex((x) => x.weekStart === lastWeekStart) < 0 ? weeks.length - 1 : weeks.findIndex((x) => x.weekStart === lastWeekStart)));
  const max = Math.max(1, ...weeks.map((w) => Math.max(w.members + w.returningVisitors + w.firstVisitors, w.online)));
  const H = 150;
  const px = (n: number) => (n / max) * H;
  const w = weeks[Math.min(sel, weeks.length - 1)];
  const fmax = Math.max(1, ...weeks.map((x) => x.firstVisitors));
  const pts = weeks.map((x, i) => [weeks.length === 1 ? 50 : 6 + (i / (weeks.length - 1)) * 88, 80 - (x.firstVisitors / fmax) * 66] as const);
  return (
    <>
      <div className="at-legend">
        <span style={{ ['--c' as any]: 'var(--brand)' }}>Members</span>
        <span style={{ ['--c' as any]: 'var(--gold)' }}>Returning visitors</span>
        <span style={{ ['--c' as any]: 'var(--good)' }}>First-time visitors</span>
        <span style={{ ['--c' as any]: 'var(--info)' }}>Online (lighter bar)</span>
      </div>
      <div className="at-scroll">
        <div className="at-chart" role="group" aria-label="Weekly attendance, tap a week for details">
          {weeks.map((x, i) => (
            <button key={x.weekStart} type="button" className={'at-col' + (i === sel ? ' sel' : '')} onClick={() => setSel(i)} aria-label={`Week of ${wk(x.weekStart)}`}>
              <div className="at-pair">
                <div className="at-stack">
                  <i className="at-m" style={{ height: px(x.members) }} />
                  <i className="at-r" style={{ height: px(x.returningVisitors) }} />
                  <i className="at-f" style={{ height: px(x.firstVisitors) }} />
                </div>
                <div className="at-onl" style={{ height: px(x.online) }} />
              </div>
            </button>
          ))}
        </div>
        <div className="at-labels">
          {weeks.map((x) => <div key={x.weekStart}><b>{x.members + x.returningVisitors + x.firstVisitors}</b>{wk(x.weekStart)}</div>)}
        </div>
      </div>
      {w && (
        <div className="at-detail">
          <b>Week of {wk(w.weekStart)}{w.weekStart > (lastWeekStart ?? '') ? ' (this week so far)' : ''}</b>: {w.members} members, {w.returningVisitors} returning visitors, {w.firstVisitors} first-time visitors, {w.online} online
          {w.headcount != null ? `, headcount ${w.headcount}` : ''}. {plural(w.services, wd.oneLower, wd.manyLower)}.
        </div>
      )}
      <h3 style={{ margin: '24px 0 4px' }}>Visitors over time</h3>
      <p className="tiny" style={{ margin: '0 0 6px' }}>First-time visitors each week. Going up is good news.</p>
      <svg className="at-spark" viewBox="0 0 100 90" preserveAspectRatio="none" role="img" aria-label="First-time visitors per week">
        <polyline fill="none" stroke="var(--good)" strokeWidth="2" vectorEffect="non-scaling-stroke" points={pts.map((p) => p.join(',')).join(' ')} />
      </svg>
      <div className="at-labels" style={{ minWidth: 0 }}>
        {weeks.map((x) => <div key={x.weekStart} style={{ minWidth: 0 }}><b>{x.firstVisitors}</b>{wk(x.weekStart)}</div>)}
      </div>
    </>
  );
}

const TABS: [string, string][] = [['new', 'To follow up'], ['contacted', 'Contacted'], ['returning', 'Returning'], ['member', 'Members'], ['not_interested', 'Not interested'], ['', 'All']];
const WELCOME: Record<string, { t: string; tone: 'done' | 'wait' | 'off' }> = {
  sent: { t: 'Welcome SMS sent', tone: 'done' }, not_sent: { t: 'Not sent: check the SMS balance', tone: 'wait' }, off: { t: 'Welcome SMS off', tone: 'off' },
};
const STATUS_TEXT: Record<string, string> = { new: 'New', contacted: 'Contacted', returning: 'Returning', member: 'Joined as a member', not_interested: 'Not interested' };

function VisitorRow({ v, onDone, toast }: { v: any; onDone: () => void; toast: Toast }) {
  const w = useWords();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(v.note ?? '');
  const [busy, setBusy] = useState(false);
  const canChange = v.status !== 'member';
  const set = async (status?: string) => {
    setBusy(true);
    try {
      await api.post(`/attendance/visitors/${v.id}`, { ...(status ? { status } : {}), note: note.trim() });
      toast(status === 'contacted' ? `${v.name} marked as contacted.` : status === 'not_interested' ? `${v.name} marked as not interested.` : 'Note saved.');
      setOpen(false); onDone();
    } catch (e: any) { toast(friendly(e?.message ?? 'Could not save. Try again.'), 'bad'); }
    setBusy(false);
  };
  const wl = WELCOME[v.welcome] ?? WELCOME.off;
  return (
    <div className="at-vis">
      <div className="at-vis-top">
        <div>
          <div className="at-vis-name">{v.name}</div>
          <div className="tiny">Came to {v.firstService || `a ${w.oneLower}`} on {day(v.firstSeenAt)}{v.branch ? ` (${v.branch})` : ''}{v.visits > 1 ? `. ${v.visits} visits, last on ${day(v.lastSeenAt)}` : ''}</div>
          {v.invitedBy && <div className="tiny">Invited by {v.invitedBy}</div>}
        </div>
        <div className="at-chips">
          <StatusChip tone={v.status === 'new' ? 'done' : v.status === 'not_interested' ? 'off' : 'info'}>{STATUS_TEXT[v.status] ?? v.status}</StatusChip>
          <StatusChip tone={wl.tone}>{wl.t}</StatusChip>
        </div>
      </div>
      {v.contactedBy && <div className="tiny">Contacted by {v.contactedBy}{v.contactedAt ? ` on ${dayTime(v.contactedAt)}` : ''}</div>}
      {v.note && !open && <div style={{ fontSize: 14 }}>Note: {v.note}</div>}
      <div className="at-actions">
        {v.phone && <a className="btn primary small" href={`tel:${v.phone}`}>Call {v.phone}</a>}
        {canChange && v.status !== 'contacted' && <Button small kind="ghost" onClick={() => set('contacted')} disabled={busy}>Contacted</Button>}
        {canChange && v.status !== 'not_interested' && <Button small kind="ghost" onClick={() => set('not_interested')} disabled={busy}>Not interested</Button>}
        {canChange && v.status !== 'new' && v.status !== 'returning' && <Button small kind="ghost" onClick={() => set('new')} disabled={busy}>Back to follow up</Button>}
        {canChange && <Button small kind="ghost" onClick={() => setOpen(!open)}>{v.note ? 'Edit note' : 'Add note'}</Button>}
      </div>
      {open && (
        <div className="at-note">
          <textarea aria-label={`Note about ${v.name}`} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="For example: spoke on the phone, will come with family" />
          <div className="at-actions"><Button small onClick={() => set()} disabled={busy}>Save note</Button><Button small kind="ghost" onClick={() => setOpen(false)}>Cancel</Button></div>
        </div>
      )}
    </div>
  );
}

function Visitors({ branchId, toast }: { branchId: string; toast: Toast }) {
  const [tab, setTab] = useState('new');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const query = (csv = false) => {
    const p = new URLSearchParams();
    if (tab) p.set('status', tab);
    if (branchId) p.set('branchId', branchId);
    if (q.trim()) p.set('q', q.trim());
    if (csv) p.set('csv', '1');
    const s = p.toString();
    return s ? '?' + s : '';
  };
  const key = query();
  const d = useAsync<any>(() => api.get('/attendance/visitors' + key), [key]);
  const list: any[] = d.data?.visitors ?? [];
  const sm = d.data?.summary;
  const count = (k: string) => (k === 'new' && sm ? ` (${sm.new})` : k === 'returning' && sm ? ` (${sm.returning})` : k === 'member' && sm ? ` (${sm.members})` : '');
  const csv = async () => {
    setBusy(true); setErr('');
    try {
      const token = api.getToken();
      const res = await fetch(`${API_URL}/attendance/visitors${query(true)}`, { headers: { 'x-churchos-app': 'staff', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
      if (!res.ok) throw new Error('Could not download the file. Try again.');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = 'visitors.csv'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) { setErr(friendly(e?.message ?? 'Could not download the file.')); }
    setBusy(false);
  };
  return (
    <>
      <Toolbar end={<Button small kind="ghost" onClick={csv} disabled={busy}>{busy ? 'Preparing...' : 'Download CSV'}</Button>}>
        <input type="search" aria-label="Search visitors" placeholder="Search by name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
      </Toolbar>
      <div className="chips" style={{ marginBottom: 16 }}>
        {TABS.map(([k, t]) => <button key={k || 'all'} type="button" className={'chip' + (tab === k ? ' on' : '')} onClick={() => setTab(k)}>{t}{count(k)}</button>)}
      </div>
      {err && <Note tone="bad">{err}</Note>}
      <Load loading={d.loading} error={d.error} hasData={!!d.data}>
        {list.length === 0
          ? <Card><EmptyState icon="people" title={tab === 'new' ? 'No one is waiting for a follow-up' : 'No visitors here'} text={tab === 'new' ? 'New visitors will appear here.' : undefined} /></Card>
          : <Card pad={false}><div className="at-list">{list.map((v) => <VisitorRow key={v.id + v.status + (v.note ?? '')} v={v} toast={toast} onDone={d.reload} />)}</div></Card>}
      </Load>
    </>
  );
}

function Care({ branchId }: { branchId: string }) {
  const d = useAsync<any>(() => api.get('/attendance/care' + (branchId ? `?branchId=${branchId}` : '')), [branchId]);
  const list: any[] = d.data?.members ?? [];
  return (
    <>
      <p className="at-line" style={{ marginTop: 0, marginBottom: 16 }}>Members who came in at least 3 of 6 weeks and not in the last 3. It is based on check-ins, so it is only as complete as your check-in coverage. Find them under Members to get in touch.</p>
      <Load loading={d.loading} error={d.error} hasData={!!d.data}>
        {list.length === 0 ? <Card><EmptyState icon="heart" title="No regular members have gone quiet" text="Good news." /></Card> : (
          <Card pad={false}>
            <div className="at-list">
              {list.map((m) => (
                <div className="at-care" key={m.id}>
                  <div><b>{m.name}</b> <span className="tiny">{m.memberNumber}</span><span className="at-sub">{m.branch}</span></div>
                  <div className="at-care-r">
                    <div>Last seen {day(m.lastSeen)}</div>
                    <span className="at-sub">Came in {m.weeksBefore} of the 6 weeks before</span>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </Load>
    </>
  );
}

function Email({ toast }: { toast: Toast }) {
  const p = useAsync<any>(() => api.get('/attendance/prefs'), []);
  const [busy, setBusy] = useState(false);
  const on = !!p.data?.weeklyEmail;
  const flip = async (v: boolean) => {
    try { await api.put('/attendance/prefs', { weeklyEmail: v }); p.reload(); toast(v ? 'You will get the report every Monday.' : 'Monday email switched off.'); }
    catch (e: any) { toast(friendly(e?.message ?? 'Could not save. Try again.'), 'bad'); }
  };
  const send = async () => {
    setBusy(true);
    try { await api.post('/attendance/report/send-now', {}); toast('Sent. Check your email.'); }
    catch (e: any) { toast(friendly(e?.message ?? 'Could not send the report.'), 'bad'); }
    setBusy(false);
  };
  return (
    <Section title="Monday email" hint="The same numbers, in your inbox.">
      <Card>
        <label className="at-switch"><input type="checkbox" checked={on} disabled={!p.data} onChange={(e) => flip(e.target.checked)} /> Email me this report every Monday at 7:00 am</label>
        <div style={{ marginTop: 14 }}><Button kind="ghost" onClick={send} disabled={busy}>{busy ? 'Sending...' : "Send me last week's report now"}</Button></div>
      </Card>
    </Section>
  );
}

export function Attendance() {
  const s = useSession();
  const w = useWords();
  const toast = useToast();
  const [tab, setTab] = useState('overview');
  const [branch, setBranch] = useState('');
  const branchId = branch || (s.scope !== 'all' ? s.scope : '');
  const d = useAsync<any>(() => api.get(`/attendance/summary?weeks=8${branchId ? `&branchId=${branchId}` : ''}`), [branchId]);
  const weeks: any[] = d.data?.weeks ?? [];
  const r = d.data?.lastWeek;
  const t: Totals | undefined = r?.totals;
  return (
    <>
      <PageHeader title="Attendance" subtitle="How attendance is trending, who to follow up and who has gone quiet."
        tabs={[{ id: 'overview', label: 'Last week' }, { id: 'visitors', label: 'Visitors' }, { id: 'quiet', label: 'Stopped coming' }, { id: 'report', label: 'Report' }]} tab={tab} onTab={setTab} />
      {s.branches.length > 1 && (
        <Toolbar>
          <select aria-label="Branch" value={branch} onChange={(e) => setBranch(e.target.value)}>
            <option value="">{s.scope === 'all' ? 'All branches' : 'Selected branch'}</option>
            {s.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Toolbar>
      )}

      {tab === 'overview' && (
        <Load loading={d.loading} error={d.error} hasData={!!d.data} rows={4}>
          {d.data && r && t && (
            <>
              <Section title={`Last week (${wk(r.weekStart)} to ${wk(r.weekEnd)})`}>
                {t.services === 0 ? <Card><EmptyState icon="people" title={`No ${w.manyLower} were held last week`} /></Card> : (
                  <>
                    <StatTiles>
                      <Tile label="Members" k="members" t={t} prev={r.previous} avg={r.average4} />
                      <Tile label="First-time visitors" k="firstVisitors" t={t} prev={r.previous} avg={r.average4} good />
                      <Tile label="Returning visitors" k="returningVisitors" t={t} prev={r.previous} avg={r.average4} />
                      <Tile label="Online" k="online" t={t} prev={r.previous} avg={r.average4} />
                    </StatTiles>
                    <p className="at-line">
                      {t.headcount != null ? <>Headcount counted by ushers: <b>{t.headcount}</b> across {plural(t.services, w.oneLower, w.manyLower)}.</> : <>{plural(t.services, w.oneLower, w.manyLower)} held. No headcount was entered.</>}
                      {r.coverage != null && <> Check-ins cover {r.coverage}% of the headcount, so the member and visitor numbers are a sample.</>}
                    </p>
                  </>
                )}
              </Section>
              <Section title="Last 8 weeks">
                <Card>{weeks.length === 0 ? <EmptyState icon="list" title="No attendance has been recorded yet" /> : <Chart weeks={weeks} lastWeekStart={r.weekStart} />}</Card>
              </Section>
              <Section title={`Last week's ${w.manyLower}`}>
                {r.services.length === 0 ? <Card><EmptyState icon="worship" title={`No ${w.manyLower} were held last week`} /></Card> : (
                  <Card pad={false}>
                    <table className="at-table">
                      <thead><tr><th>{w.one}</th><th>Branch</th><th>Date</th><th className="num">Members</th><th className="num">First-time</th><th className="num">Returning</th><th className="num">Online (peak)</th><th className="num">Headcount</th><th className="num">Checked in</th></tr></thead>
                      <tbody>
                        {r.services.map((x: any) => (
                          <tr key={x.id}>
                            <td data-l={w.one}><b>{x.name}</b></td>
                            <td data-l="Branch">{x.branch}</td>
                            <td data-l="Date">{dayTime(x.startsAt)}</td>
                            <td data-l="Members" className="num">{x.members}</td>
                            <td data-l="First-time" className="num">{x.firstVisitors}</td>
                            <td data-l="Returning" className="num">{x.returningVisitors}</td>
                            <td data-l="Online (peak)" className="num">{x.online} ({x.onlinePeak})</td>
                            <td data-l="Headcount" className="num">{x.headcount ?? '-'}</td>
                            <td data-l="Checked in" className="num">{x.coverage != null ? `${x.coverage}%` : '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                )}
              </Section>
            </>
          )}
        </Load>
      )}

      {tab === 'visitors' && <Visitors branchId={branchId} toast={toast.show} />}
      {tab === 'quiet' && <Care branchId={branchId} />}

      {tab === 'report' && (
        <>
          <Load loading={d.loading} error={d.error} hasData={!!d.data}>
            {r && (r.events?.length > 0 || r.kids?.length > 0) ? (
              <Section title="Last week at church">
                <Card>
                  <div className="at-two">
                    {r.events?.length > 0 && (
                      <div>
                        <h4 style={{ marginTop: 0 }}>Events</h4>
                        {r.events.map((e: any, i: number) => (
                          <div className="at-care" key={i}>
                            <div><b>{e.title}</b><span className="at-sub">{dayTime(e.startsAt)}</span></div>
                            <div className="at-care-r">{e.kind === 'tickets' ? `${e.sold} sold, ${e.scanned} scanned` : `${e.going} replied going`}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    {r.kids?.length > 0 && (
                      <div>
                        <h4 style={{ marginTop: 0 }}>Children in class</h4>
                        {r.kids.map((k: any, i: number) => <div className="at-care" key={i}><b>{k.className}</b><span>{k.count}</span></div>)}
                      </div>
                    )}
                  </div>
                </Card>
              </Section>
            ) : r ? <Section title="Last week at church"><Card><EmptyState icon="today" title="No events or children's classes last week" /></Card></Section> : null}
          </Load>
          <Email toast={toast.show} />
        </>
      )}
      {toast.node}
    </>
  );
}
