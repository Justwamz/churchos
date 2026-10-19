import { useState } from 'react';
import { Button, kes, shortDate, useAsync } from '@churchos/ui';
import { api, useSession } from './session';
import { Load } from './bits';
import { CHANNEL_NAME, describeAudience } from './audience';
import { ComposeMessage, composePreset } from './ComposeMessage';
import { CancelButton, MessageDetail } from './MessageDetail';
import { MessageStatus } from './MessageStatus';
import { useAction } from './prefill';
import { Card, EmptyState, PageHeader, Skeleton, StatusChip } from './ui';
import './comm.css';

const FILTERS: [string, string][] = [['', 'All'], ['scheduled', 'Scheduled'], ['sent', 'Sent'], ['cancelled', 'Cancelled']];

export function Messages() {
  const s = useSession();
  const [status, setStatus] = useState('');
  const canSend = s.can('messages.send');
  const [view, setView] = useState<'list' | 'compose' | { id: string }>(canSend && composePreset.groupId ? 'compose' : 'list');
  const d = useAsync<any[]>(() => api.get('/messages' + s.qs({ branch: undefined, status: status || undefined })), [s.qs(), status]);
  useAction('messages', (a) => { if (a === 'compose' && canSend) setView('compose'); });

  if (view === 'compose') return <><PageHeader title="New message" subtitle="Choose who it is for and ChurchOS delivers it." actions={<Button kind="ghost" onClick={() => setView('list')}>Cancel</Button>} /><ComposeMessage onClose={() => setView('list')} onSent={() => d.reload()} /></>;
  if (typeof view === 'object') return <><PageHeader title="Message" subtitle="What was sent and what happened." /><MessageDetail id={view.id} onBack={() => setView('list')} onChanged={() => d.reload()} /></>;

  return (
    <>
      <PageHeader title="Messages" subtitle="Send news to your people. ChurchOS delivers it."
        actions={canSend ? <Button onClick={() => setView('compose')}>New message</Button> : undefined}
        tabs={FILTERS.map(([id, label]) => ({ id, label }))} tab={status} onTab={setStatus} />
      <Load loading={false} error={d.error} hasData={!!d.data}>
        {!d.data && !d.error && <Skeleton rows={4} height={96} />}
        {d.data && (d.data.length === 0 ? (
          <Card><EmptyState icon="message" title={status ? 'No messages here' : 'No messages yet'} text={status ? 'Try another tab.' : canSend ? 'Send your first message to your members.' : 'Messages sent to your church will show here.'}
            action={!status && canSend ? <Button onClick={() => setView('compose')}>Send your first message</Button> : undefined} /></Card>
        ) : (
          <div className="comm-list">
            {d.data.map((m) => (
              <div key={m.id} role="button" tabIndex={0} className="comm-item" onClick={() => setView({ id: m.id })} onKeyDown={(e) => e.key === 'Enter' && setView({ id: m.id })}>
                <div className="comm-item-top">
                  <b>{m.title}</b>
                  <MessageStatus m={m} />
                </div>
                <div className="comm-chips">{(m.channels as string[]).map((c) => <StatusChip key={c} tone="off">{CHANNEL_NAME[c] ?? c}</StatusChip>)}</div>
                <div className="tiny">{describeAudience(m.audience, s.branches, m.group_name)}</div>
                <div className="tiny">{m.source === 'group_leader' ? 'Sent by a group leader' : `Sent by ${m.sender_name}`}{m.status === 'sent' && m.summary?.people != null && ` · ${m.summary.people.toLocaleString()} ${m.summary.people === 1 ? 'person' : 'people'}, cost ${kes(m.summary.cost ?? 0)}`}{m.status !== 'scheduled' && m.sent_at ? ` · ${shortDate(m.sent_at)}` : ''}</div>
                {m.status === 'scheduled' && <div style={{ marginTop: 8 }}><CancelButton small id={m.id} onDone={() => d.reload()} /></div>}
              </div>
            ))}
          </div>
        ))}
      </Load>
    </>
  );
}
