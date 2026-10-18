import { useEffect, useState } from 'react';
import { API_URL, Badge, Button, Card, Empty, ErrorNote, Field, Note, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Load, PageHead } from './bits';
import { Modal } from './MemberForm';
import './pastoral.css';

const STATUSES: { key: string; label: string; tone: 'info' | 'warn' | 'good' | 'muted' }[] = [
  { key: 'new', label: 'New', tone: 'info' }, { key: 'under_review', label: 'Under review', tone: 'warn' },
  { key: 'done', label: 'Done', tone: 'good' }, { key: 'not_possible', label: 'Not possible', tone: 'muted' },
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
    <Modal title="Reply to suggestion" onClose={onClose}>
      <div className="stack">
        <div className="pa-card">
          <div className="pa-body">{s.body}</div>
          <div className="pa-meta"><Badge tone="info">{s.categoryLabel}</Badge><span>{s.author}</span><span>{when(s.createdAt)}</span></div>
        </div>
        {s.anonymous && <Note>Anonymous suggestions cannot be traced. Your reply still reaches the person who sent it.</Note>}
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>{STATUSES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select>
        </Field>
        <Field label="Your reply" hint={`${response.length}/500${needsReply ? '. Needed for this status.' : ''}`}>
          <textarea rows={4} maxLength={500} value={response} onChange={(e) => setResponse(e.target.value)} />
        </Field>
        <label className="pa-switch"><input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} /><span>Share this answer with the church as "You said, we did"<span className="tiny" style={{ display: 'block' }}>Needs a reply. The sender's name is not shown.</span></span></label>
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row"><Button disabled={busy} onClick={save}>{busy ? 'Saving...' : 'Save'}</Button><Button kind="ghost" onClick={onClose}>Back</Button></div>
      </div>
    </Modal>
  );
}

export function Suggestions() {
  const sess = useSession();
  const toast = useToast();
  const [status, setStatus] = useState('');
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

  return (
    <div>
      <PageHead title="Suggestions" sub="Ideas and concerns from members. Reply, and share what you did about it." action={<Button kind="ghost" onClick={csv} disabled={busy}>{busy ? 'Preparing...' : 'Download CSV'}</Button>} />
      {err && <Note tone="bad">{err}</Note>}
      <div className="pa-strip">
        {STATUSES.map((x) => (
          <button type="button" key={x.key} className={`pa-sum ${status === x.key ? 'on' : ''}`} aria-pressed={status === x.key} onClick={() => setStatus(status === x.key ? '' : x.key)}>
            <b>{sum ? sum[x.key] ?? 0 : '-'}</b><span>{x.label}</span>
          </button>
        ))}
      </div>
      <Card>
        <div className="pa-filters">
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{STATUSES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select>
          </Field>
          <Field label="Topic">
            <select value={category} onChange={(e) => setCategory(e.target.value)}><option value="">All topics</option>{(d.data?.categories ?? []).map((c: any) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
          </Field>
          {sess.branches.length > 1 && (
            <Field label="Branch">
              <select value={branch} onChange={(e) => setBranch(e.target.value)}><option value="">{sess.scope === 'all' ? 'All branches' : 'Selected branch'}</option>{sess.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
            </Field>
          )}
          <Field label="Search"><input type="search" placeholder="Words in the suggestion" value={search} onChange={(e) => setSearch(e.target.value)} /></Field>
        </div>
      </Card>
      <div style={{ height: 14 }} />
      <Load loading={d.loading} error={d.error} hasData={!!d.data}>
        {rows.length === 0 ? <Empty>No suggestions match these choices.</Empty> : (
          <div className="pa-list">
            {rows.map((r) => {
              const st = STATUSES.find((x) => x.key === r.status);
              return (
                <article className="pa-card" key={r.id}>
                  <div className="pa-meta">
                    <Badge tone="info">{r.categoryLabel}</Badge>
                    <Badge tone={st?.tone ?? 'muted'}>{r.statusLabel}</Badge>
                    {r.published && <Badge tone="good">Shared: You said, we did</Badge>}
                    <span className={r.anonymous ? 'pa-lock pa-muted' : ''}>{r.anonymous && <Lock />}{r.author}</span>
                    {r.branch && <span>{r.branch}</span>}
                    <span>{when(r.createdAt)}</span>
                  </div>
                  <div className="pa-body">{r.body}</div>
                  {r.response && <div className="pa-reply"><span className="tiny">Your reply</span><br />{r.response}</div>}
                  <div className="row"><Button small kind={r.response ? 'ghost' : 'primary'} onClick={() => setEdit(r)}>{r.response ? 'Edit reply' : 'Reply'}</Button></div>
                </article>
              );
            })}
          </div>
        )}
      </Load>
      {edit && <Editor s={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); toast.show('Saved'); d.reload(); }} />}
      {toast.node}
    </div>
  );
}
