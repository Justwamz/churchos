import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';

/**
 * OverflowMenu: one "More" button that opens a short list of secondary actions, so a card keeps one or two visible buttons instead of four.
 * Closes on Escape, on a click outside and after a choice. `items` with `hidden: true` are left out (use it for rights).
 *   <OverflowMenu label="More actions for this wallet" items={[{ label: 'Move credit', onClick: ... }]} />
 */
export type MenuItem = { label: string; onClick: () => void; hidden?: boolean };
export function OverflowMenu({ items, label = 'More actions', text = 'More' }: { items: MenuItem[]; label?: string; text?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const list = items.filter((i) => !i.hidden);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); box.current?.querySelector('button')?.focus(); } };
    document.addEventListener('mousedown', click);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', click); document.removeEventListener('keydown', key); };
  }, [open]);
  if (list.length === 0) return null;
  return (
    <div className="u-ovf" ref={box}>
      <button type="button" className="btn ghost" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen((o) => !o)}>{text}<Icon name="chevron" size={16} style={{ transform: 'rotate(90deg)' }} /></button>
      {open && (
        <div className="u-ovf-menu" role="menu">
          {list.map((i) => <button key={i.label} type="button" role="menuitem" onClick={() => { setOpen(false); i.onClick(); }}>{i.label}</button>)}
        </div>
      )}
    </div>
  );
}
