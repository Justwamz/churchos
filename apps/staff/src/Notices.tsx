import { useState } from 'react';
import { Button, Card, ErrorNote, Field, Note, shortDate, useAsync, useToast } from '@churchos/ui';
import { api, useSession } from './session';
import { Load } from './bits';
import { Card as UCard, EmptyState, PageHeader, Skeleton, StatusChip } from './ui';
import { Modal } from './MemberForm';
import { AudiencePicker, audienceValue, explainCommunity as explain, initialAudience, toIso, toLocal, type AudState } from './communityBits';
import { useAction } from './prefill';
import './community.css';
import './comm.css';

const STATE: Record<string, { text: string; tone: 'done' | 'info' | 'off' }> = {
  live: { text: 'Live', tone: 'done' }, scheduled: { text: 'Scheduled', tone: 'info' }, expired: { text: 'Ended', tone: 'off' }, archived: { text: 'Archived', tone: 'off' },
};
const TABS = [{ id: 'all', label: 'All' }, { id: 'live', label: 'Live' }, { id: 'scheduled', label: 'Scheduled' }, { id: 'ended', label: 'Ended' }];

function PhonePreview({ title, body, pinned }: { title: string; body: string; pinned: boolean }) {
  return (
    <div className="ph-frame" aria-label="Preview of the notice on the member app">
      <div className="ph-bar" />
      <div className="ph-card">
        {pinned && <div className="tiny">Pinned</div>}
        <b>{title || 'Your headline'}</b>
        <p>{body || 'Your text will show here.'}</p>
      </div>
    </div>
  );
}

function NoticeForm({ notice, onClose, onSaved }: { notice?: any; onClose: () => void; onSaved: (m: string) => void }) {
  const s = useSession();
  const [title, setTitle] = useState<string>(notice?.title ?? '');
  const [body, setBody] = useState<string>(notice?.body ?? '');
  const [aud, setAud] = useState<AudState>(initialAudience(notice?.audience, s.branches[0]?.id ?? ''));
  const [pinned, setPinned] = useState<boolean>(!!notice?.pinned);
  const scheduled = !!notice && notice.state === 'scheduled';
  const [from, setFrom] = useState<'now' | 'date'>(scheduled ? 'date' : 'now');
  const [start, setStart] = useState(scheduled ? toLocal(notice.publishAt) : '');
  const [until, setUntil] = useState<'never' | 'date'>(notice?.expiresAt ? 'date' : 'never');
  const [end, setEnd] = useState(toLocal(notice?.expiresAt));
  const [alert, setAlert] = useState<boolean>(notice ? !!notice.notify : true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setErr('');
    if (!title.trim()) return setErr('Write a headline.');
    if (!body.trim()) return setErr('Write the text of the notice.');
    if (aud.kind === 'group' && !aud.group) return setErr('Choose a group.');
    if (from === 'date' && !start) return setErr('Choose when it should start showing.');
    if (until === 'date' && !end) return setErr('Choose when it should stop showing.');
    if (from === 'date' && until === 'date' && Date.parse(`${end}:00+03:00`) <= Date.parse(`${start}:00+03:00`)) return setErr('It must stop showing after it starts.');
    const payload: any = {
      title: title.trim(), body: body.trim(), audience: audienceValue(aud), pinned, notify: alert,
      expiresAt: until === 'date' ? toIso(end) : null,
    };
    if (from === 'date') payload.publishAt = toIso(start);
    setBusy(true);
    try {
      if (notice) await api.put(`/notices/${notice.id}` + s.qs({ branch: undefined }), payload);
      else await api.post('/notices' + s.qs({ branch: undefined }), payload);
      onSaved(notice ? 'Changes saved' : from === 'date' ? 'Notice saved. It will show at the time you chose.' : 'Notice published');
    } catch (e: any) { setErr(explain(e)); setBusy(false); }
  };

  return (
    <div className="stack">
      <PageHeader title={notice ? 'Edit notice' : 'New notice'} subtitle="Members read it on the notice board in the member app." actions={<Button kind="ghost" onClick={onClose}>Cancel</Button>} />
      <div className="comm-split">
        <div className="stack">
          <Card title="1. Words">
            <div className="stack">
              <Field label="Headline" hint={`${title.length} of 80 characters`}><input maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
              <Field label="Text" hint={`${body.length} of 2000 characters`}><textarea rows={6} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
              <label className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> <b>Pin to the top</b></label>
            </div>
          </Card>
          <Card title="2. Who should see it?"><AudiencePicker name="ntaud" value={aud} onChange={setAud} /></Card>
          <Card title="3. When?">
            <div className="stack" style={{ gap: 10 }}>
              <Field label="Show from">
                <select value={from} onChange={(e) => setFrom(e.target.value as 'now' | 'date')}><option value="now">Now</option><option value="date">Choose a date and time</option></select>
              </Field>
              {from === 'date' && <Field label="Starts" hint="East Africa Time"><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></Field>}
              <Field label="Hide after">
                <select value={until} onChange={(e) => setUntil(e.target.value as 'never' | 'date')}><option value="never">Never</option><option value="date">Choose a date and time</option></select>
              </Field>
              {until === 'date' && <Field label="Ends" hint="East Africa Time"><input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>}
              <label className="row" style={{ gap: 8, flexWrap: 'nowrap', alignItems: 'flex-start' }}><input type="checkbox" checked={alert} onChange={(e) => setAlert(e.target.checked)} /> <b>Send members an alert in the app when it goes live (no SMS, no cost)</b></label>
            </div>
          </Card>
          {err && <ErrorNote>{err}</ErrorNote>}
          <div className="row"><Button disabled={busy} onClick={save}>{busy ? 'Saving...' : notice ? 'Save changes' : 'Publish notice'}</Button><Button kind="ghost" disabled={busy} onClick={onClose}>Cancel</Button></div>
        </div>
        <div className="stack"><b>How it looks on the member app</b><PhonePreview title={title} body={body} pinned={pinned} /></div>
      </div>
    </div>
  );
}

function when(n: any) {
  const from = n.state === 'scheduled' ? `Shows from ${shortDate(n.publishAt)}` : `Published ${shortDate(n.publishAt)}`;
  return `${from}. ${n.expiresAt ? `Hidden after ${shortDate(n.expiresAt)}` : 'No end date'}.`;
}

export function Notices() {
  const s = useSession();
  const toast = useToast();
  const list = useAsync<any[]>(() => api.get('/notices' + s.qs({ branch: undefined })), [s.grant.org.id]);
  const [mode, setMode] = useState<'list' | 'form'>('list');
  const [tab, setTab] = useState('all');
  const [editing, setEditing] = useState<any>(null);
  const [archiving, setArchiving] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const canManage = s.can('notices.manage');
  useAction('notices', (a) => { if (a === 'new' && canManage) { setEditing(null); setMode('form'); } });

  const archive = async () => {
    setBusy(true); setErr('');
    try { await api.post(`/notices/${archiving.id}/archive` + s.qs({ branch: undefined }), {}); setArchiving(null); toast.show('Notice archived'); list.reload(); }
    catch (e: any) { setErr(explain(e)); }
    setBusy(false);
  };

  if (mode === 'form') {
    return (
      <div>
        <NoticeForm notice={editing} onClose={() => setMode('list')} onSaved={(m) => { setMode('list'); toast.show(m); list.reload(); }} />
        {toast.node}
      </div>
    );
  }
  const rows = (list.data ?? []).filter((n) => tab === 'all' || (tab === 'ended' ? n.state === 'expired' || n.state === 'archived' : n.state === tab));
  return (
    <div>
      <PageHeader title="Notices" subtitle="Messages that members read on the notice board in the member app." actions={canManage ? <Button onClick={() => { setEditing(null); setMode('form'); }}>New notice</Button> : undefined}
        tabs={TABS} tab={tab} onTab={setTab} />
      <Load loading={false} error={list.error} hasData={!!list.data}>
        {!list.data && !list.error && <Skeleton rows={3} height={110} />}
        {list.data && (rows.length === 0
          ? <UCard><EmptyState icon="communicate" title={tab === 'all' ? 'No notices yet' : 'Nothing here'} text={tab === 'all' ? (canManage ? 'Publish your first notice for the member app.' : 'Notices for your church will show here.') : 'Try another tab.'}
              action={tab === 'all' && canManage ? <Button onClick={() => { setEditing(null); setMode('form'); }}>New notice</Button> : undefined} /></UCard>
          : <div className="comm-list">{rows.map((n) => {
            const st = STATE[n.state] ?? { text: n.state, tone: 'off' as const };
            return (
              <section key={n.id} className="comm-item" style={{ cursor: 'default' }}>
                <div className="comm-item-top">
                  <b>{n.title}</b>
                  <div className="comm-chips">{n.pinned && <StatusChip tone="wait">Pinned</StatusChip>}<StatusChip tone={st.tone}>{st.text}</StatusChip></div>
                </div>
                <div className="muted" style={{ fontSize: 14, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{n.body.length > 240 ? `${n.body.slice(0, 240)}...` : n.body}</div>
                <div className="tiny">Shown to: {n.audienceLabel}. {when(n)}{n.createdBy ? ` By ${n.createdBy}.` : ''}</div>
                {canManage && n.state !== 'archived' && (
                  <div className="row"><Button small kind="ghost" onClick={() => { setEditing(n); setMode('form'); }}>Edit</Button><Button small kind="ghost" onClick={() => { setErr(''); setArchiving(n); }}>Archive</Button></div>
                )}
              </section>
            );
          })}</div>)}
      </Load>
      {archiving && (
        <Modal title="Archive this notice?" onClose={() => setArchiving(null)}>
          <div className="stack">
            <Note>Members will no longer see "{archiving.title}". You cannot bring it back, but you can publish a new one.</Note>
            {err && <ErrorNote>{err}</ErrorNote>}
            <div className="row"><Button kind="danger" disabled={busy} onClick={archive}>{busy ? 'Archiving...' : 'Yes, archive it'}</Button><Button kind="ghost" onClick={() => setArchiving(null)}>Keep it</Button></div>
          </div>
        </Modal>
      )}
      {toast.node}
    </div>
  );
}
