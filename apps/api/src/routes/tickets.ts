import { legalVersionOf } from '../legal';
import { brandingInfo } from './branding';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import qrcode from 'qrcode-generator';
import { buildReference, computeFee, maskEmail, networkMismatch } from '@churchos/shared';
import { parseKes, str } from '../limits';
import { normalizePhone } from '../auth';
import { abuse, abuseDisabled, dailyCap, promptGuard, windowHit as hourlyWindowHit } from '../abuse';
import { clientIp } from '../ratelimit';
import { assertEmail, checkEmail } from '../email-rules';
import { diff, type FieldSpec } from '../audit';
import { validateArtwork } from '../artwork';
import { checkoutLink, HttpError, requireSession, type Ctx } from '../ctx';
import { addNotification } from '../notifications';
import { inStaffScope, grantsFor } from '../scope';
import { sendEmail } from '../wallets';
import { csv, normalizeMethod } from './helpers';
import { refundStateFor, runRefundJobs } from './ticket-refunds';
import { creditStateFor, findCredits, restoreUsed, retakeUsed, spendIn } from './event-credit';
import { runCreditReminders } from './credit-extras';
import { errLine } from '../redact';

const HOLD_MINUTES = 15;
const MAX_PER_ORDER = 20;
const MAX_FREE_PER_PERSON = 10;

const TYPE_SPECS: FieldSpec[] = [
  { field: 'name', label: 'Name' },
  { field: 'price', label: 'Price (cents)' },
  { field: 'quantity', label: 'Number available' },
  { field: 'perOrderMax', label: 'Most per order' },
  { field: 'salesStart', label: 'Sales open' },
  { field: 'salesEnd', label: 'Sales close' },
  { field: 'active', label: 'On sale' },
];

const ticketUrlOf = (ctx: Ctx, token: string) => `${ctx.givingUrl}/t/${token}`;
const kesText = (c: number) => `KES ${(c / 100).toLocaleString('en-KE')}`;
const when = (iso: string) => new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const text = (v: unknown, max: number, label: string, required = false) => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (required && !s) throw new HttpError(400, `Enter the ${label}`, 'bad_content');
  if (s.length > max) throw new HttpError(400, `The ${label} can be at most ${max} characters`, 'bad_content');
  return s || null;
};
const isoOrNull = (v: unknown, label: string): string | null => {
  if (v === undefined || v === null || v === '') return null;
  const t = Date.parse(String(v));
  if (Number.isNaN(t)) throw new HttpError(400, `Choose a valid ${label}`, 'bad_date');
  return new Date(t).toISOString();
};

/** A QR code as scalable SVG, and as a small GIF picture for emails (L174). */
export function qrSvg(data: string): string {
  const q = qrcode(0, 'M');
  q.addData(data);
  q.make();
  return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
}
const qrGif = (data: string): string => {
  const q = qrcode(0, 'M');
  q.addData(data);
  q.make();
  return q.createDataURL(6, 8);
};

/** Event tickets: types, orders, QR tickets, door check-in, reports (L170 to L178). */
export function ticketRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };
  const nowIso = () => ctx.clock.now().toISOString();
  /** How much credit the buyer chose to use, in KES in the request, or null for as much as possible. */
  const creditAmt = (v: unknown) => (v === undefined || v === null || v === '' ? null : parseKes(v, { min: 0, max: 1_000_000, label: 'the credit to use' }));
  const newCode = () => randomBytes(4).toString('hex').toUpperCase();
  const ticketUrl = (token: string) => ticketUrlOf(ctx, token);
  const issueTickets = (orderId: string) => issueTicketsFor(ctx, orderId);
  const ticketsOf = (orderId: string) => ticketsOfOrder(ctx, orderId);
  const sendConfirmation = (orderId: string) => sendConfirmationFor(ctx, orderId);

  // ======================= availability =======================

  /** How many of each ticket type are sold, held while someone pays, and left (L173). */
  async function counts(eventId: string) {
    const types = await ctx.db.query<any>(`SELECT * FROM ticket_types WHERE event_id=$1 ORDER BY sort, created_at`, [eventId]);
    const sold = new Map((await ctx.db.query<any>(`SELECT type_id, count(*)::int AS n, count(*) FILTER (WHERE status='used')::int AS used FROM tickets WHERE event_id=$1 AND status IN ('valid','used') GROUP BY type_id`, [eventId])).map((r) => [r.type_id, r]));
    const held = new Map((await ctx.db.query<any>(`SELECT l.type_id, COALESCE(SUM(l.qty),0)::int AS n FROM ticket_order_lines l JOIN ticket_orders o ON o.id=l.order_id WHERE o.event_id=$1 AND o.status='awaiting_payment' AND o.hold_until > $2 GROUP BY l.type_id`, [eventId, nowIso()])).map((r) => [r.type_id, r.n as number]));
    const takings = new Map((await ctx.db.query<any>(`SELECT l.type_id, COALESCE(SUM(l.qty * l.unit_price),0) AS money FROM ticket_order_lines l JOIN ticket_orders o ON o.id=l.order_id WHERE o.event_id=$1 AND o.status='paid' GROUP BY l.type_id`, [eventId])).map((r) => [r.type_id, Number(r.money)]));
    return types.map((t) => {
      const s = sold.get(t.id)?.n ?? 0;
      const h = held.get(t.id) ?? 0;
      const now = nowIso();
      const open = t.active && (!t.sales_start || t.sales_start <= now) && (!t.sales_end || t.sales_end > now);
      return { row: t, sold: s, used: sold.get(t.id)?.used ?? 0, held: h, left: Math.max(0, t.quantity - s - h), takings: takings.get(t.id) ?? 0, open };
    });
  }

  const typeView = (c: Awaited<ReturnType<typeof counts>>[number], staff: boolean) => ({
    id: c.row.id, name: c.row.name, description: c.row.description, price: Number(c.row.price), perOrderMax: c.row.per_order_max,
    salesStart: c.row.sales_start, salesEnd: c.row.sales_end, active: c.row.active, onSale: c.open && c.left > 0, soldOut: c.left === 0,
    left: staff || c.left <= 20 ? c.left : null,
    ...(staff ? { quantity: c.row.quantity, sold: c.sold, held: c.held, takings: c.takings, checkedIn: c.used } : {}),
  });

  async function eventByCode(code: string) {
    const e = (await ctx.db.query<any>(`SELECT e.*, o.name AS church FROM events e JOIN organisations o ON o.id=e.org_id WHERE upper(e.code)=upper($1) AND e.ticketed`, [code]))[0];
    if (!e) throw new HttpError(404, 'There are no tickets for sale under that link', 'not_found');
    return e;
  }
  const publicEvent = async (e: any) => {
    const types = await counts(e.id);
    const branch = e.branch_id ? (await ctx.db.query<any>(`SELECT name FROM branches WHERE id=$1`, [e.branch_id]))[0]?.name : null;
    const over = e.status === 'cancelled' || Date.parse(e.ends_at ?? e.starts_at) < ctx.clock.now().getTime();
    return {
      code: e.code, title: e.title, description: e.description, location: e.location, startsAt: e.starts_at, endsAt: e.ends_at, church: e.church, branding: await brandingInfo(ctx, e.org_id), branch,
      status: e.status, cancelReason: e.cancel_reason, over, refundDaysBefore: e.refund_days_before ?? null,
      postponed: e.postponed_at ? { note: e.postpone_note, from: e.postponed_from, startsAt: e.status === 'scheduled' ? e.starts_at : null, refundUntil: e.refund_open_until ?? null } : null, posterUrl: e.poster_data ? `/public/event/${e.code}/poster` : null,
      types: types.filter((t) => t.row.active).map((t) => typeView(t, false)),
    };
  };

  // ======================= buying (L171 to L173) =======================

  interface Buyer { name: string; email: string | null; phone: string | null; userId: string | null; membershipId: string | null }

  /** At most a few orders waiting for payment per email, phone or signed-in user across all events (and per IP in one hold window). Lapsed orders release their stock as before. */
  async function capUnpaid(req: FastifyRequest | undefined, w: { emailKey: string | null; phone: string | null; userId: string | null }) {
    if (abuseDisabled()) return;
    const L = abuse();
    const n = Number((await ctx.db.query<any>(
      `SELECT count(*)::int AS n FROM ticket_orders WHERE status='awaiting_payment' AND hold_until > $1 AND ((buyer_email_key IS NOT NULL AND buyer_email_key=$2) OR (buyer_phone IS NOT NULL AND buyer_phone=$3) OR (buyer_user_id IS NOT NULL AND buyer_user_id=$4))`,
      [nowIso(), w.emailKey ?? '', w.phone ?? '', w.userId ?? ''],
    ))[0].n);
    if (n >= L.unpaidPerPerson) throw new HttpError(429, `You already have ${n} orders waiting for payment. Pay for them or wait ${HOLD_MINUTES} minutes for them to be released.`, 'too_many_unpaid');
    if (req) hourlyWindowHit(ctx, `unpaid:ip:${clientIp(req)}`, L.unpaidPerIp, HOLD_MINUTES * 60_000, 'Too many orders from this device. Please wait a few minutes and try again.');
  }

  async function createOrder(o: { event: any; lines: any; buyer: Buyer; method: unknown; advertId?: string | null; req?: FastifyRequest; credit?: { userId?: string | null; code?: unknown; amount?: number | null } }) {
    const e = o.event;
    if (e.status === 'cancelled') throw new HttpError(409, 'This event was cancelled', 'cancelled');
    if (e.status === 'postponed') throw new HttpError(409, 'This event has been postponed. Tickets go back on sale when the new date is announced.', 'postponed');
    if (Date.parse(e.ends_at ?? e.starts_at) < ctx.clock.now().getTime()) throw new HttpError(409, 'This event has already happened', 'over');
    const wanted: { typeId: string; qty: number }[] = [];
    for (const l of Array.isArray(o.lines) ? o.lines : []) {
      if (typeof l?.typeId !== 'string' || (l.qty !== undefined && typeof l.qty !== 'number' && !(typeof l.qty === 'string' && /^\d{1,6}$/.test(l.qty)))) throw new HttpError(400, 'Each ticket line needs a ticket type and a whole-number quantity', 'bad_lines');
      const qty = Number(l?.qty);
      if (!Number.isInteger(qty) || qty < 1) continue;
      if (wanted.some((w) => w.typeId === String(l.typeId))) throw new HttpError(400, 'Each ticket type can appear once. Change its quantity instead.', 'bad_lines');
      wanted.push({ typeId: String(l.typeId), qty });
    }
    if (!wanted.length) throw new HttpError(400, 'Choose at least one ticket', 'bad_lines');
    if (wanted.reduce((s, w) => s + w.qty, 0) > MAX_PER_ORDER) throw new HttpError(400, `You can buy up to ${MAX_PER_ORDER} tickets in one order`, 'too_many');
    const avail = await counts(e.id);
    const lines = wanted.map((w) => {
      const c = avail.find((a) => a.row.id === w.typeId);
      if (!c) throw new HttpError(404, 'That ticket type was not found', 'not_found');
      if (!c.open) throw new HttpError(409, `"${c.row.name}" is not on sale at the moment`, 'not_on_sale');
      if (w.qty > c.row.per_order_max) throw new HttpError(400, `You can buy up to ${c.row.per_order_max} "${c.row.name}" tickets in one order`, 'too_many');
      if (w.qty > c.left) throw new HttpError(409, c.left === 0 ? `"${c.row.name}" is sold out` : `Only ${c.left} "${c.row.name}" ticket${c.left === 1 ? '' : 's'} left`, 'sold_out');
      return { c, qty: w.qty, price: Number(c.row.price) };
    });
    const subtotal = lines.reduce((s, l) => s + l.qty * l.price, 0);
    const b = o.buyer;
    if (!b.userId && !b.email) throw new HttpError(400, 'Enter an email address so we can send your tickets', 'bad_email');
    // A member whose saved address is no longer accepted still gets their tickets in the app.
    if (b.email && b.userId && !checkEmail(b.email).ok) b.email = null;
    const mailbox = b.email ? assertEmail(b.email) : null;
    if (mailbox) b.email = mailbox.email;
    const free = subtotal === 0;
    const phone = b.phone ? normalizePhone(b.phone) : null;
    // Event credit (Slice 20): what the buyer has, or the code they typed, pays first. Only the rest goes to the phone or card.
    const credits = o.credit && subtotal > 0 ? await findCredits(ctx, e.org_id, o.credit) : [];
    const creditUse = Math.min(credits.reduce((s, c) => s + c.balance, 0), subtotal, o.credit?.amount != null ? Math.max(0, o.credit.amount) : Infinity); // the buyer may choose to use only part of it
    const payable = subtotal - creditUse;
    const covered = payable === 0;
    if (free) {
      const held = Number((await ctx.db.query<any>(
        `SELECT COALESCE(SUM(l.qty),0)::int AS n FROM ticket_order_lines l JOIN ticket_orders o ON o.id=l.order_id WHERE o.event_id=$1 AND o.status IN ('paid','awaiting_payment') AND l.unit_price=0 AND ((o.buyer_user_id IS NOT NULL AND o.buyer_user_id=$2) OR (o.buyer_email_key IS NOT NULL AND o.buyer_email_key=$3))`,
        [e.id, b.userId ?? '', mailbox?.key ?? ''],
      ))[0].n);
      if (held + wanted.reduce((s, w) => s + w.qty, 0) > MAX_FREE_PER_PERSON) throw new HttpError(409, `One person can get up to ${MAX_FREE_PER_PERSON} free tickets for an event`, 'free_limit');
      // LG-13: the mailbox limit alone is bypassed with new addresses, so the same event also caps free tickets per IP and per phone.
      const nFree = wanted.reduce((s, w) => s + w.qty, 0);
      const capMsg = 'That is a lot of free tickets from one place for this event. Please try again tomorrow, or ask the church.';
      if (o.req) dailyCap(ctx, `free:ip:${e.id}:${clientIp(o.req)}`, nFree, abuse().freeIpEventDay, capMsg);
      if (phone) dailyCap(ctx, `free:ph:${e.id}:${phone}`, nFree, abuse().freePhoneEventDay, capMsg);
    }
    let method: string | null = null;
    let providerTxId: string | null = null;
    let checkoutUrl: string | null = null;
    let fee: ReturnType<typeof computeFee> | null = null;
    let startPrompt: (() => Promise<string>) | null = null;
    const code = newCode();
    const branch = (await ctx.db.query<any>(`SELECT id, code, name FROM branches WHERE id=COALESCE($2, (SELECT id FROM branches WHERE org_id=$1 ORDER BY code LIMIT 1))`, [e.org_id, e.branch_id]))[0];
    if (!covered) {
      method = String(normalizeMethod(o.method));
      if (method === 'cash') throw new HttpError(400, 'Tickets are paid by M-Pesa, Airtel Money, T-Kash or card. There is no cash sale.', 'bad_method');
      if (!phone && method !== 'card') throw new HttpError(400, 'Enter the phone number to send the payment prompt to', 'bad_phone');
      const mismatch = phone ? networkMismatch(method, phone) : null;
      if (mismatch) throw new HttpError(400, mismatch, 'wrong_network');
      const org = (await ctx.db.query<any>(`SELECT fee_schedule FROM organisations WHERE id=$1`, [e.org_id]))[0];
      fee = computeFee(org.fee_schedule, method as any, payable, 'member'); // the buyer pays the service fee on top (L172)
      if (fee.amountPaid > 15_000_000) throw new HttpError(400, 'An order can be at most KES 150,000. Please buy in two orders.', 'too_large');
      // LG-05 and LG-13: payment prompts are limited per phone, IP and user, and one person cannot hold more than a few unpaid orders at once.
      promptGuard(ctx, o.req, { phone, uid: b.userId });
      await capUnpaid(o.req, { emailKey: mailbox?.key ?? null, phone, userId: b.userId });
      const reference = buildReference(branch.code, `TKT-${code}`);
      // LG-14: the order and its stock reservation are written first; the prompt is sent after (see below), never before.
      startPrompt = async () => {
        if (method === 'card') {
          const card = await ctx.provider.initiateCardCheckout({ amount: fee!.amountPaid, reference, phone: phone ?? undefined });
          checkoutUrl = checkoutLink(ctx, card);
          return card.providerTxId;
        }
        return (await ctx.provider.initiateStkPush({ phone: phone!, amount: fee!.amountPaid, reference, method: method as any })).providerTxId;
      };
    }
    const id = ctx.newId('tko');
    const secret = randomBytes(16).toString('hex');
    const now = nowIso();
    await ctx.db.tx(async (q) => {
      // The numbers are checked again inside the transaction, so two buyers cannot take the last ticket.
      for (const l of lines) {
        const s = Number((await q.query<any>(`SELECT count(*) AS n FROM tickets WHERE type_id=$1 AND status IN ('valid','used')`, [l.c.row.id]))[0].n);
        const h = Number((await q.query<any>(`SELECT COALESCE(SUM(l.qty),0) AS n FROM ticket_order_lines l JOIN ticket_orders o ON o.id=l.order_id WHERE l.type_id=$1 AND o.status='awaiting_payment' AND o.hold_until > $2`, [l.c.row.id, now]))[0].n);
        if (l.c.row.quantity - s - h < l.qty) throw new HttpError(409, `"${l.c.row.name}" has just sold out`, 'sold_out');
      }
      await q.query(
        `INSERT INTO ticket_orders (id, secret, code, org_id, branch_id, event_id, buyer_name, buyer_email, buyer_phone, buyer_user_id, buyer_membership_id, method, status, subtotal, service_fee, total, provider_tx_id, hold_until, advert_id, created_at, buyer_email_key, credit_used)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [id, secret, code, e.org_id, e.branch_id, e.id, b.name, b.email, phone, b.userId, b.membershipId, method, covered ? 'paid' : 'awaiting_payment', subtotal, fee?.totalFee ?? 0, fee?.amountPaid ?? 0, providerTxId, covered ? null : new Date(ctx.clock.now().getTime() + HOLD_MINUTES * 60_000).toISOString(), o.advertId ?? null, now, mailbox?.key ?? null, creditUse],
      );
      for (const l of lines) await q.query(`INSERT INTO ticket_order_lines (order_id, type_id, type_name, qty, unit_price) VALUES ($1,$2,$3,$4,$5)`, [id, l.c.row.id, l.c.row.name, l.qty, l.price]);
      if (creditUse > 0) await spendIn(q, ctx, e.org_id, id, credits, creditUse, now);
      if (fee) {
        await q.query(`INSERT INTO give_intents (id, provider_tx_id, org_id, branch_id, purpose, project_id, phone, method, base_amount, amount_paid, fee, created_at) VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,$11)`,
          [ctx.newId('int'), providerTxId, e.org_id, branch.id, `TKT-${code}`, phone ?? '', method, payable, fee.amountPaid, JSON.stringify(fee), now]);
      }
    });
    if (startPrompt) {
      try {
        providerTxId = await startPrompt();
        await ctx.db.query(`UPDATE ticket_orders SET provider_tx_id=$2 WHERE id=$1 AND provider_tx_id IS NULL`, [id, providerTxId]);
        await ctx.db.query(`UPDATE give_intents SET provider_tx_id=$2 WHERE purpose=$1 AND provider_tx_id IS NULL`, [`TKT-${code}`, providerTxId]);
      } catch (err) {
        // The provider would not take the prompt: nothing is live, so the order is released with its stock and any credit it held.
        await ctx.db.query(`UPDATE ticket_orders SET status='lapsed', hold_until=NULL WHERE id=$1 AND status='awaiting_payment'`, [id]);
        await restoreUsed(ctx, id);
        throw err;
      }
    }
    await ctx.ledger.audit({ orgId: e.org_id, branchId: e.branch_id, actor: b.userId ?? undefined, actorType: b.userId ? 'user' : 'system', action: 'ticket.order', entity: 'ticket_order', entityId: id, summary: `${free ? 'Took' : 'Started an order for'} ${lines.map((l) => `${l.qty} x ${l.c.row.name}`).join(', ')} for "${e.title}"${free ? '' : `, ${kesText(subtotal)}${creditUse ? `, of which ${kesText(creditUse)} from event credit` : ''}${fee ? ` plus a ${kesText(fee.totalFee)} service fee` : ''}`}`, meta: { order: code, subtotal, free, creditUsed: creditUse, advert: o.advertId ?? null } });
    if (covered) await issueTickets(id);
    return { id, secret, code, free, covered, creditUsed: creditUse, checkoutUrl, subtotal, serviceFee: fee?.totalFee ?? 0, total: fee?.amountPaid ?? 0, method };
  }

  // ======================= public: event page, ordering, ticket page =======================

  app.get('/public/event/:code', async (req) => publicEvent(await eventByCode((req.params as any).code)));

  app.get('/public/event/:code/poster', async (req, reply) => {
    const e = await eventByCode((req.params as any).code);
    if (!e.poster_data) throw new HttpError(404, 'no poster', 'not_found');
    return reply.header('content-type', e.poster_mime).header('cache-control', 'public, max-age=300').send(Buffer.from(e.poster_data, 'base64'));
  });

  /** What the buyer will pay, before they commit: the tickets, the service fee on top, and the total (L172). */
  async function quoteFor(b: any, e: any, who: { userId?: string | null; code?: unknown; amount?: number | null }) {
    const types = await counts(e.id);
    let subtotal = 0;
    let count = 0;
    for (const l of Array.isArray(b.lines) ? b.lines : []) {
      const c = types.find((x) => x.row.id === String(l?.typeId));
      const qty = Math.floor(Number(l?.qty));
      if (!c || !Number.isFinite(qty) || qty < 1 || qty > 10000) continue;
      subtotal += qty * Number(c.row.price);
      count += qty;
    }
    if (subtotal === 0) return { count, subtotal: 0, serviceFee: 0, total: 0, free: true, credit: 0, creditUsed: 0, covered: false };
    const credits = await findCredits(ctx, e.org_id, who);
    const credit = credits.reduce((s, c) => s + c.balance, 0);
    const creditUsed = Math.min(credit, subtotal, who.amount != null ? Math.max(0, who.amount) : Infinity);
    if (creditUsed === subtotal) return { count, subtotal, serviceFee: 0, total: 0, free: false, credit, creditUsed, covered: true };
    const org = (await ctx.db.query<any>(`SELECT fee_schedule FROM organisations WHERE id=$1`, [e.org_id]))[0];
    const method = b.method === 'card' || b.method === 'airtel' || b.method === 'tkash' ? b.method : 'mpesa';
    const fee = computeFee(org.fee_schedule, method, subtotal - creditUsed, 'member');
    return { count, subtotal, serviceFee: fee.totalFee, total: fee.amountPaid, free: false, credit, creditUsed, covered: false };
  }

  app.post('/public/tickets/quote', async (req) => {
    const b = (req.body ?? {}) as any;
    const e = await eventByCode(str(b.code, { max: 40, label: 'The event code' }));
    return quoteFor(b, e, { code: b.creditCode, amount: creditAmt(b.creditAmount) });
  });

  app.post('/me/tickets/quote', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const e = await eventByCode(str(b.code, { max: 40, label: 'The event code' }));
    return quoteFor(b, e, { userId: b.useCredit === false ? null : req.session!.uid, code: b.creditCode, amount: creditAmt(b.creditAmount) });
  });

  app.post('/public/tickets/orders', async (req) => {
    const b = (req.body ?? {}) as any;
    const e = await eventByCode(str(b.code, { max: 40, label: 'The event code' }));
    const name = text(b.name, 80, 'name', true)!;
    const r = await createOrder({ event: e, lines: b.lines, method: b.method, buyer: { name, email: text(b.email, 120, 'email', true)!.toLowerCase(), phone: b.phone ? String(b.phone) : null, userId: null, membershipId: null }, advertId: null, req, credit: b.creditCode ? { code: b.creditCode, amount: creditAmt(b.creditAmount) } : undefined });
    if (legalVersionOf(b.legalVersion)) await ctx.db.query(`UPDATE ticket_orders SET legal_version=$2, legal_accepted_at=$3 WHERE id=$1`, [r.id, legalVersionOf(b.legalVersion), ctx.clock.now().toISOString()]);
    return orderResponse(r.id);
  });

  async function orderResponse(id: string) {
    const o = (await ctx.db.query<any>(`SELECT o.*, e.title, e.code AS event_code FROM ticket_orders o JOIN events e ON e.id=o.event_id WHERE o.id=$1`, [id]))[0];
    const ev = (await ctx.db.query<any>(`SELECT * FROM events WHERE id=$1`, [o.event_id]))[0];
    const lines = await ctx.db.query<any>(`SELECT type_name, qty, unit_price FROM ticket_order_lines WHERE order_id=$1 ORDER BY type_name`, [id]);
    const tickets = o.status === 'paid' ? await ticketsOf(id) : [];
    return {
      id: o.id, secret: o.secret, code: o.code, status: o.status, event: { title: o.title, code: o.event_code }, subtotal: Number(o.subtotal), serviceFee: Number(o.service_fee), total: Number(o.total), method: o.method,
      refund: await refundStateFor(ctx, o, ev), credit: await creditStateFor(ctx, o, ev), creditUsed: Number(o.credit_used), creditIssued: Number(o.credit_issued), eventStatus: ev.status,
      holdUntil: o.hold_until, payUrl: o.status === 'awaiting_payment' && o.method === 'card' && o.provider_tx_id ? `${ctx.givingUrl}/checkout/${o.provider_tx_id}` : null,
      lines: lines.map((l) => ({ name: l.type_name, qty: l.qty, unitPrice: Number(l.unit_price) })),
      tickets: tickets.map((t) => ({ id: t.id, serial: t.serial, type: t.type_name, holder: t.holder_name, status: t.status, url: ticketUrl(t.token), token: t.token })),
      message: o.status === 'awaiting_payment' ? (o.method === 'card' ? 'Open the card page to pay. Your tickets are held for 15 minutes.' : 'Check your phone and enter your PIN. Your tickets are held for 15 minutes.') : o.status === 'paid' ? 'Your tickets are confirmed. We have emailed them to you.' : undefined,
    };
  }

  app.get('/public/tickets/orders/:secret', async (req) => {
    const o = (await ctx.db.query<any>(`SELECT id FROM ticket_orders WHERE secret=$1`, [(req.params as any).secret]))[0];
    if (!o) throw new HttpError(404, 'order not found', 'not_found');
    return orderResponse(o.id);
  });

  /** `own` is true for the signed-in buyer's list (member app), which needs the order's refund and credit state. The public ticket page gets this ticket only: no order secret, no order actions (AZ-06). */
  async function ticketView(t: any, own = false) {
    const e = (await ctx.db.query<any>(`SELECT e.*, o.name AS church FROM events e JOIN organisations o ON o.id=e.org_id WHERE e.id=$1`, [t.event_id]))[0];
    const ord = (await ctx.db.query<any>(`SELECT * FROM ticket_orders WHERE id=$1`, [t.order_id]))[0];
    return {
      order: own ? { id: ord.id, code: ord.code, refund: await refundStateFor(ctx, ord, e), credit: await creditStateFor(ctx, ord, e) } : { code: ord.code },
      id: t.id, serial: t.serial, type: t.type_name, holder: t.holder_name, status: t.status, usedAt: t.checked_in_at, url: ticketUrl(t.token), token: t.token, qrSvg: qrSvg(ticketUrl(t.token)),
      event: { id: e.id, code: e.code, title: e.title, startsAt: e.starts_at, endsAt: e.ends_at, location: e.location, church: e.church, branding: await brandingInfo(ctx, e.org_id), cancelled: e.status === 'cancelled', postponed: e.status === 'postponed', movedFrom: e.postponed_from && e.status === 'scheduled' ? e.postponed_from : null, posterUrl: e.poster_data ? `/public/event/${e.code}/poster` : null },
    };
  }

  /** The ticket page behind every QR code and email link. The long random token is the secret (L174). */
  app.get('/public/tickets/:token', async (req) => {
    const t = (await ctx.db.query<any>(`SELECT * FROM tickets WHERE token=$1`, [(req.params as any).token]))[0];
    if (!t) throw new HttpError(404, 'We could not find that ticket', 'not_found');
    return ticketView(t);
  });

  // ======================= members =======================

  app.post('/me/tickets/orders', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const uid = req.session!.uid;
    const e = (await ctx.db.query<any>(`SELECT * FROM events WHERE id=$1 AND ticketed`, [String(b.eventId ?? '')]))[0];
    const m = e ? (await ctx.db.query<any>(`SELECT id, full_name FROM memberships WHERE user_id=$1 AND org_id=$2 AND status='active' ORDER BY joined_at LIMIT 1`, [uid, e.org_id]))[0] : null;
    if (!e || !m) throw new HttpError(404, 'That event was not found', 'not_found');
    const user = (await ctx.db.query<any>(`SELECT email FROM users WHERE id=$1`, [uid]))[0];
    const open = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM ticket_orders WHERE buyer_user_id=$1 AND status='awaiting_payment' AND hold_until > $2`, [uid, nowIso()]))[0].n);
    if (open >= 3) throw new HttpError(429, 'You have 3 ticket orders waiting for payment. Pay for them or cancel them first.', 'too_many');
    const r = await createOrder({ event: e, lines: b.lines, method: b.method, buyer: { name: m.full_name, email: user?.email ?? null, phone: b.phone ? String(b.phone) : req.session!.phone, userId: uid, membershipId: m.id }, advertId: b.advertId ? String(b.advertId) : null, req, credit: { userId: b.useCredit === false ? null : uid, code: b.creditCode, amount: creditAmt(b.creditAmount) } });
    return orderResponse(r.id);
  });

  app.get('/me/tickets', auth, async (req) => {
    const uid = req.session!.uid;
    const rows = await ctx.db.query<any>(
      `SELECT t.* FROM tickets t JOIN ticket_orders o ON o.id=t.order_id JOIN events e ON e.id=t.event_id
        WHERE o.buyer_user_id=$1 AND t.status <> 'cancelled' ORDER BY e.starts_at DESC, t.serial LIMIT 100`,
      [uid],
    );
    const tickets = [];
    for (const t of rows) tickets.push(await ticketView(t, true));
    const pend = await ctx.db.query<any>(`SELECT id FROM ticket_orders WHERE buyer_user_id=$1 AND status='awaiting_payment' AND hold_until > $2 ORDER BY created_at DESC`, [uid, nowIso()]);
    const pending = [];
    for (const p of pend) pending.push(await orderResponse(p.id));
    return { tickets, pending };
  });

  app.post('/me/tickets/orders/:id/cancel', auth, async (req) => {
    const o = (await ctx.db.query<any>(`SELECT * FROM ticket_orders WHERE id=$1 AND buyer_user_id=$2`, [(req.params as any).id, req.session!.uid]))[0];
    if (!o) throw new HttpError(404, 'order not found', 'not_found');
    if (o.status !== 'awaiting_payment') throw new HttpError(409, 'Only an order that is waiting for payment can be cancelled', 'wrong_state');
    await ctx.db.query(`UPDATE ticket_orders SET status='lapsed' WHERE id=$1`, [o.id]);
    await restoreUsed(ctx, o.id);
    return { id: o.id, status: 'lapsed' };
  });

  // ======================= staff: setting up tickets (L170) =======================

  async function staffEvent(req: FastifyRequest, id: string, perm: 'events.manage' | 'events.view' | 'events.checkin') {
    const e = (await ctx.db.query<any>(`SELECT * FROM events WHERE id=$1`, [id]))[0];
    if (!e || !(await inStaffScope(ctx, req, perm, e.org_id, e.branch_id))) throw new HttpError(404, 'not found', 'not_found');
    return e;
  }

  app.put('/events/:id/ticketing', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const e = await staffEvent(req, (req.params as any).id, 'events.manage');
    if (e.status === 'cancelled') throw new HttpError(409, 'This event was cancelled', 'locked');
    const before = await counts(e.id);
    const ticketed = !!b.ticketed;
    let refundDays: number | null = e.refund_days_before ?? null;
    if ('refundDaysBefore' in b) {
      refundDays = b.refundDaysBefore === null || b.refundDaysBefore === '' ? null : Number(b.refundDaysBefore);
      if (refundDays !== null && (!Number.isInteger(refundDays) || refundDays < 0 || refundDays > 365)) throw new HttpError(400, 'Refunds can be allowed from 0 to 365 days before the event', 'bad_days');
    }
    const changeReason = text(b.reason, 200, 'reason');
    const incoming: any[] = Array.isArray(b.types) ? b.types : [];
    if (ticketed && incoming.length === 0) throw new HttpError(400, 'Add at least one ticket type', 'bad_types');
    if (incoming.length > 10) throw new HttpError(400, 'An event can have up to 10 ticket types', 'bad_types');
    const kept = new Set<string>();
    const rows: any[] = [];
    const names = new Set<string>();
    incoming.forEach((t, i) => {
      const name = text(t.name, 40, 'ticket name', true)!;
      if (names.has(name.toLowerCase())) throw new HttpError(400, `There are two ticket types called "${name}"`, 'duplicate');
      names.add(name.toLowerCase());
      let price: number;
      price = t.price === '' || t.price === undefined || t.price === null ? 0 : parseKes(t.price, { min: 0, max: 150_000, label: `the price of "${name}"` });
      if (price < 0 || (price > 0 && price < 1000) || price > 15_000_000) throw new HttpError(400, `The price of "${name}" must be 0 or between KES 10 and KES 150,000`, 'bad_amount');
      const quantity = Number(t.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100_000) throw new HttpError(400, `Enter how many "${name}" tickets are available (1 to 100,000)`, 'bad_number');
      const perOrderMax = t.perOrderMax === undefined || t.perOrderMax === '' ? 10 : Number(t.perOrderMax);
      if (!Number.isInteger(perOrderMax) || perOrderMax < 1 || perOrderMax > MAX_PER_ORDER) throw new HttpError(400, `Most per order must be from 1 to ${MAX_PER_ORDER}`, 'bad_number');
      const salesStart = isoOrNull(t.salesStart, 'sales start');
      const salesEnd = isoOrNull(t.salesEnd, 'sales end');
      if (salesStart && salesEnd && salesEnd <= salesStart) throw new HttpError(400, `Sales for "${name}" must close after they open`, 'bad_date');
      const old = t.id ? before.find((x) => x.row.id === t.id) : undefined;
      if (t.id && !old) throw new HttpError(404, 'One of the ticket types was not found', 'not_found');
      if (old) {
        kept.add(old.row.id);
        if (quantity < old.sold + old.held) throw new HttpError(409, `${old.sold + old.held} "${old.row.name}" tickets are already sold or held, so the number cannot be less than that`, 'quantity_too_low');
      }
      rows.push({ id: old?.row.id ?? ctx.newId('tkt'), old, name, description: text(t.description, 120, 'description'), price, quantity, perOrderMax, salesStart, salesEnd, active: t.active !== false, sort: i });
    });
    for (const old of before) if (!kept.has(old.row.id) && (old.sold > 0 || old.held > 0)) throw new HttpError(409, `"${old.row.name}" has sales, so it cannot be removed. Switch it off instead.`, 'has_sales');
    const code = e.code ?? newCode();
    await ctx.db.tx(async (q) => {
      for (const old of before) if (!kept.has(old.row.id)) await q.query(`DELETE FROM ticket_types WHERE id=$1`, [old.row.id]);
      for (const r of rows) {
        if (r.old) await q.query(`UPDATE ticket_types SET name=$2, description=$3, price=$4, quantity=$5, per_order_max=$6, sales_start=$7, sales_end=$8, active=$9, sort=$10 WHERE id=$1`, [r.id, r.name, r.description, r.price, r.quantity, r.perOrderMax, r.salesStart, r.salesEnd, r.active, r.sort]);
        else await q.query(`INSERT INTO ticket_types (id, org_id, event_id, name, description, price, quantity, per_order_max, sales_start, sales_end, active, sort, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [r.id, e.org_id, e.id, r.name, r.description, r.price, r.quantity, r.perOrderMax, r.salesStart, r.salesEnd, r.active, r.sort, nowIso()]);
      }
      // A ticketed event takes its own numbers, so replies and a capacity would only confuse people.
      await q.query(`UPDATE events SET ticketed=$2, code=$3, rsvp=CASE WHEN $2 THEN false ELSE rsvp END, capacity=CASE WHEN $2 THEN NULL ELSE capacity END, refund_days_before=$5, updated_at=$4 WHERE id=$1`, [e.id, ticketed, code, nowIso(), ticketed ? refundDays : null]);
    });
    const changes = rows.flatMap((r) => diff(TYPE_SPECS, r.old ? { name: r.old.row.name, price: Number(r.old.row.price), quantity: r.old.row.quantity, perOrderMax: r.old.row.per_order_max, salesStart: r.old.row.sales_start, salesEnd: r.old.row.sales_end, active: r.old.row.active } : null, { name: r.name, price: r.price, quantity: r.quantity, perOrderMax: r.perOrderMax, salesStart: r.salesStart, salesEnd: r.salesEnd, active: r.active }).map((c) => ({ ...c, label: `${r.name}: ${c.label}` })));
    await ctx.ledger.audit({ orgId: e.org_id, branchId: e.branch_id, actor: req.session!.uid, action: 'event.ticketing', entity: 'event', entityId: e.id, summary: ticketed ? `Set the ticket types for "${e.title}": ${rows.map((r) => `${r.name} ${r.price ? kesText(r.price) : 'free'} x ${r.quantity}`).join(', ')}` : `Turned tickets off for "${e.title}"`, reason: changeReason ?? undefined, changes, meta: { refundDaysBefore: ticketed ? refundDays : null } });
    return { id: e.id, ticketed, code, shareUrl: `${ctx.givingUrl}/?event=${code}` };
  });

  app.post('/events/:id/poster', auth, async (req) => {
    const e = await staffEvent(req, (req.params as any).id, 'events.manage');
    const p = validateArtwork((req.body as any)?.image);
    await ctx.db.query(`UPDATE events SET poster_mime=$2, poster_data=$3, poster_w=$4, poster_h=$5, updated_at=$6 WHERE id=$1`, [e.id, p.mime, p.data, p.width, p.height, nowIso()]);
    await ctx.ledger.audit({ orgId: e.org_id, branchId: e.branch_id, actor: req.session!.uid, action: 'event.update', entity: 'event', entityId: e.id, summary: `Changed the poster of "${e.title}"` });
    return { ok: true };
  });

  app.get('/events/:id/poster', auth, async (req, reply) => {
    const e = await staffEvent(req, (req.params as any).id, 'events.view');
    if (!e.poster_data) throw new HttpError(404, 'no poster', 'not_found');
    return reply.header('content-type', e.poster_mime).header('cache-control', 'private, max-age=300').send(Buffer.from(e.poster_data, 'base64'));
  });

  app.get('/events/:id/tickets', auth, async (req) => {
    const e = await staffEvent(req, (req.params as any).id, 'events.view');
    const types = await counts(e.id);
    const fees = (await ctx.db.query<any>(`SELECT COALESCE(SUM(service_fee),0) AS fees, COALESCE(SUM(subtotal),0) AS money, count(*)::int AS orders FROM ticket_orders WHERE event_id=$1 AND status='paid'`, [e.id]))[0];
    // A cancelled event: the paid orders the church now has to refund by hand (money is never returned automatically).
    const refunds = e.status === 'cancelled'
      ? (await ctx.db.query<any>(`SELECT o.id, o.code, o.buyer_name, o.method, o.total, o.created_at, (SELECT count(*) FROM tickets t WHERE t.order_id=o.id)::int AS n FROM ticket_orders o WHERE o.event_id=$1 AND o.status='paid' AND o.total > 0 AND o.credit_issued = 0 AND NOT EXISTS (SELECT 1 FROM ticket_refunds r WHERE r.order_id=o.id AND r.status IN ('approved','refunded')) ORDER BY o.created_at`, [e.id]))
          .map((o) => ({ orderId: o.id, code: o.code, buyer: o.buyer_name, method: o.method, total: Number(o.total), tickets: o.n, at: o.created_at }))
      : [];
    return {
      status: e.status, cancelReason: e.cancel_reason, refunds, refundDaysBefore: e.refund_days_before ?? null, postponed: e.postponed_at ? { note: e.postpone_note, from: e.postponed_from, refundUntil: e.refund_open_until ?? null } : null,
      pendingRefunds: Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM ticket_refunds WHERE event_id=$1 AND status='pending'`, [e.id]))[0].n),
      eventId: e.id, ticketed: e.ticketed, code: e.code, shareUrl: e.code ? `${ctx.givingUrl}/?event=${e.code}` : null, hasPoster: !!e.poster_data, posterUrl: e.poster_data ? `/events/${e.id}/poster` : null,
      types: types.map((t) => typeView(t, true)),
      totals: { sold: types.reduce((s, t) => s + t.sold, 0), held: types.reduce((s, t) => s + t.held, 0), checkedIn: types.reduce((s, t) => s + t.used, 0), takings: Number(fees.money), serviceFees: Number(fees.fees), orders: fees.orders },
    };
  });

  app.get('/events/:id/attendees', auth, async (req, reply) => {
    const q = req.query as any;
    const e = await staffEvent(req, (req.params as any).id, 'events.manage');
    const params: unknown[] = [e.id];
    let where = `t.event_id=$1`;
    if (q.status) { params.push(String(q.status)); where += ` AND t.status=$${params.length}`; }
    if (q.type) { params.push(String(q.type)); where += ` AND t.type_id=$${params.length}`; }
    const term = String(q.q ?? '').trim().slice(0, 60);
    if (term) { params.push(`%${term.replace(/[!%_]/g, (c) => `!${c}`)}%`); where += ` AND (t.holder_name ILIKE $${params.length} ESCAPE '!' OR t.serial ILIKE $${params.length} ESCAPE '!' OR o.code ILIKE $${params.length} ESCAPE '!' OR o.buyer_email ILIKE $${params.length} ESCAPE '!')`; }
    const rows = await ctx.db.query<any>(`SELECT t.id, t.serial, t.holder_name, t.type_name, t.status, t.checked_in_at, t.cancel_reason, o.id AS order_id, o.code AS order_code, o.buyer_email, o.method, o.created_at, u.name AS by_name FROM tickets t JOIN ticket_orders o ON o.id=t.order_id LEFT JOIN users u ON u.id=t.checked_in_by WHERE ${where} ORDER BY t.serial LIMIT 2000`, params);
    const out = rows.map((r) => ({ id: r.id, serial: r.serial, holder: r.holder_name, type: r.type_name, status: r.status, checkedInAt: r.checked_in_at, checkedInBy: r.by_name, cancelReason: r.cancel_reason, orderId: r.order_id, orderCode: r.order_code, email: maskEmail(r.buyer_email), bought: r.created_at }));
    if (q.format === 'csv') return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="tickets-${e.code ?? e.id}.csv"`).send(csv(out.map((r) => ({ ticket: r.serial, name: r.holder, type: r.type, status: r.status, checked_in: r.checkedInAt ?? '', order: r.orderCode, email: r.email ?? '' }))));
    return out;
  });

  app.post('/tickets/:id/cancel', auth, async (req) => {
    const t = (await ctx.db.query<any>(`SELECT t.*, o.buyer_user_id, o.buyer_email, o.code AS order_code, o.total, o.method, e.title, e.branch_id FROM tickets t JOIN ticket_orders o ON o.id=t.order_id JOIN events e ON e.id=t.event_id WHERE t.id=$1`, [(req.params as any).id]))[0];
    if (!t || !(await inStaffScope(ctx, req, 'events.manage', t.org_id, t.branch_id))) throw new HttpError(404, 'ticket not found', 'not_found');
    if (t.status !== 'valid') throw new HttpError(409, t.status === 'used' ? 'This ticket was already used at the door' : 'This ticket is already cancelled', 'wrong_state');
    const reason = text((req.body as any)?.reason, 200, 'reason', true)!;
    await ctx.db.query(`UPDATE tickets SET status='cancelled', cancelled_by=$2, cancel_reason=$3 WHERE id=$1`, [t.id, req.session!.uid, reason]);
    await ctx.ledger.audit({ orgId: t.org_id, branchId: t.branch_id, actor: req.session!.uid, action: 'ticket.cancel', entity: 'ticket', entityId: t.id, summary: `Cancelled ticket ${t.serial} for "${t.title}"`, reason, meta: { order: t.order_code, paid: Number(t.total) > 0 } });
    const body = `Your ticket ${t.serial} for ${t.title} was cancelled: ${reason}.${Number(t.total) > 0 ? ' If you paid for it, the church will arrange your refund with you.' : ''}`;
    if (t.buyer_user_id) await addNotification(ctx, { orgId: t.org_id, userId: t.buyer_user_id, kind: 'announcement', title: 'A ticket was cancelled', body, link: 'member:tickets' });
    if (t.buyer_email) await sendEmail(ctx, t.org_id, t.buyer_email, `Your ticket for ${t.title} was cancelled`, body);
    return { id: t.id, status: 'cancelled', refundNeeded: Number(t.total) > 0 };
  });

  app.post('/tickets/orders/:id/resend', auth, async (req) => {
    const o = (await ctx.db.query<any>(`SELECT o.*, e.branch_id AS ebranch FROM ticket_orders o JOIN events e ON e.id=o.event_id WHERE o.id=$1`, [(req.params as any).id]))[0];
    if (!o || !(await inStaffScope(ctx, req, 'events.manage', o.org_id, o.ebranch))) throw new HttpError(404, 'order not found', 'not_found');
    if (o.status !== 'paid') throw new HttpError(409, 'Only a paid order has tickets to send', 'wrong_state');
    await sendConfirmation(o.id);
    await ctx.ledger.audit({ orgId: o.org_id, branchId: o.ebranch, actor: req.session!.uid, action: 'ticket.resend', entity: 'ticket_order', entityId: o.id, summary: `Sent the tickets of order ${o.code} again` });
    return { ok: true };
  });

  // ======================= the door (L175) =======================

  const tokenOf = (raw: string) => {
    const s = raw.trim();
    const m = /\/t\/([A-Za-z0-9_-]{20,})\/?(?:\?.*)?$/.exec(s);
    return m ? m[1] : s;
  };

  app.post('/events/:id/checkin', auth, async (req) => {
    const e = await staffEvent(req, (req.params as any).id, 'events.checkin');
    const raw = String((req.body as any)?.code ?? (req.body as any)?.token ?? '').trim();
    if (!raw) throw new HttpError(400, 'Scan a ticket or type its code', 'bad_code');
    const key = tokenOf(raw);
    const t = (await ctx.db.query<any>(`SELECT t.*, o.code AS order_code, ub.name AS used_by FROM tickets t JOIN ticket_orders o ON o.id=t.order_id LEFT JOIN users ub ON ub.id=t.checked_in_by WHERE t.token=$1 OR upper(t.serial)=upper($1)`, [key]))[0];
    if (!t) return { result: 'not_found', message: 'We do not know this ticket' };
    const base = { serial: t.serial, holder: t.holder_name, type: t.type_name };
    if (t.event_id !== e.id) {
      const other = (await ctx.db.query<any>(`SELECT title FROM events WHERE id=$1`, [t.event_id]))[0];
      return { result: 'wrong_event', ...base, message: `This ticket is for ${other?.title ?? 'another event'}` };
    }
    if (t.status === 'cancelled') return { result: 'cancelled', ...base, message: 'This ticket was cancelled' };
    if (e.status === 'cancelled') return { result: 'event_cancelled', ...base, message: 'This event was cancelled' };
    if (e.status === 'postponed') return { result: 'event_postponed', ...base, message: 'This event was postponed. Do not let anyone in yet.' };
    const pending = (await ctx.db.query<any>(`SELECT 1 FROM ticket_refunds WHERE order_id=$1 AND status='pending'`, [t.order_id]))[0];
    if (pending) return { result: 'refund_pending', ...base, message: 'The buyer asked for a refund for this ticket. Ask a manager before letting them in.' };
    const upd = await ctx.db.query<any>(`UPDATE tickets SET status='used', checked_in_at=$2, checked_in_by=$3 WHERE id=$1 AND status='valid' RETURNING id`, [t.id, nowIso(), req.session!.uid]);
    if (upd.length === 0) {
      const again = (await ctx.db.query<any>(`SELECT t.checked_in_at, u.name AS by_name FROM tickets t LEFT JOIN users u ON u.id=t.checked_in_by WHERE t.id=$1`, [t.id]))[0];
      return { result: 'already_used', ...base, usedAt: again.checked_in_at, usedBy: again.by_name, message: `Already used at ${when(again.checked_in_at)}` };
    }
    const group = (await ctx.db.query<any>(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status='used')::int AS used FROM tickets WHERE order_id=$1 AND status <> 'cancelled'`, [t.order_id]))[0];
    await ctx.ledger.audit({ orgId: e.org_id, branchId: e.branch_id, actor: req.session!.uid, action: 'ticket.checkin', entity: 'ticket', entityId: t.id, summary: `Checked in ${t.holder_name}, ${t.type_name}, ticket ${t.serial} for "${e.title}"`, meta: { order: t.order_code } });
    return { result: 'valid', ...base, message: 'Valid. Let them in.', group: { total: group.total, checkedIn: group.used } };
  });

  app.get('/events/:id/checkin/stats', auth, async (req) => {
    const e = await staffEvent(req, (req.params as any).id, 'events.checkin');
    const r = (await ctx.db.query<any>(`SELECT count(*) FILTER (WHERE status IN ('valid','used'))::int AS sold, count(*) FILTER (WHERE status='used')::int AS used FROM tickets WHERE event_id=$1`, [e.id]))[0];
    const recent = await ctx.db.query<any>(`SELECT t.holder_name, t.type_name, t.checked_in_at FROM tickets t WHERE t.event_id=$1 AND t.status='used' ORDER BY t.checked_in_at DESC LIMIT 8`, [e.id]);
    return { title: e.title, startsAt: e.starts_at, sold: r.sold, checkedIn: r.used, recent: recent.map((x) => ({ holder: x.holder_name, type: x.type_name, at: x.checked_in_at })) };
  });

  /** Events with tickets, for the check-in screen: what the person may scan for today and soon. */
  app.get('/checkin/events', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'events.checkin');
    const now = ctx.clock.now().getTime();
    const rows = await ctx.db.query<any>(`SELECT id, title, starts_at, ends_at, branch_id, location, status FROM events WHERE org_id=$1 AND ticketed AND status='scheduled' AND COALESCE(ends_at, starts_at) >= $2 AND starts_at <= $3 ORDER BY starts_at`, [g.orgId, new Date(now - 12 * 3600_000).toISOString(), new Date(now + 30 * 86400_000).toISOString()]);
    return rows.filter((e) => (e.branch_id ? g.branchIds.includes(e.branch_id) : g.wholeOrg)).map((e) => ({ id: e.id, title: e.title, startsAt: e.starts_at, location: e.location }));
  });
}

/** A payment for TKT-code arrived: the order is paid and the tickets are made and sent (L173, L174). */
export async function ticketsPaid(ctx: Ctx, code: string, paymentId: string): Promise<void> {
  const now = ctx.clock.now().toISOString();
  const o = (await ctx.db.query<any>(`SELECT o.*, e.title FROM ticket_orders o JOIN events e ON e.id=o.event_id WHERE o.code=$1`, [code]))[0];
  if (!o || o.status === 'paid') return;
  if (o.status === 'lapsed') {
    // Paid after the hold ran out: honour it if the tickets are still there, otherwise flag a refund.
    const lines = await ctx.db.query<any>(`SELECT type_id, qty FROM ticket_order_lines WHERE order_id=$1`, [o.id]);
    for (const l of lines) {
      const t = (await ctx.db.query<any>(`SELECT quantity FROM ticket_types WHERE id=$1`, [l.type_id]))[0];
      const sold = Number((await ctx.db.query<any>(`SELECT count(*) AS n FROM tickets WHERE type_id=$1 AND status IN ('valid','used')`, [l.type_id]))[0].n);
      const held = Number((await ctx.db.query<any>(`SELECT COALESCE(SUM(l.qty),0) AS n FROM ticket_order_lines l JOIN ticket_orders x ON x.id=l.order_id WHERE l.type_id=$1 AND x.status='awaiting_payment' AND x.hold_until > $2`, [l.type_id, now]))[0].n);
      if (!t || t.quantity - sold - held < Number(l.qty)) {
        await ctx.db.query(`UPDATE ticket_orders SET payment_id=$2 WHERE id=$1`, [o.id, paymentId]);
        await ctx.ledger.audit({ orgId: o.org_id, branchId: o.branch_id, actorType: 'psp', action: 'ticket.paid_late', entity: 'ticket_order', entityId: o.id, summary: `Payment arrived for the lapsed ticket order ${o.code} but the tickets are gone. Arrange a refund.`, links: { paymentId } });
        return;
      }
    }
  }
  if (o.status === 'lapsed' && Number(o.credit_used) > 0 && !(await retakeUsed(ctx, o.id))) {
    await ctx.db.query(`UPDATE ticket_orders SET payment_id=$2 WHERE id=$1`, [o.id, paymentId]);
    await ctx.ledger.audit({ orgId: o.org_id, branchId: o.branch_id, actorType: 'psp', action: 'ticket.paid_late', entity: 'ticket_order', entityId: o.id, summary: `Payment arrived for the lapsed ticket order ${o.code} but the credit it used is gone. Arrange a refund.`, links: { paymentId } });
    return;
  }
  await ctx.db.query(`UPDATE ticket_orders SET status='paid', payment_id=$2, paid_at=$3, hold_until=NULL WHERE id=$1`, [o.id, paymentId, now]);
  await ctx.ledger.audit({ orgId: o.org_id, branchId: o.branch_id, actorType: 'psp', action: 'ticket.paid', entity: 'ticket_order', entityId: o.id, summary: `Payment received for ticket order ${o.code} for "${o.title}"`, links: { paymentId } });
  await issueTicketsFor(ctx, o.id);
}

/** Makes the tickets for a paid order and sends them (L174). */
export async function issueTicketsFor(ctx: Ctx, orderId: string) {
  const o = (await ctx.db.query<any>(`SELECT o.*, e.title, e.code AS event_code FROM ticket_orders o JOIN events e ON e.id=o.event_id WHERE o.id=$1`, [orderId]))[0];
  const lines = await ctx.db.query<any>(`SELECT * FROM ticket_order_lines WHERE order_id=$1 ORDER BY type_name`, [orderId]);
  if ((await ctx.db.query<any>(`SELECT 1 FROM tickets WHERE order_id=$1 LIMIT 1`, [orderId]))[0]) return;
  const now = ctx.clock.now().toISOString();
  const have = Number((await ctx.db.query<any>(`SELECT count(*) AS n FROM tickets WHERE event_id=$1`, [o.event_id]))[0].n);
  let n = have;
  await ctx.db.tx(async (q) => {
    for (const l of lines) {
      for (let i = 0; i < l.qty; i++) {
        n++;
        await q.query(`INSERT INTO tickets (id, org_id, event_id, order_id, type_id, type_name, serial, token, holder_name, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [ctx.newId('tk'), o.org_id, o.event_id, orderId, l.type_id, l.type_name, `${o.event_code}-${String(n).padStart(4, '0')}`, randomBytes(18).toString('base64url'), o.buyer_name, now]);
      }
    }
  });
  await sendConfirmationFor(ctx, orderId);
}

async function ticketsOfOrder(ctx: Ctx, orderId: string) {
  return ctx.db.query<any>(`SELECT * FROM tickets WHERE order_id=$1 ORDER BY serial`, [orderId]);
}

/** The confirmation: an email with every ticket and its QR code, and for members a message in the app (L174). */
export async function sendConfirmationFor(ctx: Ctx, orderId: string) {
  const o = (await ctx.db.query<any>(`SELECT o.*, e.title, e.starts_at, e.ends_at, e.location, org.name AS church FROM ticket_orders o JOIN events e ON e.id=o.event_id JOIN organisations org ON org.id=o.org_id WHERE o.id=$1`, [orderId]))[0];
  const tickets = await ticketsOfOrder(ctx, orderId);
  if (!tickets.length) return;
  const lines: string[] = [];
  for (const t of tickets) lines.push(`${t.type_name} for ${t.holder_name}, ticket ${t.serial}: ${ticketUrlOf(ctx, t.token)}`);
  if (o.buyer_user_id) {
    await addNotification(ctx, {
      orgId: o.org_id, userId: o.buyer_user_id, kind: 'receipt', title: `Your tickets for ${o.title}`,
      body: `You have ${tickets.length} ticket${tickets.length === 1 ? '' : 's'} for ${o.title}, ${when(o.starts_at)}${o.location ? ` at ${o.location}` : ''}. Open My tickets to show the QR code at the door.`, link: 'member:tickets',
    });
  }
  if (o.buyer_email) {
    const orderLink = `${ctx.givingUrl}/tickets/${o.secret}`;
    const subject = `Your tickets for ${o.title}`;
    const plain = `Hello ${o.buyer_name},\n\nThank you. Your ${tickets.length === 1 ? 'ticket is' : 'tickets are'} confirmed for ${o.title}\n${when(o.starts_at)}${o.location ? `\n${o.location}` : ''}\nHosted by ${o.church}\n\nShow the QR code at the door. Each ticket works once.\n\n${lines.join('\n')}\n\nTo change or cancel your order, use this private link: ${orderLink}\n\nOrder ${o.code}${o.total > 0 ? `, paid ${kesText(Number(o.total))} (tickets ${kesText(Number(o.subtotal))} plus a ${kesText(Number(o.service_fee))} service fee)` : ', free'}.\n`;
    const cards = tickets.map((t) => `<div style="border:1px solid #e3e0d6;border-radius:14px;padding:16px;margin:12px 0;text-align:center"><div style="font-weight:700">${esc(t.type_name)}</div><div style="color:#667">${esc(t.holder_name)}</div><img alt="QR code for ticket ${esc(t.serial)}" width="200" height="200" src="${qrGif(ticketUrlOf(ctx, t.token))}" style="margin:8px 0"/><div style="font-family:monospace;letter-spacing:1px">${esc(t.serial)}</div><div style="margin-top:8px"><a href="${ticketUrlOf(ctx, t.token)}">Open or print this ticket</a></div></div>`).join('');
    const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#17212b"><h2 style="color:#0e5a52">You are going to ${esc(o.title)}</h2><p>Hello ${esc(o.buyer_name)}, thank you. Your ${tickets.length === 1 ? 'ticket is' : 'tickets are'} confirmed.</p><p><b>${esc(when(o.starts_at))}</b>${o.location ? `<br/>${esc(o.location)}` : ''}<br/>Hosted by ${esc(o.church)}</p><p>Show the QR code at the door. Each ticket works once.</p>${cards}<p style="font-size:13px"><a href="${orderLink}">Manage this order</a> to ask for a refund, keep it as credit or cancel. Keep this link private.</p><p style="color:#667;font-size:13px">Order ${esc(o.code)}${o.total > 0 ? `. Paid ${kesText(Number(o.total))}: tickets ${kesText(Number(o.subtotal))} plus a ${kesText(Number(o.service_fee))} service fee.` : '. Free.'}</p></div>`;
    await sendEmail(ctx, o.org_id, o.buyer_email, subject, plain, html);
  }
}



/** Holds that ran out are released, and ticket holders get a reminder the day before (L173, L177). */
export async function runTicketJobs(ctx: Ctx): Promise<{ lapsed: number; reminders: number; refunded: number }> {
  const refunds = await runRefundJobs(ctx);
  await runCreditReminders(ctx).catch((e) => console.error(`credit reminders failed ${errLine(e)}`));
  const now = ctx.clock.now().toISOString();
  const lapsed = await ctx.db.query<any>(`UPDATE ticket_orders SET status='lapsed' WHERE status='awaiting_payment' AND hold_until <= $1 RETURNING id, org_id, branch_id, code`, [now]);
  for (const o of lapsed) await restoreUsed(ctx, o.id);
  for (const o of lapsed) await ctx.ledger.audit({ orgId: o.org_id, branchId: o.branch_id, actorType: 'system', action: 'ticket.lapsed', entity: 'ticket_order', entityId: o.id, summary: `The ticket order ${o.code} was not paid in time. The tickets were released.` });
  const soon = await ctx.db.query<any>(`UPDATE events SET ticket_reminder_sent=true WHERE ticketed AND status='scheduled' AND NOT ticket_reminder_sent AND starts_at > $1 AND starts_at <= $2 RETURNING *`, [now, new Date(ctx.clock.now().getTime() + 24 * 3600_000).toISOString()]);
  let reminders = 0;
  for (const e of soon) {
    const orders = await ctx.db.query<any>(`SELECT o.id, o.buyer_name, o.buyer_email, o.buyer_user_id, (SELECT count(*) FROM tickets t WHERE t.order_id=o.id AND t.status='valid')::int AS n FROM ticket_orders o WHERE o.event_id=$1 AND o.status='paid'`, [e.id]);
    for (const o of orders) {
      if (!o.n) continue;
      const body = `${e.title} is ${when(e.starts_at)}${e.location ? ` at ${e.location}` : ''}. Have your QR code ready at the door.`;
      if (o.buyer_user_id) await addNotification(ctx, { orgId: e.org_id, userId: o.buyer_user_id, kind: 'announcement', title: `Tomorrow: ${e.title}`, body, link: 'member:tickets' });
      if (o.buyer_email) await sendEmail(ctx, e.org_id, o.buyer_email, `Tomorrow: ${e.title}`, `Hello ${o.buyer_name},\n\n${body}\n\nYour tickets are in the email we sent you when you bought them, or open them from My tickets in the app.\n`);
      reminders++;
    }
  }
  return { lapsed: lapsed.length, reminders, refunded: refunds.refunded };
}

/** An event was cancelled: every buyer is told and the church is told how many paid orders need a refund (L176). */
export async function notifyTicketBuyersOfCancel(ctx: Ctx, event: any, reason: string | null): Promise<{ orders: number; ticketsToRefund: number; ordersToRefund: number }> {
  const now = ctx.clock.now().toISOString();
  for (const l of await ctx.db.query<any>(`UPDATE ticket_orders SET status='lapsed' WHERE event_id=$1 AND status='awaiting_payment' RETURNING id`, [event.id])) await restoreUsed(ctx, l.id);
  const orders = await ctx.db.query<any>(`SELECT o.*, (SELECT count(*) FROM tickets t WHERE t.order_id=o.id AND t.status <> 'cancelled')::int AS n FROM ticket_orders o WHERE o.event_id=$1 AND o.status='paid'`, [event.id]);
  let tickets = 0;
  let ordersToRefund = 0;
  for (const o of orders) {
    const paid = Number(o.total) > 0;
    if (paid) { ordersToRefund++; tickets += o.n; }
    const body = `"${event.title}" was cancelled.${reason ? ` ${reason}` : ''}${paid ? ' You can keep your money as event credit for another event from your ticket page, or the church will arrange your refund with you.' : ''}`;
    if (o.buyer_user_id) await addNotification(ctx, { orgId: o.org_id, userId: o.buyer_user_id, kind: 'announcement', title: 'An event was cancelled', body, link: 'member:tickets' });
    if (o.buyer_email) await sendEmail(ctx, o.org_id, o.buyer_email, `${event.title} was cancelled`, `Hello ${o.buyer_name},\n\n${body}\n`);
  }
  if (orders.length) await ctx.ledger.audit({ orgId: event.org_id, branchId: event.branch_id, actorType: 'system', action: 'ticket.event_cancelled', entity: 'event', entityId: event.id, summary: `"${event.title}" was cancelled. ${orders.length} ticket orders were told, ${ordersToRefund} paid orders need a refund.`, meta: { orders: orders.length, ordersToRefund, ticketsToRefund: tickets } });
  return { orders: orders.length, ordersToRefund, ticketsToRefund: tickets };
}
