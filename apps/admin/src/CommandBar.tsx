import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from './icons';
import { AREAS, PAGES, areaOfPage } from './navmap';

/**
 * Command palette (Ctrl+K / Cmd+K or the search field in the top bar): jump to any admin page.
 * Keyboard: type, Up/Down to move, Enter to open, Esc to close. Recent pages are remembered on this device (optional).
 */
type Item = { key: string; label: string; hint?: string; icon: IconName; run: () => void; text: string };
const RECENT_KEY = 'churchos:admin-recent';
const readRecent = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); } catch { return []; } };
const writeRecent = (key: string) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify([key, ...readRecent().filter((r) => r !== key)].slice(0, 6))); } catch { /* optional */ } };

export function CommandBar({ onClose, go }: { onClose: () => void; go: (page: string) => void }) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const open = (id: string) => { writeRecent(id); onClose(); go(id); };
  const base = useMemo<Item[]>(() => PAGES.map((p) => {
    const area = areaOfPage(p.id);
    return { key: p.id, label: p.label, hint: area && area.id !== 'overview' ? area.label : undefined, icon: area?.icon ?? 'list', run: () => open(p.id), text: `${p.label} ${p.id} ${p.keywords} ${area?.label ?? ''}`.toLowerCase() };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    const groups: { title: string; items: Item[] }[] = [];
    if (!t) {
      const rec = readRecent().map((r) => base.find((b) => b.key === r)).filter(Boolean) as Item[];
      if (rec.length) groups.push({ title: 'Recent', items: rec });
      for (const a of AREAS) groups.push({ title: a.label, items: base.filter((b) => (a.ids as string[]).includes(b.key)) });
    } else {
      const words = t.split(/\s+/);
      const hit = base.filter((b) => words.every((x) => b.text.includes(x)));
      hit.sort((a, b) => Number(b.label.toLowerCase().startsWith(t)) - Number(a.label.toLowerCase().startsWith(t)) || Number(b.label.toLowerCase().includes(t)) - Number(a.label.toLowerCase().includes(t)));
      groups.push({ title: 'Pages', items: hit });
    }
    return groups.filter((g) => g.items.length);
  }, [q, base]);

  const flat = rows.flatMap((g) => g.items);
  useEffect(() => { setIdx(0); }, [q]);
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
      <div className="cb" role="dialog" aria-modal="true" aria-label="Search pages" onKeyDown={onKey}>
        <div className="cb-input">
          <Icon name="search" size={20} />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search pages" aria-label="Search" role="combobox" aria-expanded="true" aria-controls="cb-list" aria-activedescendant={flat[idx] ? 'cb-' + idx : undefined} autoComplete="off" spellCheck={false} />
          <button type="button" className="cb-esc" onClick={onClose} aria-label="Close search"><span className="cb-esc-key">Esc</span><Icon name="close" size={18} /></button>
        </div>
        <div className="cb-list" id="cb-list" role="listbox" ref={list}>
          {rows.map((g) => (
            <div key={g.title} role="group" aria-label={g.title}>
              <div className="cb-group">{g.title}</div>
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
          {flat.length === 0 && <div className="cb-none">Nothing found for "{q.trim()}".</div>}
        </div>
        <div className="cb-foot"><span><kbd>↑</kbd><kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to open</span><span><kbd>Esc</kbd> to close</span></div>
      </div>
    </div>
  );
}
