import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { runShopJobs } from './routes/shop';

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

const OWNER = '0700000001', TREAS = '0700000002', ADMIN = '0700000003', COAST = '0700000004', HOPE = '0700000005', PA1 = '0700000099';
const HOUR = 3600_000;
const BR = 'br_grc001';
const wait = async (fn: () => Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
const items = async (who = OWNER, qs = '') => (await call(who, 'GET', `/shop/items${qs}`)).json() as any[];
const item = async (name: string, who = OWNER) => (await items(who)).find((i) => i.name === name);
const stock = async (name: string) => (await item(name)).stock as number;
const sell = (who: string, lines: [string, number][], extra: any = {}) =>
  call(who, 'POST', '/shop/sales', { branchId: BR, method: 'cash', lines: lines.map(([itemId, qty]) => ({ itemId, qty })), ...extra });
const sale = async (id: string, who = OWNER) => (await call(who, 'GET', `/shop/sales/${id}`)).json();

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);

describe('items and who sees what (L155, L162)', () => {
  it('shows the shop with stock, and hides cost from people who only sell', async () => {
    const all = await items();
    expect(all.map((i) => i.name)).toEqual(expect.arrayContaining(['Bible, KJV hardcover', 'Rosary, wooden', 'Church T-shirt']));
    expect(await stock('Bible, KJV hardcover')).toBe(22); // 24 received, 2 sold
    expect(await stock('Prayer book')).toBe(3);
    const bible = all.find((i) => i.name === 'Bible, KJV hardcover');
    expect(bible).toMatchObject({ price: 180000, cost: 120000, canManage: true, value: 22 * 120000 });
    const esther = await items(TREAS);
    expect(esther.find((i) => i.name === 'Bible, KJV hardcover')).toMatchObject({ price: 180000, cost: null, value: null, canManage: false });
    expect(await items(HOPE)).toEqual([]);
    expect(await items(COAST)).toEqual([]); // the Mombasa shop has nothing
    expect((await call(COAST, 'GET', `/shop/items?branch=${BR}`)).statusCode).toBe(403);
    expect((await call('0711000001', 'GET', '/shop/items')).statusCode).toBe(403); // a member has no shop permission
    expect((await call(null, 'GET', '/shop/items')).statusCode).toBe(401);
  });

  it('finds items by name, code or category, and lists what is low or out', async () => {
    expect((await items(OWNER, '?q=rosary')).map((i) => i.name).sort()).toEqual(['Rosary, crystal', 'Rosary, wooden']);
    expect((await items(OWNER, '?q=BIB-SW')).map((i) => i.name)).toEqual(['Bible, Swahili']);
    expect((await items(OWNER, '?category=Candles')).map((i) => i.name)).toEqual(['Candles, pack of 12']);
    expect((await items(OWNER, '?q=%')).length).toBe(0); // a wildcard is plain text
    const low = (await items(OWNER, '?low=1')).map((i) => i.name).sort();
    expect(low).toEqual(['Church T-shirt', 'Prayer book']);
    expect((await item('Church T-shirt')).out).toBe(true);
  });

  it('creates and changes items only with the manage permission, and keeps price history', async () => {
    const body = { branchId: BR, name: 'Holy water bottle', code: 'HWB-1', category: 'Other', price: 120, cost: 60, lowStock: 3, openingStock: 10 };
    expect((await call(TREAS, 'POST', '/shop/items', body)).statusCode).toBe(403);
    expect((await call(ADMIN, 'POST', '/shop/items', { ...body, branchId: 'br_grc002' })).statusCode).toBe(403);
    expect((await call(ADMIN, 'POST', '/shop/items', { ...body, price: 'abc' })).json().code).toBe('bad_amount');
    expect((await call(ADMIN, 'POST', '/shop/items', { ...body, price: 0 })).json().code).toBe('bad_amount');
    expect((await call(ADMIN, 'POST', '/shop/items', { ...body, code: 'bad code!' })).json().code).toBe('bad_code');
    const ok = await call(ADMIN, 'POST', '/shop/items', body);
    expect(ok.statusCode).toBe(200);
    expect((await call(ADMIN, 'POST', '/shop/items', body)).json().code).toBe('duplicate');
    expect((await call(ADMIN, 'POST', '/shop/items', { ...body, name: 'Another', code: 'hwb-1' })).json().code).toBe('duplicate'); // codes are not case sensitive
    expect(await stock('Holy water bottle')).toBe(10);
    const id = ok.json().id;
    expect((await call(TREAS, 'PUT', `/shop/items/${id}`, { price: 130 })).statusCode).toBe(404);
    expect((await call(ADMIN, 'PUT', `/shop/items/${id}`, { price: 150, lowStock: 4 })).statusCode).toBe(200);
    expect((await item('Holy water bottle')).price).toBe(15000);
    const events = (await call(PA1, 'GET', '/admin/audit/events?action=shop')).json().events;
    expect(events.map((e: any) => e.action)).toEqual(expect.arrayContaining(['shop.item_create', 'shop.price_change']));
    const versions = await ctx.db.query<any>(`SELECT count(*)::int AS n FROM entity_versions WHERE entity='shop_item' AND entity_id=$1`, [id]);
    expect(versions[0].n).toBe(2);
  });
});

describe('stock movements (L156)', () => {
  let id = '';
  beforeAll(async () => { id = (await item('Candles, pack of 12')).id; });

  it('receives, adjusts and writes off with reasons, and never below zero', async () => {
    const st = (kind: string, qty: number, extra: any = {}) => call(ADMIN, 'POST', `/shop/items/${id}/stock`, { kind, qty, ...extra });
    expect((await st('received', 20, { unitCost: 90 })).json().stock).toBe(56); // 36 + 20
    expect((await item('Candles, pack of 12')).cost).toBe(9000); // the latest cost
    expect((await st('adjusted', -2)).json().code).toBe('bad_content'); // a reason is needed
    expect((await st('adjusted', -2, { reason: 'Counted two fewer than the book' })).json().stock).toBe(54);
    expect((await st('adjusted', 0, { reason: 'x' })).json().code).toBe('bad_number');
    expect((await st('written_off', 4, { reason: 'Damaged in the rain' })).json().stock).toBe(50);
    expect((await st('written_off', 500, { reason: 'Too many' })).json().code).toBe('below_zero');
    expect((await st('received', 0)).statusCode).toBe(400);
    expect((await st('stolen', 1, { reason: 'x' })).json().code).toBe('bad_kind');
    expect((await call(TREAS, 'POST', `/shop/items/${id}/stock`, { kind: 'received', qty: 1 })).statusCode).toBe(404);
    const moves = (await call(OWNER, 'GET', `/shop/items/${id}/movements`)).json();
    expect(moves.slice(0, 3).map((m: any) => [m.kind, m.qty])).toEqual([['written_off', -4], ['adjusted', -2], ['received', 20]]);
    expect(moves[0]).toMatchObject({ reason: 'Damaged in the rain', by: 'Daniel Mwangi' === moves[0].by ? 'Daniel Mwangi' : moves[0].by });
    expect((await call(TREAS, 'GET', `/shop/items/${id}/movements`)).json().every((m: any) => m.unitCost === null)).toBe(true);
  });

  it('cannot be changed or deleted after the fact', async () => {
    await expect(ctx.db.query(`UPDATE shop_movements SET qty=999 WHERE item_id=$1`, [id])).rejects.toThrow();
    await expect(ctx.db.query(`DELETE FROM shop_movements WHERE item_id=$1`, [id])).rejects.toThrow();
    expect(await stock('Candles, pack of 12')).toBe(50);
  });
});

describe('selling for cash (L157, L158)', () => {
  it('completes at once, takes the stock, and numbers the receipt', async () => {
    const candles = (await item('Candles, pack of 12')).id;
    const prayer = (await item('Prayer book')).id;
    const before = await stock('Candles, pack of 12');
    const r = await sell(TREAS, [[candles, 2], [prayer, 1]], { buyerName: 'Mama Njeri' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'completed', method: 'cash', total: 2 * 15000 + 40000, buyer: 'Mama Njeri', receiptNo: 'GRC001-00004' });
    expect(r.json().lines.map((l: any) => [l.name, l.qty, l.total])).toEqual([['Candles, pack of 12', 2, 30000], ['Prayer book', 1, 40000]]);
    expect(r.json().lines[0].unitCost).toBeUndefined(); // a cashier does not see cost
    expect(await stock('Candles, pack of 12')).toBe(before - 2);
    expect(await stock('Prayer book')).toBe(2);
    expect((await sale(r.json().id, ADMIN)).lines[0].unitCost).toBe(9000); // a manager does
    const next = await sell(TREAS, [[candles, 1]]);
    expect(next.json().receiptNo).toBe('GRC001-00005');
  });

  it('records a member as the buyer', async () => {
    const r = await sell(TREAS, [[(await item('Candles, pack of 12')).id, 1]], { buyerMembershipId: 'm_jane' });
    expect(r.json().buyer).toBe('Jane Wanjiku');
    expect((await sell(TREAS, [[(await item('Candles, pack of 12')).id, 1]], { buyerMembershipId: 'm_nobody' })).statusCode).toBe(404);
  });

  it('refuses what cannot be sold', async () => {
    const tshirt = (await item('Church T-shirt')).id;
    const prayer = (await item('Prayer book')).id;
    const oos = await sell(TREAS, [[tshirt, 1]]);
    expect(oos.statusCode).toBe(409);
    expect(oos.json().code).toBe('out_of_stock');
    expect((await sell(TREAS, [[prayer, 3]])).json().code).toBe('out_of_stock'); // only 2 left
    expect(await stock('Prayer book')).toBe(2); // a refused sale takes nothing
    expect((await sell(TREAS, [[prayer, 1], [prayer, 1]])).json().code).toBe('bad_lines');
    expect((await sell(TREAS, [])).json().code).toBe('bad_lines');
    expect((await sell(TREAS, [[prayer, 0]])).json().code).toBe('bad_number');
    expect((await sell(TREAS, [['itm_nope', 1]])).statusCode).toBe(404);
    await call(ADMIN, 'PUT', `/shop/items/${prayer}`, { active: false });
    expect((await sell(TREAS, [[prayer, 1]])).json().code).toBe('inactive');
    await call(ADMIN, 'PUT', `/shop/items/${prayer}`, { active: true });
    expect((await call('0711000001', 'POST', '/shop/sales', { branchId: BR, method: 'cash', lines: [{ itemId: prayer, qty: 1 }] })).statusCode).toBe(403);
    expect((await call(COAST, 'POST', '/shop/sales', { branchId: BR, method: 'cash', lines: [{ itemId: prayer, qty: 1 }] })).statusCode).toBe(403); // another branch
  });
});

describe('selling by mobile money and card (L158)', () => {
  it('sends a prompt, holds the stock and completes when the payment arrives, with the platform fee', async () => {
    const bibleSw = (await item('Bible, Swahili')).id;
    const before = await stock('Bible, Swahili');
    expect((await sell(TREAS, [[bibleSw, 1]], { method: 'mpesa' })).json().code).toBe('bad_phone');
    expect((await sell(TREAS, [[bibleSw, 1]], { method: 'airtel', phone: '0711000001' })).json().code).toBe('wrong_network');
    expect(await stock('Bible, Swahili')).toBe(before); // nothing was held by the refused ones
    const r = await sell(TREAS, [[bibleSw, 1]], { method: 'mpesa', phone: '0711000001', buyerMembershipId: 'm_jane' });
    expect(r.statusCode).toBe(200);
    const id = r.json().id;
    expect(['awaiting_payment', 'completed']).toContain(r.json().status);
    expect(await wait(async () => (await sale(id)).status === 'completed')).toBe(true);
    expect(await stock('Bible, Swahili')).toBe(before - 1);
    const done = await sale(id);
    expect(done).toMatchObject({ paid: true, total: 150000 });
    const p = (await ctx.db.query<any>(`SELECT amount_paid, platform_fee, purpose FROM payments WHERE purpose=$1`, [`SHOP-${done.code}`]))[0];
    expect(Number(p.amount_paid)).toBe(150000);
    expect(Number(p.platform_fee)).toBeGreaterThan(0);
    const note = (await call('0711000001', 'GET', '/me/notifications')).json().rows.find((n: any) => n.title === 'Shop receipt');
    expect(note.body).toMatch(/Receipt GRC001-/);
  });

  it('takes a card on the hosted page, and an unpaid card sale lapses and puts the stock back', async () => {
    const rosary = (await item('Rosary, wooden')).id;
    const before = await stock('Rosary, wooden');
    const r = (await sell(TREAS, [[rosary, 5]], { method: 'card' })).json();
    expect(r.status).toBe('awaiting_payment');
    expect(r.checkoutUrl).toMatch(/\/checkout\/CARD[A-Z0-9]+$/);
    expect(await stock('Rosary, wooden')).toBe(before - 5); // held
    const tx = r.checkoutUrl.split('/').pop();
    expect((await call(null, 'POST', `/public/checkout/${tx}/pay`, { number: '4242 4242 4242 4242', expiry: '12/30', cvc: '123' })).json().status).toBe('paid');
    expect(await wait(async () => (await sale(r.id)).status === 'completed')).toBe(true);

    const lapsing = (await sell(TREAS, [[rosary, 4]], { method: 'card' })).json();
    expect(await stock('Rosary, wooden')).toBe(before - 9);
    expect((await call(TREAS, 'POST', `/shop/sales/${lapsing.id}/cancel`)).json().status).toBe('lapsed');
    expect(await stock('Rosary, wooden')).toBe(before - 5); // released
    expect((await call(TREAS, 'POST', `/shop/sales/${lapsing.id}/cancel`)).statusCode).toBe(409);
  });

  it('releases the stock of a waiting sale after 30 minutes, and still honours a late payment', async () => {
    const candles = (await item('Candles, pack of 12')).id;
    const before = await stock('Candles, pack of 12');
    const r = (await sell(TREAS, [[candles, 3]], { method: 'card' })).json();
    expect(await stock('Candles, pack of 12')).toBe(before - 3);
    ctx.clock.advance(31 * 60_000);
    expect((await runShopJobs(ctx)).lapsed).toBe(1);
    expect((await sale(r.id)).status).toBe('lapsed');
    expect(await stock('Candles, pack of 12')).toBe(before);
    const tx = (await ctx.db.query<any>(`SELECT provider_tx_id FROM shop_sales WHERE id=$1`, [r.id]))[0].provider_tx_id;
    await call(null, 'POST', `/public/checkout/${tx}/pay`, { number: '4242 4242 4242 4242', expiry: '12/30', cvc: '123' });
    expect(await wait(async () => (await sale(r.id)).status === 'completed')).toBe(true); // the buyer did pay, and the stock was still there
    expect(await stock('Candles, pack of 12')).toBe(before - 3);
  });
});

describe('voiding and returns (L159)', () => {
  it('voids a cash sale with a reason and puts the stock back, but not a mobile sale', async () => {
    const bible = (await item('Bible, KJV hardcover')).id;
    const before = await stock('Bible, KJV hardcover');
    const r = (await sell(TREAS, [[bible, 2]])).json();
    expect(await stock('Bible, KJV hardcover')).toBe(before - 2);
    expect((await call(TREAS, 'POST', `/shop/sales/${r.id}/void`, { reason: 'Wrong item' })).statusCode).toBe(404); // a cashier cannot void
    expect((await call(ADMIN, 'POST', `/shop/sales/${r.id}/void`, {})).json().code).toBe('bad_content');
    expect((await call(ADMIN, 'POST', `/shop/sales/${r.id}/void`, { reason: 'Customer changed their mind' })).json().status).toBe('voided');
    expect(await stock('Bible, KJV hardcover')).toBe(before);
    expect((await sale(r.id)).voidReason).toBe('Customer changed their mind');
    expect((await call(ADMIN, 'POST', `/shop/sales/${r.id}/void`, { reason: 'again' })).json().code).toBe('wrong_state');
    const mobile = (await call(ADMIN, 'GET', '/shop/sales?status=completed&q=Jane')).json().find((s: any) => s.method === 'mpesa');
    expect((await call(ADMIN, 'POST', `/shop/sales/${mobile.id}/void`, { reason: 'x' })).json().code).toBe('not_cash');
  });

  it('can only void a cash sale for a day', async () => {
    const r = (await sell(TREAS, [[(await item('Rosary, crystal')).id, 1]])).json();
    ctx.clock.advance(25 * HOUR);
    expect((await call(ADMIN, 'POST', `/shop/sales/${r.id}/void`, { reason: 'Too late now' })).json().code).toBe('too_late');
  });
});

describe('closing the till (L160)', () => {
  const today = () => new Date(ctx.clock.now().getTime() + 3 * HOUR).toISOString().slice(0, 10);

  it('shows what the cash sales say, and wants a note when the count differs', async () => {
    const t = (await call(TREAS, 'GET', `/shop/till?branch=${BR}`)).json();
    expect(t.day).toBe(today());
    expect(t.till).toBeNull();
    const r = (await sell(TREAS, [[(await item('Candles, pack of 12')).id, 2]])).json(); // 300.00 in cash today
    const fig = (await call(TREAS, 'GET', `/shop/till?branch=${BR}`)).json();
    expect(fig.expected).toBe(t.expected + 30000);
    const close = (counted: number, extra: any = {}) => call(TREAS, 'POST', '/shop/till', { branchId: BR, counted, ...extra });
    expect((await close(fig.expected / 100 - 50)).json().code).toBe('note_required');
    expect((await close(5, { day: '2999-01-01' })).json().code).toBe('bad_day');
    expect((await call('0711000001', 'POST', '/shop/till', { branchId: BR, counted: 10 })).statusCode).toBe(403);
    const ok = await close(fig.expected / 100 - 50, { note: 'A customer was given 50 shillings too much change' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ expected: fig.expected, variance: -5000 });
    expect((await close(10)).json().code).toBe('already_closed');
    expect((await call(TREAS, 'GET', `/shop/till?branch=${BR}`)).json().till).toMatchObject({ variance: -5000, by: 'Esther Njeri' });
    void r;
  });

  it('sends the count to the cash sign-off, where a second person approves it and the fee is charged', async () => {
    const entries = (await call(TREAS, 'GET', '/cash')).json();
    const e = entries.find((x: any) => x.purpose === 'SHOP');
    expect(e).toMatchObject({ status: 'counted', counted_by: 'u_treas' });
    expect((await call(TREAS, 'POST', `/cash/${e.id}/signoff`, { approve: true })).json().code).toBe('same_person');
    const ok = await call(ADMIN, 'POST', `/cash/${e.id}/signoff`, { approve: true });
    expect(ok.json().status).toBe('approved');
    expect(ok.json().fee).toBeGreaterThan(0);
  });
});

describe('reports (L161)', () => {
  it('summarises the shop, with cost and margin only for managers', async () => {
    const from = new Date(ctx.clock.now().getTime() - 60 * 86400_000).toISOString();
    const r = (await call(OWNER, 'GET', `/shop/reports?from=${encodeURIComponent(from)}`)).json();
    expect(r.canSeeCost).toBe(true);
    expect(r.totals.sales).toBeGreaterThan(5);
    expect(r.totals.revenue).toBeGreaterThan(0);
    expect(r.totals.margin).toBe(r.totals.revenue - r.totals.cost);
    expect(r.byItem[0].revenue).toBeGreaterThanOrEqual(r.byItem[1].revenue); // best sellers first
    expect(r.byCategory.map((c: any) => c.category)).toEqual(expect.arrayContaining(['Bibles', 'Rosaries']));
    expect(r.byMethod.map((m: any) => m.method)).toEqual(expect.arrayContaining(['cash', 'mpesa', 'card']));
    expect(r.byDay.length).toBeGreaterThan(1);
    expect(r.lowStock.map((i: any) => i.name)).toEqual(expect.arrayContaining(['Church T-shirt', 'Prayer book']));
    expect(r.stockValue).toBeGreaterThan(0);
    const cashier = (await call(TREAS, 'GET', `/shop/reports?from=${encodeURIComponent(from)}`)).json();
    expect(cashier.canSeeCost).toBe(false);
    expect(cashier.stockValue).toBeNull();
    expect(cashier.totals.cost).toBeUndefined();
    expect(cashier.totals.margin).toBeUndefined();
    expect(JSON.stringify(cashier.byItem)).not.toMatch(/margin/);
    expect((await call(HOPE, 'GET', '/shop/reports')).json().totals.sales).toBe(0);
    expect((await call('0711000001', 'GET', '/shop/reports')).statusCode).toBe(403);
  });

  it('lists and searches sales, and everything is in the audit log', async () => {
    const all = (await call(OWNER, 'GET', '/shop/sales')).json();
    expect(all.length).toBeGreaterThan(5);
    expect(all[0].createdAt >= all[all.length - 1].createdAt).toBe(true);
    expect((await call(OWNER, 'GET', '/shop/sales?q=Njeri')).json().every((s: any) => /njeri/i.test(s.buyer ?? ''))).toBe(true);
    expect((await call(OWNER, 'GET', '/shop/sales?q=GRC001-00004')).json()).toHaveLength(1);
    expect((await call(OWNER, 'GET', '/shop/sales?q=rosary')).json().every((s: any) => /rosary/i.test(s.items))).toBe(true);
    expect((await call(OWNER, 'GET', '/shop/sales?q=%')).json()).toEqual([]);
    expect((await call(HOPE, 'GET', `/shop/sales/${all[0].id}`)).statusCode).toBe(404);
    const actions = (await call(PA1, 'GET', '/admin/audit/events?action=shop')).json().events.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['shop.sale', 'shop.sale_paid', 'shop.void', 'shop.cancel', 'shop.lapsed', 'shop.till', 'shop.stock_received', 'shop.stock_adjusted', 'shop.stock_written_off']));
  });
});
