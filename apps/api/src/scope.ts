import type { FastifyRequest } from 'fastify';
import { branchesFor, type Permission } from './auth';
import { HttpError, type Ctx } from './ctx';

/** Who a notice, event or advert is for. The same three choices everywhere (L131, L133, L134). */
export type Audience = { type: 'org' } | { type: 'branch'; id: string } | { type: 'group'; id: string };

export interface Grants {
  orgId: string;
  branchIds: string[];
  /** True when the person holds the permission over every branch of the organisation. */
  wholeOrg: boolean;
}

/** The organisation and branches where the signed-in user holds a permission. A user in several organisations picks one with ?org=. */
export async function grantsFor(ctx: Ctx, req: FastifyRequest, permission: Permission, orgHint?: string): Promise<Grants> {
  const rows = await branchesFor(ctx.db, req.session!.uid, permission);
  if (rows.length === 0) throw new HttpError(403, `missing permission ${permission}`, 'forbidden');
  const wanted = orgHint ?? ((req.query as any)?.org as string | undefined);
  const orgId = wanted && rows.some((r) => r.orgId === wanted) ? wanted : rows[0].orgId;
  const branchIds = rows.filter((r) => r.orgId === orgId).map((r) => r.branchId);
  const all = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM branches WHERE org_id=$1`, [orgId]))[0].n);
  return { orgId, branchIds, wholeOrg: branchIds.length === all };
}

/** Checks an audience the publisher chose is one they manage, and returns where to file it. */
export async function audienceOf(ctx: Ctx, raw: any, g: Grants): Promise<{ audience: Audience; branchId: string | null; label: string }> {
  const t = raw?.type;
  if (t === 'org') {
    if (!g.wholeOrg) throw new HttpError(403, 'Only people who manage every branch can publish to the whole church. Choose a branch or group.', 'forbidden');
    return { audience: { type: 'org' }, branchId: null, label: 'Whole church' };
  }
  if (t === 'branch') {
    const b = (await ctx.db.query<any>(`SELECT id, name FROM branches WHERE id=$1 AND org_id=$2`, [raw.id, g.orgId]))[0];
    if (!b) throw new HttpError(404, 'That branch was not found', 'not_found');
    if (!g.branchIds.includes(b.id)) throw new HttpError(403, 'You do not manage that branch', 'forbidden');
    return { audience: { type: 'branch', id: b.id }, branchId: b.id, label: b.name };
  }
  if (t === 'group') {
    const gr = (await ctx.db.query<any>(`SELECT id, name, branch_id FROM groups WHERE id=$1 AND org_id=$2`, [raw.id, g.orgId]))[0];
    if (!gr) throw new HttpError(404, 'That group was not found', 'not_found');
    if (gr.branch_id ? !g.branchIds.includes(gr.branch_id) : !g.wholeOrg) throw new HttpError(403, 'You do not manage that group', 'forbidden');
    return { audience: { type: 'group', id: gr.id }, branchId: gr.branch_id ?? null, label: gr.name };
  }
  throw new HttpError(400, 'Choose who it is for: the whole church, a branch or a group', 'bad_audience');
}

export async function audienceLabel(ctx: Ctx, audience: Audience): Promise<string> {
  if (audience.type === 'org') return 'Whole church';
  if (audience.type === 'branch') return (await ctx.db.query<any>(`SELECT name FROM branches WHERE id=$1`, [audience.id]))[0]?.name ?? 'A branch';
  return (await ctx.db.query<any>(`SELECT name FROM groups WHERE id=$1`, [audience.id]))[0]?.name ?? 'A group';
}

/** Whether a staff member with a permission may act on something filed under (orgId, branchId). Out of scope reads as missing, never forbidden. */
export async function inStaffScope(ctx: Ctx, req: FastifyRequest, permission: Permission, orgId: string, branchId: string | null): Promise<boolean> {
  const rows = await branchesFor(ctx.db, req.session!.uid, permission);
  const mine = rows.filter((r) => r.orgId === orgId).map((r) => r.branchId);
  if (branchId) return mine.includes(branchId);
  const all = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM branches WHERE org_id=$1`, [orgId]))[0].n);
  return mine.length === all && all > 0;
}

/**
 * SQL that is true when the signed-in member ($uid) is in the audience of row alias \`a\`: the whole church, their branch, or their group.
 * \`a\` needs org_id and an audience jsonb column. Pass the placeholder number holding the user id.
 */
export const audienceMatchSql = (a: string, uid: string) => `EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=${uid} AND m.status='active' AND m.org_id=${a}.org_id AND (
      ${a}.audience->>'type'='org'
      OR (${a}.audience->>'type'='branch' AND m.branch_id=${a}.audience->>'id')
      OR (${a}.audience->>'type'='group' AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id=${a}.audience->>'id' AND gm.membership_id=m.id))))`;

/** The users (people with accounts) a row's audience reaches, for in-app alerts. Children have no account, so only adults appear. */
export async function audienceUserIds(ctx: Ctx, orgId: string, audience: Audience): Promise<string[]> {
  const base = `SELECT DISTINCT m.user_id FROM memberships m WHERE m.org_id=$1 AND m.status='active' AND m.user_id IS NOT NULL`;
  if (audience.type === 'org') return (await ctx.db.query<any>(base, [orgId])).map((r) => r.user_id);
  if (audience.type === 'branch') return (await ctx.db.query<any>(`${base} AND m.branch_id=$2`, [orgId, audience.id])).map((r) => r.user_id);
  return (await ctx.db.query<any>(`${base} AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id=$2 AND gm.membership_id=m.id)`, [orgId, audience.id])).map((r) => r.user_id);
}
