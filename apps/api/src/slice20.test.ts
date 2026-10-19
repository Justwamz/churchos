import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
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

const OWNER = '0700000001', HOPE = '0700000005', PA1 = '0700000099';
const JANE = '0711000001', PETER = '0711000002';
const DAY = 86_400_000;
const wait = async (fn: () => Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
const order = async (secret: string) => (await call(null, 'GET', `/public/tickets/orders/${secret}`)).json();
const inDays = (n: number) => new Date(ctx.clock.now().getTime() + n * DAY).toISOString();

async function makeEvent(title: string, days: number, price: number, refundDays: number | null = 30) {
  const id = (await call(OWNER, 'POST', '/events', { title, audience: { type: 'org' }, startsAt: inDays(days), endsAt: inDays(days + 0.1), location: 'Main hall' })).json().id;
  expect((await call(OWNER, 'PUT', `/events/${id}/ticketing`, { ticketed: true, refundDaysBefore: refundDays, types: [{ name: 'Regular', price, quantity: 100 }] })).statusCode).toBe(200);
  const s = (await call(OWNER, 'GET', `/events/${id}/tickets`)).json();
  return { id, code: s.code as string, type: s.types[0].id as string };
}
let n = 0;
/** A guest buys and pays (the simulated phone pays at once). */
async function buy(ev: { code: string; type: string }, qty = 1, extra: any = {}) {
  n++;
  const r = await call(null, 'POST', '/public/tickets/orders', { code: ev.code, name: `Credit Buyer${n}`, email: `credit.buyer${n}@acme.co.ke`, phone: `0711666${String(100 + n)}`, method: 'mpesa', lines: [{ typeId: ev.type, qty }], ...extra });
  expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
  const o = r.json();
  if (!o.covered) expect(await wait(async () => (await order(o.secret)).status === 'paid')).toBe(true);
  return order(o.secret);
}
/** A member buys and pays. */
async function mine(who: string, ev: { id: string; type: string }, qty = 1, extra: any = {}) {
  const r = await call(who, 'POST', '/me/tickets/orders', { eventId: ev.id, method: 'mpesa', lines: [{ typeId: ev.type, qty }], ...extra });
  expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
  const o = r.json();
  if (extra.method !== 'card') expect(await wait(async () => (await order(o.secret)).status === 'paid')).toBe(true);
  return order(o.secret);
}
const balance = async (who: string) => (await call(who, 'GET', '/me/credit')).json();

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);

describe('keeping ticket money as credit (guest buyer)', () => {
  let ev: Awaited<ReturnType<typeof makeEvent>>;
  let code = '';
  beforeAll(async () => { ev = await makeEvent('Credit gala', 60, 2000); });

  it('turns an order into credit the buyer keeps with a code, and the service fee is not included', async () => {
    const o = await buy(ev, 2);
    expect(o.credit).toMatchObject({ allowed: true, amount: 400000 });
    expect(o.total).toBeGreaterThan(o.subtotal);
    ctx.email.sent.length = 0;
    const r = await call(null, 'POST', `/public/tickets/orders/${o.secret}/credit`, {});
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ amount: 400000, tickets: 2 });
    code = r.json().code;
    expect(code).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    const after = await order(o.secret);
    expect(after.tickets.every((t: any) => t.status === 'cancelled')).toBe(true);
    expect(after.credit.allowed).toBe(false);
    expect(after.creditIssued).toBe(400000);
    expect(after.refund.why).toMatch(/turned into credit/);
    expect(ctx.email.sent.some((m) => /Your event credit/.test(m.subject) && m.body.includes(code))).toBe(true);
    expect((await call(null, 'POST', `/public/tickets/orders/${o.secret}/credit`, {})).json().code).toBe('not_creditable');
    expect((await call(null, 'GET', `/public/credit/${code}`)).json()).toMatchObject({ balance: 400000 });
    expect((await call(null, 'GET', '/public/credit/0000-0000-0000-0000')).statusCode).toBe(404);
    // the seats are free again, and the order no longer needs a refund when the event is cancelled
    expect((await call(OWNER, 'GET', `/events/${ev.id}/tickets`)).json().types[0].left).toBe(100);
  });

  it('is spent with the code: all of a smaller order, then part of a bigger one with the rest paid', async () => {
    const cheap = await makeEvent('Cheap evening', 40, 1000);
    const q = (await call(null, 'POST', '/public/tickets/quote', { code: cheap.code, method: 'mpesa', creditCode: code, lines: [{ typeId: cheap.type, qty: 1 }] })).json();
    expect(q).toMatchObject({ subtotal: 100000, creditUsed: 100000, covered: true, total: 0, serviceFee: 0, credit: 400000 });
    const o1 = await buy(cheap, 1, { creditCode: code });
    expect(o1).toMatchObject({ status: 'paid', total: 0, creditUsed: 100000, subtotal: 100000 });
    expect(o1.tickets).toHaveLength(1);
    expect((await call(null, 'GET', `/public/credit/${code}`)).json().balance).toBe(300000);
    // a covered order is not a free-ticket order and does not appear as a sale at the phone
    const big = await makeEvent('Big dinner', 40, 5000);
    const q2 = (await call(null, 'POST', '/public/tickets/quote', { code: big.code, method: 'mpesa', creditCode: code, lines: [{ typeId: big.type, qty: 1 }] })).json();
    expect(q2).toMatchObject({ subtotal: 500000, creditUsed: 300000, covered: false });
    expect(q2.total).toBeGreaterThan(200000); // the rest plus the service fee on the rest only
    expect(q2.total).toBeLessThan(220000);
    const o2 = await buy(big, 1, { creditCode: code });
    expect(o2).toMatchObject({ status: 'paid', creditUsed: 300000, subtotal: 500000 });
    expect(o2.total).toBe(q2.total);
    expect((await call(null, 'GET', `/public/credit/${code}`)).json().balance).toBe(0);
    const used = await call(null, 'POST', '/public/tickets/orders', { code: cheap.code, name: 'Credit Reuser', email: 'credit.reuser@acme.co.ke', phone: '0711666999', method: 'mpesa', creditCode: code, lines: [{ typeId: cheap.type, qty: 1 }] });
    expect(used.json().code).toBe('credit_used');
  });

  it('refuses a made-up code, and a code from another church', async () => {
    const e2 = await makeEvent('Wrong code night', 40, 1000);
    expect((await call(null, 'POST', '/public/tickets/orders', { code: e2.code, name: 'Some Body', email: 'some.body@acme.co.ke', phone: '0711666998', method: 'mpesa', creditCode: 'AAAA-BBBB-CCCC-DDDD', lines: [{ typeId: e2.type, qty: 1 }] })).json().code).toBe('bad_credit_code');
    const hopeEv = (await call(HOPE, 'POST', '/events', { title: 'Hope night', audience: { type: 'org' }, startsAt: inDays(30), endsAt: inDays(30.1) })).json();
    if (hopeEv.id) {
      await call(HOPE, 'PUT', `/events/${hopeEv.id}/ticketing`, { ticketed: true, types: [{ name: 'Regular', price: 1000, quantity: 10 }] });
      const t = (await call(HOPE, 'GET', `/events/${hopeEv.id}/tickets`)).json();
      const g = await buy(ev, 1);
      const c = (await call(null, 'POST', `/public/tickets/orders/${g.secret}/credit`, {})).json();
      const cross = await call(null, 'POST', '/public/tickets/orders', { code: t.code, name: 'Cross Over', email: 'cross.over@acme.co.ke', phone: '0711666997', method: 'mpesa', creditCode: c.code, lines: [{ typeId: t.types[0].id, qty: 1 }] });
      expect(cross.json().code).toBe('bad_credit_code');
    }
  });
});

describe('member credit', () => {
  let ev: Awaited<ReturnType<typeof makeEvent>>;
  beforeAll(async () => { ev = await makeEvent('Member credit night', 60, 3000); });

  it('lands in the member account, shows in My credit, and is used automatically', async () => {
    expect((await balance(JANE)).total).toBe(0);
    const o = await mine(JANE, ev, 1);
    expect(o.credit.allowed).toBe(true);
    const r = await call(JANE, 'POST', `/me/tickets/orders/${o.id}/credit`, {});
    expect(r.json()).toMatchObject({ amount: 300000, code: null });
    expect((await call(PETER, 'POST', `/me/tickets/orders/${o.id}/credit`, {})).statusCode).toBe(404);
    const b = await balance(JANE);
    expect(b.total).toBe(300000);
    expect(b.credits[0]).toMatchObject({ amount: 300000, balance: 300000, event: 'Member credit night' });
    const next = await makeEvent('Member next night', 50, 2000);
    const q = (await call(JANE, 'POST', '/me/tickets/quote', { code: next.code, method: 'mpesa', lines: [{ typeId: next.type, qty: 1 }] })).json();
    expect(q).toMatchObject({ creditUsed: 200000, covered: true, total: 0 });
    const q0 = (await call(JANE, 'POST', '/me/tickets/quote', { code: next.code, method: 'mpesa', useCredit: false, lines: [{ typeId: next.type, qty: 1 }] })).json();
    expect(q0).toMatchObject({ creditUsed: 0, covered: false });
    const paid = await mine(JANE, next, 1);
    expect(paid).toMatchObject({ status: 'paid', total: 0, creditUsed: 200000 });
    expect((await balance(JANE)).total).toBe(100000);
    expect((await balance(JANE)).spent[0]).toMatchObject({ amount: 200000, event: 'Member next night' });
    expect((await balance(PETER)).total).toBe(0);
  });

  it('goes back when an order waiting for payment is cancelled or runs out of time', async () => {
    const big = await makeEvent('Member big night', 50, 4000);
    const before = (await balance(JANE)).total; // KES 1,000
    expect(before).toBe(100000);
    const o = await call(JANE, 'POST', '/me/tickets/orders', { eventId: big.id, method: 'card', lines: [{ typeId: big.type, qty: 1 }] });
    expect(o.json()).toMatchObject({ status: 'awaiting_payment', creditUsed: 100000 });
    expect((await balance(JANE)).total).toBe(0);
    expect((await call(JANE, 'POST', `/me/tickets/orders/${o.json().id}/cancel`)).statusCode).toBe(200);
    expect((await balance(JANE)).total).toBe(100000);
    const o2 = await call(JANE, 'POST', '/me/tickets/orders', { eventId: big.id, method: 'card', lines: [{ typeId: big.type, qty: 1 }] });
    expect((await balance(JANE)).total).toBe(0);
    ctx.clock.advance(60 * 60_000);
    await runTicketJobs(ctx);
    expect((await order(o2.json().secret)).status).toBe('lapsed');
    expect((await balance(JANE)).total).toBe(100000);
    // restoring twice does nothing
    await runTicketJobs(ctx);
    expect((await balance(JANE)).total).toBe(100000);
  });

  it('returns the credit a cancelled order used, and refunds only what was paid by phone', async () => {
    const big = await makeEvent('Mixed payment night', 55, 4000, 30);
    const o = await mine(JANE, big, 1); // KES 1,000 credit + the rest by phone
    expect(o.creditUsed).toBe(100000);
    expect(o.total).toBeGreaterThan(300000);
    expect((await balance(JANE)).total).toBe(0);
    expect((await call(JANE, 'POST', `/me/tickets/orders/${o.id}/refund-request`, { reason: 'Clash' })).json()).toMatchObject({ status: 'requested' });
    const r = (await call(OWNER, 'GET', `/events/${big.id}/refund-requests`)).json().requests[0];
    expect((await call(OWNER, 'POST', `/refund-requests/${r.id}/decide`, { approve: true })).json().status).toBe('approved');
    expect((await balance(JANE)).total).toBe(100000);
    expect((await ctx.db.query<any>(`SELECT * FROM reversal_requests ORDER BY created_at DESC LIMIT 1`))[0].status).toBe('pending');
  });

  it('gives the credit back when an order paid entirely with credit is cancelled by the buyer', async () => {
    const cheap = await makeEvent('Covered night', 50, 800);
    const o = await mine(JANE, cheap, 1);
    expect(o).toMatchObject({ total: 0, creditUsed: 80000 });
    expect(o.refund).toMatchObject({ allowed: true, freeCancel: true });
    expect(o.credit.allowed).toBe(false);
    expect((await balance(JANE)).total).toBe(20000);
    const c = await call(JANE, 'POST', `/me/tickets/orders/${o.id}/refund-request`, {});
    expect(c.json()).toMatchObject({ status: 'cancelled', refund: false });
    expect((await balance(JANE)).total).toBe(100000);
  });
});

describe('the church offers credit first (cancelled events)', () => {
  it('turns every paid order into credit in one go, and leaves refunds for those who ask', async () => {
    const gone = await makeEvent('Cancelled credit test', 50, 2000, null);
    const a = await buy(gone, 2);
    const b = await buy(gone, 1);
    const c = await mine(PETER, gone, 1);
    expect((await call(OWNER, 'POST', `/events/${gone.id}/credit-all`, {})).json().code).toBe('wrong_state');
    await call(OWNER, 'POST', `/events/${gone.id}/cancel`, { reason: 'Venue unavailable' });
    // the buyer sees credit as an option on a cancelled event
    expect((await order(a.secret)).credit).toMatchObject({ allowed: true, amount: 400000 });
    // one buyer chooses credit themselves, another asks for a refund
    expect((await call(null, 'POST', `/public/tickets/orders/${b.secret}/credit`, {})).statusCode).toBe(200);
    const all = await call(OWNER, 'POST', `/events/${gone.id}/credit-all`, {});
    expect(all.json()).toMatchObject({ credited: 2, amount: 600000, skipped: [] });
    expect((await balance(PETER)).total).toBe(200000);
    const stat = (await call(OWNER, 'GET', `/events/${gone.id}/credit`)).json();
    expect(stat.issued).toMatchObject({ orders: 3, amount: 800000, spent: 0 });
    // nothing is left to refund
    expect((await call(OWNER, 'GET', `/events/${gone.id}/tickets`)).json().refunds).toEqual([]);
    expect((await call(OWNER, 'POST', `/events/${gone.id}/refund-all`, {})).json()).toMatchObject({ refunded: 0 });
    expect((await call(HOPE, 'POST', `/events/${gone.id}/credit-all`, {})).statusCode).toBe(404);
    void c;
  });

  it('lets the church move one order to credit with a note, and not one that was asked about or used', async () => {
    const ev = await makeEvent('One by one credit', 45, 1500, 30);
    const a = await buy(ev, 1);
    const b = await buy(ev, 1);
    await call(null, 'POST', `/public/tickets/orders/${b.secret}/refund-request`, { reason: 'Clash' });
    const r = await call(OWNER, 'POST', `/events/${ev.id}/orders/${a.id}/credit`, { note: 'Moved to the next gala' });
    expect(r.statusCode).toBe(200);
    expect((await call(OWNER, 'POST', `/events/${ev.id}/orders/${b.id}/credit`, {})).json().code).toBe('not_creditable'); // the refund request must be decided first
    expect((await call(HOPE, 'POST', `/events/${ev.id}/orders/${b.id}/credit`, {})).statusCode).toBe(404);
    const tk = (await order(a.secret)).tickets;
    expect(tk.every((t: any) => t.status === 'cancelled')).toBe(true);
    const used = await buy(ev, 1);
    await call(OWNER, 'POST', `/events/${ev.id}/checkin`, { token: (await order(used.secret)).tickets[0].token });
    expect((await call(OWNER, 'POST', `/events/${ev.id}/orders/${used.id}/credit`, {})).json().code).toBe('not_creditable');
  });

  it('stops once the event has started, and leaves every step in the audit log', async () => {
    const soon = await makeEvent('Starting soon', 1, 1000, null);
    const o = await buy(soon, 1);
    ctx.clock.advance(2 * DAY);
    const late = await order(o.secret);
    expect(late.credit.allowed).toBe(false);
    expect((await call(null, 'POST', `/public/tickets/orders/${o.secret}/credit`, {})).json().code).toBe('not_creditable');
    const ev = await call(PA1, 'GET', '/admin/audit/events?action=credit.issued');
    expect(ev.json().events.length).toBeGreaterThan(3);
    expect((await call(PA1, 'GET', '/admin/reconcile')).json().ok).toBe(true);
  });
});
