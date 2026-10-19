import type { FastifyInstance } from 'fastify';
import { branchesFor } from '../auth';
import { HttpError, requireSession, type Ctx } from '../ctx';

/**
 * What a church calls its gatherings (Slice 25): Service, Mass, Gathering, Meeting or its own word. One setting, held by the owner, that the apps
 * use wherever they say "service". Left alone it stays "Service".
 */

export const PRESETS = [
  { one: 'Service', many: 'Services' },
  { one: 'Mass', many: 'Masses' },
  { one: 'Gathering', many: 'Gatherings' },
  { one: 'Meeting', many: 'Meetings' },
  { one: 'Celebration', many: 'Celebrations' },
];

const clean = (v: unknown, label: string) => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (s.length < 2 || s.length > 24 || !/^[\p{L}][\p{L} '\-]*$/u.test(s)) throw new HttpError(400, `Enter the ${label} using letters only, 2 to 24 characters`, 'bad_word');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export async function wordsFor(ctx: Ctx, orgId: string | null | undefined) {
  const r = orgId ? (await ctx.db.query<any>(`SELECT gathering_one, gathering_many FROM org_settings WHERE org_id=$1`, [orgId]))[0] : null;
  const one = r?.gathering_one || 'Service';
  const many = r?.gathering_many || 'Services';
  return { one, many, oneLower: one.toLowerCase(), manyLower: many.toLowerCase() };
}

export function wordsRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };

  /** The church of the signed-in person: their membership, or the church where they hold a role. */
  async function orgOf(uid: string, hint?: string) {
    if (hint) {
      const ok = (await ctx.db.query<any>(`SELECT 1 FROM memberships WHERE user_id=$1 AND org_id=$2 UNION SELECT 1 FROM role_assignments WHERE user_id=$1 AND org_id=$2`, [uid, hint]))[0];
      if (ok) return hint;
    }
    const r = (await ctx.db.query<any>(`SELECT org_id FROM role_assignments WHERE user_id=$1 LIMIT 1`, [uid]))[0] ?? (await ctx.db.query<any>(`SELECT org_id FROM memberships WHERE user_id=$1 ORDER BY joined_at LIMIT 1`, [uid]))[0];
    return (r?.org_id as string | undefined) ?? null;
  }

  app.get('/me/words', auth, async (req) => {
    const orgId = await orgOf(req.session!.uid, (req.query as any).org);
    const rows = await branchesFor(ctx.db, req.session!.uid, 'church.settings');
    return { ...(await wordsFor(ctx, orgId)), orgId, presets: PRESETS, canChange: !!orgId && rows.some((r) => r.orgId === orgId) };
  });

  app.put('/church/words', auth, async (req) => {
    const rows = await branchesFor(ctx.db, req.session!.uid, 'church.settings');
    if (!rows.length) throw new HttpError(403, 'missing permission church.settings', 'forbidden');
    const orgId = rows[0].orgId;
    const b = (req.body ?? {}) as any;
    const one = clean(b.one, 'word for one gathering');
    const many = clean(b.many, 'word for several gatherings');
    await ctx.db.query(
      `INSERT INTO org_settings (org_id, gathering_one, gathering_many) VALUES ($1,$2,$3) ON CONFLICT (org_id) DO UPDATE SET gathering_one=$2, gathering_many=$3`,
      [orgId, one, many],
    );
    await ctx.ledger.audit({ orgId, actor: req.session!.uid, action: 'church.words', entity: 'organisation', entityId: orgId, summary: `Changed what the church calls its gatherings to "${one}" / "${many}"` });
    return { ...(await wordsFor(ctx, orgId)), ok: true };
  });
}
