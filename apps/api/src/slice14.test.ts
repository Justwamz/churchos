import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { checkEmail, emailKey } from './email-rules';
import { runTicketJobs } from './routes/tickets';

let app: Awaited<ReturnType<typeof buildApp>>['app'];
let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
const tokens: Record<string, string> = {};
async function login(phone: string) {
  if (tokens[phone]) return tokens[phone];
  const r = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: '123456' } });
  tokens[phone] = r.json().token;
  return tokens[phone];
}
const call = async (phone: string | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: any) =>
  app.inject({ method, url, payload, headers: phone ? { authorization: `Bearer ${await login(phone)}` } : {} });

const OWNER = '0700000001', ADMIN = '0700000003', PA1 = '0700000099', HOPE = '0700000005';
const JANE = '0711000001', PETER = '0711000002';
const HOUR = 3600_000, DAY = 24 * HOUR;
const wait = async (fn: () => Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
const inbox = async (who: string) => (await call(who, 'GET', '/me/notifications')).json().rows as any[];
const order = async (secret: string) => (await call(null, 'GET', `/public/tickets/orders/${secret}`)).json();
const inDays = (n: number) => new Date(ctx.clock.now().getTime() + n * DAY).toISOString();

/** A ticketed event starting in `days` days, refundable until `refundDays` before (or never). */
async function makeEvent(title: string, days: number, refundDays: number | null, price = 200000) {
  const id = (await call(OWNER, 'POST', '/events', { title, audience: { type: 'org' }, startsAt: inDays(days), endsAt: inDays(days + 0.1), location: 'Main hall' })).json().id;
  const r = await call(OWNER, 'PUT', `/events/${id}/ticketing`, { ticketed: true, refundDaysBefore: refundDays, types: [{ name: price ? 'Regular' : 'Entry', price: price / 100, quantity: 100 }] });
  expect(r.statusCode).toBe(200);
  const s = (await call(OWNER, 'GET', `/events/${id}/tickets`)).json();
  return { id, code: s.code as string, type: s.types[0].id as string };
}
let n = 0;
async function buy(ev: { code: string; type: string }, qty = 1, extra: any = {}) {
  n++;
  const r = await call(null, 'POST', '/public/tickets/orders', { code: ev.code, name: extra.name ?? `Buyer Number${n}`, email: extra.email ?? `buyer.number${n}@acme.co.ke`, phone: extra.phone ?? `0711777${String(100 + n)}`, method: 'mpesa', lines: [{ typeId: ev.type, qty }] });
  expect(r.statusCode).toBe(200);
  const o = r.json();
  expect(await wait(async () => (await order(o.secret)).status === 'paid')).toBe(true);
  return order(o.secret);
}
const smsTo = (phone: string) => ctx.messaging.sent.filter((m) => m.channel === 'sms' && m.to === phone);

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);

describe('email addresses everywhere on the platform (L191)', () => {
  it('refuses made-up, example, throw-away and plus addresses, and accepts real ones', () => {
    for (const bad of ['abc@gmail.com', 'test@gmail.com', 'jo@acme.co.ke', 'aaaa@acme.co.ke', 'name+1@gmail.com', 'x@example.com', 'someone@test.com', 'real@mailinator.com', 'real.person@localhost', 'a@yopmail.com', 'qwerty@gmail.com', 'me@acme.co.ke', 'nobody@example.org', 'user@something.test', 'abc123@gmail.com', 'plainaddress', 'two@@acme.co.ke', ' ']) {
      expect(checkEmail(bad).ok, bad).toBe(false);
    }
    for (const good of ['ken@jtl.co.ke', 'wanjala@acme.co.ke', 'mary.wanjiku@gmail.com', 'Daniel.Mwangi@GraceChurch.org', 'esther-njeri@outlook.com']) {
      expect(checkEmail(good).ok, good).toBe(true);
    }
    expect(emailKey('Mary.Wanjiku@googlemail.com')).toBe('marywanjiku@gmail.com');
    expect(emailKey('mary.wanjiku@acme.co.ke')).toBe('mary.wanjiku@acme.co.ke');
  });

  it('applies to ticket buyers, member profiles, staff alerts and branch details', async () => {
    const ev = await makeEvent('Email rules night', 40, null);
    const base = { code: ev.code, name: 'Some Body', phone: '0711888001', method: 'mpesa', lines: [{ typeId: ev.type, qty: 1 }] };
    for (const email of ['abc@gmail.com', 'name+1@gmail.com', 'a@mailinator.com', 'x@example.com']) {
      expect((await call(null, 'POST', '/public/tickets/orders', { ...base, email })).json().code, email).toBe('bad_email');
    }
    expect((await call(JANE, 'PUT', '/me/profile', { email: 'abc@gmail.com' })).json().code).toBe('bad_email');
    expect((await call(JANE, 'PUT', '/me/profile', { email: 'jane.wanjiku@gmail.com' })).statusCode).toBe(200);
    expect((await call(OWNER, 'PUT', '/certificates/branch-profile/br_grc001', { address: 'Road', town: 'Nairobi', phone: '+254 700 000 111', email: 'test@acme.co.ke' })).json().code).toBe('bad_email');
    const cfg = (await call(OWNER, 'GET', '/integrations')).json();
    const put = (alertEmails: string[]) => call(OWNER, 'PUT', '/integrations', { walletMode: cfg.walletMode, smsSenderId: cfg.smsSenderId, whatsappDisplayName: cfg.whatsappDisplayName, whatsappNumber: cfg.whatsappNumber, alertEmails });
    expect((await put(['finance@gracechurch.org', 'abc@gmail.com'])).json().code).toBe('bad_email');
  });

  it('counts one mailbox once for the free-ticket limit, whatever dots are used', async () => {
    const free = await makeEvent('Free entry night', 40, null, 0);
    const a = await call(null, 'POST', '/public/tickets/orders', { code: free.code, name: 'Ann Lee', email: 'ann.lee.k@gmail.com', lines: [{ typeId: free.type, qty: 10 }] });
    expect(a.statusCode).toBe(200);
    const b = await call(null, 'POST', '/public/tickets/orders', { code: free.code, name: 'Ann Lee', email: 'annleek@googlemail.com', lines: [{ typeId: free.type, qty: 1 }] });
    expect(b.json().code).toBe('free_limit');
  });
});

describe('how long before the event tickets can be refunded (L193)', () => {
  it('is set per event, validated, and audited with the reason for any change', async () => {
    const ev = await makeEvent('Refund policy night', 60, 30);
    expect((await call(OWNER, 'GET', `/events/${ev.id}/tickets`)).json().refundDaysBefore).toBe(30);
    expect((await call(null, 'GET', `/public/event/${ev.code}`)).json().refundDaysBefore).toBe(30);
    const put = (extra: any) => call(OWNER, 'PUT', `/events/${ev.id}/ticketing`, { ticketed: true, types: [{ id: ev.type, name: 'Regular', price: 2000, quantity: 150 }], ...extra });
    expect((await put({ refundDaysBefore: -1 })).json().code).toBe('bad_days');
    expect((await put({ refundDaysBefore: 400 })).json().code).toBe('bad_days');
    expect((await put({ refundDaysBefore: 14, reason: 'Venue extended, more room' })).statusCode).toBe(200);
    expect((await call(OWNER, 'GET', `/events/${ev.id}/tickets`)).json().refundDaysBefore).toBe(14);
    const evs = (await call(PA1, 'GET', '/admin/audit/events?action=event.ticketing')).json().events as any[];
    expect(evs.some((e) => /Venue extended/.test(e.reason ?? ''))).toBe(true);
    expect((await put({ refundDaysBefore: null })).statusCode).toBe(200);
    expect((await call(OWNER, 'GET', `/events/${ev.id}/tickets`)).json().refundDaysBefore).toBeNull();
  });

  it('can be raised after sales begin, but not cut below what is sold', async () => {
    const ev = await makeEvent('Demand night', 60, null);
    await buy(ev, 5);
    const put = (quantity: number) => call(OWNER, 'PUT', `/events/${ev.id}/ticketing`, { ticketed: true, types: [{ id: ev.type, name: 'Regular', price: 2000, quantity, }], reason: 'Demand' });
    expect((await put(250)).statusCode).toBe(200);
    expect((await put(3)).json().code).toBe('quantity_too_low');
  });
});

describe('a buyer cancels and asks for a refund, and the church approves each one (L193, L194)', () => {
  let ev: { id: string; code: string; type: string };
  beforeAll(async () => { ev = await makeEvent('Gala refund test', 60, 30); });

  it('says whether a buyer can ask, and until when', async () => {
    const o = await buy(ev, 2);
    expect(o.refund).toMatchObject({ allowed: true, freeCancel: false, request: null });
    expect(Date.parse(o.refund.until)).toBeCloseTo(Date.parse(inDays(30)), -4);
    const closed = await makeEvent('Too late test', 20, 30);
    expect((await buy(closed)).refund).toMatchObject({ allowed: false, why: 'The time to ask for a refund for this event has ended.' });
    const never = await makeEvent('No refunds test', 60, null);
    expect((await buy(never)).refund.why).toBe('Tickets for this event cannot be refunded.');
  });

  it('puts a request in front of the church and holds the tickets in the meantime', async () => {
    const o = await buy(ev, 2, { phone: '0711999001' });
    const r = await call(null, 'POST', `/public/tickets/orders/${o.secret}/refund-request`, { reason: 'Cannot travel' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'requested', refund: true });
    const after = await order(o.secret);
    expect(after.refund.request.status).toBe('pending');
    expect(after.refund.allowed).toBe(false);
    expect(after.tickets.every((t: any) => t.status === 'valid')).toBe(true);
    expect((await call(null, 'POST', `/public/tickets/orders/${o.secret}/refund-request`, {})).json().code).toBe('not_refundable');
    // At the door, the ticket is held back until the church decides.
    const door = await call(OWNER, 'POST', `/events/${ev.id}/checkin`, { code: o.tickets[0].serial });
    expect(door.json().result).toBe('refund_pending');
    const list = (await call(OWNER, 'GET', `/events/${ev.id}/refund-requests`)).json();
    expect(list.pending).toBeGreaterThanOrEqual(1);
    const mine = list.requests.find((x: any) => x.orderCode === o.code);
    expect(mine).toMatchObject({ status: 'pending', kind: 'buyer', total: Number(o.total), reason: 'Cannot travel' });
    expect(ctx.email.sent.some((m) => /Refund request received/.test(m.subject))).toBe(true);
    const staffNote = (await ctx.db.query<any>(`SELECT title FROM notifications WHERE user_id='u_owner'`)).some((x) => /Refund request/.test(x.title));
    expect(staffNote).toBe(true);
  });

  it('lets the church decline with a reason, and the buyer cannot ask again', async () => {
    const list = (await call(OWNER, 'GET', `/events/${ev.id}/refund-requests`)).json().requests;
    const r = list.find((x: any) => x.status === 'pending');
    expect((await call(OWNER, 'POST', `/refund-requests/${r.id}/decide`, { approve: false })).json().code).toBe('bad_content');
    expect((await call(HOPE, 'POST', `/refund-requests/${r.id}/decide`, { approve: false, note: 'No' })).statusCode).toBe(404);
    const d = await call(OWNER, 'POST', `/refund-requests/${r.id}/decide`, { approve: false, note: 'Tickets are transferable. Please give them to a friend.' });
    expect(d.json().status).toBe('declined');
    expect((await call(OWNER, 'POST', `/refund-requests/${r.id}/decide`, { approve: false, note: 'again' })).json().code).toBe('already_decided');
    const o = (await ctx.db.query<any>(`SELECT secret FROM ticket_orders WHERE code=$1`, [r.orderCode]))[0];
    const view = await order(o.secret);
    expect(view.refund).toMatchObject({ allowed: false, request: { status: 'declined' } });
    expect(view.tickets.every((t: any) => t.status === 'valid')).toBe(true);
    expect((await call(null, 'POST', `/public/tickets/orders/${o.secret}/refund-request`, {})).json().code).toBe('not_refundable');
  });

  it('approves one: the tickets stop working, a refund request goes to ChurchOS, and the money follows', async () => {
    const o = await buy(ev, 1, { phone: '0711999002' });
    await call(null, 'POST', `/public/tickets/orders/${o.secret}/refund-request`, { reason: 'Clash' });
    const r = (await call(OWNER, 'GET', `/events/${ev.id}/refund-requests`)).json().requests.find((x: any) => x.orderCode === o.code);
    ctx.email.sent.length = 0;
    const a = await call(OWNER, 'POST', `/refund-requests/${r.id}/decide`, { approve: true, note: 'Sorry you cannot come' });
    expect(a.json().status).toBe('approved');
    const view = await order(o.secret);
    expect(view.tickets.every((t: any) => t.status === 'cancelled')).toBe(true);
    expect(view.refund.allowed).toBe(false);
    const rev = (await ctx.db.query<any>(`SELECT * FROM reversal_requests ORDER BY created_at DESC LIMIT 1`))[0];
    expect(rev).toMatchObject({ status: 'pending', source: 'staff', force: true });
    expect(rev.reason).toMatch(/Ticket refund/);
    expect(ctx.email.sent.some((m) => /refund for .* was approved/.test(m.subject))).toBe(true);
    const seen = (await call(OWNER, 'GET', `/events/${ev.id}/refund-requests`)).json().requests.find((x: any) => x.id === r.id);
    expect(seen).toMatchObject({ status: 'approved', money: 'Waiting for ChurchOS to send the money', decidedBy: 'Daniel Mwangi' });

    // ChurchOS sends the money, even though the usual 72-hour reversal window has passed.
    ctx.clock.advance(5 * DAY);
    const dec = await call(PA1, 'POST', `/admin/reversal-requests/${rev.id}/decide`, { approve: true });
    expect(dec.statusCode).toBe(200);
    ctx.email.sent.length = 0;
    expect((await runTicketJobs(ctx)).refunded).toBeGreaterThanOrEqual(1);
    const done = (await call(OWNER, 'GET', `/events/${ev.id}/refund-requests`)).json().requests.find((x: any) => x.id === r.id);
    expect(done).toMatchObject({ status: 'refunded', money: 'Money sent back' });
    expect(ctx.email.sent.some((m) => /refund for .* was sent/.test(m.subject))).toBe(true);
    expect((await runTicketJobs(ctx)).refunded).toBe(0);
  });

  it('cannot refund an order whose tickets were used at the door', async () => {
    const o = await buy(ev, 2);
    await call(null, 'POST', `/public/tickets/orders/${o.secret}/refund-request`, {});
    const r = (await call(OWNER, 'GET', `/events/${ev.id}/refund-requests`)).json().requests.find((x: any) => x.orderCode === o.code);
    // A pending request holds the door, so the manager lets the second ticket in by hand after declining; use a fresh order instead.
    await call(OWNER, 'POST', `/refund-requests/${r.id}/decide`, { approve: false, note: 'We would like you to come' });
    const used = await buy(ev, 1);
    expect((await call(OWNER, 'POST', `/events/${ev.id}/checkin`, { code: used.tickets[0].serial })).json().result).toBe('valid');
    const state = await order(used.secret);
    expect(state.refund.allowed).toBe(false);
    expect(state.refund.why).toMatch(/already used/);
    expect((await call(null, 'POST', `/public/tickets/orders/${used.secret}/refund-request`, {})).json().code).toBe('not_refundable');
  });

  it('works for members in the app, and free tickets are given back at once', async () => {
    const mine = await call(JANE, 'POST', '/me/tickets/orders', { eventId: ev.id, method: 'mpesa', lines: [{ typeId: ev.type, qty: 1 }] });
    expect(mine.statusCode).toBe(200);
    expect(await wait(async () => (await order(mine.json().secret)).status === 'paid')).toBe(true);
    const r = await call(JANE, 'POST', `/me/tickets/orders/${mine.json().id}/refund-request`, { reason: 'Unwell' });
    expect(r.json().status).toBe('requested');
    expect((await call(PETER, 'POST', `/me/tickets/orders/${mine.json().id}/refund-request`, {})).statusCode).toBe(404);
    const tix = (await call(JANE, 'GET', '/me/tickets')).json().tickets;
    expect(tix.some((t: any) => t.order?.refund?.request?.status === 'pending')).toBe(true);

    const free = await makeEvent('Free refund test', 30, null, 0);
    const o = await buy(free, 3);
    expect(o.refund).toMatchObject({ allowed: true, freeCancel: true });
    const c = await call(null, 'POST', `/public/tickets/orders/${o.secret}/refund-request`, {});
    expect(c.json()).toMatchObject({ status: 'cancelled', refund: false });
    expect((await order(o.secret)).tickets.every((t: any) => t.status === 'cancelled')).toBe(true);
    expect((await call(OWNER, 'GET', `/events/${free.id}/tickets`)).json().types[0].left).toBe(100);
  });

  it('refunds orders for a cancelled event one by one or all at once', async () => {
    const gone = await makeEvent('Cancelled refund test', 50, null);
    const a = await buy(gone, 2);
    const b = await buy(gone, 1);
    expect((await call(OWNER, 'POST', `/events/${gone.id}/refund-all`, {})).json().code).toBe('wrong_state');
    await call(OWNER, 'POST', `/events/${gone.id}/cancel`, { reason: 'Venue unavailable' });
    expect((await order(a.secret)).refund.why).toMatch(/church will arrange your refund/);
    const first = await call(OWNER, 'POST', `/events/${gone.id}/orders/${a.id}/refund`, { note: 'Venue unavailable' });
    expect(first.json().status).toBe('approved');
    expect((await call(OWNER, 'POST', `/events/${gone.id}/orders/${a.id}/refund`, {})).json().code).toBe('already_refunded');
    const rest = (await call(OWNER, 'GET', `/events/${gone.id}/tickets`)).json();
    expect(rest.refunds.map((x: any) => x.orderId)).toEqual([b.id]);
    const all = await call(OWNER, 'POST', `/events/${gone.id}/refund-all`, {});
    expect(all.json()).toMatchObject({ refunded: 1, failed: [] });
    expect((await call(OWNER, 'GET', `/events/${gone.id}/tickets`)).json().refunds).toEqual([]);
    const reqs = (await call(OWNER, 'GET', `/events/${gone.id}/refund-requests`)).json().requests;
    expect(reqs.map((x: any) => x.kind)).toEqual(['church', 'church']);
  });

  it('keeps the books balanced', async () => {
    expect((await call(PA1, 'GET', '/admin/reconcile')).json().ok).toBe(true);
  });
});

describe('postponing an event (L192)', () => {
  let ev: { id: string; code: string; type: string };
  let member: any;
  let guest: any;
  beforeAll(async () => {
    ev = await makeEvent('Postpone test night', 30, null);
    guest = await buy(ev, 2, { phone: '0711999010', email: 'guest.postpone@acme.co.ke' });
    const m = await call(JANE, 'POST', '/me/tickets/orders', { eventId: ev.id, method: 'mpesa', lines: [{ typeId: ev.type, qty: 1 }] });
    expect(await wait(async () => (await order(m.json().secret)).status === 'paid')).toBe(true);
    member = m.json();
  });

  it('is for managers of the event, and not for an event that is over or cancelled', async () => {
    expect((await call(HOPE, 'POST', `/events/${ev.id}/postpone`, { startsAt: inDays(60) })).statusCode).toBe(404);
    expect((await call(OWNER, 'POST', `/events/${ev.id}/postpone`, { startsAt: inDays(-1) })).json().code).toBe('bad_date');
    expect((await call(OWNER, 'POST', `/events/${ev.id}/postpone`, { startsAt: inDays(60), endsAt: inDays(59) })).json().code).toBe('bad_date');
    expect((await call(OWNER, 'POST', `/events/${ev.id}/postpone`, { startsAt: inDays(60), refundDays: 200 })).json().code).toBe('bad_days');
  });

  it('postpones with no date yet: sales and the door pause, everyone is told by email, SMS and in the app', async () => {
    ctx.email.sent.length = 0;
    ctx.messaging.clear();
    const r = await call(OWNER, 'POST', `/events/${ev.id}/postpone`, { note: 'The venue flooded' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'postponed', told: { orders: 2 } });
    expect(r.json().told.sms).toBeGreaterThanOrEqual(1);
    expect(ctx.email.sent.filter((m) => /Postponed: Postpone test night/.test(m.subject)).length).toBe(2);
    expect(ctx.email.sent.find((m) => /Postponed/.test(m.subject))!.body).toMatch(/new date will be announced[\s\S]*ask for a refund[\s\S]*\/tickets\//);
    expect(smsTo('254711999010').some((m) => /postponed/.test(m.body) && /\/tickets\//.test(m.body))).toBe(true);
    expect((await inbox(JANE)).some((n) => /Postponed: Postpone test night/.test(n.title))).toBe(true);
    const pub = (await call(null, 'GET', `/public/event/${ev.code}`)).json();
    expect(pub).toMatchObject({ status: 'postponed', postponed: { note: 'The venue flooded', startsAt: null } });
    const buyNow = await call(null, 'POST', '/public/tickets/orders', { code: ev.code, name: 'Late Comer', email: 'late.comer@acme.co.ke', phone: '0711999011', method: 'mpesa', lines: [{ typeId: ev.type, qty: 1 }] });
    expect(buyNow.json().code).toBe('postponed');
    const door = await call(OWNER, 'POST', `/events/${ev.id}/checkin`, { code: guest.tickets[0].serial });
    expect(door.json().result).toBe('event_postponed');
    expect((await call(OWNER, 'POST', `/events/${ev.id}/postpone`, {})).json().code).toBe('already');
    const upcoming = (await call(OWNER, 'GET', '/events')).json();
    expect(upcoming.find((e: any) => e.id === ev.id).status).toBe('postponed');
    const mine = (await call(JANE, 'GET', '/me/events')).json();
    expect((mine.rows ?? mine).some((e: any) => e.id === ev.id && e.status === 'postponed')).toBe(true);
  });

  it('lets a buyer ask for a refund while the date is not announced, whatever the usual policy', async () => {
    const o = await order(guest.secret);
    expect(o.refund).toMatchObject({ allowed: true, until: null });
    expect(o.eventStatus).toBe('postponed');
    const r = await call(null, 'POST', `/public/tickets/orders/${guest.secret}/refund-request`, { reason: 'Can no longer come' });
    expect(r.json().status).toBe('requested');
    const row = (await call(OWNER, 'GET', `/events/${ev.id}/refund-requests`)).json().requests[0];
    expect(row.kind).toBe('postponed');
  });

  it('sets the new date: tickets stay valid, sales resume, and a refund window opens', async () => {
    ctx.email.sent.length = 0;
    const newStart = inDays(45);
    const r = await call(OWNER, 'POST', `/events/${ev.id}/postpone`, { startsAt: newStart, refundDays: 14, note: 'Now in the new hall' });
    expect(r.json()).toMatchObject({ status: 'scheduled' });
    expect(r.json().told.orders).toBe(2);
    expect(ctx.email.sent.some((m) => /moved to/.test(m.body) && /Your tickets stay valid for the new date/.test(m.body))).toBe(true);
    const pub = (await call(null, 'GET', `/public/event/${ev.code}`)).json();
    expect(pub.status).toBe('scheduled');
    expect(pub.startsAt).toBe(newStart);
    expect(pub.postponed.startsAt).toBe(newStart);
    expect((await call(null, 'POST', '/public/tickets/orders', { code: ev.code, name: 'Late Comer', email: 'late.comer@acme.co.ke', phone: '0711999011', method: 'mpesa', lines: [{ typeId: ev.type, qty: 1 }] })).statusCode).toBe(200);
    const mem = await order(member.secret);
    expect(mem.tickets.every((t: any) => t.status === 'valid')).toBe(true);
    expect(mem.refund.allowed).toBe(true);
    expect(Date.parse(mem.refund.until)).toBeCloseTo(Date.parse(inDays(14)), -4);
    const ev2 = (await ctx.db.query<any>(`SELECT postponed_from, status, ticket_reminder_sent FROM events WHERE id=$1`, [ev.id]))[0];
    expect(ev2).toMatchObject({ status: 'scheduled', ticket_reminder_sent: false });
    expect(ev2.postponed_from).not.toBe(newStart);
    const log = (await call(PA1, 'GET', '/admin/audit/events?action=event.postponed')).json().events;
    expect(log.length).toBeGreaterThanOrEqual(2);
  });

  it('closes the refund window after the days the church set', async () => {
    ctx.clock.advance(15 * DAY);
    const mem = await order(member.secret);
    expect(mem.refund).toMatchObject({ allowed: false, why: 'The time to ask for a refund for this event has ended.' });
  });

  it('keeps the books balanced', async () => {
    expect((await call(PA1, 'GET', '/admin/reconcile')).json().ok).toBe(true);
  });
});
