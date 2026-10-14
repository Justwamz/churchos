import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Api } from './api';

type Audience = 'member' | 'staff' | 'admin';

/** Inline Markdown: **bold**, `code`. Everything is rendered as React text, so article content can never inject HTML. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(<strong key={i++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={i++}>{t.slice(1, -1)}</code>);
    else out.push(<em key={i++}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A small Markdown renderer for help articles: headings, paragraphs, bullet and numbered lists. */
export function HelpMarkdown({ source }: { source: string }) {
  const lines = source.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      if (level === 1) { i++; continue; } // the article title is shown separately
      blocks.push(level === 2 ? <h4 key={key++}>{inline(h[2])}</h4> : <h5 key={key++}>{inline(h[2])}</h5>);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
      blocks.push(<ul key={key++}>{items.map((t, n) => <li key={n}>{inline(t)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ''));
      blocks.push(<ol key={key++}>{items.map((t, n) => <li key={n}>{inline(t)}</li>)}</ol>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|\s*[-*]\s+|\s*\d+\.\s+)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={key++}>{inline(para.join(' '))}</p>);
  }
  return <>{blocks}</>;
}

/** Search snippets mark matches with << >>. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(<<|>>)/);
  let on = false;
  return (
    <>
      {parts.map((p, i) => {
        if (p === '<<') { on = true; return null; }
        if (p === '>>') { on = false; return null; }
        return <Fragment key={i}>{on ? <mark>{p}</mark> : p}</Fragment>;
      })}
    </>
  );
}

/**
 * The Help button every app shows (L82). It opens a panel with search, articles for this screen, and the full list,
 * limited to what this person is allowed to read (L86).
 */
export function HelpButton(p: { api: Api; audience: Audience; screen?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[] | null>(null);
  const [articles, setArticles] = useState<any[]>([]);
  const [context, setContext] = useState<any[]>([]);
  const [article, setArticle] = useState<any | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setError(undefined);
    p.api.get(`/help/articles?audience=${p.audience}`).then(setArticles).catch(() => setError('Help is not available right now.'));
    if (p.screen) p.api.get(`/help/context?screen=${encodeURIComponent(p.screen)}`).then(setContext).catch(() => setContext([]));
    setTimeout(() => inputRef.current?.focus(), 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, p.screen, p.audience]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    const text = q.trim();
    if (!text) { setResults(null); return; }
    const t = setTimeout(() => {
      setLoading(true);
      p.api.get(`/help/search?q=${encodeURIComponent(text)}&audience=${p.audience}`)
        .then((r) => setResults(r.results))
        .catch(() => setError('Search is not available right now.'))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, p.audience]);

  const openArticle = (id: string) => {
    setError(undefined);
    p.api.get(`/help/articles/${id}`).then(setArticle).catch(() => setError('We could not open that article.'));
  };

  // Group the full list by area for browsing.
  const byArea = articles.reduce<Record<string, any[]>>((m, a) => ((m[a.area] ||= []).push(a), m), {});

  return (
    <>
      <button type="button" className="help-fab" onClick={() => setOpen(true)} aria-label="Open help" title="Help">
        <span aria-hidden>?</span>
        <span className="help-fab-label">{p.label ?? 'Help'}</span>
      </button>
      {open && (
        <div className="help-scrim" onClick={() => setOpen(false)}>
          <aside className="help-panel" role="dialog" aria-label="Help" onClick={(e) => e.stopPropagation()}>
            <header className="help-head">
              {article ? (
                <button type="button" className="help-back" onClick={() => setArticle(null)}>← Back</button>
              ) : (
                <strong>Help</strong>
              )}
              <button type="button" className="help-close" onClick={() => setOpen(false)} aria-label="Close help">×</button>
            </header>

            {!article && (
              <div className="help-search">
                <input ref={inputRef} type="search" placeholder="Search help, e.g. “wrong church”" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search help" />
              </div>
            )}

            <div className="help-body">
              {error && <div className="note bad">{error}</div>}

              {article ? (
                <article className="help-article">
                  <h3>{article.title}</h3>
                  <HelpMarkdown source={article.body} />
                  {article.related?.length > 0 && (
                    <div className="help-related">
                      <div className="tiny">Related</div>
                      {article.related.map((r: any) => (
                        <button type="button" key={r.id} className="help-link" onClick={() => openArticle(r.id)}>{r.title}</button>
                      ))}
                    </div>
                  )}
                </article>
              ) : results ? (
                <div>
                  {loading && <div className="tiny">Searching…</div>}
                  {!loading && results.length === 0 && <div className="empty">No help found for “{q}”. Try fewer or different words.</div>}
                  {results.map((r) => (
                    <button type="button" key={r.chunkId} className="help-result" onClick={() => openArticle(r.articleId)}>
                      <div className="help-result-title">{r.title}</div>
                      {r.heading !== r.title && <div className="tiny">{r.heading}</div>}
                      <div className="help-snippet"><Snippet text={r.snippet} /></div>
                    </button>
                  ))}
                </div>
              ) : (
                <div>
                  {context.length > 0 && (
                    <section>
                      <div className="help-group">About this screen</div>
                      {context.map((a) => <button type="button" key={a.id} className="help-link strong" onClick={() => openArticle(a.id)}>{a.title}</button>)}
                    </section>
                  )}
                  {Object.entries(byArea).map(([area, list]) => (
                    <section key={area}>
                      <div className="help-group">{area}</div>
                      {list.map((a) => <button type="button" key={a.id} className="help-link" onClick={() => openArticle(a.id)}>{a.title}</button>)}
                    </section>
                  ))}
                  {articles.length === 0 && !error && <div className="empty">No help articles yet.</div>}
                </div>
              )}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
