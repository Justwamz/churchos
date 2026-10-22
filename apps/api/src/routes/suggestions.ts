import type { FastifyInstance } from 'fastify';
import { branchesFor } from '../auth';
import { formGuard } from '../abuse';
import { HttpError, requireSession, type Ctx } from '../ctx';
import { addNotification } from '../notifications';
import { grantsFor, inStaffScope } from '../scope';
import { csv } from './helpers';

/** The suggestion box (L231): a member sends an idea, named or anonymous; the church answers; some answers are shared as "You said, we did". */

const DAY = 86_400_000;
const PER_DAY = 5;
export const CATEGORIES: Record<string, string> = {
  worship: 'Worship and services',
  facilities: 'Buildings and facilities',
  children_youth: 'Children and youth',
  giving: 'Giving and finances',
  communication: 'Communication',
  other: 'Something else',
};
const STATUS_LABEL: Record<string, string> = { new: 'New', under_review: 'Under review', done: 'Done', not_possible: 'Not possible' };

const clean = (v: unknown, n: number) => String(v ?? '').trim().replace(/[ \t]+/g, ' ').slice(0, n);

export function suggestionRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };
  const nowIso = () => ctx.clock.now().toISOString();

  async function myMemberships(uid: string) {
    return ctx.db.query<any>(`SELECT m.id, m.org_id, m.branch_id, m.full_name, b.name AS branch, o.name AS church FROM memberships m JOIN branches b ON b.id=m.branch_id JOIN organisations o ON o.id=m.org_id WHERE m.user_id=$1 AND m.status='active' AND m.category='adult' ORDER BY m.joined_at`, [uid]);
  }

  const mineView = (r: any) => ({ id: r.id, category: r.category, categoryLabel: CATEGORIES[r.category] ?? r.category, body: r.body, anonymous: r.membership_id === null, status: r.status, statusLabel: STATUS_LABEL[r.status], response: r.response, respondedAt: r.responded_at, published: r.published, createdAt: r.created_at, church: r.church, branch: r.branch });

  app.get('/me/suggestions/info', auth, async (req) => {
    const ms = await myMemberships(req.session!.uid);
    return { categories: Object.entries(CATEGORIES).map(([key, label]) => ({ key, label })), memberships: ms.map((m) => ({ membershipId: m.id, church: m.church, branch: m.branch })) };
  });

  app.post('/me/suggestions', auth, async (req) => {
    formGuard(ctx, req.session!.uid, 'suggestion');
    const uid = req.session!.uid;
    const b = (req.body ?? {}) as any;
    const body = clean(b.body, 1000);
    if (body.length < 10) throw new HttpError(400, 'Tell us a little more: at least a sentence', 'bad_content');
    const category = String(b.category ?? 'other');
    if (!CATEGORIES[category]) throw new HttpError(400, 'Choose a category', 'bad_category');
    const ms = await myMemberships(uid);
    const m = b.membershipId ? ms.find((x) => x.id === String(b.membershipId)) : ms[0];
    if (!m) throw new HttpError(403, 'The suggestion box is for members of a church', 'not_a_member');
    const recent = await ctx.db.query<any>(`SELECT count(*)::int AS n FROM suggestions s JOIN suggestion_owners o ON o.suggestion_id=s.id WHERE o.user_id=$1 AND s.created_at > $2`, [uid, new Date(ctx.clock.now().getTime() - DAY).toISOString()]);
    if (Number(recent[0].n) >= PER_DAY) throw new HttpError(429, 'You have sent a few suggestions today. Please try again tomorrow.', 'too_many');
    const anonymous = !!b.anonymous;
    const id = ctx.newId('sug');
    await ctx.db.query(`INSERT INTO suggestions (id, org_id, branch_id, membership_id, author_name, category, body, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`, [id, m.org_id, m.branch_id, anonymous ? null : m.id, anonymous ? null : m.full_name, category, body, nowIso()]);
    await ctx.db.query(`INSERT INTO suggestion_owners (suggestion_id, user_id) VALUES ($1,$2)`, [id, uid]);
    // The people who read suggestions are told there is a new one. Nothing about who sent it.
    const users = await ctx.db.query<any>(`SELECT DISTINCT user_id FROM role_assignments WHERE org_id=$1`, [m.org_id]);
    for (const u of users) {
      if (!(await branchesFor(ctx.db, u.user_id, 'suggestions.view')).some((x) => x.orgId === m.org_id && x.branchId === m.branch_id)) continue;
      await addNotification(ctx, { orgId: m.org_id, userId: u.user_id, kind: 'announcement', title: 'New suggestion', body: `A new suggestion in the box: ${CATEGORIES[category]}. Open Suggestions in the staff app.`, link: `staff:suggestions?open=${id}`, audience: 'staff' });
    }
    return { id, anonymous };
  });

  app.get('/me/suggestions', auth, async (req) => {
    const rows = await ctx.db.query<any>(
      `SELECT s.*, b.name AS branch, o.name AS church FROM suggestions s JOIN suggestion_owners w ON w.suggestion_id=s.id JOIN branches b ON b.id=s.branch_id JOIN organisations o ON o.id=s.org_id WHERE w.user_id=$1 ORDER BY s.created_at DESC LIMIT 100`,
      [req.session!.uid],
    );
    return { suggestions: rows.map(mineView) };
  });

  /** "You said, we did": suggestions the church chose to share, with their answers, and never who sent them. */
  app.get('/me/suggestions/published', auth, async (req) => {
    const ms = await myMemberships(req.session!.uid);
    if (!ms.length) return { suggestions: [] };
    const rows = await ctx.db.query<any>(`SELECT s.id, s.category, s.body, s.status, s.response, s.responded_at FROM suggestions s WHERE s.published AND s.branch_id = ANY($1::text[]) ORDER BY s.responded_at DESC LIMIT 50`, [[...new Set(ms.map((m) => m.branch_id))]]);
    return { suggestions: rows.map((r) => ({ id: r.id, categoryLabel: CATEGORIES[r.category] ?? r.category, body: r.body, status: r.status, statusLabel: STATUS_LABEL[r.status], response: r.response, respondedAt: r.responded_at })) };
  });

  // ======================= the church =======================

  app.get('/suggestions', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'suggestions.view');
    const q = req.query as any;
    const params: unknown[] = [g.orgId, g.branchIds];
    let where = `s.org_id=$1 AND s.branch_id = ANY($2::text[])`;
    if (q.branchId) { params.push(String(q.branchId)); where += ` AND s.branch_id=$${params.length}`; }
    if (q.status) { params.push(String(q.status)); where += ` AND s.status=$${params.length}`; }
    if (q.category) { params.push(String(q.category)); where += ` AND s.category=$${params.length}`; }
    if (q.q) { params.push(`%${String(q.q).replace(/[\\%_]/g, (c) => '\\' + c)}%`); where += ` AND (s.body ILIKE $${params.length} OR s.author_name ILIKE $${params.length})`; }
    const rows = await ctx.db.query<any>(`SELECT s.*, b.name AS branch FROM suggestions s JOIN branches b ON b.id=s.branch_id WHERE ${where} ORDER BY (s.status='new') DESC, s.created_at DESC LIMIT 500`, params);
    const view = rows.map((s) => ({ id: s.id, category: s.category, categoryLabel: CATEGORIES[s.category] ?? s.category, body: s.body, author: s.author_name ?? 'Anonymous', anonymous: s.membership_id === null, branch: s.branch, status: s.status, statusLabel: STATUS_LABEL[s.status], response: s.response, respondedAt: s.responded_at, published: s.published, createdAt: s.created_at }));
    if (q.csv) return csv(view.map((v) => ({ Date: v.createdAt, From: v.author, Branch: v.branch, Category: v.categoryLabel, Suggestion: v.body, Status: v.statusLabel, Reply: v.response ?? '', Published: v.published ? 'yes' : '' })));
    const count = (st: string) => view.filter((v) => v.status === st).length;
    return { suggestions: view, summary: { new: count('new'), under_review: count('under_review'), done: count('done'), not_possible: count('not_possible') }, categories: Object.entries(CATEGORIES).map(([key, label]) => ({ key, label })) };
  });

  app.post('/suggestions/:id', auth, async (req) => {
    const s = (await ctx.db.query<any>(`SELECT * FROM suggestions WHERE id=$1`, [(req.params as any).id]))[0];
    if (!s || !(await inStaffScope(ctx, req, 'suggestions.view', s.org_id, s.branch_id))) throw new HttpError(404, 'not found', 'not_found');
    const b = (req.body ?? {}) as any;
    const status = b.status === undefined ? s.status : String(b.status);
    if (!STATUS_LABEL[status]) throw new HttpError(400, 'Choose a status', 'bad_status');
    const response = b.response !== undefined ? clean(b.response, 500) || null : s.response;
    const publish = b.publish === undefined ? s.published : !!b.publish;
    if (publish && !response) throw new HttpError(400, 'Write the answer before sharing it with the church', 'reply_required');
    if (status === 'done' || status === 'not_possible') { if (!response) throw new HttpError(400, 'Tell the member what happened with it', 'reply_required'); }
    const replied = response !== s.response || status !== s.status;
    await ctx.db.query(`UPDATE suggestions SET status=$2, response=$3, published=$4, responded_by=CASE WHEN $5 THEN $6 ELSE responded_by END, responded_at=CASE WHEN $5 THEN $7 ELSE responded_at END, updated_at=$7 WHERE id=$1`, [s.id, status, response, publish, replied, req.session!.uid, nowIso()]);
    await ctx.ledger.audit({ orgId: s.org_id, branchId: s.branch_id, actor: req.session!.uid, action: 'suggestion.updated', entity: 'suggestion', entityId: s.id, summary: `Suggestion marked ${STATUS_LABEL[status].toLowerCase()}${publish && !s.published ? ' and shared with the church' : ''}` });
    if (replied) {
      const owner = (await ctx.db.query<any>(`SELECT user_id FROM suggestion_owners WHERE suggestion_id=$1`, [s.id]))[0];
      if (owner) await addNotification(ctx, { orgId: s.org_id, userId: owner.user_id, kind: 'announcement', title: 'Your suggestion has an answer', body: `Your suggestion is now "${STATUS_LABEL[status]}".${response ? ` ${response}` : ''}`, link: 'member:suggestions' });
    }
    return { ok: true };
  });
}
