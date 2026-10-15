import { useEffect, useRef, type ReactNode } from 'react';

/** Inline SVG icons, so the app needs no icon dependency. `filled` is used for the active tab. */
const P: Record<string, ReactNode> = {
  home: <path d="M3.5 11 12 3.8 20.5 11v8.2a1.3 1.3 0 0 1-1.3 1.3H15v-5.6H9v5.6H4.8a1.3 1.3 0 0 1-1.3-1.3z" />,
  give: <path d="M12 20.3s-7.8-4.7-7.8-10.4A4.5 4.5 0 0 1 12 7.3a4.5 4.5 0 0 1 7.8 2.6c0 5.7-7.8 10.4-7.8 10.4z" />,
  chat: <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z" />,
  groups: (<><circle cx="9" cy="8.5" r="3.2" /><path d="M2.8 19.5c0-3.3 2.8-5.6 6.2-5.6s6.2 2.3 6.2 5.6z" /><circle cx="17" cy="9.5" r="2.5" /><path d="M16.5 14.3c2.7 0 4.7 1.8 4.7 4.6h-4.2" /></>),
  me: (<><circle cx="12" cy="8" r="4" /><path d="M4 20.5c0-4 3.6-6.3 8-6.3s8 2.3 8 6.3z" /></>),
  bell: <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  history: (<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>),
  cert: (<><rect x="4" y="4" width="16" height="12" rx="2" /><path d="M8 8.5h8M8 12h5M9 16l-1 4.5 3-1.7 3 1.7-1-4.5" /></>),
  swap: <path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5" />,
  coin: (<><circle cx="12" cy="12" r="8.5" /><path d="M12 7v10M9.5 9.5h4a1.7 1.7 0 0 1 0 3.4h-3a1.7 1.7 0 0 0 0 3.4h4.5" /></>),
  chev: <path d="m9 5 7 7-7 7" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  receipt: <path d="M6 3.5h12v17l-3-2-3 2-3-2-3 2zM9 8.5h6M9 12h6" />,
  family: (<><circle cx="8" cy="7.5" r="2.7" /><circle cx="16.5" cy="9.5" r="2" /><path d="M3 19c0-3 2.3-5 5-5s5 2 5 5zM14 19c0-2.4 1.3-3.8 3-3.8s3 1.4 3 3.8z" /></>),
  logout: <path d="M10 4.5H5.5v15H10M15 8l4 4-4 4M19 12H9.5" />,
  help: (<><circle cx="12" cy="12" r="8.5" /><path d="M9.7 9.6a2.4 2.4 0 0 1 4.6.8c0 1.6-2.3 1.9-2.3 3.4M12 16.6v.1" /></>),
  install: <path d="M12 4v11M7.5 11 12 15.5 16.5 11M5 19.5h14" />,
  pledge: (<><path d="M5 4.5h14v15H5z" /><path d="M8.5 9h7M8.5 12.5h7M8.5 16h4" /></>),
};
const CLOSED = new Set(['home', 'give', 'chat', 'groups', 'me', 'bell']);

export function Icon({ name, filled, size = 24 }: { name: string; filled?: boolean; size?: number }) {
  return (
    <svg className="ico" width={size} height={size} viewBox="0 0 24 24" fill={filled && CLOSED.has(name) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {P[name]}
    </svg>
  );
}

/** A slide-up panel. `full` makes it cover the whole screen (used for the thank-you screen). */
export function Sheet({ open, onClose, title, children, full, label }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; full?: boolean; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); prev?.focus?.(); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null;
  return (
    <div className={`sheet-wrap ${full ? 'full' : ''}`}>
      <div className="sheet-scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label ?? (typeof title === 'string' ? title : 'Details')} ref={ref} tabIndex={-1}>
        {!full && <div className="sheet-grip" aria-hidden="true" />}
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" size={22} /></button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

export function Skeleton({ lines = 3, tall }: { lines?: number; tall?: boolean }) {
  return (
    <div className="skel" role="status" aria-label="Loading">
      {tall && <i className="skel-block" />}
      {Array.from({ length: lines }, (_, i) => <i key={i} className="skel-line" style={{ width: `${92 - i * 16}%` }} />)}
    </div>
  );
}
