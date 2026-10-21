import type { FastifyInstance, FastifyRequest } from 'fastify';
import { loadGrants } from '../auth';
import { HttpError, type Ctx } from '../ctx';
import { getSession } from '../sessions';
import type { HelpAudience } from '../help';

/**
 * Which audiences this caller may read (L86). Member help is open to everyone, staff help needs a signed-in staff user,
 * admin help needs a platform admin. The same rule will apply to the future assistant (L84).
 */
async function allowedAudiences(ctx: Ctx, req: FastifyRequest): Promise<HelpAudience[]> {
  const out: HelpAudience[] = ['member'];
  const s = await getSession(ctx, req);
  if (!s) return out;
  if (s.isAdmin) out.push('staff', 'admin');
  else if ((await loadGrants(ctx.db, s.uid)).length > 0) out.push('staff');
  return out;
}

/** Restricts a requested audience to the allowed ones. Asking for one you cannot read yields nothing, not an error. */
function wanted(allowed: HelpAudience[], requested: unknown): HelpAudience[] {
  if (!requested) return allowed;
  const r = String(requested).split(',').map((s) => s.trim()) as HelpAudience[];
  return allowed.filter((a) => r.includes(a));
}

const audienceClause = (n: number, count: number, start = 1) => {
  // An article is visible if any of its audiences is allowed.
  const parts = Array.from({ length: count }, (_, i) => `a.audiences @> $${start + i}::jsonb`);
  return `(${parts.join(' OR ')})`;
};

export function helpRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/help/articles', async (req) => {
    const q = req.query as any;
    const aud = wanted(await allowedAudiences(ctx, req), q.audience);
    if (aud.length === 0) return [];
    const lang = String(q.lang ?? 'en');
    return ctx.db.query<any>(
      `SELECT a.id, a.title, a.area, a.tags, a.audiences, a.version FROM help_articles a
        WHERE a.lang = $1 AND ${audienceClause(0, aud.length, 2)} ORDER BY a.area, a.title`,
      [lang, ...aud.map((x) => JSON.stringify([x]))],
    );
  });

  app.get('/help/articles/:id', async (req) => {
    const aud = await allowedAudiences(ctx, req);
    const a = (await ctx.db.query<any>(`SELECT * FROM help_articles a WHERE a.id=$1 AND ${audienceClause(0, aud.length, 2)}`, [(req.params as any).id, ...aud.map((x) => JSON.stringify([x]))]))[0];
    // The same answer for "does not exist" and "not yours", so article ids cannot be probed.
    if (!a) throw new HttpError(404, 'We could not find that help article', 'not_found');
    const related = await ctx.db.query<any>(`SELECT id, title FROM help_articles a WHERE a.area=$1 AND a.id<>$2 AND ${audienceClause(0, aud.length, 3)} ORDER BY title LIMIT 5`, [a.area, a.id, ...aud.map((x) => JSON.stringify([x]))]);
    return { ...a, related };
  });

  /** Articles that explain a screen, used by contextual "learn more" links. */
  app.get('/help/context', async (req) => {
    const screen = String((req.query as any).screen ?? '');
    const aud = await allowedAudiences(ctx, req);
    return ctx.db.query<any>(
      `SELECT a.id, a.title, a.area FROM help_articles a WHERE a.screens @> $1::jsonb AND ${audienceClause(0, aud.length, 2)} ORDER BY a.title`,
      [JSON.stringify([screen]), ...aud.map((x) => JSON.stringify([x]))],
    );
  });

  /**
   * Full-text search over chunks. With ?full=1 it returns whole chunks with metadata, which is the retrieval interface
   * the future assistant will use (L84).
   */
  app.get('/help/search', async (req) => {
    const q = req.query as any;
    const text = String(q.q ?? '').trim().slice(0, 200);
    if (!text) return { query: '', results: [] };
    const aud = wanted(await allowedAudiences(ctx, req), q.audience);
    if (aud.length === 0) return { query: text, results: [] };
    const limit = Math.min(Math.max(Number(q.limit ?? 8), 1), 20);
    const lang = String(q.lang ?? 'en');
    const full = q.full === '1' || q.full === 'true';
    const rows = await ctx.db.query<any>(
      `SELECT c.id AS chunk_id, a.id AS article_id, a.title, a.area, a.tags, a.version, c.heading, c.text,
              ts_rank(c.tsv, websearch_to_tsquery('english', $1)) AS rank,
              ts_headline('english', c.text, websearch_to_tsquery('english', $1), 'MaxWords=28, MinWords=10, StartSel=<<, StopSel=>>') AS snippet
         FROM help_chunks c JOIN help_articles a ON a.id = c.article_id
        WHERE c.tsv @@ websearch_to_tsquery('english', $1) AND a.lang = $2 AND ${audienceClause(0, aud.length, 3)}
        ORDER BY rank DESC LIMIT ${limit}`,
      [text, lang, ...aud.map((x) => JSON.stringify([x]))],
    );
    return {
      query: text,
      results: rows.map((r) => ({
        articleId: r.article_id, chunkId: r.chunk_id, title: r.title, heading: r.heading, area: r.area, rank: Number(r.rank),
        snippet: r.snippet, ...(full ? { text: r.text, tags: r.tags, version: r.version } : {}),
      })),
    };
  });
}
