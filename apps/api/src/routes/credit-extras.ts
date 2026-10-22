import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { branchesFor, normalizePhone } from '../auth';
import { maskPhone } from '@churchos/shared';
import { grantsFor, inStaffScope } from '../scope';
import { HttpError, requireSession, type Ctx } from '../ctx';
import { rateLimit } from '../ratelimit';
import { parseKes } from '../limits';
import { addNotification, type NotificationAudience } from '../notifications';
import { sendEmail } from '../wallets';
import { showCode } from './event-credit';

/**
 * More for event credit (Slice 27): a member can ask for their credit back as money (the church approves and pays it itself and records it),
 * send credit to another member of the same church, the church sees how much credit it is holding, and people who leave credit unused are reminded.
 */

const MIN_REFUND = 10_000; // KES 100
const MIN_TRANSFER = 5_000; // KES 50
const MAX_TRANSFERS_PER_DAY = 10;
const REMIND_AFTER_MS = 30 * 86_400_000;
const kesText = (c: number) => `KES ${(c / 100).toLocaleString('en-KE')}`;
const cents = (v: unknown, label: string) => parseKes(v, { min: 1, max: 1_000_000, label: `the ${label}` });
const text = (v: unknown, max: number) => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (s.length > max) throw new HttpError(400, `That is too long (at most ${max} characters)`, 'bad_content');
  return s || null;
};
const maskName = (full: string) => {
  const parts = full.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
};

interface Row { id: string; balance: number }

export function creditExtraRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };
  const nowIso = () => ctx.clock.now().toISOString();

  async function myOrg(uid: string, hint?: unknown): Promise<string> {
    const want = String(hint ?? '');
    if (want) {
      const ok = (await ctx.db.query<any>(`SELECT 1 FROM memberships WHERE user_id=$1 AND org_id=$2 AND status='active' UNION SELECT 1 FROM event_credits WHERE user_id=$1 AND org_id=$2`, [uid, want]))[0];
      if (ok) return want;
    }
    const r = (await ctx.db.query<any>(`SELECT org_id FROM event_credits WHERE user_id=$1 AND balance > 0 ORDER BY created_at LIMIT 1`, [uid]))[0] ?? (await ctx.db.query<any>(`SELECT org_id FROM memberships WHERE user_id=$1 AND status='active' ORDER BY joined_at LIMIT 1`, [uid]))[0];
    if (!r) throw new HttpError(404, 'You are not a member of a church yet', 'not_a_member');
    return r.org_id as string;
  }

  const balanceRows = async (orgId: string, uid: string): Promise<Row[]> =>
    (await ctx.db.query<any>(`SELECT id, balance FROM event_credits WHERE org_id=$1 AND user_id=$2 AND balance > 0 ORDER BY created_at, id`, [orgId, uid])).map((r) => ({ id: r.id, balance: Number(r.balance) }));

  /** Takes `amount` from the credits, oldest first, inside a transaction. Returns what was taken from each. */
  async function drain(q: { query<T = any>(sql: string, p?: unknown[]): Promise<T[]> }, rows: Row[], amount: number) {
    let left = amount;
    const taken: { id: string; take: number }[] = [];
    for (const c of rows) {
      if (left <= 0) break;
      const take = Math.min(c.balance, left);
      const ok = await q.query<any>(`UPDATE event_credits SET balance = balance - $2 WHERE id=$1 AND balance >= $2 RETURNING id`, [c.id, take]);
      if (!ok[0]) throw new HttpError(409, 'Your credit just changed. Please look again.', 'credit_changed');
      taken.push({ id: c.id, take });
      left -= take;
    }
    if (left > 0) throw new HttpError(409, 'You do not have that much credit', 'not_enough_credit');
    return taken;
  }

  async function staffOrg(req: FastifyRequest, perms: ('events.manage' | 'collections.view')[]) {
    for (const p of perms) {
      const rows = await branchesFor(ctx.db, req.session!.uid, p);
      if (rows.length) return { orgId: rows[0].orgId, perm: p, wholeOrg: false };
    }
    throw new HttpError(403, `missing permission ${perms[0]}`, 'forbidden');
  }

  async function churchPeople(orgId: string) {
    const rows = await ctx.db.query<any>(`SELECT DISTINCT ra.user_id FROM role_assignments ra JOIN roles r ON r.id=ra.role_id WHERE ra.org_id=$1 AND r.permissions @> '["events.manage"]'::jsonb`, [orgId]);
    return rows.map((r) => r.user_id as string);
  }

  const note = (orgId: string | null, userId: string, title: string, body: string, link: string = 'member:credit', audience: NotificationAudience = 'member') =>
    addNotification(ctx, { orgId, userId, kind: 'announcement', title, body, link, audience });

  // ======================= ask for the credit back as money =======================

  /** `phone` is passed in: the member sees their own number; staff see it masked, except once a request is approved and they have to pay it. */
  const refundView = (r: any, phone: string | null = r.phone) => ({ id: r.id, amount: Number(r.amount), status: r.status, reason: r.reason, member: r.member_name, phone, requestedAt: r.created_at, decidedBy: r.decided_by_name, decidedAt: r.decided_at, decisionNote: r.decision_note, paidAt: r.paid_at, paidBy: r.paid_by_name, paidReference: r.paid_reference });

  /** The money is held back from the credit straight away, so it cannot be spent while the church decides. A decline or a cancel puts it back. */
  app.post('/me/credit/refund-request', auth, async (req) => {
    const uid = req.session!.uid;
    const b = (req.body ?? {}) as any;
    const orgId = await myOrg(uid, b.orgId);
    const rows = await balanceRows(orgId, uid);
    const total = rows.reduce((s, r) => s + r.balance, 0);
    const amount = b.all ? total : cents(b.amount, 'amount');
    if (amount < MIN_REFUND) throw new HttpError(400, `The smallest refund is ${kesText(MIN_REFUND)}`, 'too_small');
    if (amount > total) throw new HttpError(409, `You have ${kesText(total)} of credit`, 'not_enough_credit');
    const open = (await ctx.db.query<any>(`SELECT id FROM credit_refunds WHERE org_id=$1 AND user_id=$2 AND status IN ('pending','approved')`, [orgId, uid]))[0];
    if (open) throw new HttpError(409, 'You already have a refund request open. Wait for it to be decided, or cancel it first.', 'open_request');
    const name = (await ctx.db.query<any>(`SELECT full_name FROM memberships WHERE user_id=$1 AND org_id=$2 ORDER BY joined_at LIMIT 1`, [uid, orgId]))[0]?.full_name ?? req.session!.name;
    const reason = text(b.reason, 200);
    const id = ctx.newId('crf');
    // The member's branch is kept on the request, so only the staff who manage that branch can see and decide it (AZ-04).
    const branchId = (await ctx.db.query<any>(`SELECT branch_id FROM memberships WHERE user_id=$1 AND org_id=$2 AND status='active' ORDER BY joined_at LIMIT 1`, [uid, orgId]))[0]?.branch_id ?? null;
    await ctx.db.tx(async (q) => {
      const taken = await drain(q, rows, amount);
      await q.query(`INSERT INTO credit_refunds (id, org_id, user_id, member_name, phone, amount, reason, created_at, branch_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, orgId, uid, name, req.session!.phone ?? null, amount, reason, nowIso(), branchId]);
      for (const t of taken) await q.query(`INSERT INTO credit_refund_holds (org_id, refund_id, credit_id, amount) VALUES ($1,$2,$3,$4)`, [orgId, id, t.id, t.take]);
    });
    await ctx.ledger.audit({ orgId, actor: uid, action: 'credit.refund_requested', entity: 'credit_refund', entityId: id, summary: `${name} asked for ${kesText(amount)} of their event credit back as money`, reason: reason ?? undefined });
    for (const u of await churchPeople(orgId)) await note(orgId, u, 'Event credit refund request', `${name} asked for ${kesText(amount)} of their event credit back. Open Events > Event credit to decide.`, 'staff:credit?tab=refunds', 'staff');
    return { id, amount, status: 'pending' };
  });

  async function restoreHolds(refundId: string) {
    const holds = await ctx.db.query<any>(`UPDATE credit_refund_holds SET undone=true WHERE refund_id=$1 AND NOT undone RETURNING credit_id, amount`, [refundId]);
    for (const h of holds) await ctx.db.query(`UPDATE event_credits SET balance = balance + $2 WHERE id=$1`, [h.credit_id, Number(h.amount)]);
    return holds.reduce((s, h) => s + Number(h.amount), 0);
  }

  app.post('/me/credit/refund-request/:id/cancel', auth, async (req) => {
    const r = (await ctx.db.query<any>(`UPDATE credit_refunds SET status='cancelled' WHERE id=$1 AND user_id=$2 AND status='pending' RETURNING *`, [(req.params as any).id, req.session!.uid]))[0];
    if (!r) throw new HttpError(404, 'That request is not waiting any more', 'not_found');
    await restoreHolds(r.id);
    await ctx.ledger.audit({ orgId: r.org_id, actor: req.session!.uid, action: 'credit.refund_cancelled', entity: 'credit_refund', entityId: r.id, summary: `${r.member_name} cancelled their request for ${kesText(Number(r.amount))} of credit back` });
    return { ok: true };
  });

  /** A request is in the caller's scope when they hold events.manage over its branch (or, for an old request with no branch, over every branch). */
  async function refundInScope(req: FastifyRequest, r: any) {
    return inStaffScope(ctx, req, 'events.manage', r.org_id, r.branch_id ?? null);
  }

  app.get('/credit/refunds', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'events.manage');
    const status = String((req.query as any).status ?? '');
    // Only the branches this person manages; requests with no branch (made before branches were recorded) need a church-wide grant.
    const rows = await ctx.db.query<any>(`SELECT * FROM credit_refunds WHERE org_id=$1 AND (branch_id = ANY($2::text[])${g.wholeOrg ? ' OR branch_id IS NULL' : ''}) ${status ? 'AND status = ANY($3::text[])' : ''} ORDER BY (status='pending') DESC, (status='approved') DESC, created_at DESC LIMIT 200`, status ? [g.orgId, g.branchIds, status.split(',')] : [g.orgId, g.branchIds]);
    // The full number is shown only while a request is approved and waiting to be paid (the person who pays needs it), and that is logged once.
    const reveal = rows.filter((r) => r.status === 'approved' && r.phone);
    const firstTime = reveal.length ? await ctx.db.query<any>(`UPDATE credit_refunds SET phone_revealed_at=$2 WHERE id = ANY($1::text[]) AND phone_revealed_at IS NULL RETURNING id`, [reveal.map((r) => r.id), nowIso()]) : [];
    for (const f of firstTime) await ctx.ledger.audit({ orgId: g.orgId, actor: req.session!.uid, action: 'access.reveal', category: 'access', entity: 'credit_refund', entityId: f.id, summary: 'Saw the phone number on an approved event credit refund, to pay it', meta: { fields: ['phone'] } });
    return { refunds: rows.map((r) => refundView(r, r.status === 'approved' ? r.phone : maskPhone(r.phone))), toDecide: rows.filter((r) => r.status === 'pending').length, toPay: rows.filter((r) => r.status === 'approved').length };
  });

  app.post('/credit/refunds/:id/decide', auth, async (req) => {
    await grantsFor(ctx, req, 'events.manage');
    const b = (req.body ?? {}) as any;
    const r = (await ctx.db.query<any>(`SELECT * FROM credit_refunds WHERE id=$1`, [(req.params as any).id]))[0];
    if (!r || !(await refundInScope(req, r))) throw new HttpError(404, 'not found', 'not_found');
    const s = { orgId: r.org_id as string };
    // The person who asked cannot decide their own request (AZ-03).
    if (r.user_id === req.session!.uid) throw new HttpError(403, 'You cannot decide your own refund request. Ask someone else at the church.', 'same_person');
    if (r.status !== 'pending') throw new HttpError(409, 'This request was already decided', 'already_decided');
    const decisionNote = text(b.note, 300);
    if (!b.approve && !decisionNote) throw new HttpError(400, 'Say why you are declining, so the member knows', 'bad_content');
    const done = (await ctx.db.query<any>(`UPDATE credit_refunds SET status=$2, decided_by=$3, decided_by_name=$4, decided_at=$5, decision_note=$6 WHERE id=$1 AND status='pending' RETURNING id`, [r.id, b.approve ? 'approved' : 'declined', req.session!.uid, req.session!.name, nowIso(), decisionNote]))[0];
    if (!done) throw new HttpError(409, 'This request was already decided', 'already_decided');
    if (!b.approve) await restoreHolds(r.id);
    await ctx.ledger.audit({ orgId: s.orgId, actor: req.session!.uid, action: b.approve ? 'credit.refund_approved' : 'credit.refund_declined', entity: 'credit_refund', entityId: r.id, summary: `${b.approve ? 'Approved' : 'Declined'} ${r.member_name}'s request for ${kesText(Number(r.amount))} of credit back`, reason: decisionNote ?? undefined });
    await note(s.orgId, r.user_id, b.approve ? 'Your credit refund was approved' : 'Your credit refund was declined', b.approve ? `The church approved ${kesText(Number(r.amount))}. It will be sent to ${r.phone ?? 'you'} and you will be told when it has been paid.${decisionNote ? ` Note: ${decisionNote}` : ''}` : `The church could not refund ${kesText(Number(r.amount))}. The credit is back in your account. ${decisionNote}`);
    return { id: r.id, status: b.approve ? 'approved' : 'declined' };
  });

  /** ChurchOS does not send the money: the church pays the member itself (for example by M-Pesa) and records it here. */
  app.post('/credit/refunds/:id/paid', auth, async (req) => {
    await grantsFor(ctx, req, 'events.manage');
    const reference = text((req.body as any)?.reference, 60);
    if (!reference) throw new HttpError(400, 'Enter the payment reference, for example the M-Pesa code', 'bad_content');
    const cur = (await ctx.db.query<any>(`SELECT * FROM credit_refunds WHERE id=$1`, [(req.params as any).id]))[0];
    if (!cur || !(await refundInScope(req, cur))) throw new HttpError(404, 'not found', 'not_found');
    const s = { orgId: cur.org_id as string };
    // Nobody marks their own refund as paid (AZ-03). The person who approved it may also be the one who pays it.
    if (cur.user_id === req.session!.uid) throw new HttpError(403, 'You cannot mark your own refund as paid', 'same_person');
    const r = (await ctx.db.query<any>(`UPDATE credit_refunds SET status='paid', paid_by=$3, paid_by_name=$4, paid_at=$5, paid_reference=$6 WHERE id=$1 AND org_id=$2 AND status='approved' RETURNING *`, [cur.id, s.orgId, req.session!.uid, req.session!.name, nowIso(), reference]))[0];
    if (!r) throw new HttpError(409, 'Only an approved request can be marked as paid', 'wrong_state');
    await ctx.ledger.audit({ orgId: s.orgId, actor: req.session!.uid, action: 'credit.refund_paid', entity: 'credit_refund', entityId: r.id, summary: `Recorded that ${r.member_name} was paid ${kesText(Number(r.amount))} for their event credit, reference ${reference}` });
    await note(s.orgId, r.user_id, 'Your credit refund was paid', `${kesText(Number(r.amount))} was sent to you by the church. Reference ${reference}.`);
    return { id: r.id, status: 'paid' };
  });

  // ======================= send credit to another member =======================

  async function recipientOf(orgId: string, phoneRaw: unknown, fromUser: string) {
    const phone = normalizePhone(String(phoneRaw ?? ''));
    if (!phone) throw new HttpError(400, 'Enter a valid phone number', 'bad_phone');
    const m = (await ctx.db.query<any>(`SELECT m.user_id, m.full_name FROM memberships m WHERE m.org_id=$1 AND m.status='active' AND m.user_id IS NOT NULL AND m.phone=$2 LIMIT 1`, [orgId, phone]))[0];
    if (!m || m.user_id === fromUser) throw new HttpError(404, 'We could not find another member of your church with that number', 'recipient_not_found');
    return { userId: m.user_id as string, name: m.full_name as string };
  }

  /** Shows who a number belongs to (first name and last initial) so the sender can check before sending. A few tries an hour, so numbers cannot be probed. */
  app.post('/me/credit/transfer/lookup', auth, async (req) => {
    const uid = req.session!.uid;
    if (!rateLimit(ctx, `credit-lookup:${uid}`, { max: 10, windowMs: 3600_000 }).ok) throw new HttpError(429, 'Too many look-ups. Please try again in an hour.', 'rate_limited');
    const orgId = await myOrg(uid, (req.body as any)?.orgId);
    const r = await recipientOf(orgId, (req.body as any)?.phone, uid);
    return { name: maskName(r.name) };
  });

  app.post('/me/credit/transfer', auth, async (req) => {
    const uid = req.session!.uid;
    const b = (req.body ?? {}) as any;
    const orgId = await myOrg(uid, b.orgId);
    const to = await recipientOf(orgId, b.phone, uid);
    const rows = await balanceRows(orgId, uid);
    const total = rows.reduce((s, r) => s + r.balance, 0);
    const amount = b.all ? total : cents(b.amount, 'amount');
    if (amount < MIN_TRANSFER) throw new HttpError(400, `The smallest amount you can send is ${kesText(MIN_TRANSFER)}`, 'too_small');
    if (amount > total) throw new HttpError(409, `You have ${kesText(total)} of credit`, 'not_enough_credit');
    const today = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM credit_transfers WHERE from_user=$1 AND created_at > $2`, [uid, new Date(ctx.clock.now().getTime() - 86_400_000).toISOString()]))[0].n);
    if (today >= MAX_TRANSFERS_PER_DAY) throw new HttpError(429, 'You have sent credit 10 times today. Please try again tomorrow.', 'too_many');
    const from = (await ctx.db.query<any>(`SELECT full_name FROM memberships WHERE user_id=$1 AND org_id=$2 ORDER BY joined_at LIMIT 1`, [uid, orgId]))[0]?.full_name ?? req.session!.name;
    const msg = text(b.note, 120);
    const id = ctx.newId('ctr');
    await ctx.db.tx(async (q) => {
      await drain(q, rows, amount);
      await q.query(`INSERT INTO event_credits (id, org_id, user_id, email, secret, amount, balance, source_order_id, source_event_id, reason, source_kind, issued_by, issued_by_name, created_at) VALUES ($1,$2,$3,NULL,$4,$5,$5,NULL,NULL,$6,'transfer',$7,$8,$9)`,
        [ctx.newId('ecr'), orgId, to.userId, randomBytes(8).toString('hex').toUpperCase(), amount, `Sent by ${from}`, uid, from, nowIso()]);
      await q.query(`INSERT INTO credit_transfers (id, org_id, from_user, from_name, to_user, to_name, amount, note, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, orgId, uid, from, to.userId, to.name, amount, msg, nowIso()]);
    });
    await ctx.ledger.audit({ orgId, actor: uid, action: 'credit.transferred', entity: 'credit_transfer', entityId: id, summary: `${from} sent ${kesText(amount)} of event credit to ${to.name}`, meta: { amount } });
    await note(orgId, to.userId, `${from} sent you event credit`, `${from} sent you ${kesText(amount)} of event credit${msg ? `: "${msg}"` : ''}. It is used automatically the next time you buy tickets from this church.`);
    await note(orgId, uid, 'Event credit sent', `You sent ${kesText(amount)} of event credit to ${maskName(to.name)}.`);
    return { id, amount, to: maskName(to.name) };
  });

  app.get('/me/credit/history', auth, async (req) => {
    const uid = req.session!.uid;
    const refunds = await ctx.db.query<any>(`SELECT * FROM credit_refunds WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30`, [uid]);
    const out = await ctx.db.query<any>(`SELECT * FROM credit_transfers WHERE from_user=$1 OR to_user=$1 ORDER BY created_at DESC LIMIT 30`, [uid]);
    return {
      refunds: refunds.map((r) => refundView(r)),
      transfers: out.map((t) => ({ id: t.id, direction: t.from_user === uid ? 'sent' : 'received', other: t.from_user === uid ? maskName(t.to_name) : maskName(t.from_name), amount: Number(t.amount), note: t.note, at: t.created_at })),
    };
  });

  // ======================= what the church is holding =======================

  app.get('/credit/summary', auth, async (req) => {
    // Someone who looks after only some branches sees only those branches' figures (AZ-04): credit held by members of their branches, and
    // refund requests filed under them. Credit held by guests belongs to no branch and is shown to church-wide staff only.
    let s: { orgId: string; perm: 'events.manage' | 'collections.view'; whole: boolean; branchIds: string[] } | null = null;
    for (const perm of ['events.manage', 'collections.view'] as const) {
      if (!(await branchesFor(ctx.db, req.session!.uid, perm)).length) continue;
      const g = await grantsFor(ctx, req, perm);
      if (!s || g.wholeOrg) s = { orgId: g.orgId, perm, whole: g.wholeOrg, branchIds: g.branchIds };
      if (g.wholeOrg) break;
    }
    if (!s) throw new HttpError(403, 'missing permission events.manage', 'forbidden');
    const orgId = s.orgId;
    const mine = s.whole ? '' : ` AND user_id IN (SELECT user_id FROM memberships WHERE org_id=$1 AND branch_id = ANY($B::text[]) AND user_id IS NOT NULL)`;
    const bp = s.branchIds;
    const one = async (sql: string, p: unknown[] = [orgId]) => (await ctx.db.query<any>(sql, p))[0];
    const now = ctx.clock.now().getTime();
    const d30 = new Date(now - 30 * 86_400_000).toISOString();
    const d90 = new Date(now - 90 * 86_400_000).toISOString();
    const held = await one(`SELECT COALESCE(SUM(balance),0) AS total, count(DISTINCT COALESCE(user_id, email, id)) FILTER (WHERE balance > 0)::int AS holders, COALESCE(SUM(balance) FILTER (WHERE created_at >= $2),0) AS b30, COALESCE(SUM(balance) FILTER (WHERE created_at < $2 AND created_at >= $3),0) AS b90, COALESCE(SUM(balance) FILTER (WHERE created_at < $3),0) AS older FROM event_credits WHERE org_id=$1 AND balance > 0${mine.replace('$B', '$4')}`, s.whole ? [orgId, d30, d90] : [orgId, d30, d90, bp]);
    const issued = await one(`SELECT COALESCE(SUM(amount),0) AS total, count(*)::int AS n FROM event_credits WHERE org_id=$1 AND source_kind <> 'transfer'${mine.replace('$B', '$2')}`, s.whole ? [orgId] : [orgId, bp]);
    const used = await one(`SELECT COALESCE(SUM(amount),0) AS total FROM event_credit_moves WHERE org_id=$1 AND NOT undone${s.whole ? '' : ` AND credit_id IN (SELECT id FROM event_credits WHERE org_id=$1${mine.replace('$B', '$2')})`}`, s.whole ? [orgId] : [orgId, bp]);
    const refunded = await one(`SELECT COALESCE(SUM(amount) FILTER (WHERE status='paid'),0) AS paid, COALESCE(SUM(amount) FILTER (WHERE status IN ('pending','approved')),0) AS open, count(*) FILTER (WHERE status='pending')::int AS to_decide, count(*) FILTER (WHERE status='approved')::int AS to_pay FROM credit_refunds WHERE org_id=$1${s.whole ? '' : ' AND branch_id = ANY($2::text[])'}`, s.whole ? [orgId] : [orgId, bp]);
    const out: any = {
      outstanding: Number(held.total), holders: held.holders, aging: { under30: Number(held.b30), from30to90: Number(held.b90), over90: Number(held.older) },
      issued: { total: Number(issued.total), orders: issued.n }, used: Number(used.total),
      refunded: { paid: Number(refunded.paid), open: Number(refunded.open), toDecide: refunded.to_decide, toPay: refunded.to_pay },
      note: 'This is money the church has already received and holds as a promise to buyers. It is not income until the credit is spent.',
    };
    if (s.perm === 'events.manage' && s.whole) {
      const top = await ctx.db.query<any>(
        `SELECT COALESCE(c.user_id, c.email, c.id) AS who, COALESCE(MAX(m.full_name), MAX(c.email), 'Guest') AS name, SUM(c.balance) AS balance, MIN(c.created_at) AS since
           FROM event_credits c LEFT JOIN memberships m ON m.user_id=c.user_id AND m.org_id=c.org_id WHERE c.org_id=$1 AND c.balance > 0 GROUP BY COALESCE(c.user_id, c.email, c.id) ORDER BY SUM(c.balance) DESC LIMIT 20`,
        [orgId],
      );
      out.top = top.map((t) => ({ name: t.name, balance: Number(t.balance), since: t.since }));
    }
    return out;
  });
}

/** Once a month, people with credit they have not used are reminded: members in the app, guests by email with their code. */
export async function runCreditReminders(ctx: Ctx): Promise<{ members: number; guests: number }> {
  const now = ctx.clock.now();
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - REMIND_AFTER_MS).toISOString();
  const rows = await ctx.db.query<any>(
    `UPDATE event_credits SET last_reminded_at=$1 WHERE balance > 0 AND created_at < $2 AND (last_reminded_at IS NULL OR last_reminded_at < $2) RETURNING id, org_id, user_id, email, secret, balance`,
    [nowIso, cutoff],
  );
  const byWho = new Map<string, { orgId: string; userId: string | null; email: string | null; total: number; secret: string }>();
  for (const r of rows) {
    const k = `${r.org_id}:${r.user_id ?? r.email ?? r.id}`;
    const cur = byWho.get(k) ?? { orgId: r.org_id, userId: r.user_id, email: r.email, total: 0, secret: r.secret };
    cur.total += Number(r.balance);
    byWho.set(k, cur);
  }
  let members = 0, guests = 0;
  for (const w of byWho.values()) {
    const org = (await ctx.db.query<any>(`SELECT name FROM organisations WHERE id=$1`, [w.orgId]))[0];
    const coming = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM events WHERE org_id=$1 AND ticketed AND status='scheduled' AND starts_at > $2`, [w.orgId, nowIso]))[0].n);
    const body = `You have ${kesText(w.total)} of event credit at ${org?.name ?? 'your church'}. ${coming ? `${coming} ticketed event${coming === 1 ? ' is' : 's are'} coming up: it is used automatically when you buy tickets.` : 'It never expires and is used on your next ticketed event.'}`;
    if (w.userId) {
      await addNotification(ctx, { orgId: w.orgId, userId: w.userId, kind: 'reminder', title: 'You have event credit', body, link: 'member:credit' });
      members++;
    } else if (w.email) {
      if (await sendEmail(ctx, w.orgId, w.email, 'You have event credit', `Hello,\n\n${body}\n\nYour credit code: ${showCode(w.secret)}\n`)) guests++;
    }
  }
  return { members, guests };
}
