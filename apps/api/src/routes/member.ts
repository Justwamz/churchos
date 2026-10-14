import type { FastifyInstance } from 'fastify';
import { toCents } from '@churchos/shared';
import { HttpError, requireSession, type Ctx } from '../ctx';
import { createReversalRequest } from './reversals';
import { churchByCode } from './public';

export function memberRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };

  async function myMemberships(uid: string) {
    return ctx.db.query<any>(
      `SELECT m.id, m.org_id, m.branch_id, m.member_number, m.full_name, m.household_id, m.relationship, m.joined_at,
              b.name AS branch_name, b.code AS branch_code, o.name AS org_name
         FROM memberships m JOIN branches b ON b.id=m.branch_id JOIN organisations o ON o.id=m.org_id
        WHERE m.user_id=$1 AND m.status='active' ORDER BY m.joined_at`,
      [uid],
    );
  }

  app.get('/me', auth, async (req) => {
    const s = req.session!;
    const memberships = await myMemberships(s.uid);
    const household = [];
    for (const m of memberships) {
      if (!m.household_id) continue;
      household.push(
        ...(await ctx.db.query<any>(
          `SELECT id, full_name, relationship, member_number FROM memberships WHERE household_id=$1 AND status='active' ORDER BY full_name`,
          [m.household_id],
        )),
      );
    }
    const transfers = await ctx.db.query<any>(
      `SELECT t.id, t.status, t.created_at, fb.name AS from_name, tb.name AS to_name FROM transfers t
         JOIN branches fb ON fb.id=t.from_branch JOIN branches tb ON tb.id=t.to_branch
        WHERE t.membership_id IN (SELECT id FROM memberships WHERE user_id=$1) ORDER BY t.created_at DESC`,
      [s.uid],
    );
    return { user: { id: s.uid, name: s.name, phone: s.phone }, memberships, household, transfers };
  });

  app.get('/me/giving', auth, async (req) => {
    const rows = await ctx.db.query<any>(
      `SELECT p.id, p.received_at AS date, p.method, p.purpose, p.amount_paid AS amount, p.stage AS status, p.provider_tx_id AS receipt, b.name AS church
         FROM payments p LEFT JOIN branches b ON b.id=p.branch_id WHERE p.payer_phone=$1 ORDER BY p.received_at DESC LIMIT 200`,
      [req.session!.phone],
    );
    const total = rows.filter((r) => r.status !== 'reversed' && r.status !== 'refunded').reduce((t, r) => t + r.amount, 0);
    return { rows, total };
  });

  app.get('/me/pledges', auth, async (req) => {
    return ctx.db.query<any>(
      `SELECT pl.id, pl.amount, pl.created_at, p.name AS project, p.code AS project_code, b.code AS branch_code,
              COALESCE((SELECT SUM(amount_paid) FROM payments WHERE project_id=pl.project_id AND member_id=pl.membership_id AND stage IN ('pending','available','paid_out')),0) AS paid
         FROM pledges pl JOIN projects p ON p.id=pl.project_id JOIN branches b ON b.id=p.branch_id
        WHERE pl.membership_id IN (SELECT id FROM memberships WHERE user_id=$1) ORDER BY pl.created_at DESC`,
      [req.session!.uid],
    );
  });

  app.post('/me/pledges', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const church = await churchByCode(ctx, b.churchCode);
    if (!church) throw new HttpError(404, 'unknown church', 'unknown_church');
    const project = (await ctx.db.query<any>(`SELECT id, org_id FROM projects WHERE branch_id=$1 AND code=$2 AND status='open'`, [church.id, String(b.projectCode ?? '').toUpperCase()]))[0];
    if (!project) throw new HttpError(404, 'That project is not open', 'unknown_project');
    const m = (await myMemberships(req.session!.uid)).find((x) => x.org_id === project.org_id);
    if (!m) throw new HttpError(403, 'You need to be a member of this church to pledge', 'not_a_member');
    let amount: number;
    try { amount = toCents(b.amount); } catch { throw new HttpError(400, 'Enter a valid amount', 'bad_amount'); }
    if (!(amount > 0)) throw new HttpError(400, 'The pledge must be more than zero', 'bad_amount');
    const id = ctx.newId('plg');
    await ctx.db.query(`INSERT INTO pledges (id, org_id, project_id, membership_id, amount, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [
      id, project.org_id, project.id, m.id, amount, ctx.clock.now().toISOString(),
    ]);
    return { id };
  });

  /** A member asks to move to another branch, in the same or a different church (L7, L30). The receiving branch decides. */
  app.post('/me/transfer-request', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const dest = await churchByCode(ctx, b.toChurchCode);
    if (!dest) throw new HttpError(404, 'We could not find a church with that code', 'unknown_church');
    const mine = await myMemberships(req.session!.uid);
    const from = b.membershipId ? mine.find((m) => m.id === b.membershipId) : mine[0];
    if (!from) throw new HttpError(404, 'You are not a member of any church yet', 'not_a_member');
    if (from.branch_id === dest.id) throw new HttpError(400, 'You already belong to that church', 'same_branch');
    const open = (await ctx.db.query<any>(`SELECT 1 FROM transfers WHERE membership_id=$1 AND status='requested'`, [from.id]))[0];
    if (open) throw new HttpError(409, 'You already have a transfer waiting for approval', 'duplicate_request');
    const id = ctx.newId('trf');
    await ctx.db.query(
      `INSERT INTO transfers (id, org_id, to_org_id, membership_id, from_branch, to_branch, requested_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, from.org_id, dest.org_id, from.id, from.branch_id, dest.id, req.session!.uid, ctx.clock.now().toISOString()],
    );
    return { id, status: 'requested', to: dest.name };
  });

  /** "I paid the wrong church": paste the confirmation SMS (L11). */
  app.post('/me/reversal-request', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    return createReversalRequest(ctx, { requestedBy: req.session!.uid, source: 'member', message: b.message, reason: b.reason, payerPhone: req.session!.phone });
  });
}
