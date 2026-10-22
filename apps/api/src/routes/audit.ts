import type { FastifyInstance } from 'fastify';
import { canonical, verifyChains } from '@churchos/ledger';
import { HttpError, requireAdmin, requireSession, staffScope, type Ctx } from '../ctx';
import { csv } from './helpers';
import { intParam } from '../limits';

/** Who may see what: an organisation, optionally narrowed to some branches. Null means every church (platform admins). */
interface Visible {
  orgId: string | null;
  branchIds: string[] | null;
}

const EVENT_COLS = `e.seq, e.id, e.at, e.org_id, e.branch_id, e.actor_id, e.actor_name, e.actor_type, e.action, e.category, e.entity, e.entity_id,
  e.summary, e.changes, e.reason, e.ip, e.user_agent, e.app, e.request_id, e.links, e.meta, e.hash`;

function where(v: Visible, q: any, startAt = 1): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const parts: string[] = [];
  const add = (sql: string, val: unknown) => {
    params.push(val);
    // One value can fill several placeholders in the same clause.
    parts.push(sql.split('?').join(`$${startAt + params.length - 1}`));
  };
  if (v.orgId) add('e.org_id = ?', v.orgId);
  // Events with no branch belong to the whole church, so they stay visible when narrowed to some branches.
  if (v.branchIds) add('(e.branch_id IS NULL OR e.branch_id = ANY(?::text[]))', v.branchIds);
  if (!v.orgId && q.org) add('e.org_id = ?', String(q.org));
  if (q.from) add('e.at >= ?', new Date(q.from).toISOString());
  if (q.to) add('e.at <= ?', new Date(new Date(q.to).getTime() + 86400_000 - 1).toISOString());
  if (q.category) add('e.category = ?', String(q.category));
  // Wildcard characters typed by the user are escaped, so an action name with an underscore matches literally.
  if (q.action) add("e.action LIKE ? ESCAPE '!'", `${String(q.action).replace(/[!%_]/g, (c) => '!' + c)}%`);
  if (q.entity) add('e.entity = ?', String(q.entity));
  if (q.entityId) add('e.entity_id = ?', String(q.entityId));
  if (q.actor) add('(e.actor_id = ? OR lower(COALESCE(e.actor_name, \'\')) LIKE lower(\'%\' || ? || \'%\'))', String(q.actor));
  if (q.q) add("(lower(e.summary) LIKE ? OR lower(e.action) LIKE ? OR lower(COALESCE(e.actor_name,'')) LIKE ?)", `%${String(q.q).toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c)}%`);
  if (q.before) add('e.seq < ?', Number(q.before));
  return { sql: parts.length ? parts.join(' AND ') : 'TRUE', params };
}

async function listEvents(ctx: Ctx, v: Visible, q: any) {
  const limit = intParam(q.limit, { min: 1, max: 200, def: 50 });
  const w = where(v, q);
  const rows = await ctx.db.query<any>(`SELECT ${EVENT_COLS} FROM audit_events e WHERE ${w.sql} ORDER BY e.seq DESC LIMIT ${limit + 1}`, w.params);
  const more = rows.length > limit;
  const events = more ? rows.slice(0, limit) : rows;
  return { events, nextBefore: more ? events[events.length - 1].seq : null };
}

function visibleEntity(v: Visible, row: { org_id: string; branch_id: string | null }) {
  if (v.orgId && row.org_id !== v.orgId) return false;
  if (v.branchIds && row.branch_id && !v.branchIds.includes(row.branch_id)) return false;
  return true;
}

async function history(ctx: Ctx, v: Visible, entity: string, entityId: string) {
  const w = where(v, { entity, entityId });
  const events = await ctx.db.query<any>(`SELECT ${EVENT_COLS} FROM audit_events e WHERE ${w.sql} ORDER BY e.seq ASC LIMIT 500`, w.params);
  const versions = (
    await ctx.db.query<any>(
      `SELECT version, summary, changed_by, changed_by_name, changed_at, event_id, org_id, branch_id FROM entity_versions WHERE entity=$1 AND entity_id=$2 ORDER BY version`,
      [entity, entityId],
    )
  ).filter((r) => visibleEntity(v, r));
  return { entity, entityId, events, versions: versions.map(({ org_id: _o, branch_id: _b, ...r }) => r) };
}

async function version(ctx: Ctx, v: Visible, entity: string, entityId: string, n: number) {
  const r = (await ctx.db.query<any>(`SELECT * FROM entity_versions WHERE entity=$1 AND entity_id=$2 AND version=$3`, [entity, entityId, n]))[0];
  if (!r || !visibleEntity(v, r)) throw new HttpError(404, 'We could not find that version', 'not_found');
  return { entity, entityId, version: r.version, summary: r.summary, changedBy: r.changed_by_name, changedAt: r.changed_at, snapshot: r.snapshot };
}

/** Field-by-field comparison of two versions of the same thing. Only fields that differ are returned. */
async function compare(ctx: Ctx, v: Visible, entity: string, entityId: string, from: number, to: number) {
  const a = await version(ctx, v, entity, entityId, from);
  const b = await version(ctx, v, entity, entityId, to);
  const keys = [...new Set([...Object.keys(a.snapshot ?? {}), ...Object.keys(b.snapshot ?? {})])];
  const changes = keys
    .filter((k) => canonical(a.snapshot?.[k] ?? null) !== canonical(b.snapshot?.[k] ?? null))
    .map((k) => ({ field: k, before: a.snapshot?.[k] ?? null, after: b.snapshot?.[k] ?? null }));
  return { entity, entityId, from: { version: a.version, changedBy: a.changedBy, changedAt: a.changedAt }, to: { version: b.version, changedBy: b.changedBy, changedAt: b.changedAt }, changes };
}

const changesText = (c: any[] | null) => (c ?? []).map((x) => `${x.label ?? x.field}: ${JSON.stringify(x.before)} -> ${JSON.stringify(x.after)}`).join('; ');

export function auditRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };
  const adm = { preHandler: requireAdmin };
  const staffVisible = async (req: any, perm: 'audit.view' | 'audit.export'): Promise<Visible> => {
    const s = await staffScope(ctx, req, perm);
    return { orgId: s.orgId, branchIds: s.branchIds };
  };
  const ALL: Visible = { orgId: null, branchIds: null };
  const need = (q: any) => {
    if (!q.entity || !q.entityId) throw new HttpError(400, 'Say which record you want the history of', 'bad_request');
    return { entity: String(q.entity), entityId: String(q.entityId) };
  };

  // ---------- a church's own audit log (L108) ----------

  app.get('/audit/events', auth, async (req) => listEvents(ctx, await staffVisible(req, 'audit.view'), req.query));

  app.get('/audit/events/:id', auth, async (req) => {
    const v = await staffVisible(req, 'audit.view');
    const w = where(v, {});
    const e = (await ctx.db.query<any>(`SELECT ${EVENT_COLS} FROM audit_events e WHERE ${w.sql} AND e.id=$${w.params.length + 1}`, [...w.params, (req.params as any).id]))[0];
    if (!e) throw new HttpError(404, 'We could not find that event', 'not_found');
    return e;
  });

  app.get('/audit/history', auth, async (req) => {
    const { entity, entityId } = need(req.query);
    return history(ctx, await staffVisible(req, 'audit.view'), entity, entityId);
  });

  app.get('/audit/versions/:entity/:id/:version', auth, async (req) => {
    const p = req.params as any;
    return version(ctx, await staffVisible(req, 'audit.view'), p.entity, p.id, Number(p.version));
  });

  app.get('/audit/compare', auth, async (req) => {
    const q = req.query as any;
    const { entity, entityId } = need(q);
    return compare(ctx, await staffVisible(req, 'audit.view'), entity, entityId, Number(q.from), Number(q.to));
  });

  app.get('/audit/verify', auth, async (req) => {
    const v = await staffVisible(req, 'audit.view');
    const [r] = await verifyChains(ctx.db, v.orgId!);
    return r ?? { chain: v.orgId, events: 0, ok: true };
  });

  app.get('/audit/export', auth, async (req, reply) => {
    const v = await staffVisible(req, 'audit.export');
    const { events } = await listEvents(ctx, v, { ...(req.query as any), limit: 200, before: undefined });
    await ctx.ledger.audit({ orgId: v.orgId, action: 'access.audit_export', category: 'access', summary: 'Exported the audit log', meta: { rows: events.length } });
    reply.header('content-type', 'text/csv').header('content-disposition', 'attachment; filename="audit-log.csv"');
    return csv(events.map((e) => ({ time: e.at, who: e.actor_name ?? e.actor_id ?? 'system', capacity: e.actor_type, action: e.action, category: e.category, what: e.summary, record: `${e.entity ?? ''} ${e.entity_id ?? ''}`.trim(), changes: changesText(e.changes), reason: e.reason ?? '', from_ip: e.ip ?? '', app: e.app ?? '' })));
  });

  // ---------- platform admins see every church ----------

  // Kept for the existing admin screen: newest events first.
  app.get('/admin/audit', adm, async (req) => (await listEvents(ctx, ALL, { ...(req.query as any), limit: 100 })).events);
  app.get('/admin/audit/events', adm, async (req) => listEvents(ctx, ALL, req.query));
  app.get('/admin/audit/history', adm, async (req) => {
    const { entity, entityId } = need(req.query);
    return history(ctx, ALL, entity, entityId);
  });
  app.get('/admin/audit/versions/:entity/:id/:version', adm, async (req) => {
    const p = req.params as any;
    return version(ctx, ALL, p.entity, p.id, Number(p.version));
  });
  app.get('/admin/audit/compare', adm, async (req) => {
    const q = req.query as any;
    const { entity, entityId } = need(q);
    return compare(ctx, ALL, entity, entityId, Number(q.from), Number(q.to));
  });
  app.get('/admin/audit/verify', adm, async () => {
    const chains = await verifyChains(ctx.db);
    return { ok: chains.every((c) => c.ok), chains };
  });
}
