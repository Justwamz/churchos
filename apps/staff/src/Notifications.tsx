import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Empty, ErrorNote, Spinner } from '@churchos/ui';
import { api, friendly } from './session';
import { Icon } from './icons';
import { ctaLabel, parseLink, useOpenLink } from './links';

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
}

/** Staff messages only: tasks for the staff app. A person's own messages live in the member app. */
const APP = '?app=staff';

/** The unread count is shared so the phone Menu tab can show the same number as the bell, and open the same list. */
let sharedUnread = 0;
const UNREAD_EVENT = 'churchos:unread';
const OPEN_EVENT = 'churchos:open-bell';
export const openBell = () => window.dispatchEvent(new Event(OPEN_EVENT));
export function useUnread(): number {
  const [n, setN] = useState(sharedUnread);
  useEffect(() => {
    const on = () => setN(sharedUnread);
    window.addEventListener(UNREAD_EVENT, on);
    return () => window.removeEventListener(UNREAD_EVENT, on);
  }, []);
  return n;
}
const setUnread = (n: number) => { if (n !== sharedUnread) { sharedUnread = n; window.dispatchEvent(new Event(UNREAD_EVENT)); } };

const TrashIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3" /></svg>
);

const CSS = `
.bell-wrap { position: relative; display: inline-block; }
.bell-btn { position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; min-height: 42px; min-width: 42px; cursor: pointer; font-size: 18px; color: var(--ink); }
.bell-count { position: absolute; top: -6px; right: -6px; background: var(--bad); color: #fff; border-radius: 999px; font-size: 11px; font-weight: 700; padding: 1px 6px; min-width: 18px; }
.bell-panel { position: absolute; right: 0; top: 48px; width: 380px; max-height: 70vh; overflow-y: auto; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); z-index: 60; padding: 12px; }
.bell-item { display: flex; gap: 8px; align-items: flex-start; padding: 10px 12px; border-radius: 10px; border: 1px solid transparent; margin-bottom: 6px; }
.bell-item.unread { background: var(--accent-tint); border-color: var(--line); }
.bell-item.link { cursor: pointer; }
.bell-item.link:hover { border-color: var(--accent); }
.bell-main { flex: 1; min-width: 0; text-align: left; }
button.bell-link { display: block; width: 100%; background: none; border: 0; padding: 0; font: inherit; color: inherit; text-align: left; cursor: pointer; border-radius: 8px; }
.bell-link:focus-visible, .bell-del:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.bell-cta { margin-top: 8px; }
.bell-del { flex: none; background: none; border: 0; color: var(--muted); cursor: pointer; padding: 6px; border-radius: 8px; min-width: 34px; min-height: 34px; }
.bell-del:hover { color: var(--bad); }
.bell-undo { position: sticky; top: 0; z-index: 1; margin-bottom: 8px; display: flex; gap: 12px; align-items: center; justify-content: space-between; background: var(--ink); color: var(--surface); border-radius: 10px; padding: 8px 12px; font-size: 14px; }
.bell-undo button { background: transparent; border: 1px solid currentColor; color: inherit; border-radius: 8px; padding: 4px 10px; cursor: pointer; font: inherit; }
@media (max-width: 640px) { .bell-panel { position: fixed; left: 0; right: 0; top: 0; bottom: auto; width: auto; max-height: 85vh; border-radius: 0 0 16px 16px; } }
`;

export function Notifications() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ unread: number; rows: any[] } | null>(null);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [undo, setUndo] = useState<{ ids: string[]; text: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const openLink = useOpenLink();

  const load = useCallback(async () => {
    try { const d = await api.get('/me/notifications' + APP); setData(d); setUnread(d.unread ?? 0); setError(''); } catch (e: any) { setError(friendly(e.message)); }
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30_000);
    const on = () => { setOpen(true); load(); };
    window.addEventListener(OPEN_EVENT, on);
    return () => { clearInterval(t); window.removeEventListener(OPEN_EVENT, on); if (timer.current) clearTimeout(timer.current); };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const markAll = async () => {
    try { await api.post('/me/notifications/read' + APP, {}); await load(); } catch (e: any) { setError(friendly(e.message)); }
  };

  const deleted = (ids: string[], text: string) => {
    setHidden((h) => new Set([...h, ...ids]));
    setUndo({ ids, text });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setUndo(null), 8000);
    load();
  };
  const remove = async (ids: string[], text: string) => {
    try {
      const r = await api.post('/me/notifications/delete', { ids });
      if (r.deleted) deleted(r.ids, text);
    } catch (e: any) { setError(friendly(e.message)); }
  };
  const removeRead = async () => {
    try {
      const r = await api.post('/me/notifications/delete-read', {});
      if (r.deleted) deleted(r.ids, `${r.deleted} read message${r.deleted === 1 ? '' : 's'} deleted`);
    } catch (e: any) { setError(friendly(e.message)); }
  };
  const restore = async () => {
    if (!undo) return;
    const ids = undo.ids;
    setUndo(null);
    try { await api.post('/me/notifications/restore', { ids }); } catch { /* the refresh shows the truth */ }
    setHidden((h) => { const x = new Set(h); ids.forEach((i) => x.delete(i)); return x; });
    load();
  };

  // Opening a message's page marks just that message read.
  const go = (n: any) => { setOpen(false); if (!n.read) api.post('/me/notifications/read' + APP, { ids: [n.id] }).then(load).catch(() => { /* the list refreshes later */ }); openLink(n.link); };

  const rows = (data?.rows ?? []).filter((n) => !hidden.has(n.id));
  const unread = rows.filter((n) => !n.read).length;
  const readCount = rows.length - unread;

  return (
    <div className="bell-wrap" ref={box}>
      <style>{CSS}</style>
      <button type="button" className="bell-btn" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} aria-expanded={open} onClick={() => { setOpen((v) => !v); load(); }}>
        <Icon name="bell" size={20} />
        {unread > 0 && <span className="bell-count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="bell-panel" role="dialog" aria-label="Notifications">
          <div className="row between" style={{ marginBottom: 8 }}>
            <b>Notifications</b>
            <div className="row" style={{ gap: 6 }}>
              {unread > 0 && <Button kind="ghost" small onClick={markAll}>Mark all as read</Button>}
              {readCount > 0 && <Button kind="ghost" small onClick={removeRead}>Delete read</Button>}
              <Button kind="ghost" small onClick={() => setOpen(false)}>Close</Button>
            </div>
          </div>
          {error && <ErrorNote>{error}</ErrorNote>}
          {undo && (
            <div className="bell-undo" role="status">{undo.text}<button type="button" onClick={restore}>Undo</button></div>
          )}
          {!loaded && <Spinner />}
          {loaded && data && rows.length === 0 && <Empty>You are all caught up</Empty>}
          {rows.map((n) => {
            const hasLink = !!parseLink(n.link);
            const inner = (
              <>
                <div style={{ fontWeight: n.read ? 500 : 700 }}>{n.title}</div>
                {n.body && <div className="muted" style={{ fontSize: 14 }}>{n.body}</div>}
                <div className="tiny">{ago(n.created_at)}</div>
              </>
            );
            return (
              <div key={n.id} className={`bell-item ${n.read ? '' : 'unread'} ${hasLink ? 'link' : ''}`} onClick={hasLink ? () => go(n) : undefined}>
                <div className="bell-main">
                  {hasLink
                    ? <button type="button" className="bell-link" onClick={(e) => { e.stopPropagation(); go(n); }}>{inner}</button>
                    : inner}
                  {hasLink && <div className="bell-cta" onClick={(e) => e.stopPropagation()}><Button small onClick={() => go(n)}>{ctaLabel(n.link, n.kind)}</Button></div>}
                </div>
                <button type="button" className="bell-del" aria-label={`Delete notification: ${n.title}`} title="Delete" onClick={(e) => { e.stopPropagation(); remove([n.id], 'Notification deleted'); }}><TrashIcon /></button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
