import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Button, ErrorNote, Note, shortDate } from '@churchos/ui';
import { api } from './api';
import { parseLink } from './links';
import { Icon, Skeleton } from './ui';

export type NotifState = { data?: any; error?: string; loading: boolean; reload: () => void; setData?: (d: any) => void };

/** Opens the screen a message link points at. Provided by the app shell (openLink in App.tsx). */
export const LinkCtx = createContext<(link: string) => void>(() => {});

export { parseLink };

const CTA: Record<string, string> = { tickets: 'View ticket', credit: 'See credit', bookings: 'Open booking', book: 'Open booking', prayer: 'Open prayer', suggestions: 'Open suggestions', shop: 'Open shop', kids: 'Open children', events: 'See events', notices: 'See notices', groups: 'Open groups', me: 'Open my profile', home: 'Open Home' };
export function ctaLabel(link?: string | null): string | null {
  const l = parseLink(link);
  if (!l) return null;
  if (l.page === 'give') return l.params.sub === 'history' ? 'Open giving history' : l.params.sub === 'pledges' ? 'Open pledges' : l.params.sub === 'regular' ? 'Open regular giving' : 'Open giving';
  return CTA[l.page] ?? 'Open';
}

/** Opens a message: marks it read, then jumps to its screen. */
export function useOpenMessage(reload: () => void) {
  const openLink = useContext(LinkCtx);
  return (r: any) => {
    if (!parseLink(r.link)) return;
    if (!r.read) api.post('/me/notifications/read', { ids: [r.id] }).then(reload, () => {});
    openLink(r.link);
  };
}

const KIND_LABEL: Record<string, string> = { message: 'Message', receipt: 'Receipt', reminder: 'Reminder', announcement: 'Announcement' };
const kindOf = (k: string) => (k === 'giving' || k === 'gift' ? 'receipt' : k);

async function markAllRead(reload: () => void, setBusy: (b: boolean) => void) {
  setBusy(true);
  try { await api.post('/me/notifications/read', {}); } catch { /* the refresh shows the truth */ }
  setBusy(false);
  reload();
}

function Row({ r, compact, onDelete, canDelete, onOpen }: { r: any; compact?: boolean; onDelete?: (id: string) => void; canDelete?: boolean; onOpen?: (r: any) => void }) {
  const cta = onOpen ? ctaLabel(r.link) : null;
  const kind = kindOf(r.kind);
  const receipt = kind === 'receipt';
  return (
    <li className={`msg ${r.read ? '' : 'unread'} ${receipt ? 'receipt-row' : ''} ${cta ? 'lnk-row' : ''}`}
      {...(cta ? { onClick: () => onOpen!(r), onKeyDown: (e: React.KeyboardEvent) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen!(r); } }, tabIndex: 0, 'aria-label': `${r.title}. ${cta}` } : {})}>
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
        {cta && <button type="button" className="lnk-cta" onClick={(e) => { e.stopPropagation(); onOpen!(r); }}>{cta}<Icon name="chev" size={16} /></button>}
      </div>
      {onDelete && (
        <button type="button" className="msg-del" aria-label={`Delete message: ${r.title}`} title="Delete" disabled={!canDelete} onClick={(e) => { e.stopPropagation(); onDelete(r.id); }}>
          <Icon name="trash" size={19} />
        </button>
      )}
    </li>
  );
}

export function Inbox({ n, online }: { n: NotifState; online: boolean }) {
  const openMsg = useOpenMessage(n.reload);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ ids: string[]; text: string } | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const all: any[] = n.data?.rows ?? [];
  const rows = all.filter((r) => !hidden.has(r.id));
  const unread = rows.filter((r) => !r.read).length;
  const readCount = rows.filter((r) => r.read).length;

  const done = (ids: string[], text: string) => {
    setHidden((h) => new Set([...h, ...ids]));
    setUndo({ ids, text });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setUndo(null), 8000);
    n.reload();
  };

  async function remove(ids: string[], text: string) {
    setErr(null);
    setBusy(true);
    try {
      const r = await api.post<{ deleted: number; ids: string[] }>('/me/notifications/delete', { ids });
      if (r.deleted) done(r.ids, text);
    } catch (e: any) { setErr(e?.message ?? 'We could not delete that. Please try again.'); }
    setBusy(false);
  }

  async function removeRead() {
    setErr(null);
    setBusy(true);
    try {
      const r = await api.post<{ deleted: number; ids: string[] }>('/me/notifications/delete-read', {});
      if (r.deleted) done(r.ids, `${r.deleted} read message${r.deleted === 1 ? '' : 's'} deleted`);
    } catch (e: any) { setErr(e?.message ?? 'We could not delete those. Please try again.'); }
    setBusy(false);
  }

  async function restore() {
    if (!undo) return;
    const ids = undo.ids;
    setUndo(null);
    try { await api.post('/me/notifications/restore', { ids }); } catch { /* the refresh shows the truth */ }
    setHidden((h) => { const x = new Set(h); ids.forEach((i) => x.delete(i)); return x; });
    n.reload();
  }

  return (
    <div className="stack">
      {!online && <Note tone="warn">You are offline. Your messages will refresh when you are connected again.</Note>}
      {err && <ErrorNote>{err}</ErrorNote>}
      {n.loading && !n.data ? <div className="card"><Skeleton lines={4} /></div> : n.error && !n.data ? (
        <div className="stack"><ErrorNote>{n.error}</ErrorNote><Button kind="ghost" onClick={n.reload}>Try again</Button></div>
      ) : !rows.length ? (
        <div className="empty-state"><Icon name="chat" size={40} /><strong>No messages</strong><span>Messages and receipts from your church will appear here.</span></div>
      ) : (
        <>
          <div className="inbox-bar">
            {unread > 0 ? <span className="badge warn">{unread} unread</span> : <span className="tiny">All caught up</span>}
            <span className="inbox-actions">
              <button type="button" className="link-btn" disabled={busy || unread === 0 || !online} onClick={() => markAllRead(n.reload, setBusy)}>Mark all read</button>
              <button type="button" className="link-btn danger" disabled={busy || readCount === 0 || !online} onClick={removeRead}>Delete read</button>
            </span>
          </div>
          <ul className="msg-list">{rows.map((r) => <Row key={r.id} r={r} onOpen={openMsg} canDelete={online && !busy} onDelete={(id) => remove([id], 'Message deleted')} />)}</ul>
          <p className="tiny" style={{ textAlign: 'center' }}>Deleting a message only removes it from your inbox. Your giving record and receipts are not affected.</p>
        </>
      )}
      {undo && (
        <div className="toast good" role="status" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {undo.text}
          <button type="button" className="btn small ghost" style={{ width: 'auto' }} onClick={restore}>Undo</button>
        </div>
      )}
    </div>
  );
}
