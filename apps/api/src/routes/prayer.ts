import type { FastifyInstance } from 'fastify';
import { HttpError, requireSession, type Ctx } from '../ctx';
import { addNotification } from '../notifications';
import { grantsFor, inStaffScope } from '../scope';

/**
 * Prayer requests and the pastoral notice (L225 to L230). There is no care inbox and no chat: talking to a pastor is a booking,
 * and a prayer request is a short text that someone chooses to share with the team, a group, a branch or the church.
 */

const DAY = 86_400_000;
const SHOW_DAYS = 60;
const SHOW_ANSWERED_DAYS = 14;
const REMOVE_AFTER_DAYS = 365;
const PER_DAY = 10;
const AUDIENCES = ['team', 'group', 'branch', 'church'] as const;

export const DEFAULT_HELPLINES = [
  { name: 'Emergency', phone: '999', note: 'Police, ambulance and fire. From a mobile you can also call 112.' },
  { name: 'Childline Kenya', phone: '116', note: 'Free, any time, for children and young people.' },
  { name: 'Gender violence helpline', phone: '1195', note: 'Free, any time.' },
  { name: 'Kenya Red Cross counselling', phone: '1199', note: 'Free counselling line.' },
];

export const PASTORAL_NOTICE =
  'What you write or say to a pastor or counsellor is private. Only the people you speak with can know it. ChurchOS staff and church administrators can see that a booking or prayer request exists, but not what was said. Nothing is recorded in calls. Confidentiality has limits: if someone may be at risk of serious harm, or a child may be being hurt, the church has to act to keep them safe. If you are in danger right now, call the emergency number below.';

const cap = (v: unknown, n: number) => String(v ?? '').trim().replace(/[ \t]+/g, ' ').slice(0, n);

export function prayerRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };
  const nowIso = () => ctx.clock.now().toISOString();

  async function helplinesOf(orgId: string) {
    const r = (await ctx.db.query<any>(`SELECT helplines FROM pastoral_settings WHERE org_id=$1`, [orgId]))[0];
    return { helplines: r ? r.helplines : DEFAULT_HELPLINES, standard: !r };
  }

  async function myMemberships(uid: string) {
    return ctx.db.query<any>(`SELECT m.id, m.org_id, m.branch_id, m.full_name, b.name AS branch FROM memberships m JOIN branches b ON b.id=m.branch_id WHERE m.user_id=$1 AND m.status='active' AND m.category='adult' ORDER BY m.joined_at`, [uid]);
  }

  async function myGroups(membershipIds: string[]) {
    if (!membershipIds.length) return [];
    return ctx.db.query<any>(`SELECT g.id, g.name, g.org_id FROM group_members gm JOIN groups g ON g.id=gm.group_id WHERE gm.membership_id = ANY($1::text[]) ORDER BY g.name`, [membershipIds]);
  }

  // ======================= members =======================

  app.get('/me/pastoral/info', auth, async (req) => {
    const ms = await myMemberships(req.session!.uid);
    const org = ms[0]?.org_id;
    const h = org ? await helplinesOf(org) : { helplines: DEFAULT_HELPLINES, standard: true };
    return { notice: PASTORAL_NOTICE, helplines: h.helplines, groups: (await myGroups(ms.map((m) => m.id))).map((g) => ({ id: g.id, name: g.name })), branches: ms.map((m) => ({ membershipId: m.id, branch: m.branch })) };
  });

  const view = (r: any, mine: boolean, prayed: boolean, prayers: number, groupName: string | null) => ({
    id: r.id, body: r.body, audience: r.audience, groupName, author: r.anonymous ? 'A member' : r.author_name, anonymous: r.anonymous, mine, prayed, prayers, status: r.status, answeredNote: r.answered_note, answeredAt: r.answered_at, createdAt: r.created_at,
  });

  app.get('/me/prayer', auth, async (req) => {
    const uid = req.session!.uid;
    const ms = await myMemberships(uid);
    if (!ms.length) return { requests: [] };
    const groups = await myGroups(ms.map((m) => m.id));
    const since = new Date(ctx.clock.now().getTime() - SHOW_DAYS * DAY).toISOString();
    const answeredSince = new Date(ctx.clock.now().getTime() - SHOW_ANSWERED_DAYS * DAY).toISOString();
    const rows = await ctx.db.query<any>(
      `SELECT r.*, (r.id IN (SELECT prayer_id FROM prayer_owners WHERE user_id=$1)) AS mine, g.name AS group_name,
              (SELECT count(*)::int FROM prayer_prays p WHERE p.prayer_id=r.id) AS prayers, EXISTS (SELECT 1 FROM prayer_prays p WHERE p.prayer_id=r.id AND p.user_id=$1) AS prayed
         FROM prayer_requests r LEFT JOIN groups g ON g.id=r.group_id
        WHERE (r.id IN (SELECT prayer_id FROM prayer_owners WHERE user_id=$1)
               OR (r.status <> 'hidden' AND (
                    (r.audience='church' AND r.org_id = ANY($2::text[]))
                 OR (r.audience='branch' AND r.branch_id = ANY($3::text[]))
                 OR (r.audience='group' AND r.group_id = ANY($4::text[])))))
          AND (r.created_at >= $5 OR (r.answered_at IS NOT NULL AND r.answered_at >= $6))
        ORDER BY r.created_at DESC LIMIT 100`,
      [uid, [...new Set(ms.map((m) => m.org_id))], [...new Set(ms.map((m) => m.branch_id))], groups.map((g) => g.id), since, answeredSince],
    );
    // A request that is hidden was either taken down by its author or hidden by the prayer team: the author is told which.
    return { requests: rows.map((r) => ({ ...view(r, r.mine, r.prayed, r.prayers, r.group_name), takenDownBy: r.status === 'hidden' ? (r.hidden_by === uid ? 'you' : 'team') : null })) };
  });

  app.post('/me/prayer', auth, async (req) => {
    const uid = req.session!.uid;
    const b = (req.body ?? {}) as any;
    const body = String(b.body ?? '').trim().replace(/[ \t]+/g, ' ').slice(0, 600);
    if (body.length < 3) throw new HttpError(400, 'Write your prayer request', 'bad_content');
    const audience = String(b.audience ?? 'team');
    if (!(AUDIENCES as readonly string[]).includes(audience)) throw new HttpError(400, 'Choose who can see your request', 'bad_audience');
    const ms = await myMemberships(uid);
    if (!ms.length) throw new HttpError(403, 'Prayer requests are for members of a church', 'not_a_member');
    let m = ms[0];
    let groupId: string | null = null;
    if (audience === 'group') {
      const g = (await myGroups(ms.map((x) => x.id))).find((x) => x.id === String(b.groupId ?? ''));
      if (!g) throw new HttpError(400, 'Choose one of your groups', 'bad_group');
      groupId = g.id;
      m = ms.find((x) => x.org_id === g.org_id) ?? m;
    }
    const today = await ctx.db.query<any>(`SELECT count(*)::int AS n FROM prayer_requests r JOIN prayer_owners o ON o.prayer_id=r.id WHERE o.user_id=$1 AND r.created_at > $2`, [uid, new Date(ctx.clock.now().getTime() - DAY).toISOString()]);
    if (Number(today[0].n) >= PER_DAY) throw new HttpError(429, 'You have sent a lot of requests today. Please try again tomorrow.', 'too_many');
    const id = ctx.newId('pr');
    const anonymous = !!b.anonymous;
    await ctx.db.query(
      `INSERT INTO prayer_requests (id, org_id, branch_id, body, audience, group_id, anonymous, author_name, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [id, m.org_id, m.branch_id, body, audience, groupId, anonymous, anonymous ? null : m.full_name, nowIso()],
    );
    await ctx.db.query(`INSERT INTO prayer_owners (prayer_id, user_id) VALUES ($1,$2)`, [id, uid]);
    return { id };
  });

  async function visibleToMe(uid: string, id: string) {
    const rows = (await ctx.db.query<any>(`SELECT * FROM prayer_requests WHERE id=$1`, [id]))[0];
    if (!rows) throw new HttpError(404, 'not found', 'not_found');
    const owner = (await ctx.db.query<any>(`SELECT 1 FROM prayer_owners WHERE prayer_id=$1 AND user_id=$2`, [id, uid]))[0];
    if (owner) return { r: rows, owner: true };
    if (rows.status === 'hidden' || rows.audience === 'team') throw new HttpError(404, 'not found', 'not_found');
    const ms = await myMemberships(uid);
    const ok = rows.audience === 'church' ? ms.some((m) => m.org_id === rows.org_id)
      : rows.audience === 'branch' ? ms.some((m) => m.branch_id === rows.branch_id)
        : (await myGroups(ms.map((m) => m.id))).some((g) => g.id === rows.group_id);
    if (!ok) throw new HttpError(404, 'not found', 'not_found');
    return { r: rows, owner: false };
  }

  app.post('/me/prayer/:id/pray', auth, async (req) => {
    const { r } = await visibleToMe(req.session!.uid, (req.params as any).id);
    await ctx.db.query(`INSERT INTO prayer_prays (prayer_id, user_id, at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [r.id, req.session!.uid, nowIso()]);
    const n = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM prayer_prays WHERE prayer_id=$1`, [r.id]))[0].n);
    return { prayers: n, prayed: true };
  });

  app.post('/me/prayer/:id/answered', auth, async (req) => {
    const { r, owner } = await visibleToMe(req.session!.uid, (req.params as any).id);
    if (!owner) throw new HttpError(403, 'Only the person who wrote it can mark it answered', 'forbidden');
    await ctx.db.query(`UPDATE prayer_requests SET status='answered', answered_at=$2, answered_note=$3, updated_at=$2 WHERE id=$1 AND status <> 'hidden'`, [r.id, nowIso(), cap((req.body as any)?.note, 200) || null]);
    return { ok: true };
  });

  app.post('/me/prayer/:id/withdraw', auth, async (req) => {
    const { r, owner } = await visibleToMe(req.session!.uid, (req.params as any).id);
    if (!owner) throw new HttpError(403, 'Only the person who wrote it can take it down', 'forbidden');
    await ctx.db.query(`UPDATE prayer_requests SET status='hidden', hidden_by=$2, updated_at=$3 WHERE id=$1`, [r.id, req.session!.uid, nowIso()]);
    return { ok: true };
  });

  // ======================= the prayer team (L227, L228) =======================

  app.get('/prayer', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'prayer.respond');
    const q = req.query as any;
    const params: unknown[] = [g.orgId, g.branchIds];
    let where = `r.org_id=$1 AND r.branch_id = ANY($2::text[])`;
    if (q.status) { params.push(String(q.status)); where += ` AND r.status=$${params.length}`; }
    if (q.audience) { params.push(String(q.audience)); where += ` AND r.audience=$${params.length}`; }
    const rows = await ctx.db.query<any>(
      `SELECT r.*, b.name AS branch, gr.name AS group_name, (SELECT count(*)::int FROM prayer_prays p WHERE p.prayer_id=r.id) AS prayers
         FROM prayer_requests r JOIN branches b ON b.id=r.branch_id LEFT JOIN groups gr ON gr.id=r.group_id WHERE ${where} ORDER BY (r.status='open') DESC, r.created_at DESC LIMIT 300`,
      params,
    );
    return { requests: rows.map((r) => ({ id: r.id, body: r.body, audience: r.audience, groupName: r.group_name, author: r.anonymous ? 'A member' : r.author_name, anonymous: r.anonymous, branch: r.branch, status: r.status, prayers: r.prayers, answeredNote: r.answered_note, createdAt: r.created_at })) };
  });

  async function teamRequest(req: any, id: string) {
    const r = (await ctx.db.query<any>(`SELECT * FROM prayer_requests WHERE id=$1`, [id]))[0];
    if (!r || !(await inStaffScope(ctx, req, 'prayer.respond', r.org_id, r.branch_id))) throw new HttpError(404, 'not found', 'not_found');
    return r;
  }

  app.post('/prayer/:id/answer', auth, async (req) => {
    const r = await teamRequest(req, (req.params as any).id);
    await ctx.db.query(`UPDATE prayer_requests SET status='answered', answered_at=$2, answered_note=$3, updated_at=$2 WHERE id=$1 AND status <> 'hidden'`, [r.id, nowIso(), cap((req.body as any)?.note, 200) || null]);
    await ctx.ledger.audit({ orgId: r.org_id, branchId: r.branch_id, actor: req.session!.uid, action: 'prayer.answered', entity: 'prayer_request', entityId: r.id, summary: 'Marked a prayer request as answered' });
    return { ok: true };
  });

  app.post('/prayer/:id/hide', auth, async (req) => {
    const r = await teamRequest(req, (req.params as any).id);
    const hide = (req.body as any)?.restore !== true;
    const reason = cap((req.body as any)?.reason, 200);
    if (hide && !reason) throw new HttpError(400, 'Say why you are hiding it', 'bad_content');
    await ctx.db.query(`UPDATE prayer_requests SET status=$2, hidden_by=$3, updated_at=$4 WHERE id=$1`, [r.id, hide ? 'hidden' : 'open', hide ? req.session!.uid : null, nowIso()]);
    await ctx.ledger.audit({ orgId: r.org_id, branchId: r.branch_id, actor: req.session!.uid, action: hide ? 'prayer.hidden' : 'prayer.restored', entity: 'prayer_request', entityId: r.id, summary: hide ? 'Hid a prayer request from the shared lists' : 'Showed a prayer request again', reason: hide ? reason : undefined });
    const owner = (await ctx.db.query<any>(`SELECT user_id FROM prayer_owners WHERE prayer_id=$1`, [r.id]))[0];
    if (hide && owner) await addNotification(ctx, { orgId: r.org_id, userId: owner.user_id, kind: 'announcement', title: 'Your prayer request was taken off the shared list', body: `The prayer team took your request off the shared list: ${reason}. They will still pray for you. You can speak to a pastor by booking a time in the app.`, link: 'member:prayer' });
    return { ok: true };
  });

  // ======================= helplines (L229) =======================

  function helplineList(raw: unknown) {
    const list = Array.isArray(raw) ? raw : [];
    if (list.length < 1 || list.length > 8) throw new HttpError(400, 'Add from 1 to 8 numbers', 'bad_helplines');
    return list.map((h: any) => {
      const name = cap(h?.name, 60);
      const phone = cap(h?.phone, 20);
      if (!name || !/^[0-9+ ]{3,20}$/.test(phone)) throw new HttpError(400, 'Each line needs a name and a phone number', 'bad_helplines');
      return { name, phone, note: cap(h?.note, 120) };
    });
  }

  app.get('/pastoral/settings', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'bookings.manage');
    const h = await helplinesOf(g.orgId);
    return { helplines: h.helplines, standard: h.standard, notice: PASTORAL_NOTICE, canEdit: g.wholeOrg };
  });

  app.put('/pastoral/settings', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'bookings.manage');
    if (!g.wholeOrg) throw new HttpError(403, 'Only people who manage every branch can change the helplines', 'forbidden');
    const list = helplineList((req.body as any)?.helplines);
    await ctx.db.query(`INSERT INTO pastoral_settings (org_id, helplines, updated_by, updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (org_id) DO UPDATE SET helplines=$2, updated_by=$3, updated_at=$4`, [g.orgId, JSON.stringify(list), req.session!.uid, nowIso()]);
    await ctx.ledger.audit({ orgId: g.orgId, actor: req.session!.uid, action: 'prayer.helplines', entity: 'organisation', entityId: g.orgId, summary: 'Changed the helplines shown to members' });
    return { ok: true };
  });
}

/** What members wrote is removed a year on. The fact that a request existed stays (L227). */
export async function runPrayerJobs(ctx: Ctx): Promise<{ removed: number }> {
  const cutoff = new Date(ctx.clock.now().getTime() - REMOVE_AFTER_DAYS * DAY).toISOString();
  const r = await ctx.db.query<any>(`UPDATE prayer_requests SET body='[removed]', answered_note=NULL, updated_at=$2 WHERE created_at < $1 AND body <> '[removed]' RETURNING id`, [cutoff, ctx.clock.now().toISOString()]);
  return { removed: r.length };
}
