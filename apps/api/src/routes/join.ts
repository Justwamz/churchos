import type { FastifyInstance } from 'fastify';
import { maskPhone } from '@churchos/shared';
import { branchesFor } from '../auth';
import { HttpError, requireSession, type Ctx } from '../ctx';
import { clientIp, rateLimit } from '../ratelimit';
import { nextMemberNumber } from '../members';
import { addNotification } from '../notifications';
import { wordsFor } from './words';
import { inStaffScope, staffWith } from '../scope';

/**
 * Finding a church and joining it (Slice 29). Anyone can look a church up by name or code (the church can keep itself out of the name search).
 * A signed-in person with no church sends a join request; church staff approve it and the person becomes a member. A person who already holds
 * a staff role at a church can link themselves to it at once.
 */


const clean = (v: unknown, max: number) => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (s.length > max) throw new HttpError(400, `That is too long (at most ${max} characters)`, 'bad_content');
  return s || null;
};

export function joinRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };
  const nowIso = () => ctx.clock.now().toISOString();

  // ======================= finding a church =======================

  app.get('/public/churches/search', async (req) => {
    if (!rateLimit(ctx, `church-search:${clientIp(req)}`, { max: 40, windowMs: 60_000 }).ok) throw new HttpError(429, 'Too many searches. Please wait a minute.', 'rate_limited');
    const q = String((req.query as any).q ?? '').trim().slice(0, 60);
    if (q.length < 3) return { churches: [] };
    const like = `%${q.replace(/[%_\\]/g, '')}%`;
    const rows = await ctx.db.query<any>(
      `SELECT b.code, b.name AS branch, b.region, o.name AS church, COALESCE(s.listed, true) AS listed
         FROM branches b JOIN organisations o ON o.id=b.org_id LEFT JOIN org_settings s ON s.org_id=b.org_id
        WHERE upper(b.code)=upper($1) OR (COALESCE(s.listed, true) AND (b.name ILIKE $2 OR o.name ILIKE $2 OR b.region ILIKE $2 OR b.code ILIKE $3))
        ORDER BY (upper(b.code)=upper($1)) DESC, o.name, b.name LIMIT 8`,
      [q, like, `${q.replace(/[%_\\]/g, '')}%`],
    );
    return { churches: rows.map((r) => ({ code: r.code, branch: r.branch, church: r.church, region: r.region ?? null })) };
  });

  /** The church chooses whether people can find it by typing its name. Anyone with its code or link can always reach it. */
  app.get('/church/directory', auth, async (req) => {
    const rows = await branchesFor(ctx.db, req.session!.uid, 'church.settings');
    if (!rows.length) throw new HttpError(403, 'missing permission church.settings', 'forbidden');
    const s = (await ctx.db.query<any>(`SELECT COALESCE(listed, true) AS listed FROM org_settings WHERE org_id=$1`, [rows[0].orgId]))[0];
    return { listed: s ? !!s.listed : true };
  });

  app.put('/church/directory', auth, async (req) => {
    const rows = await branchesFor(ctx.db, req.session!.uid, 'church.settings');
    if (!rows.length) throw new HttpError(403, 'missing permission church.settings', 'forbidden');
    const orgId = rows[0].orgId;
    const listed = (req.body as any)?.listed !== false;
    await ctx.db.query(`INSERT INTO org_settings (org_id, listed) VALUES ($1,$2) ON CONFLICT (org_id) DO UPDATE SET listed=$2`, [orgId, listed]);
    await ctx.ledger.audit({ orgId, actor: req.session!.uid, action: 'church.directory', entity: 'organisation', entityId: orgId, summary: listed ? 'The church can now be found by name in the search' : 'The church is hidden from the name search (people can still use its code or link)' });
    return { listed };
  });

  // ======================= the person without a church =======================

  const branchByCode = async (code: unknown) => {
    const b = (await ctx.db.query<any>(`SELECT b.id, b.org_id, b.code, b.name, o.name AS church FROM branches b JOIN organisations o ON o.id=b.org_id WHERE upper(b.code)=upper($1)`, [String(code ?? '').trim()]))[0];
    if (!b) throw new HttpError(404, 'We could not find a church with that code', 'unknown_church');
    return b;
  };

  app.get('/me/link/status', auth, async (req) => {
    const uid = req.session!.uid;
    const ms = await ctx.db.query<any>(`SELECT m.org_id, o.name AS church, b.name AS branch FROM memberships m JOIN organisations o ON o.id=m.org_id JOIN branches b ON b.id=m.branch_id WHERE m.user_id=$1 AND m.status='active' ORDER BY m.joined_at`, [uid]);
    const requests = await ctx.db.query<any>(`SELECT r.id, r.status, r.decision_note, r.decided_at, r.created_at, b.name AS branch, o.name AS church FROM join_requests r JOIN branches b ON b.id=r.branch_id JOIN organisations o ON o.id=r.org_id WHERE r.user_id=$1 ORDER BY r.created_at DESC LIMIT 10`, [uid]);
    const staffAt = await ctx.db.query<any>(`SELECT DISTINCT b.code, b.name AS branch, o.name AS church FROM role_assignments ra JOIN branches b ON b.org_id=ra.org_id JOIN organisations o ON o.id=ra.org_id WHERE ra.user_id=$1 AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=$1 AND m.org_id=ra.org_id AND m.status='active') ORDER BY o.name, b.name`, [uid]);
    return {
      linked: ms.length > 0,
      churches: ms.map((m) => ({ orgId: m.org_id, church: m.church, branch: m.branch })),
      requests: requests.map((r) => ({ id: r.id, status: r.status, church: r.church, branch: r.branch, note: r.decision_note, decidedAt: r.decided_at, requestedAt: r.created_at })),
      canLinkAtOnce: staffAt.map((s) => ({ code: s.code, church: s.church, branch: s.branch })),
    };
  });

  app.post('/me/link/request', auth, async (req) => {
    const uid = req.session!.uid;
    const b = (req.body ?? {}) as any;
    const branch = await branchByCode(b.code);
    if (b.consent !== true) throw new HttpError(400, 'Please agree that the church may keep your details', 'consent_required');
    const mine = (await ctx.db.query<any>(`SELECT 1 FROM memberships WHERE user_id=$1 AND org_id=$2 AND status='active'`, [uid, branch.org_id]))[0];
    if (mine) throw new HttpError(409, 'You are already a member of this church', 'already_member');
    const open = (await ctx.db.query<any>(`SELECT id FROM join_requests WHERE user_id=$1 AND org_id=$2 AND status='pending'`, [uid, branch.org_id]))[0];
    if (open) throw new HttpError(409, 'You already asked to join this church. Please wait for them to answer.', 'duplicate_request');
    const user = (await ctx.db.query<any>(`SELECT name, phone FROM users WHERE id=$1`, [uid]))[0];
    const name = clean(b.name, 80) ?? user.name;
    if (!name || name.length < 2) throw new HttpError(400, 'Enter your full name', 'bad_name');
    const id = ctx.newId('jrq');
    await ctx.db.query(
      `INSERT INTO join_requests (id, org_id, branch_id, user_id, name, phone, member_number, message, consent_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [id, branch.org_id, branch.id, uid, name, user.phone, clean(b.memberNumber, 40), clean(b.message, 200), nowIso()],
    );
    await ctx.ledger.audit({ orgId: branch.org_id, branchId: branch.id, actor: uid, action: 'member.join_requested', entity: 'join_request', entityId: id, summary: `${name} asked to join ${branch.church}, ${branch.name}` });
    for (const s of await staffWith(ctx, branch.org_id, branch.id, 'members.edit')) {
      await addNotification(ctx, { orgId: branch.org_id, userId: s.id, kind: 'announcement', title: 'Someone asked to join the church', body: `${name} asked to join ${branch.name}. Open People > Members > Join requests to approve or decline.`, link: 'staff:members?tab=requests', audience: 'staff' });
    }
    return { id, status: 'pending', church: branch.church, branch: branch.name };
  });

  app.post('/me/link/request/:id/cancel', auth, async (req) => {
    const r = (await ctx.db.query<any>(`UPDATE join_requests SET status='cancelled' WHERE id=$1 AND user_id=$2 AND status='pending' RETURNING id`, [(req.params as any).id, req.session!.uid]))[0];
    if (!r) throw new HttpError(404, 'That request is not waiting any more', 'not_found');
    return { ok: true };
  });

  /** Staff of a church, and the owner above all, are linked at once: they already belong to the church. */
  app.post('/me/link/instant', auth, async (req) => {
    const uid = req.session!.uid;
    const branch = await branchByCode((req.body as any)?.code);
    const role = (await ctx.db.query<any>(`SELECT 1 FROM role_assignments WHERE user_id=$1 AND org_id=$2`, [uid, branch.org_id]))[0];
    if (!role) throw new HttpError(403, 'Only people who work for this church can link themselves. Send a join request instead.', 'not_staff');
    const user = (await ctx.db.query<any>(`SELECT name, phone FROM users WHERE id=$1`, [uid]))[0];
    const m = await makeMember(branch, uid, user.name, user.phone, nowIso());
    await ctx.ledger.audit({ orgId: branch.org_id, branchId: branch.id, actor: uid, action: 'member.linked_self', entity: 'membership', entityId: m.id, summary: `${user.name}, who works for the church, linked themselves to ${branch.name} as a member` });
    return { ok: true, membershipId: m.id, memberNumber: m.number };
  });

  async function makeMember(branch: { id: string; org_id: string; code: string }, userId: string, name: string, phone: string | null, consentAt: string) {
    // A church may already have this person on its list without a sign-in: link that record rather than make a second one.
    if (phone) {
      const ex = (await ctx.db.query<any>(`SELECT id, member_number, user_id FROM memberships WHERE org_id=$1 AND phone=$2 AND category='adult' AND status='active' LIMIT 1`, [branch.org_id, phone]))[0];
      if (ex) {
        if (!ex.user_id) await ctx.db.query(`UPDATE memberships SET user_id=$2 WHERE id=$1`, [ex.id, userId]);
        return { id: ex.id as string, number: ex.member_number as string };
      }
    }
    return ctx.db.tx(async (q) => {
      const number = await nextMemberNumber(ctx, branch.org_id, q, branch.code);
      const id = ctx.newId('mem');
      await q.query(
        `INSERT INTO memberships (id, org_id, branch_id, user_id, full_name, phone, member_number, category, consent_at, consent_by, joined_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'adult',$8,$4,$9)`,
        [id, branch.org_id, branch.id, userId, name, phone, number, consentAt, nowIso()],
      );
      return { id, number };
    });
  }

  // ======================= church staff decide =======================

  app.get('/members/join-requests', auth, async (req) => {
    const rows = await branchesFor(ctx.db, req.session!.uid, 'members.edit');
    if (!rows.length) throw new HttpError(403, 'missing permission members.edit', 'forbidden');
    const status = String((req.query as any).status ?? 'pending').split(',');
    const list = await ctx.db.query<any>(
      `SELECT r.*, b.name AS branch FROM join_requests r JOIN branches b ON b.id=r.branch_id WHERE r.branch_id = ANY($1::text[]) AND r.status = ANY($2::text[]) ORDER BY (r.status='pending') DESC, r.created_at DESC LIMIT 200`,
      [rows.map((r) => r.branchId), status],
    );
    return {
      pending: list.filter((r) => r.status === 'pending').length,
      requests: list.map((r) => ({ id: r.id, name: r.name, phone: r.phone ? maskPhone(r.phone) : null, branch: r.branch, memberNumber: r.member_number, message: r.message, status: r.status, requestedAt: r.created_at, decidedBy: r.decided_by_name, decidedAt: r.decided_at, note: r.decision_note })),
    };
  });

  app.post('/members/join-requests/:id/decide', auth, async (req) => {
    const r = (await ctx.db.query<any>(`SELECT r.*, b.code AS bcode, b.name AS bname, o.name AS church FROM join_requests r JOIN branches b ON b.id=r.branch_id JOIN organisations o ON o.id=r.org_id WHERE r.id=$1`, [(req.params as any).id]))[0];
    if (!r || !(await inStaffScope(ctx, req, 'members.edit', r.org_id, r.branch_id))) throw new HttpError(404, 'not found', 'not_found');
    if (r.status !== 'pending') throw new HttpError(409, 'This request was already answered', 'already_decided');
    const b = (req.body ?? {}) as any;
    const note = clean(b.note, 200);
    if (!b.approve && !note) throw new HttpError(400, 'Say why you are declining, so they know what to do next', 'bad_content');
    let membershipId: string | null = null;
    if (b.approve) {
      const m = await makeMember({ id: r.branch_id, org_id: r.org_id, code: r.bcode }, r.user_id, r.name, r.phone, r.consent_at);
      membershipId = m.id;
    }
    const done = (await ctx.db.query<any>(`UPDATE join_requests SET status=$2, decided_by=$3, decided_by_name=$4, decided_at=$5, decision_note=$6, membership_id=$7 WHERE id=$1 AND status='pending' RETURNING id`, [r.id, b.approve ? 'approved' : 'declined', req.session!.uid, req.session!.name, nowIso(), note, membershipId]))[0];
    if (!done) throw new HttpError(409, 'This request was already answered', 'already_decided');
    await ctx.ledger.audit({ orgId: r.org_id, branchId: r.branch_id, actor: req.session!.uid, action: b.approve ? 'member.join_approved' : 'member.join_declined', entity: 'join_request', entityId: r.id, summary: `${b.approve ? 'Approved' : 'Declined'} ${r.name}'s request to join ${r.bname}`, reason: note ?? undefined });
    await addNotification(ctx, {
      orgId: r.org_id, userId: r.user_id, kind: 'announcement',
      title: b.approve ? `Welcome to ${r.church}` : 'About your request to join',
      body: b.approve ? `${r.bname} approved your request. You are now a member: giving records, ${(await wordsFor(ctx, r.org_id)).manyLower}, children and groups are open to you.` : `${r.bname} could not add you yet. ${note}`,
      link: b.approve ? 'member:home' : undefined, audience: 'member',
    });
    return { id: r.id, status: b.approve ? 'approved' : 'declined', membershipId };
  });
}
