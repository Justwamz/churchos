import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Db } from '@churchos/ledger';

export const HELP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'help');
export type HelpAudience = 'member' | 'staff' | 'admin';

export interface ParsedArticle {
  id: string;
  title: string;
  audiences: HelpAudience[];
  area: string;
  tags: string[];
  screens: string[];
  lang: string;
  version: number;
  body: string;
  chunks: { heading: string; text: string }[];
}

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Parses a help article: simple `key: value` front matter, then Markdown split into chunks at `##` headings. */
export function parseArticle(file: string, source: string): ParsedArticle {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!m) throw new Error(`${file}: missing front matter`);
  const fm: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  for (const k of ['id', 'title', 'audience', 'area']) if (!fm[k]) throw new Error(`${file}: front matter is missing "${k}"`);
  const audiences = list(fm.audience) as HelpAudience[];
  for (const a of audiences) if (!['member', 'staff', 'admin'].includes(a)) throw new Error(`${file}: unknown audience "${a}"`);
  const body = m[2].trim();
  const chunks: { heading: string; text: string }[] = [];
  let heading = fm.title;
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) chunks.push({ heading, text });
    buf = [];
  };
  for (const line of body.split(/\r?\n/)) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) {
      flush();
      heading = h[1].trim();
    } else if (!/^#\s/.test(line)) buf.push(line);
  }
  flush();
  return {
    id: fm.id, title: fm.title, audiences, area: fm.area, tags: list(fm.tags), screens: list(fm.screens),
    lang: fm.lang || 'en', version: Number(fm.version || 1), body, chunks,
  };
}

/** Reloads every article from disk. Safe to run on each start: content is replaced, never merged. */
export async function loadHelp(db: Db, dir: string = HELP_DIR): Promise<number> {
  if (!existsSync(dir)) return 0;
  const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  const articles = files.map((f) => parseArticle(f, readFileSync(join(dir, f), 'utf8')));
  const seen = new Set<string>();
  for (const a of articles) {
    if (seen.has(a.id)) throw new Error(`duplicate help article id "${a.id}"`);
    seen.add(a.id);
  }
  await db.tx(async (q) => {
    await q.query(`DELETE FROM help_chunks`);
    await q.query(`DELETE FROM help_articles`);
    for (const a of articles) {
      await q.query(
        `INSERT INTO help_articles (id, title, audiences, area, tags, screens, lang, version, body) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [a.id, a.title, JSON.stringify(a.audiences), a.area, JSON.stringify(a.tags), JSON.stringify(a.screens), a.lang, a.version, a.body],
      );
      let n = 0;
      for (const c of a.chunks) {
        await q.query(
          `INSERT INTO help_chunks (id, article_id, ordinal, heading, text, tsv) VALUES ($1,$2,$3,$4,$5,
             setweight(to_tsvector('english', $6), 'A') || setweight(to_tsvector('english', $4), 'B') || setweight(to_tsvector('english', $5), 'C'))`,
          [`${a.id}#${n}`, a.id, n, c.heading, c.text, a.title + ' ' + a.tags.join(' ')],
        );
        n++;
      }
    }
  });
  return articles.length;
}
