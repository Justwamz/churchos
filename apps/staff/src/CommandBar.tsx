import { useEffect, useMemo, useRef, useState } from 'react';
import { api, useSession } from './session';
import { Icon, type IconName } from './icons';
import { openAction, setPrefill } from './prefill';
import { QUICK_ACTIONS, areaOfPage } from './navmap';
import { PAGES, pageLabel } from './nav';
import { useWords } from './words';

/**
 * Command bar (Ctrl+K / Cmd+K, or the search field in the top bar). Jump to any page the person may open, run a quick action,
 * or find a member by name, number or phone. Keyboard: type, Up/Down to move, Enter to open, Esc to close.
 * Recently opened items are remembered on this device (localStorage, optional).
 */
type Item = { key: string; kind: 'page' | 'action' | 'member'; label: string; hint?: string; icon: IconName; run: () => void; text: string };
const RECENT_KEY = 'churchos:staff-recent';
type Recent = { key: string };

const readRecent = (): Recent[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); } catch { return []; } };
const writeRecent = (key: string) => {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([{ key }, ...readRecent().filter((r) => r.key !== key)].slice(0, 6))); } catch { /* optional */ }
};

export function CommandBar({ onClose }: { onClose: () => void }) {
  const s = useSession();
  const w = useWords();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [idx, setIdx] = useState(0);
  const [people, setPeople] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const canMembers = s.can('members.view') || s.can('members.edit');

  const go = (page: string, key: string, prefill?: string) => {
    writeRecent(key);
    if (prefill !== undefined) setPrefill(page, prefill);
    onClose();
    s.go(page);
  };

  const base = useMemo<Item[]>(() => {
    const pages: Item[] = PAGES.filter((p) => p.any.includes('*') || p.any.some((a) => s.can(a))).map((p) => {
      const label = pageLabel(p, w);
      const area = areaOfPage(p.id);
      return { key: 'page:' + p.id, kind: 'page', label, hint: area && area.id !== 'today' ? area.label : undefined, icon: area?.icon ?? 'list', run: () => go(p.id, 'page:' + p.id), text: `${label} ${p.id} ${p.keywords ?? ''} ${area?.label ?? ''}`.toLowerCase() };
    });
    const actions: Item[] = QUICK_ACTIONS.filter((a) => s.can(a.right)).map((a) => ({ key: 'action:' + a.id, kind: 'action', label: a.label, hint: 'Quick action', icon: 'plus', run: () => { openAction(a.page, a.action); go(a.page, 'action:' + a.id); }, text: `${a.label} ${a.keywords}`.toLowerCase() }));
    return [...actions, ...pages];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, w.many]);

  // debounce 250ms before asking the server about members
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    if (!canMembers || dq.length < 2) { setPeople([]); setSearching(false); return; }
    let live = true;
    setSearching(true);
    api.get('/members/grouped' + s.qs({ q: dq })).then((r: any) => {
      if (!live) return;
      const all: any[] = (r.households ?? []).flatMap((h: any) => h.members).concat(r.individuals ?? []);
      setPeople(all.slice(0, 6));
    }).catch(() => { if (live) setPeople([]); }).finally(() => { if (live) setSearching(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq, canMembers, s.qs()]);

  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    const memberItems: Item[] = (t.length >= 2 ? people : []).map((m) => ({
      key: 'member:' + m.id, kind: 'member', label: m.full_name, hint: [m.member_number, m.branch_name].filter(Boolean).join(' · '), icon: 'user',
      run: () => go('members', 'page:members', m.full_name), text: '',
    }));
    const groups: { title: string; items: Item[] }[] = [];
    if (!t) {
      const rec = readRecent().map((r) => base.find((b) => b.key === r.key)).filter(Boolean) as Item[];
      if (rec.length) groups.push({ title: 'Recent', items: rec });
      groups.push({ title: 'Quick actions', items: base.filter((b) => b.kind === 'action') });
      groups.push({ title: 'Pages', items: base.filter((b) => b.kind === 'page') });
    } else {
      const words = t.split(/\s+/);
      const hit = base.filter((b) => words.every((x) => b.text.includes(x)));
      // label matches first, then keyword matches
      hit.sort((a, b) => Number(b.label.toLowerCase().startsWith(t)) - Number(a.label.toLowerCase().startsWith(t)) || Number(b.label.toLowerCase().includes(t)) - Number(a.label.toLowerCase().includes(t)));
      if (memberItems.length) groups.push({ title: 'Members', items: memberItems });
      if (hit.filter((h) => h.kind === 'action').length) groups.push({ title: 'Quick actions', items: hit.filter((h) => h.kind === 'action') });
      if (hit.filter((h) => h.kind === 'page').length) groups.push({ title: 'Pages', items: hit.filter((h) => h.kind === 'page') });
    }
    return groups.filter((g) => g.items.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, base, people]);

  const flat = rows.flatMap((g) => g.items);
  useEffect(() => { setIdx(0); }, [q, people.length]);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => { if (prev && document.contains(prev)) prev.focus?.(); };
  }, []);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [idx, rows]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(flat.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); flat[idx]?.run(); }
    else if (e.key === 'Tab') { e.preventDefault(); input.current?.focus(); }
  };

  let n = -1;
  return (
    <div className="cb-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cb" role="dialog" aria-modal="true" aria-label="Search and commands" onKeyDown={onKey}>
        <div className="cb-input">
          <Icon name="search" size={20} />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={canMembers ? 'Search pages, actions and members' : 'Search pages and actions'} aria-label="Search" role="combobox" aria-expanded="true" aria-controls="cb-list" aria-activedescendant={flat[idx] ? 'cb-' + idx : undefined} autoComplete="off" spellCheck={false} />
          <button type="button" className="cb-esc" onClick={onClose} aria-label="Close search"><span className="cb-esc-key">Esc</span><Icon name="close" size={18} /></button>
        </div>
        <div className="cb-list" id="cb-list" role="listbox" ref={list}>
          {rows.map((g) => (
            <div key={g.title} role="group" aria-label={g.title}>
              <div className="cb-group">{g.title}{g.title === 'Members' && searching ? ' · searching...' : ''}</div>
              {g.items.map((it) => {
                n += 1;
                const i = n;
                return (
                  <button key={g.title + it.key} id={'cb-' + i} type="button" role="option" aria-selected={i === idx} className={`cb-item ${i === idx ? 'on' : ''}`} onMouseMove={() => setIdx(i)} onClick={it.run}>
                    <span className="cb-ico"><Icon name={it.icon} size={18} /></span>
                    <span className="cb-label">{it.label}</span>
                    {it.hint && <span className="cb-hint">{it.hint}</span>}
                    <Icon name="chevron" size={16} />
                  </button>
                );
              })}
            </div>
          ))}
          {flat.length === 0 && <div className="cb-none">{searching ? 'Searching...' : `Nothing found for "${q.trim()}".`}</div>}
        </div>
        <div className="cb-foot"><span><kbd>↑</kbd><kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to open</span><span><kbd>Esc</kbd> to close</span></div>
      </div>
    </div>
  );
}
