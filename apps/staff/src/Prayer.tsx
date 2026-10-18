import { useState, type ReactNode } from 'react';
import { Badge, Button, Empty, ErrorNote, Field, Note, useAsync, useToast } from '@churchos/ui';
import { api, friendly } from './session';
import { Load, PageHead } from './bits';
import { Modal } from './MemberForm';
import './pastoral.css';

const TABS = [
  { key: 'team', label: 'Prayer team only', q: 'status=open&audience=team' },
  { key: 'shared', label: 'Shared with the church', q: 'status=open' },
  { key: 'answered', label: 'Answered', q: 'status=answered' },
  { key: 'hidden', label: 'Hidden', q: 'status=hidden' },
];
const EMPTY: Record<string, string> = {
  team: 'No prayer requests for the team right now.', shared: 'Nothing shared with the church to look at.',
  answered: 'No answered prayers yet.', hidden: 'No hidden requests.',
};
const when = (iso: string) => new Date(iso).toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', year: 'numeric' });
const audienceText = (r: any) => (r.audience === 'team' ? 'Team only' : r.audience === 'group' ? r.groupName || 'Group' : r.audience === 'branch' ? 'Branch' : 'Church');

function Ask({ title, children, onClose, run, button, kind }: { title: string; children?: ReactNode; onClose: () => void; run: (text: string) => Promise<void>; button: string; kind: 'answer' | 'hide' }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    if (kind === 'hide' && !text.trim()) return setErr('Please write a reason.');
    setBusy(true); setErr('');
    try { await run(text.trim()); } catch (e: any) { setErr(friendly(e?.message)); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack">
        {children}
        <Field label={kind === 'hide' ? 'Reason' : 'A note (optional)'} hint={kind === 'hide' ? 'The author is told this reason.' : 'Shown with the request, for example how God answered.'}>
          <textarea rows={3} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="row"><Button kind={kind === 'hide' ? 'danger' : 'primary'} disabled={busy} onClick={go}>{busy ? 'Saving...' : button}</Button><Button kind="ghost" onClick={onClose}>Back</Button></div>
      </div>
    </Modal>
  );
}

export function Prayer() {
  const toast = useToast();
  const [tab, setTab] = useState('team');
  const t = TABS.find((x) => x.key === tab)!;
  const d = useAsync<any>(() => api.get(`/prayer?${t.q}`), [tab]);
  const [ask, setAsk] = useState<{ r: any; kind: 'answer' | 'hide' } | null>(null);
  const all: any[] = d.data?.requests ?? [];
  const rows = tab === 'shared' ? all.filter((r) => r.audience !== 'team') : all;

  const restore = async (r: any) => {
    try { await api.post(`/prayer/${r.id}/hide`, { restore: true }); toast.show('Showing again'); d.reload(); } catch (e: any) { toast.show(friendly(e?.message), 'bad'); }
  };

  return (
    <div>
      <PageHead title="Prayer" sub="Requests from members, for the prayer team to look after." />
      <Note tone="warn">Requests marked Team only are private to the prayer team. Please do not share them.</Note>
      <div style={{ height: 14 }} />
      <div className="chips pa-tabs" role="group" aria-label="Which requests">
        {TABS.map((x) => <button type="button" key={x.key} className={`chip ${tab === x.key ? 'on' : ''}`} aria-pressed={tab === x.key} onClick={() => setTab(x.key)}>{x.label}</button>)}
      </div>
      <Load loading={d.loading} error={d.error} hasData={!!d.data}>
        {rows.length === 0 ? <Empty>{EMPTY[tab]}</Empty> : (
          <div className="pa-list">
            {rows.map((r) => (
              <article className="pa-card" key={r.id}>
                <div className="pa-body">{r.body}</div>
                <div className="pa-meta">
                  <Badge tone={r.audience === 'team' ? 'warn' : 'info'}>{audienceText(r)}</Badge>
                  <span className={r.anonymous || r.author === 'A member' ? 'pa-muted' : ''}>{r.author}</span>
                  {r.branch && <span>{r.branch}</span>}
                  <span>{r.prayers} {r.prayers === 1 ? 'person' : 'people'} prayed</span>
                  <span>{when(r.createdAt)}</span>
                  {r.status === 'answered' && <Badge tone="good">Answered</Badge>}
                  {r.status === 'hidden' && <Badge tone="muted">Hidden</Badge>}
                </div>
                {r.answeredNote && <div className="pa-reply">{r.answeredNote}</div>}
                <div className="row">
                  {r.status === 'open' && <><Button small onClick={() => setAsk({ r, kind: 'answer' })}>Mark answered</Button><Button small kind="ghost" onClick={() => setAsk({ r, kind: 'hide' })}>Hide</Button></>}
                  {r.status === 'answered' && <Button small kind="ghost" onClick={() => setAsk({ r, kind: 'hide' })}>Hide</Button>}
                  {r.status === 'hidden' && <Button small kind="ghost" onClick={() => restore(r)}>Show again</Button>}
                </div>
              </article>
            ))}
          </div>
        )}
      </Load>
      {ask?.kind === 'answer' && (
        <Ask kind="answer" title="Mark as answered" button="Mark answered" onClose={() => setAsk(null)}
          run={async (note) => { await api.post(`/prayer/${ask.r.id}/answer`, note ? { note } : {}); setAsk(null); toast.show('Marked as answered'); d.reload(); }} />
      )}
      {ask?.kind === 'hide' && (
        <Ask kind="hide" title="Hide this request?" button="Hide request" onClose={() => setAsk(null)}
          run={async (reason) => { await api.post(`/prayer/${ask.r.id}/hide`, { reason }); setAsk(null); toast.show('Hidden'); d.reload(); }}>
          <Note>The author is told and still sees it. Other members will not.</Note>
        </Ask>
      )}
      {toast.node}
    </div>
  );
}
