import { useState } from 'react';
import { Button, ErrorNote, Note, shortDate } from '@churchos/ui';
import { api } from './api';
import { Icon, Skeleton } from './ui';

export type NotifState = { data?: any; error?: string; loading: boolean; reload: () => void; setData?: (d: any) => void };

const KIND_LABEL: Record<string, string> = { message: 'Message', receipt: 'Receipt', reminder: 'Reminder', announcement: 'Announcement' };
const kindOf = (k: string) => (k === 'giving' || k === 'gift' ? 'receipt' : k);

async function markAllRead(reload: () => void, setBusy: (b: boolean) => void) {
  setBusy(true);
  try { await api.post('/me/notifications/read', {}); } catch { /* the refresh shows the truth */ }
  setBusy(false);
  reload();
}

function Row({ r, compact }: { r: any; compact?: boolean }) {
  const kind = kindOf(r.kind);
  const receipt = kind === 'receipt';
  return (
    <li className={`msg ${r.read ? '' : 'unread'} ${receipt ? 'receipt-row' : ''}`}>
      <span className={`msg-ico ${receipt ? 'good' : ''} ${kind === 'announcement' ? 'announce' : ''}`} aria-hidden="true"><Icon name={receipt ? 'check' : kind === 'reminder' ? 'bell' : kind === 'announcement' ? 'megaphone' : 'chat'} size={20} /></span>
      <div className="msg-main">
        <div className="msg-top">
          <span className="msg-kind">{KIND_LABEL[kind] ?? 'Message'}</span>
          <span className="msg-date">{shortDate(r.created_at)}</span>
          {!r.read && <i className="dot" aria-label="Unread" />}
        </div>
        <strong className="msg-title">{r.title}</strong>
        {r.for_name && <span className="chip-for">For {r.for_name}</span>}
        <div className={`msg-body ${compact ? 'clamp2' : ''}`}>{r.body}</div>
      </div>
    </li>
  );
}

export function Inbox({ n, online }: { n: NotifState; online: boolean }) {
  const [busy, setBusy] = useState(false);
  const rows: any[] = n.data?.rows ?? [];
  const unread = Number(n.data?.unread ?? 0);
  return (
    <div className="stack">
      {!online && <Note tone="warn">You are offline. Your messages will refresh when you are connected again.</Note>}
      {n.loading && !n.data ? <div className="card"><Skeleton lines={4} /></div> : n.error && !n.data ? (
        <div className="stack"><ErrorNote>{n.error}</ErrorNote><Button kind="ghost" onClick={n.reload}>Try again</Button></div>
      ) : !rows.length ? (
        <div className="empty-state"><Icon name="chat" size={40} /><strong>No messages yet</strong><span>Messages and receipts from your church will appear here.</span></div>
      ) : (
        <>
          <div className="inbox-bar">
            {unread > 0 ? <span className="badge warn">{unread} unread</span> : <span className="tiny">All caught up</span>}
            <button type="button" className="link-btn" disabled={busy || unread === 0 || !online} onClick={() => markAllRead(n.reload, setBusy)}>Mark all read</button>
          </div>
          <ul className="msg-list">{rows.map((r) => <Row key={r.id} r={r} />)}</ul>
        </>
      )}
    </div>
  );
}
