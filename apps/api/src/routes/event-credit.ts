import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError, requireSession, type Ctx } from '../ctx';
import { inStaffScope } from '../scope';
import { notify } from '../sms';
import { sendEmail } from '../wallets';

/**
 * Event credit (Slice 20). A buyer can keep the money of their tickets as credit instead of asking for a refund: it stays with the church, belongs to the buyer,
 * never expires and can be spent on any ticketed event of the same church. The service fee is not part of the credit. Nothing moves in the money ledger:
 * the original payment stays where it is and the credit is only a promise that is spent against a later order.
 */

const kesText = (c: number) => `KES ${(c / 100).toLocaleString('en-KE')}`;
const text = (v: unknown, max: number) => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (s.length > max) throw new HttpError(400, `The note can be at most ${max} characters`, 'bad_content');
  return s || null;
};

/** The code a guest buyer keeps: 16 characters shown in groups of four. */
export const showCode = (secret: string) => secret.match(/.{1,4}/g)!.join('-');
export const cleanCode = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^0-9A-F]/g, '');

export interface CreditRow { id: string; balance: number }

/** The credit a signed-in member has at a church, or the credit a code opens. Oldest first. */
export async function findCredits(ctx: Ctx, orgId: string, who: { userId?: string | null; code?: unknown }): Promise<CreditRow[]> {
  const rows: any[] = [];
  if (who.userId) rows.push(...(await ctx.db.query<any>(`SELECT id, balance FROM event_credits WHERE org_id=$1 AND user_id=$2 AND balance > 0 ORDER BY created_at, id`, [orgId, who.userId])));
  const code = cleanCode(who.code);
  if (code) {
    if (code.length !== 16) throw new HttpError(404, 'That credit code was not found', 'bad_credit_code');
    const r = (await ctx.db.query<any>(`SELECT id, balance FROM event_credits WHERE org_id=$1 AND secret=$2`, [orgId, code]))[0];
    if (!r) throw new HttpError(404, 'That credit code was not found for this church', 'bad_credit_code');
    if (Number(r.balance) <= 0) throw new HttpError(409, 'That credit has been used up', 'credit_used');
    if (!rows.some((x) => x.id === r.id)) rows.push(r);
  }
  return rows.map((r) => ({ id: r.id, balance: Number(r.balance) }));
}

/** Takes up to `amount` from the credits inside the order's own transaction. Returns what was taken. */
export async function spendIn(q: { query<T = any>(sql: string, p?: unknown[]): Promise<T[]> }, ctx: Ctx, orgId: string, orderId: string, credits: CreditRow[], amount: number, now: string): Promise<number> {
  let left = amount;
  let taken = 0;
  for (const c of credits) {
    if (left <= 0) break;
    const take = Math.min(c.balance, left);
    const ok = await q.query<any>(`UPDATE event_credits SET balance = balance - $2 WHERE id=$1 AND balance >= $2 RETURNING id`, [c.id, take]);
    if (!ok[0]) throw new HttpError(409, 'Your credit was just used. Please check your balance and try again.', 'credit_used');
    await q.query(`INSERT INTO event_credit_moves (id, org_id, credit_id, order_id, amount, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [ctx.newId('ecm'), orgId, c.id, orderId, take, now]);
    left -= take;
    taken += take;
  }
  return taken;
}

/** Credit an order had taken goes back to where it came from: the order lapsed, or was cancelled or refunded. */
export async function restoreUsed(ctx: Ctx, orderId: string): Promise<number> {
  const moves = await ctx.db.query<any>(`UPDATE event_credit_moves SET undone=true WHERE order_id=$1 AND NOT undone RETURNING credit_id, amount`, [orderId]);
  let total = 0;
  for (const m of moves) {
    await ctx.db.query(`UPDATE event_credits SET balance = balance + $2 WHERE id=$1`, [m.credit_id, Number(m.amount)]);
    total += Number(m.amount);
  }
  return total;
}

/** A late payment for an order whose credit went back: take the credit again if it is still there. */
export async function retakeUsed(ctx: Ctx, orderId: string): Promise<boolean> {
  const moves = await ctx.db.query<any>(`SELECT * FROM event_credit_moves WHERE order_id=$1 AND undone`, [orderId]);
  if (!moves.length) return true;
  return ctx.db.tx(async (q) => {
    for (const m of moves) {
      const ok = await q.query<any>(`UPDATE event_credits SET balance = balance - $2 WHERE id=$1 AND balance >= $2 RETURNING id`, [m.credit_id, Number(m.amount)]);
      if (!ok[0]) throw new HttpError(409, 'credit gone', 'credit_used');
      await q.query(`UPDATE event_credit_moves SET undone=false WHERE id=$1`, [m.id]);
    }
    return true;
  }).catch(() => false);
}

export interface CreditState { allowed: boolean; amount: number; why: string | null }

/** Can the buyer keep the money of this paid order as credit, and how much would it be? */
export async function creditStateFor(ctx: Ctx, o: any, e: any): Promise<CreditState> {
  const amount = Number(o.subtotal);
  const no = (why: string | null): CreditState => ({ allowed: false, amount, why });
  if (o.status !== 'paid' || amount <= 0) return no(null);
  if (Number(o.credit_issued) > 0) return no('This order was turned into credit.');
  if (Number(o.total) === 0 && Number(o.credit_used) > 0) return no(null); // paid with credit: cancelling gives the credit back
  const t = (await ctx.db.query<any>(`SELECT count(*) FILTER (WHERE status='valid')::int AS valid, count(*) FILTER (WHERE status='used')::int AS used FROM tickets WHERE order_id=$1`, [o.id]))[0];
  if (t.used > 0) return no('Some of these tickets were already used, so the order cannot be turned into credit.');
  if (t.valid === 0) return no(null);
  const r = (await ctx.db.query<any>(`SELECT status FROM ticket_refunds WHERE order_id=$1 AND status IN ('pending','approved','refunded') LIMIT 1`, [o.id]))[0];
  if (r) return no(r.status === 'pending' ? 'Your refund request is waiting for the church to decide.' : null);
  if (e.status !== 'cancelled' && e.status !== 'postponed' && Date.parse(e.starts_at) <= ctx.clock.now().getTime()) return no('This event has already started.');
  return { allowed: true, amount, why: null };
}

export function eventCreditRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };
  const nowIso = () => ctx.clock.now().toISOString();

  async function tell(o: any, title: string, body: string) {
    let inApp = false;
    if (o.buyer_phone) {
      const r = await notify(ctx, { orgId: o.org_id, branchId: o.branch_id, phone: o.buyer_phone, kind: 'announcement', title, body, idemKey: `ecr:${o.id}:${title}:${nowIso().slice(0, 16)}`, sms: false });
      inApp = r.inApp;
    }
    if (!inApp && o.buyer_user_id) await ctx.db.query(`INSERT INTO notifications (id, org_id, user_id, kind, title, body, created_at) VALUES ($1,$2,$3,'announcement',$4,$5,$6)`, [ctx.newId('ntf'), o.org_id, o.buyer_user_id, title, body, nowIso()]);
  }

  /** Cancels the tickets of the order and gives the buyer the ticket money as credit. */
  async function issue(o: any, e: any, by: { userId: string | null; name: string }, reason: string | null) {
    const state = await creditStateFor(ctx, o, e);
    if (!state.allowed) throw new HttpError(409, state.why ?? 'This order cannot be turned into credit', 'not_creditable');
    const id = ctx.newId('ecr');
    const secret = randomBytes(8).toString('hex').toUpperCase();
    const now = nowIso();
    const gone = await ctx.db.tx(async (q) => {
      const c = await q.query<any>(`UPDATE ticket_orders SET credit_issued=$2 WHERE id=$1 AND credit_issued=0 AND status='paid' RETURNING id`, [o.id, state.amount]);
      if (!c[0]) throw new HttpError(409, 'This order was just changed. Please look again.', 'not_creditable');
      const cancelled = await q.query<any>(`UPDATE tickets SET status='cancelled', cancelled_by=$2, cancel_reason='Turned into credit' WHERE order_id=$1 AND status='valid' RETURNING id`, [o.id, by.userId]);
      await q.query(`INSERT INTO event_credits (id, org_id, user_id, email, secret, amount, balance, source_order_id, source_event_id, reason, issued_by, issued_by_name, created_at) VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12)`,
        [id, o.org_id, o.buyer_user_id ?? null, o.buyer_email ?? null, secret, state.amount, o.id, e.id, reason, by.userId, by.name, now]);
      return cancelled.length;
    });
    await ctx.ledger.audit({ orgId: o.org_id, branchId: o.branch_id, actor: by.userId ?? undefined, actorType: by.userId ? 'user' : 'system', action: 'credit.issued', entity: 'ticket_order', entityId: o.id, summary: `${kesText(state.amount)} of event credit was given for order ${o.code}, "${e.title}" (${gone} ticket${gone === 1 ? '' : 's'} cancelled), by ${by.name}`, reason: reason ?? undefined, meta: { credit: id, amount: state.amount } });
    const member = !!o.buyer_user_id;
    const body = `Your ${gone} ticket${gone === 1 ? '' : 's'} for "${e.title}" ${gone === 1 ? 'was' : 'were'} turned into ${kesText(state.amount)} of event credit. ${member ? 'It is in your account and is used automatically the next time you buy tickets from this church.' : `Use this code when you buy tickets from this church: ${showCode(secret)}`} It does not expire. The service fee is not included.`;
    await tell(o, `Your event credit: ${kesText(state.amount)}`, body);
    if (o.buyer_email) await sendEmail(ctx, o.org_id, o.buyer_email, `Your event credit: ${kesText(state.amount)}`, `Hello ${String(o.buyer_name).split(' ')[0]},\n\n${body}\n\nYour credit code: ${showCode(secret)}\n`);
    return { creditId: id, amount: state.amount, code: member ? null : showCode(secret), tickets: gone };
  }

  const orderOf = async (id: string, byUser?: string) => {
    const o = (await ctx.db.query<any>(byUser ? `SELECT * FROM ticket_orders WHERE id=$1 AND buyer_user_id=$2` : `SELECT * FROM ticket_orders WHERE id=$1`, byUser ? [id, byUser] : [id]))[0];
    if (!o) throw new HttpError(404, 'order not found', 'not_found');
    const e = (await ctx.db.query<any>(`SELECT * FROM events WHERE id=$1`, [o.event_id]))[0];
    return { o, e };
  };

  // ======================= the buyer =======================

  app.post('/public/tickets/orders/:secret/credit', async (req) => {
    const o0 = (await ctx.db.query<any>(`SELECT id FROM ticket_orders WHERE secret=$1`, [(req.params as any).secret]))[0];
    if (!o0) throw new HttpError(404, 'order not found', 'not_found');
    const { o, e } = await orderOf(o0.id);
    return issue(o, e, { userId: null, name: o.buyer_name }, null);
  });

  app.post('/me/tickets/orders/:id/credit', auth, async (req) => {
    const { o, e } = await orderOf((req.params as any).id, req.session!.uid);
    return issue(o, e, { userId: req.session!.uid, name: o.buyer_name }, null);
  });

  /** A member's credit, church by church, and what it came from. */
  app.get('/me/credit', auth, async (req) => {
    const rows = await ctx.db.query<any>(
      `SELECT c.*, e.title AS event_title, org.name AS church FROM event_credits c LEFT JOIN events e ON e.id=c.source_event_id JOIN organisations org ON org.id=c.org_id WHERE c.user_id=$1 ORDER BY c.created_at DESC LIMIT 100`,
      [req.session!.uid],
    );
    const churches = new Map<string, { orgId: string; church: string; balance: number }>();
    for (const r of rows) {
      const c = churches.get(r.org_id) ?? { orgId: r.org_id, church: r.church, balance: 0 };
      c.balance += Number(r.balance);
      churches.set(r.org_id, c);
    }
    const used = await ctx.db.query<any>(
      `SELECT m.amount, m.undone, m.created_at, o.code, e.title FROM event_credit_moves m JOIN event_credits c ON c.id=m.credit_id JOIN ticket_orders o ON o.id=m.order_id JOIN events e ON e.id=o.event_id WHERE c.user_id=$1 ORDER BY m.created_at DESC LIMIT 50`,
      [req.session!.uid],
    );
    return {
      total: [...churches.values()].reduce((s, c) => s + c.balance, 0),
      churches: [...churches.values()],
      credits: rows.map((r) => ({ id: r.id, church: r.church, amount: Number(r.amount), balance: Number(r.balance), event: r.event_title, reason: r.reason ?? null, kind: r.source_kind ?? 'order', at: r.created_at })),
      spent: used.filter((u) => !u.undone).map((u) => ({ amount: Number(u.amount), order: u.code, event: u.title, at: u.created_at })),
    };
  });

  /** What a credit code is worth, for the page where a guest buys tickets. */
  app.get('/public/credit/:code', async (req) => {
    const code = cleanCode((req.params as any).code);
    const r = code.length === 16 ? (await ctx.db.query<any>(`SELECT c.balance, org.name AS church FROM event_credits c JOIN organisations org ON org.id=c.org_id WHERE c.secret=$1`, [code]))[0] : null;
    if (!r) throw new HttpError(404, 'That credit code was not found', 'bad_credit_code');
    return { balance: Number(r.balance), church: r.church };
  });

  // ======================= the church =======================

  async function eventFor(req: FastifyRequest, id: string) {
    const e = (await ctx.db.query<any>(`SELECT * FROM events WHERE id=$1`, [id]))[0];
    if (!e || !(await inStaffScope(ctx, req, 'events.manage', e.org_id, e.branch_id))) throw new HttpError(404, 'not found', 'not_found');
    return e;
  }

  /** The church moves one order's money to credit, for example after cancelling or postponing the event. */
  app.post('/events/:id/orders/:orderId/credit', auth, async (req) => {
    const e = await eventFor(req, (req.params as any).id);
    const { o } = await orderOf((req.params as any).orderId);
    if (o.event_id !== e.id) throw new HttpError(404, 'order not found', 'not_found');
    return issue(o, e, { userId: req.session!.uid, name: req.session!.name }, text((req.body as any)?.note, 300) ?? (e.status === 'cancelled' ? 'Event cancelled' : null));
  });

  /** After cancelling an event: every paid order that can be, becomes credit. Orders already refunded, used or asked about are left alone. */
  app.post('/events/:id/credit-all', auth, async (req) => {
    const e = await eventFor(req, (req.params as any).id);
    if (e.status !== 'cancelled') throw new HttpError(409, 'You can give everyone credit at once only after cancelling the event', 'wrong_state');
    const orders = await ctx.db.query<any>(`SELECT * FROM ticket_orders WHERE event_id=$1 AND status='paid' AND subtotal > 0 AND credit_issued=0`, [e.id]);
    let done = 0;
    let amount = 0;
    const skipped: { orderId: string; message: string }[] = [];
    for (const o of orders) {
      try { const r = await issue(o, e, { userId: req.session!.uid, name: req.session!.name }, 'Event cancelled'); done++; amount += r.amount; } catch (err: any) { skipped.push({ orderId: o.id, message: err.message }); }
    }
    return { credited: done, amount, skipped };
  });

  /** For the ticket page: how much of this event's money became credit, and how much of it has been spent. */
  app.get('/events/:id/credit', auth, async (req) => {
    const e = await eventFor(req, (req.params as any).id);
    const out = (await ctx.db.query<any>(`SELECT count(*)::int AS orders, COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(amount-balance),0) AS spent FROM event_credits WHERE source_event_id=$1`, [e.id]))[0];
    const taken = (await ctx.db.query<any>(`SELECT count(*)::int AS orders, COALESCE(SUM(credit_used),0) AS amount FROM ticket_orders WHERE event_id=$1 AND credit_used > 0 AND status IN ('paid','awaiting_payment')`, [e.id]))[0];
    return { issued: { orders: out.orders, amount: Number(out.amount), spent: Number(out.spent) }, paidWithCredit: { orders: taken.orders, amount: Number(taken.amount) } };
  });
}
