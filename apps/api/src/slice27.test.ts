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
const call = async (phone: string | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: any) =>
  app.inject({ method, url, payload, headers: phone ? { authorization: `Bearer ${await login(phone)}` } : {} });

const OWNER = '0700000001', TREAS = '0700000002', HOPE = '0700000005', PA1 = '0700000099';
const JANE = '0711000001', PETER = '0711000002', DAVID = '0711000004', AMINA = '0711000003';
const DAY = 86_400_000;
const wait = async (fn: () => Promise<boolean>, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
const order = async (secret: string) => (await call(null, 'GET', `/public/tickets/orders/${secret}`)).json();
const inDays = (n: number) => new Date(ctx.clock.now().getTime() + n * DAY).toISOString();

async function makeEvent(title: string, days: number, price: number) {
  const id = (await call(OWNER, 'POST', '/events', { title, audience: { type: 'org' }, startsAt: inDays(days), endsAt: inDays(days + 0.1), location: 'Hall' })).json().id;
  await call(OWNER, 'PUT', `/events/${id}/ticketing`, { ticketed: true, refundDaysBefore: 30, types: [{ name: 'Regular', price, quantity: 100 }] });
  const s = (await call(OWNER, 'GET', `/events/${id}/tickets`)).json();
  return { id, code: s.code as string, type: s.types[0].id as string };
}
/** Gives a member credit by buying tickets and turning the order into credit. */
async function giveCredit(who: string, kes: number) {
  const ev = await makeEvent(`Credit source ${who} ${kes}`, 50, kes);
  const r = await call(who, 'POST', '/me/tickets/orders', { eventId: ev.id, method: 'mpesa', lines: [{ typeId: ev.type, qty: 1 }] });
  const o = r.json();
  expect(await wait(async () => (await order(o.secret)).status === 'paid')).toBe(true);
  expect((await call(who, 'POST', `/me/tickets/orders/${o.id}/credit`, {})).statusCode).toBe(200);
}
const balance = async (who: string) => (await call(who, 'GET', '/me/credit')).json().total as number;
const titles = async (who: string, re: RegExp) => ((await call(who, 'GET', '/me/notifications')).json().rows as any[]).filter((n) => re.test(n.title));

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);

describe('using only part of the credit', () => {
  it('uses the amount the buyer chose, and the quote says so', async () => {
    await giveCredit(JANE, 3000);
    const ev = await makeEvent('Partial night', 40, 2000);
    const q = (await call(JANE, 'POST', '/me/tickets/quote', { code: ev.code, method: 'mpesa', creditAmount: 500, lines: [{ typeId: ev.type, qty: 1 }] })).json();
    expect(q).toMatchObject({ credit: 300000, creditUsed: 50000, covered: false });
    expect(q.total).toBeGreaterThan(150000);
    const none = (await call(JANE, 'POST', '/me/tickets/quote', { code: ev.code, method: 'mpesa', creditAmount: 0, lines: [{ typeId: ev.type, qty: 1 }] })).json();
    expect(none).toMatchObject({ creditUsed: 0 });
    const more = (await call(JANE, 'POST', '/me/tickets/quote', { code: ev.code, method: 'mpesa', creditAmount: 99999, lines: [{ typeId: ev.type, qty: 1 }] })).json();
    expect(more).toMatchObject({ creditUsed: 200000, covered: true }); // never more than the order or the balance
    const r = await call(JANE, 'POST', '/me/tickets/orders', { eventId: ev.id, method: 'mpesa', creditAmount: 500, lines: [{ typeId: ev.type, qty: 1 }] });
    expect(r.json().creditUsed).toBe(50000);
    expect(await wait(async () => (await order(r.json().secret)).status === 'paid')).toBe(true);
    expect(await balance(JANE)).toBe(250000);
  });
});

describe('asking for credit back as money', () => {
  it('holds the amount, lets the church approve and record the payment, and tells the member', async () => {
    expect(await balance(JANE)).toBe(250000);
    expect((await call(JANE, 'POST', '/me/credit/refund-request', { amount: 50 })).json().code).toBe('too_small');
    expect((await call(JANE, 'POST', '/me/credit/refund-request', { amount: 99999 })).json().code).toBe('not_enough_credit');
    const r = await call(JANE, 'POST', '/me/credit/refund-request', { amount: 1000, reason: 'Moving abroad' });
    expect(r.json()).toMatchObject({ amount: 100000, status: 'pending' });
    expect(await balance(JANE)).toBe(150000); // held back at once
    expect((await call(JANE, 'POST', '/me/credit/refund-request', { amount: 100 })).json().code).toBe('open_request');
    const list = (await call(OWNER, 'GET', '/credit/refunds')).json();
    expect(list.toDecide).toBe(1);
    const id = list.refunds[0].id;
    expect(list.refunds[0]).toMatchObject({ amount: 100000, status: 'pending', member: 'Jane Wanjiku', reason: 'Moving abroad' });
    expect((await call(JANE, 'GET', '/credit/refunds')).statusCode).toBe(403);
    expect((await call(HOPE, 'GET', '/credit/refunds')).json().refunds).toEqual([]);
    expect((await call(OWNER, 'POST', `/credit/refunds/${id}/paid`, { reference: 'X' })).json().code).toBe('wrong_state');
    expect((await call(OWNER, 'POST', `/credit/refunds/${id}/decide`, { approve: false })).json().code).toBe('bad_content');
    expect((await call(OWNER, 'POST', `/credit/refunds/${id}/decide`, { approve: true, note: 'Sending today' })).json().status).toBe('approved');
    expect((await call(OWNER, 'POST', `/credit/refunds/${id}/decide`, { approve: true })).json().code).toBe('already_decided');
    expect((await call(OWNER, 'POST', `/credit/refunds/${id}/paid`, {})).json().code).toBe('bad_content');
    expect((await call(OWNER, 'POST', `/credit/refunds/${id}/paid`, { reference: 'SGH7K2L9' })).json().status).toBe('paid');
    expect(await balance(JANE)).toBe(150000); // stays reduced: the money has gone to her
    const paid = await titles(JANE, /refund was paid/);
    expect(paid.length).toBe(1);
    expect(paid[0].body).toMatch(/SGH7K2L9/);
    expect((await call(JANE, 'GET', '/me/credit/history')).json().refunds[0]).toMatchObject({ status: 'paid', paidReference: 'SGH7K2L9' });
  });

  it('puts the credit back when the church declines or the member cancels', async () => {
    const r1 = (await call(JANE, 'POST', '/me/credit/refund-request', { amount: 500 })).json();
    expect(await balance(JANE)).toBe(100000);
    expect((await call(JANE, 'POST', `/me/credit/refund-request/${r1.id}/cancel`)).statusCode).toBe(200);
    expect(await balance(JANE)).toBe(150000);
    expect((await call(JANE, 'POST', `/me/credit/refund-request/${r1.id}/cancel`)).statusCode).toBe(404);
    const r2 = (await call(JANE, 'POST', '/me/credit/refund-request', { all: true })).json();
    expect(r2.amount).toBe(150000);
    expect(await balance(JANE)).toBe(0);
    expect((await call(OWNER, 'POST', `/credit/refunds/${r2.id}/decide`, { approve: false, note: 'Please use it at the gala' })).json().status).toBe('declined');
    expect(await balance(JANE)).toBe(150000);
    expect((await titles(JANE, /declined/)).length).toBe(1);
  });
});

describe('sending credit to another member', () => {
  it('checks the recipient first and shows only a first name and an initial', async () => {
    expect((await call(JANE, 'POST', '/me/credit/transfer/lookup', { phone: '0711 000 004' })).json()).toEqual({ name: 'David W.' });
    expect((await call(JANE, 'POST', '/me/credit/transfer/lookup', { phone: '0711000001' })).json().code).toBe('recipient_not_found'); // not herself
    expect((await call(JANE, 'POST', '/me/credit/transfer/lookup', { phone: '0722000000' })).json().code).toBe('recipient_not_found');
  });

  it('sends, refuses too little or too much, and keeps a record', async () => {
    const dav = await balance(DAVID);
    expect((await call(JANE, 'POST', '/me/credit/transfer', { phone: '0711000004', amount: 10 })).json().code).toBe('too_small');
    expect((await call(JANE, 'POST', '/me/credit/transfer', { phone: '0711000004', amount: 99999 })).json().code).toBe('not_enough_credit');
    const r = await call(JANE, 'POST', '/me/credit/transfer', { phone: '0711000004', amount: 400, note: 'For the family night' });
    expect(r.json()).toMatchObject({ amount: 40000, to: 'David W.' });
    expect(await balance(JANE)).toBe(110000);
    expect(await balance(DAVID)).toBe(dav + 40000);
    const got = await titles(DAVID, /sent you event credit/);
    expect(got.length).toBe(1);
    expect(got[0].body).toMatch(/family night/);
    expect((await call(DAVID, 'GET', '/me/credit/history')).json().transfers[0]).toMatchObject({ direction: 'received', amount: 40000, other: 'Jane W.' });
    expect((await call(JANE, 'GET', '/me/credit/history')).json().transfers[0]).toMatchObject({ direction: 'sent', other: 'David W.' });
    const ev = await makeEvent('Gift night', 30, 300);
    expect((await call(DAVID, 'POST', '/me/tickets/quote', { code: ev.code, method: 'mpesa', lines: [{ typeId: ev.type, qty: 1 }] })).json()).toMatchObject({ covered: true });
    expect((await call(PA1, 'GET', '/admin/audit/events?action=credit.transferred')).json().events.length).toBeGreaterThan(0);
  });

  it('allows only a few look-ups an hour', async () => {
    for (let i = 0; i < 12; i++) await call(PETER, 'POST', '/me/credit/transfer/lookup', { phone: '0711000004' });
    expect((await call(PETER, 'POST', '/me/credit/transfer/lookup', { phone: '0711000004' })).json().code).toBe('rate_limited');
  });
});

describe('what the church is holding, and reminders', () => {
  it('shows the church its outstanding credit, how old it is, and who holds it', async () => {
    const s = (await call(OWNER, 'GET', '/credit/summary')).json();
    expect(s.outstanding).toBe((await balance(JANE)) + (await balance(DAVID)) + (await balance(PETER)) + (await balance(AMINA)));
    expect(s.holders).toBeGreaterThanOrEqual(2);
    expect(s.aging.under30).toBe(s.outstanding);
    expect(s.refunded).toMatchObject({ paid: 100000, open: 0, toDecide: 0, toPay: 0 });
    expect(s.used).toBeGreaterThan(0);
    expect(s.top.map((t: any) => t.name)).toEqual(expect.arrayContaining(['Jane Wanjiku', 'David Wanjiku']));
    const t = (await call(TREAS, 'GET', '/credit/summary')).json();
    expect(t.outstanding).toBe(s.outstanding);
    expect(t.top).toBeUndefined(); // the treasurer sees the totals, not who holds them
    expect((await call(JANE, 'GET', '/credit/summary')).statusCode).toBe(403);
    expect((await call(HOPE, 'GET', '/credit/summary')).json().outstanding).toBe(0);
  });

  it('reminds people once a month about credit they have not used', async () => {
    const before = (await titles(JANE, /You have event credit/)).length;
    await runTicketJobs(ctx);
    expect((await titles(JANE, /You have event credit/)).length).toBe(before); // too soon
    ctx.clock.advance(31 * DAY);
    await runTicketJobs(ctx);
    const after = await titles(JANE, /You have event credit/);
    expect(after.length).toBe(before + 1);
    expect(after[0].body).toMatch(/KES 1,100 of event credit/);
    await runTicketJobs(ctx);
    expect((await titles(JANE, /You have event credit/)).length).toBe(before + 1); // not again
    expect((await call(PA1, 'GET', '/admin/reconcile')).json().ok).toBe(true);
  });
});
