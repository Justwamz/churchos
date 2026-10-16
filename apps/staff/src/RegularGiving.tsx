import { useState } from 'react';
import { API_URL, Badge, Button, Card, Empty, Field, Note, Stat, kes, useAsync } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Load, PageHead } from './bits';
import './regular-giving.css';

const when = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '-';
const STATUS: Record<string, { text: string; tone: 'good' | 'warn' | 'bad' | 'muted' }> = {
  active: { text: 'Active', tone: 'good' }, paused: { text: 'Paused', tone: 'warn' }, cancelled: { text: 'Cancelled', tone: 'muted' }, ended: { text: 'Ended', tone: 'muted' },
};
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

export function RegularGiving() {
  const s = useSession();
  const [status, setStatus] = useState('active');
  const [branch, setBranch] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const query = (csv = false) => {
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    const b = branch || (s.scope !== 'all' ? s.scope : '');
    if (b) p.set('branchId', b);
    if (q.trim()) p.set('q', q.trim());
    if (csv) p.set('csv', '1');
    const str = p.toString();
    return str ? '?' + str : '';
  };
  const key = query();
  const d = useAsync<any>(() => api.get('/giving-plans' + key), [key]);
  const plans: any[] = d.data?.plans ?? [];
  const x = d.data?.summary;

  const csv = async () => {
    setBusy(true); setErr('');
    try {
      const token = api.getToken();
      const res = await fetch(`${API_URL}/giving-plans${query(true)}`, { headers: { 'x-churchos-app': 'staff', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
      if (!res.ok) throw new Error('Could not download the file. Try again.');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = 'regular-giving.csv'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) { setErr(friendly(e?.message ?? 'Could not download the file.')); }
    setBusy(false);
  };

  return (
    <>
      <PageHead title="Regular giving" sub="Gifts members have set up to repeat." action={<Button kind="ghost" onClick={csv} disabled={busy}>{busy ? 'Preparing...' : 'Download CSV'}</Button>} />
      <Note>Members choose these in the app. A prompt goes to their phone on the day and they enter their PIN, so a gift only happens when they complete it. Missed prompts are retried three times over two days.</Note>
      <div style={{ height: 16 }} />
      {err && <Note tone="bad">{err}</Note>}
      <Card>
        <div className="rg-filters">
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="active">Active</option><option value="paused">Paused</option><option value="cancelled">Cancelled</option><option value="ended">Ended</option><option value="">All</option>
            </select>
          </Field>
          {s.branches.length > 1 && (
            <Field label="Branch">
              <select value={branch} onChange={(e) => setBranch(e.target.value)}>
                <option value="">{s.scope === 'all' ? 'All branches' : 'Selected branch'}</option>
                {s.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Search"><input type="search" placeholder="Name or member number" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        </div>
      </Card>
      <div style={{ height: 16 }} />
      <Load loading={d.loading} error={d.error} hasData={!!d.data}>
        {x && (
          <div className="stack">
            <div className="grid cols-4">
              <Stat label="Active plans" value={x.active} hint={x.paused ? `${x.paused} paused` : undefined} />
              <Stat label="Expected per month" value={kes(x.expectedPerMonth)} />
              <Stat label="Collected this month" value={kes(x.collectedThisMonth)} hint={`${x.completedThisMonth} gift${x.completedThisMonth === 1 ? '' : 's'}`} tone="good" />
              <Stat label="Missed this month" value={x.missedThisMonth} tone={x.missedThisMonth > 0 ? 'bad' : undefined} />
            </div>
            <Card title="Plans" action={<span className="tiny">{plans.length} shown</span>}>
              {plans.length === 0 ? <Empty>No regular gifts yet. Members set them up in the app under Give &gt; Give regularly.</Empty> : (
                <table className="rg-table">
                  <thead><tr><th>Member</th><th>Branch</th><th>Gift</th><th className="num">Amount</th><th>How often</th><th>Next prompt</th><th className="num">Given</th><th className="num">Missed</th><th>Status</th></tr></thead>
                  <tbody>
                    {plans.map((p) => {
                      const st = STATUS[p.status] ?? { text: p.status, tone: 'muted' as const };
                      return (
                        <tr key={p.id}>
                          <td data-l="Member"><span><b>{p.member}</b><span className="tiny rg-num"> {p.memberNumber}</span></span></td>
                          <td data-l="Branch">{p.branch}</td>
                          <td data-l="Gift">{cap(p.purposeLabel)}</td>
                          <td data-l="Amount" className="num">{kes(p.amount)}</td>
                          <td data-l="How often">{cap(p.frequency)}</td>
                          <td data-l="Next prompt">{p.status === 'active' ? when(p.nextRunAt) : '-'}</td>
                          <td data-l="Given" className="num">{p.completed}</td>
                          <td data-l="Missed" className={'num' + (p.missed > 0 ? ' rg-miss' : '')}>{p.missed}</td>
                          <td data-l="Status"><Badge tone={st.tone}>{st.text}</Badge></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Card>
          </div>
        )}
      </Load>
    </>
  );
}
