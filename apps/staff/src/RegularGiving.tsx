import { useState } from 'react';
import { API_URL, Button, Note, kes, useAsync } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Card, EmptyState, PageHeader, Section, Stat, StatTiles, StatusChip, Toolbar } from './ui';
import { Loaded } from './money-bits';
import './regular-giving.css';

const when = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '-';
const STATUS: Record<string, { text: string; tone: 'done' | 'wait' | 'bad' | 'off' }> = {
  active: { text: 'Active', tone: 'done' }, paused: { text: 'Paused', tone: 'wait' }, cancelled: { text: 'Cancelled', tone: 'off' }, ended: { text: 'Ended', tone: 'off' },
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
      <PageHeader
        title="Regular giving"
        subtitle="Gifts members have set up to repeat."
        actions={<Button kind="ghost" onClick={csv} disabled={busy}>{busy ? 'Preparing...' : 'Download CSV'}</Button>}
        tabs={[{ id: 'active', label: 'Active' }, { id: 'paused', label: 'Paused' }, { id: 'cancelled', label: 'Cancelled' }, { id: 'ended', label: 'Ended' }, { id: 'all', label: 'All' }]}
        tab={status || 'all'}
        onTab={(t) => setStatus(t === 'all' ? '' : t)}
      />
      {err && <Note tone="bad">{err}</Note>}
      <Loaded loading={d.loading} error={d.error} hasData={!!d.data} rows={4} height={92}>
        {x && (
          <>
            <StatTiles>
              <Stat label="Active plans" value={x.active} hint={x.paused ? `${x.paused} paused` : undefined} />
              <Stat label="Expected per month" value={kes(x.expectedPerMonth)} />
              <Stat label="Collected this month" value={kes(x.collectedThisMonth)} hint={`${x.completedThisMonth} gift${x.completedThisMonth === 1 ? '' : 's'}`} tone="good" />
              <Stat label="Missed this month" value={x.missedThisMonth} tone={x.missedThisMonth > 0 ? 'bad' : undefined} />
            </StatTiles>
            <Section title="Plans" hint="Members choose these in the app. A prompt goes to their phone on the day and they enter their PIN. Missed prompts are retried three times over two days.">
              <Toolbar>
                <input type="search" aria-label="Search" placeholder="Search by name or member number" value={q} onChange={(e) => setQ(e.target.value)} />
                {s.branches.length > 1 && (
                  <select aria-label="Branch" value={branch} onChange={(e) => setBranch(e.target.value)}>
                    <option value="">{s.scope === 'all' ? 'All branches' : 'Selected branch'}</option>
                    {s.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                )}
              </Toolbar>
              {plans.length === 0 ? <Card><EmptyState icon="heart" title="No regular gifts here" text="Members set them up in the app under Give, then Give regularly." /></Card> : (
                <Card pad={false} className="mn-wrap">
                  <div className="mn-scroll">
                    <table className="mn-table">
                      <thead><tr><th>Member</th><th>Branch</th><th>Gift</th><th className="num">Amount</th><th>How often</th><th>Next prompt</th><th className="num">Given</th><th className="num">Missed</th><th>Status</th></tr></thead>
                      <tbody>
                        {plans.map((p) => {
                          const st = STATUS[p.status] ?? { text: p.status, tone: 'off' as const };
                          return (
                            <tr key={p.id}>
                              <td className="mn-first" data-l="Member"><span><b>{p.member}</b><span className="mn-sub">{p.memberNumber}</span></span></td>
                              <td data-l="Branch">{p.branch}</td>
                              <td data-l="Gift">{cap(p.purposeLabel)}</td>
                              <td className="num" data-l="Amount">{kes(p.amount)}</td>
                              <td data-l="How often">{cap(p.frequency)}</td>
                              <td data-l="Next prompt">{p.status === 'active' ? when(p.nextRunAt) : '-'}</td>
                              <td className="num" data-l="Given">{p.completed}</td>
                              <td className={'num' + (p.missed > 0 ? ' mn-bad' : '')} data-l="Missed">{p.missed}</td>
                              <td data-l="Status"><StatusChip tone={st.tone}>{st.text}</StatusChip></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </Section>
          </>
        )}
      </Loaded>
    </>
  );
}
