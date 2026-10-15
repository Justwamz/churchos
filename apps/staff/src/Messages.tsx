import { useState } from 'react';
import { Badge, Button, Card, Empty, kes, shortDate, useAsync } from '@churchos/ui';
import { api, useSession } from './session';
import { Load, PageHead } from './bits';
import { CHANNEL_NAME, describeAudience } from './audience';
import { ComposeMessage, composePreset } from './ComposeMessage';
import { CancelButton, MessageDetail } from './MessageDetail';
import { MessageStatus } from './MessageStatus';

const FILTERS: [string, string][] = [['', 'All'], ['scheduled', 'Scheduled'], ['sent', 'Sent'], ['cancelled', 'Cancelled']];

export function Messages() {
  const s = useSession();
  const [status, setStatus] = useState('');
  const canSend = s.can('messages.send');
  const [view, setView] = useState<'list' | 'compose' | { id: string }>(canSend && composePreset.groupId ? 'compose' : 'list');
  const d = useAsync<any[]>(() => api.get('/messages' + s.qs({ branch: undefined, status: status || undefined })), [s.qs(), status]);

  if (view === 'compose') return <><PageHead title="Messages" /><ComposeMessage onClose={() => setView('list')} onSent={() => d.reload()} /></>;
  if (typeof view === 'object') return <><PageHead title="Messages" /><MessageDetail id={view.id} onBack={() => setView('list')} onChanged={() => d.reload()} /></>;

  return (
    <>
      <PageHead title="Messages" sub="Send news to your people. ChurchOS delivers it." action={canSend && <Button onClick={() => setView('compose')}>New message</Button>} />
      <div className="stack">
        <div className="chips" role="group" aria-label="Filter">
          {FILTERS.map(([v, t]) => <button key={v} type="button" className={`chip ${status === v ? 'on' : ''}`} onClick={() => setStatus(v)}>{t}</button>)}
        </div>
        <Load loading={d.loading} error={d.error} hasData={!!d.data}>
          {d.data && (d.data.length === 0 ? <Card><Empty>{status ? 'No messages here.' : `No messages yet.${canSend ? ' Send your first one.' : ''}`}</Empty></Card> : (
            <div className="stack" style={{ gap: 10 }}>
              {d.data.map((m) => (
                <div key={m.id} role="button" tabIndex={0} className="card" style={{ cursor: 'pointer', padding: 14 }} onClick={() => setView({ id: m.id })} onKeyDown={(e) => e.key === 'Enter' && setView({ id: m.id })}>
                  <div className="row between" style={{ alignItems: 'flex-start' }}>
                    <b>{m.title}</b>
                    <MessageStatus m={m} />
                  </div>
                  <div className="chips" style={{ gap: 4, margin: '6px 0' }}>{(m.channels as string[]).map((c) => <Badge key={c}>{CHANNEL_NAME[c] ?? c}</Badge>)}</div>
                  <div className="tiny">{describeAudience(m.audience, s.branches, m.group_name)}</div>
                  <div className="tiny">{m.source === 'group_leader' ? 'Sent by a group leader' : `Sent by ${m.sender_name}`}{m.status === 'sent' && m.summary?.people != null && ` · ${m.summary.people.toLocaleString()} ${m.summary.people === 1 ? 'person' : 'people'}, cost ${kes(m.summary.cost ?? 0)}`}{m.status !== 'scheduled' && m.sent_at ? ` · ${shortDate(m.sent_at)}` : ''}</div>
                  {m.status === 'scheduled' && <div style={{ marginTop: 8 }}><CancelButton small id={m.id} onDone={() => d.reload()} /></div>}
                </div>
              ))}
            </div>
          ))}
        </Load>
      </div>
    </>
  );
}
