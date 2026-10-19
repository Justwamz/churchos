import { useEffect, useState } from 'react';
import { API_URL, Button, ErrorNote, Field, Note, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Gate } from './MemberForm';
import { Card, EmptyState, PageHeader, SidePanel, Stat, StatTiles, StatusChip, Toolbar } from './ui';
import './pastoral.css';
import './people.css';

const STATUSES: { key: string; label: string; tone: 'info' | 'wait' | 'done' | 'off' }[] = [
  { key: 'new', label: 'New', tone: 'info' }, { key: 'under_review', label: 'Under review', tone: 'wait' },
  { key: 'done', label: 'Done', tone: 'done' }, { key: 'not_possible', label: 'Not possible', tone: 'off' },
];
const TABS: { id: string; label: string; status: string }[] = [
  { id: 'new', label: 'New', status: 'new' }, { id: 'progress', label: 'In progress', status: 'under_review' },
  { id: 'done', label: 'Done', status: 'done' }, { id: 'shared', label: 'You said, we did', status: '' }, { id: 'all', label: 'All', status: '' },
];
const when = (iso: string) => new Date(iso).toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', year: 'numeric' });
const Lock = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
);

function Editor({ s, onClose, onSaved }: { s: any; onClose: () => void; onSaved: () => void }) {
  const [status, setStatus] = useState<string>(s.status);
  const [response, setResponse] = useState<string>(s.response ?? '');
  const [publish, setPublish] = useState<boolean>(!!s.published);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const needsReply = status === 'done' || status === 'not_possible';
  const save = async () => {
    setErr('');
    if (needsReply && !response.trim()) return setErr('Please write a reply before marking this Done or Not possible.');
    if (publish && !response.trim()) return setErr('Write a reply before sharing it with the church.');
    setBusy(true);
    try {
      await api.post(`/suggestions/${s.id}`, { status, response: response.trim(), publish });
      onSaved();
    } catch (e: any) {
      setErr(e?.code === 'reply_required' ? 'Please write a reply first.' : e?.code === 'bad_status' ? 'That status cannot be used.' : friendly(e?.message));
      setBusy(false);
    }
  };
  return (
    <SidePanel title="Reply to suggestion" subtitle={`${s.categoryLabel} · ${when(s.createdAt)}`} onClose={onClose}
      footer={<><Button disabled={busy} onClick={save}>{busy ? 'Saving...' : 'Save reply'}</Button><Button kind="ghost" onClick={onClose}>Back</Button></>}>
      <div className="pp-stack">
        <div className="pp-reply" style={{ background: 'var(--off-tint)' }}>
          <small>{s.author}</small>
          <div className="pp-req-body" style={{ fontSize: 15 }}>{s.body}</div>
        </div>
        {s.anonymous && <Note>Anonymous suggestions cannot be traced. Your reply still reaches the person who sent it.</Note>}
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>{STATUSES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select>
        </Field>
        <Field label="Your reply" hint={`${response.length}/500${needsReply ? '. Needed for this status.' : ''}`}>
          <textarea rows={5} maxLength={500} value={response} onChange={(e) => setResponse(e.target.value)} />
        </Field>
        <label className="pp-switch"><input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} /><span>Share this answer with the church as "You said, we did"<span className="pp-tiny">Needs a reply. The sender's name is not shown.</span></span></label>
        {err && <ErrorNote>{err}</ErrorNote>}
      </div>
    </SidePanel>
  );
}

export function Suggestions() {
  const sess = useSession();
  const toast = useToast();
  const [tab, setTab] = useState('new');
  const status = TABS.find((x) => x.id === tab)?.status ?? '';
  const [category, setCategory] = useState('');
  const [branch, setBranch] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => { const t = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(t); }, [search]);
  const [edit, setEdit] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const query = (csv = false) => {
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    if (category) p.set('category', category);
    const b = branch || (sess.scope !== 'all' ? sess.scope : '');
    if (b) p.set('branchId', b);
    if (q) p.set('q', q);
    if (csv) p.set('csv', '1');
    const str = p.toString();
    return str ? '?' + str : '';
  };
  const key = query();
  const d = useAsync<any>(() => api.get('/suggestions' + key), [key]);
  const rows: any[] = d.data?.suggestions ?? [];
  const sum = d.data?.summary;

  const csv = async () => {
    setBusy(true); setErr('');
    try {
      const token = api.getToken();
      const res = await fetch(`${API_URL}/suggestions${query(true)}`, { headers: { 'x-churchos-app': 'staff', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
      if (!res.ok) throw new Error('Could not download the file. Try again.');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = 'suggestions.csv'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) { setErr(friendly(e?.message ?? 'Could not download the file.')); }
    setBusy(false);
  };

  const shown = tab === 'shared' ? rows.filter((r) => r.published) : rows;
  return (
    <div>
      <PageHeader title="Suggestions" subtitle="Ideas and concerns from members. Reply, and share what you did about it."
        actions={<Button kind="ghost" onClick={csv} disabled={busy}>{busy ? 'Preparing...' : 'Download CSV'}</Button>}
        tabs={TABS.map((x) => ({ id: x.id, label: x.label, badge: x.status && sum ? sum[x.status] || undefined : undefined }))} tab={tab} onTab={setTab} />
      {err && <Note tone="bad">{err}</Note>}
      <StatTiles>
        {STATUSES.map((x) => <Stat key={x.key} label={x.label} value={sum ? sum[x.key] ?? 0 : '-'} onClick={() => setTab(TABS.find((t) => t.status === x.key)?.id ?? 'all')} />)}
      </StatTiles>
      <div style={{ height: 24 }} />
      <Toolbar>
        <input type="search" aria-label="Search suggestions" placeholder="Search the words in a suggestion" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="Topic" value={category} onChange={(e) => setCategory(e.target.value)}><option value="">All topics</option>{(d.data?.categories ?? []).map((c: any) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
        {sess.branches.length > 1 && <select aria-label="Branch" value={branch} onChange={(e) => setBranch(e.target.value)}><option value="">{sess.scope === 'all' ? 'All branches' : 'Selected branch'}</option>{sess.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>}
      </Toolbar>
      <Gate loading={d.loading} error={d.error} hasData={!!d.data}>
        {shown.length === 0 ? <EmptyState icon="message" title="Nothing here" text={tab === 'new' ? 'New suggestions will show up here.' : 'No suggestions match these choices.'} /> : (
          <div className="pp-cards">
            {shown.map((r) => {
              const st = STATUSES.find((x) => x.key === r.status);
              return (
                <Card key={r.id}>
                  <div className="pp-req">
                    <div className="pp-req-head">
                      <div className="pp-row-flex"><StatusChip tone="info">{r.categoryLabel}</StatusChip><StatusChip tone={st?.tone ?? 'off'}>{r.statusLabel}</StatusChip>{r.published && <StatusChip tone="done">Shared: You said, we did</StatusChip>}</div>
                      <span className="pp-tiny">{when(r.createdAt)}</span>
                    </div>
                    <div className="pp-req-body">{r.body}</div>
                    <div className="pp-req-meta"><span className={r.anonymous ? 'pp-lock' : ''}>{r.anonymous && <Lock />}{r.author}</span>{r.branch && <span>{r.branch}</span>}</div>
                    {r.response && <div className="pp-reply"><small>Your reply</small>{r.response}</div>}
                    <div className="pp-row-flex"><Button kind={r.response ? 'ghost' : 'primary'} onClick={() => setEdit(r)}>{r.response ? 'Edit reply' : 'Reply'}</Button></div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </Gate>
      {edit && <Editor s={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); toast.show('Saved'); d.reload(); }} />}
      {toast.node}
    </div>
  );
}
