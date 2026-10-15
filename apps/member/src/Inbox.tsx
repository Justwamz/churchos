import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorNote, Note, Spinner, shortDate } from '@churchos/ui';
import { api } from './api';

export type NotifState = { data?: any; error?: string; loading: boolean; reload: () => void };

const KIND: Record<string, { label: string; tone: 'info' | 'good' | 'warn' | 'muted' }> = {
  message: { label: 'Message', tone: 'info' },
  receipt: { label: 'Receipt', tone: 'good' },
  reminder: { label: 'Reminder', tone: 'warn' },
  announcement: { label: 'Announcement', tone: 'muted' },
};
const kindChip = (k: string) => {
  const x = KIND[k] ?? (k === 'giving' || k === 'gift' ? KIND.receipt : KIND.message);
  return <Badge tone={x.tone}>{x.label}</Badge>;
};

async function markAllRead(reload: () => void, setBusy: (b: boolean) => void) {
  setBusy(true);
  try { await api.post('/me/notifications/read', {}); } catch { /* the refresh shows the truth */ }
  setBusy(false);
  reload();
}

export function NotificationsPreview({ n, go }: { n: NotifState; go: () => void }) {
  const rows: any[] = (n.data?.rows ?? []).slice(0, 3);
  const unread = Number(n.data?.unread ?? 0);
  return (
    <Card title="Inbox" action={<Button kind="ghost" small onClick={go}>See all</Button>}>
      {n.loading && !n.data ? <Spinner /> : n.error && !n.data ? <ErrorNote>{n.error}</ErrorNote> : !rows.length ? (
        <Empty>Nothing here yet. Messages from your church will appear here.</Empty>
      ) : (
        <div className="stack">
          {unread > 0 && <div><Badge tone="warn">{unread} unread</Badge></div>}
          <ul className="list">
            {rows.map((r) => (
              <li key={r.id} className={r.read ? '' : 'notif-unread'}>
                <div className="row"><strong>{r.title}</strong><span className="tiny">{shortDate(r.created_at)}</span></div>
                <div className="muted clamp2">{r.body}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export function Inbox({ n, online }: { n: NotifState; online: boolean }) {
  const [busy, setBusy] = useState(false);
  const rows: any[] = n.data?.rows ?? [];
  const unread = Number(n.data?.unread ?? 0);
  return (
    <div className="stack">
      <h1>Inbox</h1>
      {!online && <Note tone="warn">You are offline. Your messages will refresh when you are connected again.</Note>}
      {n.loading && !n.data ? <Spinner /> : n.error && !n.data ? (
        <div className="stack"><ErrorNote>{n.error}</ErrorNote><Button kind="ghost" onClick={n.reload}>Try again</Button></div>
      ) : !rows.length ? (
        <Card><Empty>Nothing here yet. Messages from your church will appear here.</Empty></Card>
      ) : (
        <Card>
          <div className="stack">
            <div className="row">
              {unread > 0 ? <Badge tone="warn">{unread} unread</Badge> : <span className="tiny">All caught up</span>}
              <Button kind="ghost" small disabled={busy || unread === 0 || !online} onClick={() => markAllRead(n.reload, setBusy)}>Mark all as read</Button>
            </div>
            <ul className="list">
              {rows.map((r) => (
                <li key={r.id} className={r.read ? '' : 'notif-unread'}>
                  <div className="row"><span>{kindChip(r.kind)}</span><span className="tiny">{shortDate(r.created_at)}</span></div>
                  <strong>{r.title}</strong>
                  <div className="muted" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{r.body}</div>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      )}
    </div>
  );
}
