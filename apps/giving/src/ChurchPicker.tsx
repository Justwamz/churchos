import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { ApiError, createApi } from '@churchos/ui';

const api = createApi('churchos:giving:token');

export interface ChurchHit { code: string; branch: string; church: string; region: string }
export interface LastChurch { code: string; name: string }

const LAST_KEY = 'churchos:lastChurch';
export const lastChurch = {
  get(): LastChurch | null {
    try {
      const v = JSON.parse(localStorage.getItem(LAST_KEY) ?? 'null');
      return v && typeof v.code === 'string' && typeof v.name === 'string' ? v : null;
    } catch { return null; }
  },
  set(v: LastChurch) {
    try { localStorage.setItem(LAST_KEY, JSON.stringify(v)); } catch { /* storage blocked */ }
  },
};

const looksLikeCode = (s: string) => /^[A-Za-z]{2,6}\d{1,6}$/.test(s);

type State = 'idle' | 'short' | 'loading' | 'ready' | 'empty' | 'limited' | 'error';

export function ChurchPicker({ onChoose, last }: { onChoose: (code: string) => void; last?: LastChurch | null }) {
  const [text, setText] = useState('');
  const [hits, setHits] = useState<ChurchHit[]>([]);
  const [state, setState] = useState<State>('idle');
  const [active, setActive] = useState(-1);
  const id = useId();
  const listId = `${id}-list`;
  const q = text.trim();

  useEffect(() => {
    setActive(-1);
    if (!q) { setHits([]); setState('idle'); return; }
    if (q.length < 3) { setHits([]); setState('short'); return; }
    setState('loading');
    let alive = true;
    const t = setTimeout(() => {
      api.get<{ churches: ChurchHit[] }>(`/public/churches/search?q=${encodeURIComponent(q)}`)
        .then((r) => { if (!alive) return; setHits(r.churches); setState(r.churches.length ? 'ready' : 'empty'); })
        .catch((e) => {
          if (!alive) return;
          setHits([]);
          setState(e instanceof ApiError && (e.status === 429 || e.code === 'rate_limited') ? 'limited' : 'error');
        });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);

  const open = state === 'ready' && hits.length > 0;
  const choose = (h: ChurchHit) => onChoose(h.code);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && open) { e.preventDefault(); setActive((a) => (a + 1) % hits.length); }
    else if (e.key === 'ArrowUp' && open) { e.preventDefault(); setActive((a) => (a <= 0 ? hits.length - 1 : a - 1)); }
    else if (e.key === 'Escape') { setText(''); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (open) choose(hits[active >= 0 ? active : 0]);
      else if (state !== 'loading' && looksLikeCode(q)) onChoose(q.toUpperCase());
    }
  };

  const message =
    state === 'short' ? 'Type at least 3 letters'
    : state === 'empty' ? 'No church found. Check the spelling, or ask your church for its code or link.'
    : state === 'limited' ? 'Too many searches, please wait a minute.'
    : state === 'error' ? 'We could not search just now. Please try again.'
    : null;

  return (
    <div className="cp">
      <style>{CSS}</style>
      {last && !q && (
        <button type="button" className="cp-last" onClick={() => onChoose(last.code)}>
          <span>Give to <b>{last.name}</b> again</span>
          <span aria-hidden="true">&rarr;</span>
        </button>
      )}
      <label className="field-label" htmlFor={`${id}-in`}>Church name or code</label>
      <div className="cp-box">
        <svg className="cp-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input
          id={`${id}-in`}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${id}-o${active}` : undefined}
          aria-describedby={`${id}-status`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder="For example Grace Nairobi"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          autoFocus
        />
      </div>
      <ul id={listId} role="listbox" aria-label="Churches found" className="cp-list" hidden={!open}>
        {hits.map((h, i) => (
          <li
            key={h.code}
            id={`${id}-o${i}`}
            role="option"
            aria-selected={i === active}
            className={i === active ? 'on' : ''}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(h)}
          >
            <b>{h.church}</b>
            <span>{h.branch}{h.region ? `, ${h.region}` : ''}</span>
          </li>
        ))}
      </ul>
      <div id={`${id}-status`} className="cp-status" role="status" aria-live="polite">
        {state === 'loading'
          ? 'Looking for churches...'
          : open
            ? `${hits.length} ${hits.length === 1 ? 'church' : 'churches'} found. Use the arrow keys and Enter, or tap one.`
            : message
              ? <span className={state === 'short' ? '' : 'cp-warn'}>{message}</span>
              : <span className="tiny">Type your church name, or its code if you have one.</span>}
      </div>
    </div>
  );
}

const CSS = `
.cp .field-label { display: block; margin-bottom: 8px; }
.cp-box { position: relative; }
.cp-box input { width: 100%; padding-left: 42px; min-height: 50px; font-size: 1.05rem; box-sizing: border-box; }
.cp-box input:focus-visible { outline: 3px solid color-mix(in srgb, var(--brand) 45%, transparent); outline-offset: 2px; }
.cp-icon { position: absolute; left: 13px; top: 50%; transform: translateY(-50%); color: var(--ink-3); pointer-events: none; }
.cp-list { list-style: none; margin: 8px 0 0; padding: 4px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: 0 6px 18px rgba(0,0,0,.08); }
.cp-list[hidden] { display: none; }
.cp-list li { display: flex; flex-direction: column; gap: 2px; padding: 11px 12px; min-height: 44px; border-radius: 8px; cursor: pointer; }
.cp-list li span { color: var(--ink-2); font-size: 13px; }
.cp-list li.on, .cp-list li:hover { background: var(--brand-tint); }
.cp-list li.on { outline: 2px solid var(--brand); outline-offset: -2px; }
.cp-status { margin-top: 10px; min-height: 22px; font-size: 13px; color: var(--ink-2); }
.cp-warn { color: var(--ink); background: var(--brand-tint); border-radius: 8px; padding: 8px 10px; display: block; }
.cp-last { display: flex; justify-content: space-between; align-items: center; gap: 10px; width: 100%; min-height: 50px; margin-bottom: 18px; padding: 10px 14px; border: 1px solid var(--brand); border-radius: var(--radius); background: var(--brand-tint); color: var(--ink); font: inherit; text-align: left; cursor: pointer; }
.cp-last:focus-visible { outline: 3px solid color-mix(in srgb, var(--brand) 45%, transparent); outline-offset: 2px; }
`;
