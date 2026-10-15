import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Empty, ErrorNote, Spinner } from '@churchos/ui';
import { api, friendly } from './session';

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

const CSS = `
.bell-wrap { position: relative; display: inline-block; }
.bell-btn { position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; min-height: 42px; min-width: 42px; cursor: pointer; font-size: 18px; color: var(--ink); }
.bell-count { position: absolute; top: -6px; right: -6px; background: var(--bad); color: #fff; border-radius: 999px; font-size: 11px; font-weight: 700; padding: 1px 6px; min-width: 18px; }
.bell-panel { position: absolute; right: 0; top: 48px; width: 380px; max-height: 70vh; overflow-y: auto; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); z-index: 60; padding: 12px; }
.bell-item { padding: 10px 12px; border-radius: 10px; border: 1px solid transparent; margin-bottom: 6px; }
.bell-item.unread { background: var(--brand-tint); border-color: var(--line); }
@media (max-width: 640px) { .bell-panel { position: fixed; left: 0; right: 0; top: 0; bottom: auto; width: auto; max-height: 85vh; border-radius: 0 0 16px 16px; } }
`;

export function Notifications() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ unread: number; rows: any[] } | null>(null);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try { setData(await api.get('/me/notifications')); setError(''); } catch (e: any) { setError(friendly(e.message)); }
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30_000);
    return () => clearInterval(t);
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
    try { await api.post('/me/notifications/read', {}); await load(); } catch (e: any) { setError(friendly(e.message)); }
  };
  const unread = data?.unread ?? 0;

  return (
    <div className="bell-wrap" ref={box}>
      <style>{CSS}</style>
      <button type="button" className="bell-btn" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} aria-expanded={open} onClick={() => { setOpen((v) => !v); load(); }}>
        <span aria-hidden>🔔</span>
        {unread > 0 && <span className="bell-count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="bell-panel" role="dialog" aria-label="Notifications">
          <div className="row between" style={{ marginBottom: 8 }}>
            <b>Notifications</b>
            <div className="row" style={{ gap: 6 }}>
              {unread > 0 && <Button kind="ghost" small onClick={markAll}>Mark all as read</Button>}
              <Button kind="ghost" small onClick={() => setOpen(false)}>Close</Button>
            </div>
          </div>
          {error && <ErrorNote>{error}</ErrorNote>}
          {!loaded && <Spinner />}
          {loaded && data && data.rows.length === 0 && <Empty>You are all caught up</Empty>}
          {data?.rows.map((n) => (
            <div key={n.id} className={`bell-item ${n.read ? '' : 'unread'}`}>
              <div style={{ fontWeight: n.read ? 500 : 700 }}>{n.title}</div>
              {n.body && <div className="muted" style={{ fontSize: 14 }}>{n.body}</div>}
              <div className="tiny">{ago(n.created_at)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
