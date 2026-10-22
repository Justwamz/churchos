import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';

/** Slice 36: the Payments to review screen's API (held payments: list, resolve). Permission is collections.view, like the Collections screen. */

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
const q = (sql: string, p: unknown[] = []) => ctx.db.query<any>(sql, p);
const mock = () => ctx.provider as any;
const OWNER = '0700000001', HOPE = '0700000005', JANE = '0711000001';
const DAY = 86_400_000;
const inDays = (n: number) => new Date(ctx.clock.now().getTime() + n * DAY).toISOString();

async function shortOrder(title: string) {
  const id = (await call(OWNER, 'POST', '/events', { title, audience: { type: 'org' }, startsAt: inDays(30), endsAt: inDays(30.1), location: 'Hall' })).json().id;
  await call(OWNER, 'PUT', `/events/${id}/ticketing`, { ticketed: true, refundDaysBefore: 30, types: [{ name: 'Regular', price: 2000, quantity: 50 }] });
  const s = (await call(OWNER, 'GET', `/events/${id}/tickets`)).json();
  mock().setStkDelay(600_000);
  const r = await call(null, 'POST', '/public/tickets/orders', { code: s.code, name: 'Guest', email: 'held@gmail.com', phone: '0712000111', method: 'mpesa', lines: [{ typeId: s.types[0].id, qty: 1 }] });
  mock().setStkDelay(0);
  const row = (await q(`SELECT * FROM ticket_orders WHERE id=$1`, [r.json().id]))[0];
  await mock().simulatePaybill({ phone: '254712000111', amount: 1000, reference: `GRC001#TKT-${row.code}` });
  return row;
}

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);

describe('payments to review', () => {
  it('is empty at first, needs a staff right, and lists a short payment with expected, received and difference', async () => {
    expect((await call(null, 'GET', '/payments/held')).statusCode).toBe(401);
    expect((await call(JANE, 'GET', '/payments/held')).statusCode).toBe(403);
    expect((await call(OWNER, 'GET', '/payments/held')).json()).toMatchObject({ rows: [], openCount: 0 });
    const order = await shortOrder('Held screen night');
    const res = (await call(OWNER, 'GET', '/payments/held')).json();
    expect(res.openCount).toBe(1);
    const row = res.rows[0];
    expect(row).toMatchObject({ kind: 'underpaid', orderType: 'Event tickets', reference: `TKT-${order.code}`, received: 1000, status: 'open' });
    expect(row.expected).toBe(Number(order.total));
    expect(row.difference).toBe(1000 - Number(order.total));
    expect(row.what).toContain(order.code);
    // the alert links to this screen and carries the id
    const ntf = await q(`SELECT link FROM notifications WHERE audience='staff' AND link LIKE 'staff:held-payments%'`);
    expect(ntf.some((n) => n.link === `staff:held-payments?id=${row.id}`)).toBe(true);
    // another church sees nothing and cannot resolve it
    expect((await call(HOPE, 'GET', '/payments/held')).json().rows).toEqual([]);
    expect((await call(HOPE, 'POST', `/payments/held/${row.id}/resolve`, { action: 'kept_as_gift' })).statusCode).toBe(404);
  });

  it('resolving records who and when, writes an audit event, clears the alert, and cannot be done twice', async () => {
    const row = (await call(OWNER, 'GET', '/payments/held')).json().rows[0];
    expect((await call(OWNER, 'POST', `/payments/held/${row.id}/resolve`, { action: 'nonsense' })).statusCode).toBe(400);
    expect((await call(OWNER, 'POST', `/payments/held/${row.id}/resolve`, { action: 'other' })).statusCode).toBe(400);
    const before = Number((await q(`SELECT count(*)::int AS n FROM payments`))[0].n);
    const r = await call(OWNER, 'POST', `/payments/held/${row.id}/resolve`, { action: 'refunded_outside', note: 'Sent back by M-Pesa' });
    expect(r.statusCode).toBe(200);
    expect(Number((await q(`SELECT count(*)::int AS n FROM payments`))[0].n)).toBe(before);
    const h = (await q(`SELECT * FROM held_payments WHERE id=$1`, [row.id]))[0];
    expect(h).toMatchObject({ status: 'resolved', resolution: 'refunded_outside', resolution_note: 'Sent back by M-Pesa' });
    expect(h.resolved_by).toBeTruthy();
    expect(h.resolved_at).toBeTruthy();
    expect(Number((await q(`SELECT count(*)::int AS n FROM audit_events WHERE action='payment.held_resolved'`))[0].n)).toBe(1);
    expect(Number((await q(`SELECT count(*)::int AS n FROM notifications WHERE link=$1 AND deleted_at IS NULL`, [`staff:held-payments?id=${row.id}`]))[0].n)).toBe(0);
    expect((await call(OWNER, 'POST', `/payments/held/${row.id}/resolve`, { action: 'kept_as_gift' })).statusCode).toBe(409);
    expect((await call(OWNER, 'GET', '/payments/held')).json()).toMatchObject({ rows: [], openCount: 0 });
    const done = (await call(OWNER, 'GET', '/payments/held?status=resolved')).json().rows[0];
    expect(done).toMatchObject({ status: 'resolved', resolutionLabel: 'Refunded outside ChurchOS', note: 'Sent back by M-Pesa' });
    expect(done.resolvedBy).toBeTruthy();
  });
});

describe('a church adds someone who already has a church', () => {
  it('leaves an offer and an inbox message that points at Home', async () => {
    const r = await call('0700000005', 'POST', '/members', { branchId: 'br_hpc001', fullName: 'Jane At Hope', category: 'adult', phone: JANE, consent: true });
    expect(r.statusCode).toBe(200);
    const st = (await call(JANE, 'GET', '/me/link/status')).json();
    expect(st.offers.length).toBeGreaterThan(0);
    const n = (await call(JANE, 'GET', '/me/notifications')).json();
    expect(n.rows.some((x: any) => /added you/.test(x.title) && x.link === 'member:home')).toBe(true);
  });
});
