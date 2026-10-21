import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Dialog: a centred sheet (a bottom sheet on a phone) for a short decision: confirm, reject with a reason, show a number.
 * Esc and a click on the dim background close it; focus moves in and returns. Put the buttons in `footer`.
 *   {ask && <Dialog title="Run settlement now?" onClose={() => setAsk(false)} footer={<><Button kind="ghost" onClick={...}>Cancel</Button><Button>Run</Button></>}>...</Dialog>}
 */
export function Dialog({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children?: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close.current(); } };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); prev?.focus?.(); };
  }, []);
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal u-dialog" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Dialog'} tabIndex={-1} ref={box} style={wide ? { width: 'min(720px, 100%)' } : undefined}>
        <h2>{title}</h2>
        <div className="u-dialog-body">{children}</div>
        {footer && <div className="u-dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}
