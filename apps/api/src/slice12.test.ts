import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { gradientPng } from './artwork';
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
const call = async (phone: string | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: any) =>
  app.inject({ method, url, payload, headers: phone ? { authorization: `Bearer ${await login(phone)}` } : {} });

const OWNER = '0700000001', ADMIN = '0700000003', TREAS = '0700000002', HOPE = '0700000005', PA1 = '0700000099';
const JANE = '0711000001', PETER = '0711000002';
const DOOR = '0700000555'; // someone who can only scan tickets
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
const pub = async (code = 'GALA01') => (await call(null, 'GET', `/public/event/${code}`)).json();
const typeId = async (name: string, code = 'GALA01') => (await pub(code)).types.find((t: any) => t.name === name).id as string;
const buy = (extra: any = {}, lines: any[] = []) => call(null, 'POST', '/public/tickets/orders', { code: 'GALA01', name: 'Wanjala Barasa', email: 'wanjala@acme.co.ke', phone: '0711555001', method: 'mpesa', lines, ...extra });
const order = async (secret: string) => (await call(null, 'GET', `/public/tickets/orders/${secret}`)).json();
const paidOrder = async (lines: any[], extra: any = {}) => {
  const r = (await buy(extra, lines)).json();
  expect(await wait(async () => (await order(r.secret)).status === 'paid')).toBe(true);
  return order(r.secret);
};
const scan = (who: string, eventId: string, code: string) => call(who, 'POST', `/events/${eventId}/checkin`, { code });
const art = () => ({ mime: 'image/png', data: gradientPng(1280, 720, [10, 80, 90], [5, 30, 50]) });

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
  const now = ctx.clock.now().toISOString();
  await ctx.db.query(`INSERT INTO users (id, phone, name, created_at) VALUES ('u_door','254700000555','Door Volunteer',$1)`, [now]);
  await ctx.db.query(`INSERT INTO roles (id, org_id, name, permissions) VALUES ('org_grace:door','org_grace','Door','["events.checkin"]')`);
  await ctx.db.query(`INSERT INTO role_assignments (id, org_id, user_id, role_id, scope_type, scope_id) VALUES ('ra_door','org_grace','u_door','org_grace:door','org','org_grace')`);
}, 60000);

describe('setting up tickets (L170)', () => {
  let id = '';
  it('turns an event into a ticketed one with several types, and refuses sensible mistakes', async () => {
    id = (await call(OWNER, 'POST', '/events', { title: 'Marriage conference', audience: { type: 'org' }, startsAt: new Date(ctx.clock.now().getTime() + 20 * DAY).toISOString(), rsvp: true, capacity: 50 })).json().id;
    const set = (types: any[], extra: any = {}) => call(OWNER, 'PUT', `/events/${id}/ticketing`, { ticketed: true, types, ...extra });
    expect((await set([])).json().code).toBe('bad_types');
    expect((await set([{ name: 'A', price: 5, quantity: 10 }])).json().code).toBe('bad_amount'); // below KES 10 and not free
    expect((await set([{ name: 'A', price: 500, quantity: 0 }])).json().code).toBe('bad_number');
    expect((await set([{ name: 'A', price: 500, quantity: 10 }, { name: 'a', price: 100, quantity: 5 }])).json().code).toBe('duplicate');
    expect((await set([{ name: 'A', price: 500, quantity: 10, salesStart: '2030-01-02', salesEnd: '2030-01-01' }])).json().code).toBe('bad_date');
    expect((await set([{ name: 'Delegate', price: 3000, quantity: 100, description: 'Both days' }, { name: 'Student', price: 1000, quantity: 40 }])).statusCode).toBe(200);
    expect((await call(ADMIN, 'PUT', `/events/${id}/ticketing`, { ticketed: true, types: [{ name: 'x', price: 100, quantity: 1 }] })).statusCode).toBe(404); // an organisation-wide event is not Samuel's
    expect((await call(TREAS, 'PUT', `/events/${id}/ticketing`, { ticketed: true, types: [{ name: 'x', price: 100, quantity: 1 }] })).statusCode).toBe(404);
    const row = (await call(OWNER, 'GET', '/events')).json().find((e: any) => e.id === id);
    expect(row).toMatchObject({ ticketed: true, rsvp: false, capacity: null, ticketsSold: 0 }); // replies make no sense next to tickets
    expect(row.code).toMatch(/^[A-F0-9]{8}$/);
    const summary = (await call(OWNER, 'GET', `/events/${id}/tickets`)).json();
    expect(summary.types.map((t: any) => [t.name, t.price, t.quantity, t.left])).toEqual([['Delegate', 300000, 100, 100], ['Student', 100000, 40, 40]]);
    expect(summary.shareUrl).toContain(`/?event=${row.code}`);
  });

  it('takes a poster with the same rules as adverts, and changes are audited', async () => {
    expect((await call(OWNER, 'POST', `/events/${id}/poster`, { image: { mime: 'image/png', data: gradientPng(800, 800, [1, 2, 3], [4, 5, 6]) } })).json().code).toBe('artwork_ratio');
    expect((await call(OWNER, 'POST', `/events/${id}/poster`, { image: art() })).statusCode).toBe(200);
    const code = (await call(OWNER, 'GET', '/events')).json().find((e: any) => e.id === id).code;
    const img = await call(null, 'GET', `/public/event/${code}/poster`);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    const events = (await call(PA1, 'GET', '/admin/audit/events?action=event.ticketing')).json().events;
    expect(events.length).toBeGreaterThan(0);
  });

  it('cannot remove a type that has sales, or cut its number below what is sold', async () => {
    const s = (await call(OWNER, 'GET', `/events/${id}/tickets`)).json();
    const code = s.code;
    const student = s.types.find((t: any) => t.name === 'Student').id;
    const delegate = s.types.find((t: any) => t.name === 'Delegate').id;
    const r = (await call(null, 'POST', '/public/tickets/orders', { code, name: 'A B', email: 'abel@acme.co.ke', phone: '0711555009', method: 'mpesa', lines: [{ typeId: student, qty: 3 }] })).json();
    await wait(async () => (await order(r.secret)).status === 'paid');
    const keepBoth = (types: any[]) => call(OWNER, 'PUT', `/events/${id}/ticketing`, { ticketed: true, types });
    expect((await keepBoth([{ id: delegate, name: 'Delegate', price: 3000, quantity: 100 }])).json().code).toBe('has_sales'); // Student has sales
    expect((await keepBoth([{ id: delegate, name: 'Delegate', price: 3000, quantity: 100 }, { id: student, name: 'Student', price: 1000, quantity: 2 }])).json().code).toBe('quantity_too_low');
    expect((await keepBoth([{ id: delegate, name: 'Delegate', price: 3500, quantity: 100 }, { id: student, name: 'Student', price: 1000, quantity: 40, active: false }])).statusCode).toBe(200); // prices and switching off are fine
  });
});

describe('the public page and buying as a non-member (L171, L172)', () => {
  it('shows the event with what is left, never hiding the price', async () => {
    const e = await pub();
    expect(e).toMatchObject({ code: 'GALA01', title: 'Christmas Gala Dinner', church: 'Grace Community Church', over: false });
    expect(e.types.map((t: any) => [t.name, t.price])).toEqual([['Regular', 150000], ['Couple', 250000], ['Child under 12', 50000]]);
    expect(e.types[0].left).toBeNull(); // plenty left: no exact number
    expect(e.posterUrl).toBe('/public/event/GALA01/poster');
    expect((await call(null, 'GET', '/public/event/NOPE00')).statusCode).toBe(404);
    expect((await call(null, 'GET', '/public/event/PRAISE')).statusCode).toBe(200);
  });

  it('adds the service fee on top, takes the payment, and then issues one QR ticket each and emails them', async () => {
    const regular = await typeId('Regular');
    const sentBefore = ctx.email.sent.length;
    const r = (await buy({}, [{ typeId: regular, qty: 2 }])).json();
    expect(r).toMatchObject({ status: expect.stringMatching(/awaiting_payment|paid/), subtotal: 300000 });
    expect(r.serviceFee).toBeGreaterThan(0);
    expect(r.total).toBe(300000 + r.serviceFee); // the buyer pays the fee on top (L172)
    const o = await (async () => { await wait(async () => (await order(r.secret)).status === 'paid'); return order(r.secret); })();
    expect(o.status).toBe('paid');
    expect(o.tickets).toHaveLength(2);
    expect(new Set(o.tickets.map((t: any) => t.token)).size).toBe(2);
    expect(o.tickets[0].serial).toMatch(/^GALA01-\d{4}$/);
    const p = (await ctx.db.query<any>(`SELECT amount_paid, net FROM payments WHERE purpose=$1`, [`TKT-${o.code}`]))[0];
    expect(Number(p.amount_paid)).toBe(r.total);
    const mail = ctx.email.sent.slice(sentBefore).find((m) => m.to === 'wanjala@acme.co.ke')!;
    expect(mail.subject).toBe('Your tickets for Christmas Gala Dinner');
    expect(mail.body).toContain(o.tickets[0].url);
    expect((mail.html!.match(/<img /g) ?? []).length).toBe(2); // a QR code for each ticket
    expect(mail.html).toContain('data:image/gif;base64');
    expect(mail.html).toContain(o.tickets[1].serial);
  });

  it('refuses what cannot be bought, taking and holding nothing', async () => {
    const regular = await typeId('Regular');
    const child = await typeId('Child under 12');
    const lines = [{ typeId: regular, qty: 1 }];
    expect((await buy({ email: '' }, lines)).json().code).toBe('bad_content'); // email is required
    expect((await buy({ email: 'nope' }, lines)).json().code).toBe('bad_email');
    expect((await buy({ name: '' }, lines)).json().code).toBe('bad_content');
    expect((await buy({ method: 'cash' }, lines)).json().code).toBe('bad_method');
    expect((await buy({ method: 'airtel', phone: '0711555001' }, lines)).json().code).toBe('wrong_network');
    expect((await buy({ phone: '' }, lines)).json().code).toBe('bad_phone');
    expect((await buy({}, [])).json().code).toBe('bad_lines');
    expect((await buy({}, [{ typeId: regular, qty: 1 }, { typeId: regular, qty: 1 }])).json().code).toBe('bad_lines');
    expect((await buy({}, [{ typeId: 'tkt_nope', qty: 1 }])).statusCode).toBe(404);
    expect((await buy({}, [{ typeId: regular, qty: 11 }])).json().code).toBe('too_many'); // up to 10 of one type
    expect((await buy({}, [{ typeId: regular, qty: 10 }, { typeId: child, qty: 10 }, { typeId: await typeId('Couple'), qty: 5 }])).json().code).toBe('too_many'); // up to 20 tickets in total
    expect((await call(null, 'POST', '/public/tickets/orders', { code: 'NOPE00', name: 'x', email: 'x@example.com', lines })).statusCode).toBe(404);
    const held = (await call(OWNER, 'GET', `/events/${(await call(OWNER, 'GET', '/events')).json().find((e: any) => e.code === 'GALA01').id}/tickets`)).json().totals.held;
    expect(held).toBe(0);
  });
});

describe('never oversold, and holds are released (L173)', () => {
  let eventId = '';
  let code = '';
  let small = '';
  beforeAll(async () => {
    eventId = (await call(OWNER, 'POST', '/events', { title: 'Tiny workshop', audience: { type: 'org' }, startsAt: new Date(ctx.clock.now().getTime() + 5 * DAY).toISOString() })).json().id;
    const r = await call(OWNER, 'PUT', `/events/${eventId}/ticketing`, { ticketed: true, types: [{ name: 'Seat', price: 1000, quantity: 3, perOrderMax: 3 }] });
    code = r.json().code;
    small = (await call(null, 'GET', `/public/event/${code}`)).json().types[0].id;
  });
  const card = (name: string, qty: number) => call(null, 'POST', '/public/tickets/orders', { code, name, email: `${name.toLowerCase()}@acme.co.ke`, method: 'card', lines: [{ typeId: small, qty }] });

  it('holds the tickets while a buyer pays, and refuses a buyer who asks for more than is left', async () => {
    const a = (await card('Alice', 2)).json();
    expect(a.status).toBe('awaiting_payment');
    expect(a.payUrl).toMatch(/\/checkout\/CARD/);
    expect((await card('Bob', 2)).json().code).toBe('sold_out'); // only 1 left while Alice holds 2
    const b = await card('Bob', 1);
    expect(b.statusCode).toBe(200);
    expect((await card('Cy', 1)).json().code).toBe('sold_out');
    expect((await call(null, 'GET', `/public/event/${code}`)).json().types[0]).toMatchObject({ soldOut: true, onSale: false });
  });

  it('releases a hold after 15 minutes, and still honours a payment that arrives late', async () => {
    ctx.clock.advance(16 * 60_000);
    expect((await runTicketJobs(ctx)).lapsed).toBe(2);
    expect((await call(null, 'GET', `/public/event/${code}`)).json().types[0].left).toBe(3);
    const alice = (await ctx.db.query<any>(`SELECT secret, provider_tx_id FROM ticket_orders WHERE buyer_name='Alice'`))[0];
    expect((await order(alice.secret)).status).toBe('lapsed');
    await call(null, 'POST', `/public/checkout/${alice.provider_tx_id}/pay`, { number: '4242 4242 4242 4242', expiry: '12/30', cvc: '123' });
    expect(await wait(async () => (await order(alice.secret)).status === 'paid')).toBe(true); // the tickets were still there
    expect((await order(alice.secret)).tickets).toHaveLength(2);
  });

  it('flags a late payment for a refund when the tickets have gone', async () => {
    const dave = (await card('Dave', 1)).json(); // takes the last seat
    expect(dave.status).toBe('awaiting_payment');
    ctx.clock.advance(16 * 60_000);
    await runTicketJobs(ctx);
    const eve = (await card('Eve', 1)).json(); // someone else buys it after Dave's hold lapsed
    const evx = (await ctx.db.query<any>(`SELECT provider_tx_id FROM ticket_orders WHERE id=$1`, [eve.id]))[0];
    await call(null, 'POST', `/public/checkout/${evx.provider_tx_id}/pay`, { number: '4242 4242 4242 4242', expiry: '12/30', cvc: '123' });
    await wait(async () => (await order(eve.secret)).status === 'paid');
    const davex = (await ctx.db.query<any>(`SELECT provider_tx_id FROM ticket_orders WHERE id=$1`, [dave.id]))[0];
    await call(null, 'POST', `/public/checkout/${davex.provider_tx_id}/pay`, { number: '4242 4242 4242 4242', expiry: '12/30', cvc: '123' });
    await wait(async () => (await ctx.db.query<any>(`SELECT payment_id FROM ticket_orders WHERE id=$1`, [dave.id]))[0].payment_id != null);
    expect((await order(dave.secret)).status).toBe('lapsed'); // no tickets for Dave
    const flagged = (await call(PA1, 'GET', '/admin/audit/events?action=ticket.paid_late')).json().events;
    expect(flagged).toHaveLength(1);
  });
});

describe('members buy in the app (L171, L174)', () => {
  it('buys with the profile name, gets the tickets in the app, and a message', async () => {
    const regular = await typeId('Regular');
    const r = await call(JANE, 'POST', '/me/tickets/orders', { eventId: (await call(OWNER, 'GET', '/events')).json().find((e: any) => e.code === 'GALA01').id, method: 'mpesa', lines: [{ typeId: regular, qty: 1 }] });
    expect(r.statusCode).toBe(200);
    expect(await wait(async () => (await call(JANE, 'GET', '/me/tickets')).json().tickets.length >= 3)).toBe(true); // 2 from the seeded order and 1 now
    const mine = (await call(JANE, 'GET', '/me/tickets')).json();
    const t = mine.tickets[0];
    expect(t).toMatchObject({ holder: 'Jane Wanjiku', status: 'valid', type: 'Regular', event: { title: 'Christmas Gala Dinner' } });
    expect(t.qrSvg).toContain('<svg');
    expect(t.url).toContain('/t/');
    expect((await inbox(JANE)).some((n) => n.title === 'Your tickets for Christmas Gala Dinner')).toBe(true);
    expect((await call(PETER, 'GET', '/me/tickets')).json().tickets).toEqual([]);
  });

  it('shows ticketed events in the member list, and keeps others out', async () => {
    const e = (await call(JANE, 'GET', '/me/events')).json().find((x: any) => x.title === 'Christmas Gala Dinner');
    expect(e).toMatchObject({ ticketed: true, code: 'GALA01', ticketFrom: 50000, soldOut: false });
    expect((await call('0700000005', 'POST', '/me/tickets/orders', { eventId: e.id, method: 'mpesa', lines: [] })).statusCode).toBe(404);
    expect((await call(null, 'POST', '/me/tickets/orders', {})).statusCode).toBe(401);
  });

  it('gives free tickets at once, up to 10 a person for an event', async () => {
    const praise = (await call(OWNER, 'GET', '/events')).json().find((e: any) => e.code === 'PRAISE');
    const entry = await typeId('Entry', 'PRAISE');
    const get = (qty: number) => call(PETER, 'POST', '/me/tickets/orders', { eventId: praise.id, method: 'mpesa', lines: [{ typeId: entry, qty }] });
    const first = await get(4);
    expect(first.json()).toMatchObject({ status: 'paid', total: 0 });
    expect(first.json().tickets).toHaveLength(4);
    expect((await get(7)).json().code).toBe('free_limit'); // 4 + 7 is more than 10
    expect((await get(6)).statusCode).toBe(200);
    expect((await get(1)).json().code).toBe('free_limit');
    // a free ticket for a non-member needs an email address
    expect((await call(null, 'POST', '/public/tickets/orders', { code: 'PRAISE', name: 'Walk Up', email: '', lines: [{ typeId: entry, qty: 1 }] })).json().code).toBe('bad_content');
    const guest = await call(null, 'POST', '/public/tickets/orders', { code: 'PRAISE', name: 'Walk Up', email: 'walkup@acme.co.ke', lines: [{ typeId: entry, qty: 1 }] });
    expect(guest.json()).toMatchObject({ status: 'paid', total: 0 });
    expect(ctx.email.sent.some((m) => m.to === 'walkup@acme.co.ke' && m.subject.includes('Youth Praise Concert'))).toBe(true);
  });
});

describe('ticket page and the door (L174, L175)', () => {
  let eventId = '';
  let tickets: any[] = [];
  beforeAll(async () => {
    eventId = (await call(OWNER, 'GET', '/events')).json().find((e: any) => e.code === 'GALA01').id;
    tickets = (await call(JANE, 'GET', '/me/tickets')).json().tickets;
  });

  it('opens a ticket page from the QR link, with the code, the event and the state', async () => {
    const t = tickets[0];
    const page = (await call(null, 'GET', `/public/tickets/${t.token}`)).json();
    expect(page).toMatchObject({ serial: t.serial, holder: 'Jane Wanjiku', status: 'valid', event: { title: 'Christmas Gala Dinner', cancelled: false } });
    expect(page.qrSvg).toContain('<svg');
    expect((await call(null, 'GET', '/public/tickets/not-a-real-token-at-all-000')).statusCode).toBe(404);
  });

  it('lets a door volunteer scan a ticket, once, and tells them clearly what happened', async () => {
    const a = tickets[0];
    const b = tickets[1];
    const ok = (await scan(DOOR, eventId, a.url)).json(); // the QR holds the link
    expect(ok).toMatchObject({ result: 'valid', holder: 'Jane Wanjiku', type: 'Regular', serial: a.serial });
    expect(ok.group.total).toBeGreaterThanOrEqual(2);
    expect(ok.group.checkedIn).toBe(1);
    const again = (await scan(DOOR, eventId, a.token)).json(); // the bare token works too
    expect(again).toMatchObject({ result: 'already_used', usedBy: 'Door Volunteer' });
    expect(again.message).toMatch(/Already used at/);
    expect((await scan(DOOR, eventId, b.serial.toLowerCase())).json().result).toBe('valid'); // the typed code is not case sensitive
    expect((await scan(DOOR, eventId, 'GALA01-9999')).json().result).toBe('not_found');
    expect((await scan(DOOR, eventId, '')).statusCode).toBe(400);
    const praise = (await call(OWNER, 'GET', '/events')).json().find((e: any) => e.code === 'PRAISE');
    expect((await scan(DOOR, praise.id, a.token)).json().result).toBe('wrong_event');
    // the page shows it as used
    expect((await call(null, 'GET', `/public/tickets/${a.token}`)).json().status).toBe('used');
    const stats = (await call(DOOR, 'GET', `/events/${eventId}/checkin/stats`)).json();
    expect(stats.checkedIn).toBe(2);
    expect(stats.recent[0].holder).toBe('Jane Wanjiku');
    expect((await call(DOOR, 'GET', '/checkin/events')).json().map((e: any) => e.title)).toEqual(expect.arrayContaining([])); // only events that are on soon
    const log = (await call(PA1, 'GET', '/admin/audit/events?action=ticket.checkin')).json().events;
    expect(log.length).toBe(2);
  });

  it('shows the scanner nothing else, and only people with the permission can scan', async () => {
    expect((await call(TREAS, 'POST', `/events/${eventId}/checkin`, { code: tickets[0].token })).statusCode).toBe(404);
    expect((await call(JANE, 'POST', `/events/${eventId}/checkin`, { code: tickets[0].token })).statusCode).toBe(404);
    expect((await call(null, 'POST', `/events/${eventId}/checkin`, { code: 'x' })).statusCode).toBe(401);
    expect((await call(DOOR, 'GET', `/events/${eventId}/attendees`)).statusCode).toBe(404); // no list of buyers for the door
    expect((await call(DOOR, 'GET', `/events/${eventId}/tickets`)).statusCode).toBe(404);
    const r = (await scan(DOOR, eventId, tickets[2].token)).json();
    expect(Object.keys(r).sort()).toEqual(['group', 'holder', 'message', 'result', 'serial', 'type']);
  });
});

describe('cancelling, refunds and reports (L176, L177)', () => {
  let eventId = '';
  beforeAll(async () => { eventId = (await call(OWNER, 'GET', '/events')).json().find((e: any) => e.code === 'GALA01').id; });

  it('lists attendees with masked emails, searches, and exports a CSV', async () => {
    const all = (await call(OWNER, 'GET', `/events/${eventId}/attendees`)).json();
    expect(all.length).toBeGreaterThanOrEqual(5);
    expect(all.find((a: any) => a.holder === 'Wanjala Barasa').email).toMatch(/\*|•/);
    expect(JSON.stringify(all)).not.toContain('wanjala@acme.co.ke');
    expect((await call(OWNER, 'GET', `/events/${eventId}/attendees?q=wanjala`)).json().every((a: any) => a.holder === 'Wanjala Barasa')).toBe(true);
    expect((await call(OWNER, 'GET', `/events/${eventId}/attendees?q=%25`)).json()).toEqual([]);
    expect((await call(OWNER, 'GET', `/events/${eventId}/attendees?status=used`)).json().every((a: any) => a.status === 'used')).toBe(true);
    const csv = await call(OWNER, 'GET', `/events/${eventId}/attendees?format=csv`);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\n')[0]).toBe('ticket,name,type,status,checked_in,order,email');
    const s = (await call(OWNER, 'GET', `/events/${eventId}/tickets`)).json();
    expect(s.totals.sold).toBeGreaterThanOrEqual(5);
    expect(s.totals.checkedIn).toBe(3);
    expect(s.totals.takings).toBeGreaterThan(0);
    expect(s.totals.serviceFees).toBeGreaterThan(0);
  });

  it('cancels a ticket with a reason, frees it, tells the buyer, and refuses a used one', async () => {
    const all = (await call(OWNER, 'GET', `/events/${eventId}/attendees`)).json();
    const target = all.find((a: any) => a.holder === 'Wanjala Barasa' && a.status === 'valid');
    const before = (await call(OWNER, 'GET', `/events/${eventId}/tickets`)).json().types.find((t: any) => t.name === 'Regular').left;
    expect((await call(OWNER, 'POST', `/tickets/${target.id}/cancel`, {})).json().code).toBe('bad_content');
    expect((await call(TREAS, 'POST', `/tickets/${target.id}/cancel`, { reason: 'x' })).statusCode).toBe(404);
    const sentBefore = ctx.email.sent.length;
    const r = await call(OWNER, 'POST', `/tickets/${target.id}/cancel`, { reason: 'Duplicate purchase' });
    expect(r.json()).toMatchObject({ status: 'cancelled', refundNeeded: true });
    expect((await call(OWNER, 'GET', `/events/${eventId}/tickets`)).json().types.find((t: any) => t.name === 'Regular').left).toBe(before + 1);
    expect(ctx.email.sent.slice(sentBefore).some((m) => m.to === 'wanjala@acme.co.ke' && /cancelled/.test(m.subject))).toBe(true);
    expect((await scan(DOOR, eventId, target.serial)).json().result).toBe('cancelled');
    expect((await call(OWNER, 'POST', `/tickets/${target.id}/cancel`, { reason: 'again' })).statusCode).toBe(409);
    const used = all.find((a: any) => a.status === 'used');
    expect((await call(OWNER, 'POST', `/tickets/${used.id}/cancel`, { reason: 'no' })).statusCode).toBe(409);
  });

  it('sends the tickets again when asked', async () => {
    const all = (await call(OWNER, 'GET', `/events/${eventId}/attendees`)).json();
    const o = all.find((a: any) => a.holder === 'Wanjala Barasa' && a.status === 'valid');
    const before = ctx.email.sent.length;
    expect((await call(OWNER, 'POST', `/tickets/orders/${o.orderId}/resend`)).statusCode).toBe(200);
    expect(ctx.email.sent.length).toBe(before + 1);
    expect((await call(HOPE, 'POST', `/tickets/orders/${o.orderId}/resend`)).statusCode).toBe(404);
  });

  it('reminds ticket holders the day before, once', async () => {
    const starts = (await call(OWNER, 'GET', '/events')).json().find((e: any) => e.id === eventId).startsAt;
    ctx.clock.advance(Math.max(0, Date.parse(starts) - ctx.clock.now().getTime() - 30 * HOUR));
    await runTicketJobs(ctx);
    expect(ctx.email.sent.some((m) => m.subject === 'Tomorrow: Christmas Gala Dinner')).toBe(false);
    ctx.clock.advance(8 * HOUR);
    const mails = ctx.email.sent.length;
    await runTicketJobs(ctx);
    await runTicketJobs(ctx);
    expect((await inbox(JANE)).filter((n) => n.title === 'Tomorrow: Christmas Gala Dinner')).toHaveLength(0); // all of Jane's tickets were already used, so there is nothing to remind her about
    expect(ctx.email.sent.slice(mails).some((m) => m.to === 'wanjala@acme.co.ke' && m.subject.startsWith('Tomorrow'))).toBe(true);
  });

  it('tells every buyer when the event is cancelled, and says how many orders need a refund', async () => {
    const mails = ctx.email.sent.length;
    const r = (await call(OWNER, 'POST', `/events/${eventId}/cancel`, { reason: 'The hall is flooded.' })).json();
    expect(r.ordersToRefund).toBeGreaterThanOrEqual(2);
    expect(r.ticketsToRefund).toBeGreaterThanOrEqual(4);
    expect(ctx.email.sent.slice(mails).some((m) => /was cancelled/.test(m.subject) && m.body.includes('flooded'))).toBe(true);
    expect((await inbox(JANE)).some((n) => n.title === 'An event was cancelled' && /flooded/.test(n.body))).toBe(true);
    const t = (await call(JANE, 'GET', '/me/tickets')).json().tickets[0];
    expect((await scan(DOOR, eventId, t.token)).json().result).toMatch(/event_cancelled|already_used/);
    expect((await buy({}, [{ typeId: await typeId('Regular'), qty: 1 }])).statusCode).toBe(409);
    // the staff panel lists the paid orders that now need a refund, by hand
    const panel = (await call(OWNER, 'GET', `/events/${eventId}/tickets`)).json();
    expect(panel).toMatchObject({ status: 'cancelled', cancelReason: 'The hall is flooded.' });
    expect(panel.refunds.length).toBe(r.ordersToRefund);
    expect(panel.refunds[0]).toMatchObject({ code: expect.any(String), buyer: expect.any(String), total: expect.any(Number) });
    expect(panel.refunds.every((x: any) => x.total > 0)).toBe(true);
  });
});

describe('the door picker', () => {
  it('lists ticketed events up to a month ahead, so a gala in two weeks can be tested', async () => {
    const at = new Date(ctx.clock.now().getTime() + 20 * DAY).toISOString();
    const id = (await call(OWNER, 'POST', '/events', { title: 'Far gala', audience: { type: 'org' }, startsAt: at })).json().id;
    await call(OWNER, 'PUT', `/events/${id}/ticketing`, { ticketed: true, types: [{ name: 'Entry', price: 0, quantity: 10 }] });
    expect((await call(DOOR, 'GET', '/checkin/events')).json().map((e: any) => e.title)).toContain('Far gala');
    const beyond = new Date(ctx.clock.now().getTime() + 40 * DAY).toISOString();
    const id2 = (await call(OWNER, 'POST', '/events', { title: 'Too far gala', audience: { type: 'org' }, startsAt: beyond })).json().id;
    await call(OWNER, 'PUT', `/events/${id2}/ticketing`, { ticketed: true, types: [{ name: 'Entry', price: 0, quantity: 10 }] });
    expect((await call(DOOR, 'GET', '/checkin/events')).json().map((e: any) => e.title)).not.toContain('Too far gala');
  });
});

describe('adverts that sell tickets (L178)', () => {
  const mk = (extra: any) => call(OWNER, 'POST', '/adverts', { title: 'Praise concert', audience: { type: 'branch', id: 'br_grc001' }, image: art(), ...extra });
  it('leads straight to the ticket purchase for an event', async () => {
    const soon = new Date(ctx.clock.now().getTime() + 5 * DAY).toISOString();
    const praiseId = (await call(OWNER, 'POST', '/events', { title: 'Easter concert', audience: { type: 'org' }, startsAt: soon })).json().id;
    await call(OWNER, 'PUT', `/events/${praiseId}/ticketing`, { ticketed: true, types: [{ name: 'Entry', price: 0, quantity: 100 }] });
    const plainId = (await call(OWNER, 'POST', '/events', { title: 'Open house', audience: { type: 'org' }, startsAt: soon })).json().id;
    expect((await mk({ action: { kind: 'event', eventId: 'evt_nope' } })).statusCode).toBe(404);
    expect((await mk({ action: { kind: 'event', eventId: plainId } })).json().code).toBe('no_tickets');
    expect((await mk({ action: { kind: 'event', eventId: 'evt_gala' } })).json().code).toBe('event_over'); // it was cancelled above
    const made = await mk({ action: { kind: 'event', eventId: praiseId } });
    expect(made.statusCode).toBe(200);
    expect((await call(OWNER, 'GET', `/adverts/${made.json().id}`)).json().actionText).toBe('Sells tickets for Easter concert');
    await call(OWNER, 'POST', `/adverts/${made.json().id}/submit`);
    await call(ADMIN, 'POST', `/adverts/${made.json().id}/decide`, { approve: true });
    const ad = (await call(JANE, 'GET', '/me/adverts')).json().find((a: any) => a.title === 'Praise concert');
    expect(ad.action).toMatchObject({ kind: 'event', eventId: praiseId, event: { title: 'Easter concert', from: 0, available: true } });
    expect(ad.action.event.code).toMatch(/^[A-F0-9]{8}$/);
  });
});

describe('the price before paying (L172)', () => {
  it('quotes the tickets, the fee on top and the total, per payment method', async () => {
    const regular = await typeId('Regular');
    const mpesa = (await call(null, 'POST', '/public/tickets/quote', { code: 'GALA01', method: 'mpesa', lines: [{ typeId: regular, qty: 2 }] })).json();
    expect(mpesa).toMatchObject({ count: 2, subtotal: 300000, free: false });
    expect(mpesa.serviceFee).toBeGreaterThan(0);
    expect(mpesa.total).toBe(300000 + mpesa.serviceFee);
    const card = (await call(null, 'POST', '/public/tickets/quote', { code: 'GALA01', method: 'card', lines: [{ typeId: regular, qty: 2 }] })).json();
    expect(card.total).toBeGreaterThanOrEqual(mpesa.total); // a card costs at least as much as mobile money
    expect((await call(null, 'POST', '/public/tickets/quote', { code: 'PRAISE', lines: [{ typeId: await typeId('Entry', 'PRAISE'), qty: 3 }] })).json()).toMatchObject({ free: true, total: 0, count: 3 });
    expect((await call(null, 'POST', '/public/tickets/quote', { code: 'NOPE00', lines: [] })).statusCode).toBe(404);
  });
});
