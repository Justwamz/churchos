import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './ui';
import { useInstall } from './Install';

export type ProfileTarget = 'main' | 'data' | 'security';
type Item = { key: string; label: string; ico: string; hint?: string; on?: () => void; href?: string; hide?: boolean };

/** True from 700 px up: the same breakpoint where the tab bar becomes a left rail. */
function useWide() {
  const q = '(min-width: 700px)';
  const [wide, setWide] = useState(() => window.matchMedia?.(q).matches ?? false);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const f = () => setWide(m.matches);
    m.addEventListener?.('change', f);
    return () => m.removeEventListener?.('change', f);
  }, []);
  return wide;
}

const FOCUSABLE = 'a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * The profile menu behind the avatar: a popover under the avatar on tablets and desktops, a bottom sheet on phones.
 * Focus moves into the menu, Tab stays inside it, arrow keys move between items, Esc closes, and focus goes back to the avatar.
 */
export function ProfileMenu({ initials, name, church, number, linked, onOpen, onHelp, signOut, active }: {
  initials: string; name: string; church?: string; number?: string; linked: boolean; active?: boolean;
  onOpen: (t: ProfileTarget) => void; onHelp: () => void; signOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tip, setTip] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const wide = useWide();
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const inst = useInstall();

  const close = (refocus = true) => { setOpen(false); setTip(false); if (refocus) setTimeout(() => btn.current?.focus(), 0); };

  useLayoutEffect(() => {
    if (!open || !wide || !btn.current) { setPos(null); return; }
    const place = () => { const r = btn.current!.getBoundingClientRect(); setPos({ top: Math.round(r.bottom + 10), right: Math.max(12, Math.round(window.innerWidth - r.right)) }); };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, wide]);

  useEffect(() => {
    if (!open) return;
    const menuItems = () => [...(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    menuItems()[0]?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      const all = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (e.key === 'Tab' && all.length) {
        const first = all[0], last = all[all.length - 1];
        if (!panel.current?.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        const list = menuItems();
        if (!list.length) return;
        e.preventDefault();
        const i = list.indexOf(document.activeElement as HTMLElement);
        const n = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
        list[n].focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (fn: () => void) => () => { close(false); fn(); };
  const items: Item[] = [
    { key: 'profile', label: linked ? 'My profile and church' : 'Church link status', ico: 'me', hint: linked ? 'Membership, household, records, message choices' : 'Link to your church', on: pick(() => onOpen('main')) },
    { key: 'data', label: 'My data and privacy', ico: 'receipt', hint: 'Download my data, delete my account', on: pick(() => onOpen('data')) },
    { key: 'security', label: 'Security', ico: 'pin', hint: 'Passkeys and where you are signed in', on: pick(() => onOpen('security')) },
    { key: 'install', label: 'Install app', ico: 'install', hint: inst.showIosTip ? undefined : 'Open it from your home screen', hide: !(inst.canInstall || inst.showIosTip), on: () => { if (inst.canInstall) { close(false); inst.install(); } else setTip((t) => !t); } },
    { key: 'help', label: 'Help and payment issues', ico: 'help', on: pick(onHelp) },
    { key: 'legal', label: 'Terms, privacy and cookies', ico: 'link', href: '/legal' },
  ];
  const body: ReactNode = (
    <div ref={panel} className={`pm-panel ${wide ? 'pop' : 'sheetmode'}`} role="dialog" aria-modal="true" aria-label="Account menu" style={wide && pos ? { top: pos.top, right: pos.right } : undefined}>
      {!wide && <div className="sheet-grip" aria-hidden="true" />}
      <div className="pm-head">
        <span className="pm-av" aria-hidden="true">{initials}</span>
        <div className="pm-who">
          <strong>{name || 'Member'}</strong>
          {church && <span>{church}</span>}
          {number && <span>Member no. {number}</span>}
        </div>
        {!wide && <button type="button" className="icon-btn" aria-label="Close menu" onClick={() => close()}><Icon name="close" size={22} /></button>}
      </div>
      <div role="menu" aria-label="Account" className="pm-list">
        {items.filter((i) => !i.hide).map((i) => i.href
          ? <a key={i.key} role="menuitem" className="pm-item" href={i.href} target="_blank" rel="noopener" onClick={() => close(false)}><Icon name={i.ico} size={22} /><span><b>{i.label}</b></span><Icon name="chev" size={18} /></a>
          : <button key={i.key} type="button" role="menuitem" className="pm-item" onClick={i.on} aria-expanded={i.key === 'install' && inst.showIosTip ? tip : undefined}><Icon name={i.ico} size={22} /><span><b>{i.label}</b>{i.hint && <small>{i.hint}</small>}</span><Icon name="chev" size={18} /></button>)}
        {tip && inst.showIosTip && <p className="pm-tip tiny" role="note">To install: tap Share, then Add to Home Screen.</p>}
        <div className="pm-sep" role="separator" />
        <button type="button" role="menuitem" className="pm-item danger" onClick={pick(signOut)}><Icon name="logout" size={22} /><span><b>Sign out</b></span></button>
      </div>
    </div>
  );
  return (
    <>
      <button ref={btn} type="button" className={`avatar ${active ? 'on' : ''}`} aria-label="My profile and account menu" aria-haspopup="menu" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>{initials}</button>
      {open && createPortal(<div className="pm-wrap"><div className="pm-scrim" onClick={() => close()} />{body}</div>, document.body)}
    </>
  );
}
