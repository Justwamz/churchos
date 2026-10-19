import { useState, type ReactNode } from 'react';
import { Button, ErrorNote, Field, Note, useAsync, useToast } from '@churchos/ui';
import { api, friendly } from './session';
import { Gate, Modal } from './MemberForm';
import { Card, EmptyState, PageHeader, StatusChip } from './ui';
import './pastoral.css';
import './people.css';

const TABS = [
  { key: 'team', label: 'Team', q: 'status=open&audience=team' },
  { key: 'group', label: 'Group', q: 'status=open' },
  { key: 'church', label: 'Church', q: 'status=open' },
  { key: 'answered', label: 'Answered', q: 'status=answered' },
  { key: 'hidden', label: 'Hidden', q: 'status=hidden' },
];
const EMPTY: Record<string, string> = {
  team: 'No prayer requests for the team right now.', group: 'No group prayer requests to look at.', church: 'Nothing shared with the church to look at.',
  answered: 'No answered prayers yet. When a prayer is answered it will be kept here.', hidden: 'No hidden requests.',
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
        <div className="pp-form-foot"><Button kind={kind === 'hide' ? 'danger' : 'primary'} disabled={busy} onClick={go}>{busy ? 'Saving...' : button}</Button><Button kind="ghost" onClick={onClose}>Back</Button></div>
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
  const rows = tab === 'group' ? all.filter((r) => r.audience === 'group') : tab === 'church' ? all.filter((r) => r.audience !== 'team' && r.audience !== 'group') : all;

  const restore = async (r: any) => {
    try { await api.post(`/prayer/${r.id}/hide`, { restore: true }); toast.show('Showing again'); d.reload(); } catch (e: any) { toast.show(friendly(e?.message), 'bad'); }
  };

  return (
    <div>
      <PageHeader title="Prayer" subtitle="Requests from members, for the prayer team to look after."
        tabs={TABS.map((x) => ({ id: x.key, label: x.label }))} tab={tab} onTab={setTab} />
      <Note tone="warn">Requests marked Team only are private to the prayer team. Please do not share them.</Note>
      <div style={{ height: 16 }} />
      <Gate loading={d.loading} error={d.error} hasData={!!d.data}>
        {rows.length === 0 ? <EmptyState icon="heart" title={EMPTY[tab]} /> : (
          <div className="pp-cards">
            {rows.map((r) => (
              <Card key={r.id}>
                <div className="pp-req">
                  <div className="pp-req-head">
                    <div className="pp-row-flex"><StatusChip tone={r.audience === 'team' ? 'wait' : 'info'}>{audienceText(r)}</StatusChip>
                      {r.status === 'answered' && <StatusChip tone="done">Answered</StatusChip>}{r.status === 'hidden' && <StatusChip tone="off">Hidden</StatusChip>}</div>
                    <span className="pp-tiny">{when(r.createdAt)}</span>
                  </div>
                  <div className="pp-req-body">{r.body}</div>
                  <div className="pp-req-meta">
                    <span className={r.anonymous || r.author === 'A member' ? 'pa-muted' : ''}>{r.author}</span>
                    {r.branch && <span>{r.branch}</span>}
                    <span>{r.prayers} {r.prayers === 1 ? 'person' : 'people'} prayed</span>
                  </div>
                  {r.answeredNote && <div className="pp-reply"><small>How it was answered</small>{r.answeredNote}</div>}
                  <div className="pp-row-flex">
                    {r.status === 'open' && <><Button onClick={() => setAsk({ r, kind: 'answer' })}>Mark answered</Button><Button kind="ghost" onClick={() => setAsk({ r, kind: 'hide' })}>Hide</Button></>}
                    {r.status === 'answered' && <Button kind="ghost" onClick={() => setAsk({ r, kind: 'hide' })}>Hide</Button>}
                    {r.status === 'hidden' && <Button kind="ghost" onClick={() => restore(r)}>Show again</Button>}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Gate>
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
