import type { FastifyInstance, FastifyRequest } from 'fastify';
import { diff, type FieldSpec } from '../audit';
import { branchesFor } from '../auth';
import { HttpError, requireSession, type Ctx } from '../ctx';
import { inStaffScope, staffWith } from '../scope';
import { notify } from '../sms';
import { sendEmail } from '../wallets';
import { createReversalRequest } from './reversals';
import { restoreUsed } from './event-credit';

/** Refunds the church approves, and postponing an event (L192 to L195). */

const DAY = 86_400_000;
const kesText = (c: number) => `KES ${(c / 100).toLocaleString('en-KE')}`;
const when = (iso: string) => new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const text = (v: unknown, max: number, label: string, required = false) => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (required && !s) throw new HttpError(400, `Enter the ${label}`, 'bad_content');
  if (s.length > max) throw new HttpError(400, `The ${label} can be at most ${max} characters`, 'bad_content');
  return s || null;
};

export interface RefundState {
  /** The buyer can cancel this order now. */
  allowed: boolean;
  /** Free tickets are given back at once, with nothing to approve. */
  freeCancel: boolean;
  until: string | null;
  why: string | null;
  request: null | { id: string; status: string; note: string | null; at: string };
}

/** Can the buyer cancel this paid order and ask for their money back, and if not, why not? */
export async function refundStateFor(ctx: Ctx, o: any, e: any): Promise<RefundState> {
  const now = ctx.clock.now().getTime();
  const r = (await ctx.db.query<any>(`SELECT id, status, decision_note, created_at FROM ticket_refunds WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1`, [o.id]))[0];
  const request = r ? { id: r.id, status: r.status, note: r.decision_note, at: r.created_at } : null;
  const no = (why: string | null): RefundState => ({ allowed: false, freeCancel: false, until: null, why, request });
  if (o.status !== 'paid') return no(null);
  const t = (await ctx.db.query<any>(`SELECT count(*) FILTER (WHERE status='valid')::int AS valid, count(*) FILTER (WHERE status='used')::int AS used FROM tickets WHERE order_id=$1`, [o.id]))[0];
  if (t.used > 0) return no('Some of these tickets were already used, so the order cannot be cancelled here. Please contact the church.');
  if (t.valid === 0) return no(request && ['approved', 'refunded'].includes(request.status) ? 'These tickets were refunded.' : Number(o.credit_issued) > 0 ? 'These tickets were turned into credit.' : 'These tickets are cancelled.');
  if (e.status === 'cancelled') return no('This event was cancelled. The church will arrange your refund.');
  const startsMs = Date.parse(e.starts_at);
  if (e.status !== 'postponed' && Date.parse(e.ends_at ?? e.starts_at) < now) return no('This event has already happened.');
  if (request?.status === 'pending') return no('Your refund request is waiting for the church to decide.');
  if (request?.status === 'declined') return no('Your refund request was declined. Please contact the church.');
  if (Number(o.total) === 0) return { allowed: true, freeCancel: true, until: null, why: null, request };
  // A postponed event with no new date yet is open for refund requests. After a new date is set, for the window the church chose.
  if (e.status === 'postponed') return { allowed: true, freeCancel: false, until: null, why: null, request };
  const limits: number[] = [];
  if (e.refund_open_until) limits.push(Date.parse(e.refund_open_until));
  if (e.refund_days_before !== null && e.refund_days_before !== undefined) limits.push(startsMs - Number(e.refund_days_before) * DAY);
  if (limits.length === 0) return no('Tickets for this event cannot be refunded.');
  const until = Math.max(...limits);
  if (now > until) return no('The time to ask for a refund for this event has ended.');
  return { allowed: true, freeCancel: false, until: new Date(until).toISOString(), why: null, request };
}

export function ticketRefundRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };
  const nowIso = () => ctx.clock.now().toISOString();

  /** Tells a buyer: by email, in the app and, if asked, by SMS. Returns which of those went. */
  async function tell(o: any, title: string, body: string, opts: { sms?: boolean; link?: string } = {}) {
    const full = opts.link ? `${body}\n\n${opts.link}` : body;
    let inApp = false;
    let sms = false;
    if (o.buyer_phone) {
      const r = await notify(ctx, { orgId: o.org_id, branchId: o.branch_id, phone: o.buyer_phone, kind: 'announcement', title, body: opts.link && opts.sms ? `${body} ${opts.link}` : body, idemKey: `tkt:${o.id}:${title}:${body.length}:${nowIso().slice(0, 16)}`, sms: !!opts.sms });
      inApp = r.inApp;
      sms = r.sms === 'sent';
    }
    if (!inApp && o.buyer_user_id) {
      await ctx.db.query(`INSERT INTO notifications (id, org_id, user_id, kind, title, body, created_at) VALUES ($1,$2,$3,'announcement',$4,$5,$6)`, [ctx.newId('ntf'), o.org_id, o.buyer_user_id, title, body, nowIso()]);
      inApp = true;
    }
    let email = false;
    if (o.buyer_email) email = await sendEmail(ctx, o.org_id, o.buyer_email, title, `Hello ${String(o.buyer_name).split(' ')[0]},\n\n${full}\n`);
    return { inApp, sms, email };
  }

  /** Staff who manage events where the order was placed. An organisation-wide event has no branch, so anyone who manages events in the church is told. */
  async function officeStaff(o: any) {
    const branches = o.branch_id ? [{ id: o.branch_id }] : await ctx.db.query<any>(`SELECT id FROM branches WHERE org_id=$1`, [o.org_id]);
    const seen = new Map<string, { id: string; name: string; phone: string }>();
    for (const b of branches) for (const u of await staffWith(ctx, o.org_id, b.id, 'events.manage')) seen.set(u.id, u);
    return [...seen.values()];
  }

  const orderLink = (o: any) => `${ctx.givingUrl}/tickets/${o.secret}`;

  async function orderWithEvent(orderId: string) {
    const o = (await ctx.db.query<any>(`SELECT * FROM ticket_orders WHERE id=$1`, [orderId]))[0];
    const e = o ? (await ctx.db.query<any>(`SELECT * FROM events WHERE id=$1`, [o.event_id]))[0] : null;
    return { o, e };
  }

  const cancelOrderTickets = (orderId: string, by: string | null, reason: string) =>
    ctx.db.query<any>(`UPDATE tickets SET status='cancelled', cancelled_by=$2, cancel_reason=$3 WHERE order_id=$1 AND status='valid' RETURNING id`, [orderId, by, reason]);

  // ======================= the buyer asks (L193) =======================

  async function buyerRequest(o: any, e: any, reason: unknown, actor: { userId: string | null; name: string }) {
    const state = await refundStateFor(ctx, o, e);
    if (!state.allowed) throw new HttpError(409, state.why ?? 'This order cannot be cancelled', 'not_refundable');
    const why = text(reason, 300, 'reason');
    if (state.freeCancel) {
      const gone = await cancelOrderTickets(o.id, actor.userId, 'Cancelled by the buyer');
      const back = await restoreUsed(ctx, o.id); // an order paid with credit gives the credit back
      await ctx.ledger.audit({ orgId: o.org_id, branchId: o.branch_id, actor: actor.userId ?? undefined, actorType: actor.userId ? 'user' : 'system', action: 'ticket.buyer_cancel', entity: 'ticket_order', entityId: o.id, summary: `${actor.name} cancelled their ${gone.length} free ticket${gone.length === 1 ? '' : 's'} for "${e.title}" (order ${o.code})`, reason: why ?? undefined });
      await tell(o, `Your tickets for ${e.title} were cancelled`, `Your ${gone.length} ${back ? '' : 'free '}ticket${gone.length === 1 ? ' was' : 's were'} cancelled and the seat${gone.length === 1 ? ' is' : 's are'} free for someone else.${back ? ` Your ${kesText(back)} of event credit is back in your account.` : ''}`);
      return { status: 'cancelled', refund: false };
    }
    const id = ctx.newId('trf');
    const kind = e.status === 'postponed' || e.refund_open_until ? 'postponed' : 'buyer';
    await ctx.db.query(
      `INSERT INTO ticket_refunds (id, org_id, branch_id, event_id, order_id, kind, amount, reason, requested_by_name, requested_by_user, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, o.org_id, o.branch_id, e.id, o.id, kind, Number(o.total), why, actor.name, actor.userId, nowIso()],
    );
    await ctx.ledger.audit({ orgId: o.org_id, branchId: o.branch_id, actor: actor.userId ?? undefined, actorType: actor.userId ? 'user' : 'system', action: 'ticket.refund_requested', entity: 'ticket_order', entityId: o.id, summary: `${actor.name} asked for a refund of ${kesText(Number(o.total))} for order ${o.code}, "${e.title}"`, reason: why ?? undefined, meta: { refund: id, kind } });
    await tell(o, `Refund request received: ${e.title}`, `We have your request for a refund of order ${o.code}. The church will look at it and tell you. Your tickets still work until then.`);
    for (const u of await officeStaff(o)) {
      await ctx.db.query(`INSERT INTO notifications (id, org_id, user_id, kind, title, body, created_at) VALUES ($1,$2,$3,'announcement',$4,$5,$6)`, [ctx.newId('ntf'), o.org_id, u.id, `Refund request: ${e.title}`, `${actor.name} asked for a refund of ${kesText(Number(o.total))} (order ${o.code}). Open Tickets and sales for the event to approve or decline.`, nowIso()]);
    }
    return { status: 'requested', refund: true, id };
  }

  app.post('/public/tickets/orders/:secret/refund-request', async (req) => {
    const o = (await ctx.db.query<any>(`SELECT * FROM ticket_orders WHERE secret=$1`, [(req.params as any).secret]))[0];
    if (!o) throw new HttpError(404, 'order not found', 'not_found');
    const e = (await ctx.db.query<any>(`SELECT * FROM events WHERE id=$1`, [o.event_id]))[0];
    return buyerRequest(o, e, (req.body as any)?.reason, { userId: null, name: o.buyer_name });
  });

  app.post('/me/tickets/orders/:id/refund-request', auth, async (req) => {
    const o = (await ctx.db.query<any>(`SELECT * FROM ticket_orders WHERE id=$1 AND buyer_user_id=$2`, [(req.params as any).id, req.session!.uid]))[0];
    if (!o) throw new HttpError(404, 'order not found', 'not_found');
    const e = (await ctx.db.query<any>(`SELECT * FROM events WHERE id=$1`, [o.event_id]))[0];
    return buyerRequest(o, e, (req.body as any)?.reason, { userId: req.session!.uid, name: o.buyer_name });
  });

  // ======================= the church decides and refunds (L194) =======================

  async function eventFor(req: FastifyRequest, id: string) {
    const e = (await ctx.db.query<any>(`SELECT * FROM events WHERE id=$1`, [id]))[0];
    if (!e || !(await inStaffScope(ctx, req, 'events.manage', e.org_id, e.branch_id))) throw new HttpError(404, 'not found', 'not_found');
    return e;
  }

  /** Tickets are cancelled and a refund request goes to ChurchOS, which sends the money back to the buyer's phone or card. */
  async function approve(req: FastifyRequest, r: any, o: any, e: any, note: string | null, church: boolean) {
    const pay = (await ctx.db.query<any>(`SELECT id FROM payments WHERE provider_tx_id=$1`, [o.provider_tx_id]))[0];
    if (!pay) throw new HttpError(409, 'We could not find the payment for this order. Contact ChurchOS support.', 'no_payment');
    const branchIds = (await branchesFor(ctx.db, req.session!.uid, 'events.manage')).filter((b) => b.orgId === o.org_id).map((b) => b.branchId);
    const rev = await createReversalRequest(ctx, { requestedBy: req.session!.uid, source: 'staff', paymentId: pay.id, reason: `Ticket refund, order ${o.code}, "${e.title}"${r.reason ? `: ${r.reason}` : ''}`, orgId: o.org_id, branchIds, force: true });
    await cancelOrderTickets(o.id, req.session!.uid, 'Refunded');
    const credited = await restoreUsed(ctx, o.id); // credit the order used goes back; the card or phone part is refunded
    await ctx.db.query(`UPDATE ticket_refunds SET status='approved', decided_by=$2, decided_by_name=$3, decided_at=$4, decision_note=$5, reversal_id=$6 WHERE id=$1`, [r.id, req.session!.uid, req.session!.name, nowIso(), note, rev.id]);
    await ctx.ledger.audit({ orgId: o.org_id, branchId: o.branch_id, actor: req.session!.uid, action: church ? 'ticket.refund_by_church' : 'ticket.refund_approved', entity: 'ticket_order', entityId: o.id, summary: `${church ? 'Refunded' : 'Approved the refund of'} order ${o.code} (${kesText(Number(o.total))}) for "${e.title}"`, reason: note ?? undefined, meta: { refund: r.id, reversal: rev.id } });
    await tell(o, `Your refund for ${e.title} was approved`, `The church approved your refund of order ${o.code} (${kesText(Number(o.total))}). The money goes back to the number or card you paid with, less any charge the payment provider keeps.${credited ? ` The ${kesText(credited)} you paid with event credit is back in your account.` : ''} We will tell you when it has been sent.${note ? ` Note from the church: ${note}` : ''}`);
  }

  async function refundView(r: any) {
    const o = (await ctx.db.query<any>(`SELECT o.code, o.buyer_name, o.method, o.total, (SELECT count(*) FROM tickets t WHERE t.order_id=o.id)::int AS tickets FROM ticket_orders o WHERE o.id=$1`, [r.order_id]))[0];
    const rv = r.reversal_id ? (await ctx.db.query<any>(`SELECT status FROM reversal_requests WHERE id=$1`, [r.reversal_id]))[0] : null;
    return {
      id: r.id, orderId: r.order_id, orderCode: o.code, buyer: r.requested_by_name, method: o.method, total: Number(o.total), tickets: o.tickets, kind: r.kind, reason: r.reason, status: r.status, requestedAt: r.created_at,
      decidedBy: r.decided_by_name, decidedAt: r.decided_at, note: r.decision_note, money: rv ? ({ pending: 'Waiting for ChurchOS to send the money', awaiting_second: 'Waiting for ChurchOS to send the money', approved: 'Money sent back', rejected: 'ChurchOS could not send the money', failed: 'The refund failed' } as Record<string, string>)[rv.status] ?? null : null,
    };
  }

  app.get('/events/:id/refund-requests', auth, async (req) => {
    const e = await eventFor(req, (req.params as any).id);
    const rows = await ctx.db.query<any>(`SELECT * FROM ticket_refunds WHERE event_id=$1 ORDER BY (status='pending') DESC, created_at DESC LIMIT 200`, [e.id]);
    const out = [];
    for (const r of rows) out.push(await refundView(r));
    return { requests: out, pending: out.filter((r) => r.status === 'pending').length, refundDaysBefore: e.refund_days_before ?? null };
  });

  app.post('/refund-requests/:id/decide', auth, async (req) => {
    const r = (await ctx.db.query<any>(`SELECT * FROM ticket_refunds WHERE id=$1`, [(req.params as any).id]))[0];
    if (!r) throw new HttpError(404, 'not found', 'not_found');
    const e = await eventFor(req, r.event_id);
    if (r.status !== 'pending') throw new HttpError(409, 'This request was already decided', 'already_decided');
    const b = (req.body ?? {}) as any;
    const { o } = await orderWithEvent(r.order_id);
    if (!b.approve) {
      const note = text(b.note, 300, 'reason for declining', true);
      await ctx.db.query(`UPDATE ticket_refunds SET status='declined', decided_by=$2, decided_by_name=$3, decided_at=$4, decision_note=$5 WHERE id=$1`, [r.id, req.session!.uid, req.session!.name, nowIso(), note]);
      await ctx.ledger.audit({ orgId: o.org_id, branchId: o.branch_id, actor: req.session!.uid, action: 'ticket.refund_declined', entity: 'ticket_order', entityId: o.id, summary: `Declined the refund of order ${o.code} for "${e.title}"`, reason: note ?? undefined, meta: { refund: r.id } });
      await tell(o, `Your refund request for ${e.title}`, `The church could not approve a refund for order ${o.code}. ${note} Your tickets still work.`);
      return { id: r.id, status: 'declined' };
    }
    const t = (await ctx.db.query<any>(`SELECT count(*) FILTER (WHERE status='used')::int AS used FROM tickets WHERE order_id=$1`, [o.id]))[0];
    if (t.used > 0) throw new HttpError(409, 'Some of these tickets were already used at the door, so this order cannot be refunded in full. Decline it and explain, or contact ChurchOS.', 'tickets_used');
    await approve(req, r, o, e, text(b.note, 300, 'note'), false);
    return { id: r.id, status: 'approved' };
  });

  /** The church refunds an order on its own, for example after cancelling an event. */
  async function churchRefund(req: FastifyRequest, e: any, orderId: string, note: string | null) {
    const { o } = await orderWithEvent(orderId);
    if (!o || o.event_id !== e.id) throw new HttpError(404, 'order not found', 'not_found');
    if (o.status !== 'paid' || Number(o.total) === 0) throw new HttpError(409, 'Only a paid order can be refunded', 'wrong_state');
    if (Number(o.credit_issued) > 0) throw new HttpError(409, 'This order was turned into credit', 'already_credited');
    const open = (await ctx.db.query<any>(`SELECT * FROM ticket_refunds WHERE order_id=$1 AND status IN ('pending','approved','refunded')`, [o.id]))[0];
    if (open && open.status !== 'pending') throw new HttpError(409, 'This order was already refunded', 'already_refunded');
    const used = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM tickets WHERE order_id=$1 AND status='used'`, [o.id]))[0].n);
    if (used > 0 && e.status !== 'cancelled') throw new HttpError(409, 'Some of these tickets were already used at the door', 'tickets_used');
    let r = open;
    if (!r) {
      const id = ctx.newId('trf');
      await ctx.db.query(`INSERT INTO ticket_refunds (id, org_id, branch_id, event_id, order_id, kind, amount, reason, requested_by_name, requested_by_user, created_at) VALUES ($1,$2,$3,$4,$5,'church',$6,$7,$8,$9,$10)`, [id, o.org_id, o.branch_id, e.id, o.id, Number(o.total), note ?? (e.status === 'cancelled' ? 'Event cancelled' : null), req.session!.name, req.session!.uid, nowIso()]);
      r = (await ctx.db.query<any>(`SELECT * FROM ticket_refunds WHERE id=$1`, [id]))[0];
    }
    await approve(req, r, o, e, note, true);
    return { orderId: o.id, status: 'approved' };
  }

  app.post('/events/:id/orders/:orderId/refund', auth, async (req) => {
    const e = await eventFor(req, (req.params as any).id);
    return churchRefund(req, e, (req.params as any).orderId, text((req.body as any)?.note, 300, 'note'));
  });

  app.post('/events/:id/refund-all', auth, async (req) => {
    const e = await eventFor(req, (req.params as any).id);
    if (e.status !== 'cancelled') throw new HttpError(409, 'You can refund everyone at once only after cancelling the event', 'wrong_state');
    // Orders paid entirely with credit give the credit back; the rest are refunded.
    for (const c of await ctx.db.query<any>(`SELECT o.* FROM ticket_orders o WHERE o.event_id=$1 AND o.status='paid' AND o.total = 0 AND o.credit_used > 0 AND EXISTS (SELECT 1 FROM tickets t WHERE t.order_id=o.id AND t.status='valid')`, [e.id])) {
      await cancelOrderTickets(c.id, req.session!.uid, 'Event cancelled');
      const back = await restoreUsed(ctx, c.id);
      await ctx.ledger.audit({ orgId: c.org_id, branchId: c.branch_id, actor: req.session!.uid, action: 'credit.restored', entity: 'ticket_order', entityId: c.id, summary: `${kesText(back)} of event credit went back to the buyer of order ${c.code} because "${e.title}" was cancelled` });
      await tell(c, `${e.title} was cancelled`, `Your ${kesText(back)} of event credit is back in your account.`);
    }
    const orders = await ctx.db.query<any>(`SELECT o.id FROM ticket_orders o WHERE o.event_id=$1 AND o.status='paid' AND o.total > 0 AND o.credit_issued = 0 AND NOT EXISTS (SELECT 1 FROM ticket_refunds r WHERE r.order_id=o.id AND r.status IN ('approved','refunded'))`, [e.id]);
    let done = 0;
    const failed: { orderId: string; message: string }[] = [];
    for (const o of orders) {
      try { await churchRefund(req, e, o.id, null); done++; } catch (err: any) { failed.push({ orderId: o.id, message: err.message }); }
    }
    return { refunded: done, failed };
  });

  // ======================= postponing (L192) =======================

  const POSTPONE_SPECS: FieldSpec[] = [
    { field: 'status', label: 'Status' },
    { field: 'startsAt', label: 'Starts' },
    { field: 'endsAt', label: 'Ends' },
  ];

  app.post('/events/:id/postpone', auth, async (req) => {
    const e = await eventFor(req, (req.params as any).id);
    if (e.status === 'cancelled') throw new HttpError(409, 'This event was cancelled', 'locked');
    const b = (req.body ?? {}) as any;
    const now = ctx.clock.now();
    const note = text(b.note, 300, 'note');
    const hasDate = b.startsAt !== undefined && b.startsAt !== null && b.startsAt !== '';
    if (e.status === 'scheduled' && Date.parse(e.ends_at ?? e.starts_at) < now.getTime()) throw new HttpError(409, 'This event has already happened', 'over');
    if (e.status === 'postponed' && !hasDate) throw new HttpError(409, 'This event is already postponed. Set the new date when you know it.', 'already');
    let newStart: string | null = null;
    let newEnd: string | null = null;
    if (hasDate) {
      const t = Date.parse(String(b.startsAt));
      if (Number.isNaN(t) || t <= now.getTime()) throw new HttpError(400, 'Choose a new start time in the future', 'bad_date');
      newStart = new Date(t).toISOString();
      if (b.endsAt) {
        const t2 = Date.parse(String(b.endsAt));
        if (Number.isNaN(t2) || t2 <= t) throw new HttpError(400, 'The end time must be after the start time', 'bad_date');
        newEnd = new Date(t2).toISOString();
      } else if (e.ends_at) newEnd = new Date(t + Math.max(0, Date.parse(e.ends_at) - Date.parse(e.starts_at))).toISOString();
    }
    const dRaw = b.refundDays === undefined || b.refundDays === null || b.refundDays === '' ? 14 : Number(b.refundDays);
    if (!Number.isInteger(dRaw) || dRaw < 0 || dRaw > 90) throw new HttpError(400, 'The refund period must be between 0 and 90 days', 'bad_days');
    const refundUntil = newStart ? new Date(now.getTime() + dRaw * DAY).toISOString() : null;
    const before = { status: e.status, startsAt: e.starts_at, endsAt: e.ends_at ?? null };
    const status = newStart ? 'scheduled' : 'postponed';
    await ctx.db.query(
      `UPDATE events SET status=$2, starts_at=COALESCE($3, starts_at), ends_at=CASE WHEN $3::text IS NULL THEN ends_at ELSE $4 END, postponed_at=$5, postponed_from=COALESCE(postponed_from, $6), postpone_note=$7, refund_open_until=$8,
        reminder_sent=CASE WHEN $3::text IS NULL THEN reminder_sent ELSE false END, ticket_reminder_sent=CASE WHEN $3::text IS NULL THEN ticket_reminder_sent ELSE false END, updated_at=$5 WHERE id=$1`,
      [e.id, status, newStart, newEnd, now.toISOString(), e.starts_at, note, refundUntil],
    );
    const after = { status, startsAt: newStart ?? e.starts_at, endsAt: newStart ? newEnd : e.ends_at ?? null };
    await ctx.ledger.audit({
      orgId: e.org_id, branchId: e.branch_id, actor: req.session!.uid, action: 'event.postponed', entity: 'event', entityId: e.id,
      summary: newStart ? `Postponed "${e.title}" to ${when(newStart)}` : `Postponed "${e.title}", new date to be announced`, reason: note ?? undefined,
      meta: { changes: diff(POSTPONE_SPECS, before, after), refundUntil },
    });

    // Everyone with a ticket, and everyone who said they are going, is told (L192).
    const orders = await ctx.db.query<any>(`SELECT o.* FROM ticket_orders o WHERE o.event_id=$1 AND o.status='paid' AND EXISTS (SELECT 1 FROM tickets t WHERE t.order_id=o.id AND t.status='valid')`, [e.id]);
    const place = e.location ? ` at ${e.location}` : '';
    let sms = 0, email = 0, app = 0;
    for (const o of orders) {
      const paid = Number(o.total) > 0;
      const refundLine = paid ? (newStart ? ` If you cannot make the new date, you can keep your money as event credit for another event, or ask for a refund until ${when(refundUntil!)} from your ticket page${o.buyer_user_id ? ' or the app' : ''}.` : ` If you cannot attend, you can keep your money as event credit for another event, or ask for a refund from your ticket page${o.buyer_user_id ? ' or the app' : ''}.`) : '';
      const body = newStart
        ? `"${e.title}" has moved to ${when(newStart)}${place}. Your tickets stay valid for the new date.${refundLine}${note ? ` ${note}` : ''}`
        : `"${e.title}" has been postponed. The new date will be announced. Your tickets stay valid.${refundLine}${note ? ` ${note}` : ''}`;
      const r = await tell(o, `Postponed: ${e.title}`, body, { sms: true, link: orderLink(o) });
      if (r.sms) sms++;
      if (r.email) email++;
      if (r.inApp) app++;
    }
    const going = await ctx.db.query<any>(`SELECT r.user_id FROM event_rsvps r WHERE r.event_id=$1 AND r.response='going' AND r.user_id NOT IN (SELECT buyer_user_id FROM ticket_orders WHERE event_id=$1 AND buyer_user_id IS NOT NULL)`, [e.id]);
    for (const g of going) {
      await ctx.db.query(`INSERT INTO notifications (id, org_id, user_id, kind, title, body, created_at) VALUES ($1,$2,$3,'announcement',$4,$5,$6)`, [ctx.newId('ntf'), e.org_id, g.user_id, `Postponed: ${e.title}`, newStart ? `"${e.title}" has moved to ${when(newStart)}${place}.${note ? ` ${note}` : ''}` : `"${e.title}" has been postponed. The new date will be announced.${note ? ` ${note}` : ''}`, now.toISOString()]);
    }
    return { id: e.id, status, startsAt: after.startsAt, refundUntil, told: { orders: orders.length, sms, email, app, rsvp: going.length } };
  });
}

/** Refunds the church approved that ChurchOS has now paid (or could not pay) move on, and the buyer is told. Run with the other ticket jobs. */
export async function runRefundJobs(ctx: Ctx): Promise<{ refunded: number; failed: number }> {
  const rows = await ctx.db.query<any>(
    `SELECT r.*, v.status AS rv FROM ticket_refunds r JOIN reversal_requests v ON v.id=r.reversal_id WHERE r.status='approved' AND v.status IN ('approved','rejected','failed')`,
  );
  let refunded = 0, failed = 0;
  for (const r of rows) {
    const o = (await ctx.db.query<any>(`SELECT o.*, e.title FROM ticket_orders o JOIN events e ON e.id=o.event_id WHERE o.id=$1`, [r.order_id]))[0];
    const ok = r.rv === 'approved';
    const claimed = await ctx.db.query<any>(`UPDATE ticket_refunds SET status=$2 WHERE id=$1 AND status='approved' RETURNING id`, [r.id, ok ? 'refunded' : 'failed']);
    if (!claimed[0]) continue;
    const now = ctx.clock.now().toISOString();
    const title = ok ? `Your refund for ${o.title} was sent` : `Your refund for ${o.title} could not be sent`;
    const body = ok ? `Your refund of order ${o.code} has been sent back to the number or card you paid with.` : `We could not send your refund for order ${o.code} automatically. The church will contact you.`;
    if (o.buyer_user_id) await ctx.db.query(`INSERT INTO notifications (id, org_id, user_id, kind, title, body, created_at) VALUES ($1,$2,$3,'announcement',$4,$5,$6)`, [ctx.newId('ntf'), o.org_id, o.buyer_user_id, title, body, now]);
    if (o.buyer_email) await sendEmail(ctx, o.org_id, o.buyer_email, title, `Hello ${String(o.buyer_name).split(' ')[0]},\n\n${body}\n`);
    await ctx.ledger.audit({ orgId: o.org_id, branchId: o.branch_id, actorType: 'system', action: ok ? 'ticket.refunded' : 'ticket.refund_failed', entity: 'ticket_order', entityId: o.id, summary: ok ? `The refund of order ${o.code} was sent to the buyer` : `The refund of order ${o.code} could not be sent`, meta: { refund: r.id } });
    if (ok) refunded++; else failed++;
  }
  return { refunded, failed };
}
