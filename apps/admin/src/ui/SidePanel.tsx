import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from '../icons';

/**
 * SidePanel: a drawer for the details of one thing (a member, an expense, a booking) without leaving the list.
 * Slides in from the right on a desktop, rises as a bottom sheet on a phone. Sticky header with a close button; Esc and a click outside close it;
 * focus moves into it when it opens and back when it closes. Render it only when something is selected:
 *   {sel && <SidePanel title={sel.name} subtitle="Member 0042" onClose={() => setSel(null)} footer={<Button>Save</Button>}>...</SidePanel>}
 * `footer` is a sticky action bar at the bottom. `width` is the desktop width in px (default 480).
 */
export function SidePanel({ title, subtitle, onClose, children, footer, width = 480 }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close.current(); } };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); prev?.focus?.(); };
  }, []);
  return (
    <div className="u-sp-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="u-sp" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Details'} tabIndex={-1} ref={box} style={{ ['--sp-w' as any]: `${width}px` }}>
        <div className="u-sp-head">
          <div className="u-sp-titles"><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
          <button type="button" className="u-sp-x" aria-label="Close" onClick={onClose}><Icon name="close" size={20} /></button>
        </div>
        <div className="u-sp-body">{children}</div>
        {footer && <div className="u-sp-foot">{footer}</div>}
      </div>
    </div>
  );
}
