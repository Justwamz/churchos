import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { gradientPng } from './artwork';
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

const OWNER = '0700000001', TREAS = '0700000002', ADMIN = '0700000003', PA1 = '0700000099';
const JANE = '0711000001', PETER = '0711000002', AMINA = '0711000003';
const HOPE_MEMBER = '0722000111'; // a member of Hope Chapel, created in beforeAll
const BR = 'br_grc001';
const wait = async (fn: () => Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
const catalogue = async (who = JANE, qs = '') => (await call(who, 'GET', `/me/shop${qs}`)).json();
const item = async (name: string, who = JANE) => (await catalogue(who)).items.find((i: any) => i.name === name);
const stockOf = async (name: string) => ((await call(OWNER, 'GET', '/shop/items')).json().find((i: any) => i.name === name).stock) as number;
const order = (who: string, lines: [string, number][], extra: any = {}) => call(who, 'POST', '/me/shop/orders', { branchId: BR, method: 'mpesa', lines: lines.map(([itemId, qty]) => ({ itemId, qty })), ...extra });
const myOrders = async (who = JANE) => (await call(who, 'GET', '/me/shop/orders')).json() as any[];
const inbox = async (who: string, app: 'member' | 'staff' = 'member') => (await call(who, 'GET', `/me/notifications?app=${app}`)).json().rows as any[];

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
  // A member of Hope Chapel, a different church, to check nothing leaks across.
  const now = ctx.clock.now().toISOString();
  const hopeBranch = (await ctx.db.query<any>(`SELECT id FROM branches WHERE org_id='org_hope' LIMIT 1`))[0].id;
  await ctx.db.query(`INSERT INTO users (id, phone, name, created_at) VALUES ('u_hopem','254722000111','Hope Member',$1)`, [now]);
  await ctx.db.query(
    `INSERT INTO memberships (id, org_id, branch_id, user_id, full_name, phone, member_number, category, dob, sex, consent_at, consent_by, joined_at) VALUES ('m_hopem','org_hope',$1,'u_hopem','Hope Member','254722000111','H00001','adult','1990-01-01','female',$2,'u_hope',$2)`,
    [hopeBranch, now],
  );
}, 60000);

describe('the member catalogue (L164, L167)', () => {
  it('shows a member the shop of their church, with pictures, prices and what is in stock', async () => {
    const c = await catalogue();
    expect(c.branchId).toBe(BR);
    expect(c.branches.map((b: any) => b.id)).toEqual([BR]);
    expect(c.categories).toEqual(expect.arrayContaining(['Bibles', 'Rosaries', 'Candles']));
    const bible = c.items.find((i: any) => i.name === 'Bible, KJV hardcover');
    expect(bible).toMatchObject({ price: 180000, available: true, left: null, maxQty: 10, category: 'Bibles' });
    expect(bible.imageUrl).toBe(`/me/shop/items/${bible.id}/image`);
    expect(c.items.find((i: any) => i.name === 'Prayer book')).toMatchObject({ available: true, left: 3, maxQty: 3 }); // only 3 left
    expect(c.items.find((i: any) => i.name === 'Church T-shirt')).toMatchObject({ available: false, maxQty: 0 });
    expect(JSON.stringify(c)).not.toMatch(/"cost"|unit_cost|stock"/); // members never see cost or exact stock levels
  });

  it('keeps it to members of that church, and serves pictures only to them', async () => {
    expect((await catalogue(HOPE_MEMBER)).items).toEqual([]);
    const bible = await item('Bible, KJV hardcover');
    const img = await call(JANE, 'GET', `/me/shop/items/${bible.id}/image`);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect((await call(HOPE_MEMBER, 'GET', `/me/shop/items/${bible.id}/image`)).statusCode).toBe(404);
    expect((await call(null, 'GET', `/me/shop/items/${bible.id}/image`)).statusCode).toBe(401);
    expect((await call(null, 'GET', '/me/shop')).statusCode).toBe(401);
    expect((await catalogue(JANE, '?branch=br_nope')).branchId).toBe(BR); // an unknown branch falls back to a real one
  });

  it('lets managers add and remove a picture, with sensible limits', async () => {
    const candles = (await item('Candles, pack of 12')).id;
    const png = (w: number, h: number) => ({ mime: 'image/png', data: gradientPng(w, h, [10, 80, 90], [5, 30, 50]) });
    expect((await call(TREAS, 'POST', `/shop/items/${candles}/image`, { image: png(400, 400) })).statusCode).toBe(404); // a cashier cannot
    expect((await call(ADMIN, 'POST', `/shop/items/${candles}/image`, { image: png(100, 100) })).json().code).toBe('bad_picture');
    expect((await call(ADMIN, 'POST', `/shop/items/${candles}/image`, { image: { mime: 'image/gif', data: png(400, 400).data } })).json().code).toBe('bad_picture');
    expect((await call(ADMIN, 'POST', `/shop/items/${candles}/image`, { image: { mime: 'image/png', data: Buffer.alloc(600_000, 1).toString('base64') } })).json().code).toBe('picture_too_large');
    expect((await call(ADMIN, 'POST', `/shop/items/${candles}/image`, { image: png(500, 300) })).statusCode).toBe(200);
    expect((await call(OWNER, 'GET', '/shop/items')).json().find((i: any) => i.id === candles)).toMatchObject({ hasImage: true });
    expect((await call(OWNER, 'GET', `/shop/items/${candles}/image`)).statusCode).toBe(200);
    expect((await call(ADMIN, 'POST', `/shop/items/${candles}/image/remove`)).statusCode).toBe(200);
    expect((await item('Candles, pack of 12')).imageUrl).toBeNull();
  });
});

describe('ordering and paying from the app (L164, L165)', () => {
  it('holds the items, sends the prompt, and when paid gives the member a collection code', async () => {
    const rosary = (await item('Rosary, wooden')).id;
    const before = await stockOf('Rosary, wooden');
    const r = await order(JANE, [[rosary, 2]]);
    expect(r.statusCode).toBe(200);
    const o = r.json();
    expect(o).toMatchObject({ total: 50000, branchName: 'Grace Nairobi' });
    expect(await wait(async () => (await myOrders())[0].state === 'to_prepare')).toBe(true);
    expect(await stockOf('Rosary, wooden')).toBe(before - 2);
    const mine = (await myOrders())[0];
    expect(mine.collectionCode).toMatch(/^[A-F0-9]{6}$/);
    expect(mine.lines).toEqual([expect.objectContaining({ name: 'Rosary, wooden', qty: 2, total: 50000 })]);
    const p = (await ctx.db.query<any>(`SELECT amount_paid, platform_fee FROM payments WHERE purpose=$1`, [`SHOP-${mine.collectionCode}`]))[0];
    expect(Number(p.amount_paid)).toBe(50000);
    expect(Number(p.platform_fee)).toBeGreaterThan(0); // the platform fee applies
    const note = (await inbox(JANE)).find((n) => n.title === 'Shop order paid');
    expect(note.body).toContain(mine.collectionCode);
    expect((await inbox(TREAS, 'staff')).some((n) => n.title === 'New shop order')).toBe(true); // the branch hears about it
    expect((await inbox(OWNER, 'staff')).some((n) => n.title === 'New shop order')).toBe(true);
  });

  it('refuses what cannot be ordered, and takes nothing when it does', async () => {
    const tshirt = (await item('Church T-shirt')).id;
    const prayer = (await item('Prayer book')).id;
    const bible = (await item('Bible, KJV hardcover')).id;
    const before = await stockOf('Prayer book');
    expect((await order(JANE, [[tshirt, 1]])).json().code).toBe('out_of_stock');
    expect((await order(JANE, [[prayer, 4]])).json().code).toBe('out_of_stock');
    expect(await stockOf('Prayer book')).toBe(before);
    expect((await order(JANE, [[bible, 11]])).json().code).toBe('bad_number'); // up to 10 of one item
    expect((await order(JANE, [[bible, 10]], { method: 'cash' })).json().code).toBe('bad_method');
    expect((await order(JANE, [[bible, 1]], { method: 'airtel', phone: '0711000001' })).json().code).toBe('wrong_network');
    expect((await order(JANE, [[bible, 1]], { phone: '12' })).json().code).toBe('bad_phone');
    expect((await order(JANE, [])).json().code).toBe('bad_lines');
    expect((await order(JANE, [[bible, 1], [bible, 1]])).json().code).toBe('bad_lines');
    expect((await call(JANE, 'POST', '/me/shop/orders', { branchId: 'br_hope', method: 'mpesa', lines: [{ itemId: bible, qty: 1 }] })).statusCode).toBe(404);
    expect((await order(HOPE_MEMBER, [[bible, 1]])).statusCode).toBe(404); // not a member of this church
    expect((await call(null, 'POST', '/me/shop/orders', {})).statusCode).toBe(401);
  });

  it('pays by card on the hosted page, and an order that is not paid lapses and releases the stock', async () => {
    const candles = (await item('Candles, pack of 12')).id;
    const before = await stockOf('Candles, pack of 12');
    const card = (await order(PETER, [[candles, 3]], { method: 'card' })).json();
    expect(card.payUrl).toMatch(/\/checkout\/CARD/);
    expect(card.state).toBe('awaiting_payment');
    expect(card.collectionCode).toBeUndefined(); // no code until it is paid
    expect(await stockOf('Candles, pack of 12')).toBe(before - 3);
    const tx = card.payUrl.split('/').pop();
    expect((await call(null, 'POST', `/public/checkout/${tx}/pay`, { number: '4242 4242 4242 4242', expiry: '12/30', cvc: '123' })).json().status).toBe('paid');
    expect(await wait(async () => (await myOrders(PETER))[0].state === 'to_prepare')).toBe(true);

    const lapsing = (await order(PETER, [[candles, 2]], { method: 'card' })).json();
    expect(await stockOf('Candles, pack of 12')).toBe(before - 5);
    ctx.clock.advance(31 * 60_000);
    expect((await runShopJobs(ctx)).lapsed).toBe(1);
    expect((await myOrders(PETER)).find((o) => o.id === lapsing.id).state).toBe('lapsed');
    expect(await stockOf('Candles, pack of 12')).toBe(before - 3);
  });

  it('limits how many unpaid orders one member can have, and lets them cancel one', async () => {
    const bible = (await item('Bible, KJV hardcover')).id;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await order(AMINA, [[bible, 1]], { method: 'card' })).json().id);
    const fourth = await order(AMINA, [[bible, 1]], { method: 'card' });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json().code).toBe('too_many');
    const before = await stockOf('Bible, KJV hardcover');
    expect((await call(AMINA, 'POST', `/me/shop/orders/${ids[0]}/cancel`)).json().state).toBe('lapsed');
    expect(await stockOf('Bible, KJV hardcover')).toBe(before + 1);
    expect((await call(AMINA, 'POST', `/me/shop/orders/${ids[0]}/cancel`)).statusCode).toBe(409);
    expect((await call(JANE, 'POST', `/me/shop/orders/${ids[1]}/cancel`)).statusCode).toBe(404); // not hers
    for (const id of ids.slice(1)) await call(AMINA, 'POST', `/me/shop/orders/${id}/cancel`);
  });
});

describe('the branch fulfils app orders (L166)', () => {
  let id = '';
  let code = '';
  beforeAll(async () => {
    const r = (await order(JANE, [[(await item('Bible, Swahili')).id, 1]])).json();
    id = r.id;
    await wait(async () => (await myOrders())[0].state === 'to_prepare');
    code = (await myOrders())[0].collectionCode;
  });

  it('lists the orders to prepare, with the collection code and a masked phone', async () => {
    const list = (await call(TREAS, 'GET', '/shop/orders')).json();
    const o = list.find((x: any) => x.id === id);
    expect(o).toMatchObject({ state: 'to_prepare', collectionCode: code, buyer: 'Jane Wanjiku', items: '1 x Bible, Swahili' });
    expect(o.buyerPhone).toMatch(/•••/);
    expect((await call(TREAS, 'GET', `/shop/orders?q=${code.toLowerCase()}`)).json().map((x: any) => x.id)).toEqual([id]);
    expect((await call(TREAS, 'GET', '/shop/orders?q=%')).json()).toEqual([]);
    expect((await call(JANE, 'GET', '/shop/orders')).statusCode).toBe(403);
    expect((await call('0700000005', 'GET', '/shop/orders')).json()).toEqual([]); // another church
  });

  it('marks it ready and the member is told, then collected with the right code', async () => {
    expect((await call('0700000005', 'POST', `/shop/orders/${id}/ready`)).statusCode).toBe(404); // another church
    expect((await call(JANE, 'POST', `/shop/orders/${id}/ready`)).statusCode).toBe(404); // a member has no shop access, so it does not exist for them
    expect((await call(TREAS, 'POST', `/shop/orders/${id}/ready`)).json().state).toBe('ready');
    expect((await call(TREAS, 'POST', `/shop/orders/${id}/ready`)).statusCode).toBe(409);
    const note = (await inbox(JANE)).find((n) => n.title === 'Your order is ready');
    expect(note.body).toContain(code);
    expect((await myOrders())[0].state).toBe('ready');
    expect((await call(TREAS, 'POST', `/shop/orders/${id}/collected`, { code: 'ZZZZZZ' })).json().code).toBe('wrong_code');
    expect((await call(TREAS, 'POST', `/shop/orders/${id}/collected`, { code: code.toLowerCase() })).json().state).toBe('collected');
    expect((await call(TREAS, 'POST', `/shop/orders/${id}/collected`, {})).statusCode).toBe(409);
    expect((await myOrders())[0].state).toBe('collected');
    expect((await call(TREAS, 'GET', '/shop/orders')).json().some((x: any) => x.id === id)).toBe(false); // done orders leave the open list
    expect((await call(TREAS, 'GET', '/shop/orders?state=collected')).json().some((x: any) => x.id === id)).toBe(true);
  });

  it('shows app orders in the sales list and reports, and they cannot be voided like cash', async () => {
    const sales = (await call(OWNER, 'GET', '/shop/sales?q=Jane')).json();
    const s = sales.find((x: any) => x.id === id);
    expect(s).toMatchObject({ channel: 'app', method: 'mpesa', status: 'completed', canVoid: false });
    expect((await call(ADMIN, 'POST', `/shop/sales/${id}/void`, { reason: 'x' })).json().code).toBe('not_cash');
    const r = (await call(OWNER, 'GET', '/shop/reports')).json();
    expect(r.totals.revenue).toBeGreaterThan(0);
  });
});

describe('adverts that lead to the shop (L168, L169)', () => {
  const ad = async (who: string, title: string) => (await call(who, 'GET', '/me/adverts')).json().find((a: any) => a.title === title);
  const art = () => ({ mime: 'image/png', data: gradientPng(1280, 720, [10, 80, 90], [5, 30, 50]) });
  const mk = (extra: any) => call(OWNER, 'POST', '/adverts', { title: 'Shop advert', audience: { type: 'branch', id: BR }, image: art(), ...extra }); // a branch advert, so the branch admin can approve it

  it('hands the member app the item behind an advert, or the shop itself', async () => {
    const bible = await ad(JANE, 'Get your own Bible');
    expect(bible.action).toMatchObject({ kind: 'item', itemId: 'itm_bible_kjv', item: { name: 'Bible, KJV hardcover', price: 180000, available: true } });
    expect(bible.action.item.imageUrl).toBe('/me/shop/items/itm_bible_kjv/image');
    const rosary = await ad(JANE, 'Rosary week');
    expect(rosary.action).toMatchObject({ kind: 'checkout', qty: 1, item: { name: 'Rosary, wooden', available: true } });
    expect((await ad(JANE, 'Christmas Carols Night')).action).toBeNull(); // an ordinary advert
  });

  it('lets staff choose where an advert leads, with the item checked and approval needed again after a change', async () => {
    expect((await mk({ action: { kind: 'item', itemId: 'itm_nope' } })).statusCode).toBe(404);
    expect((await mk({ action: { kind: 'checkout', itemId: 'itm_rosary_wood', qty: 11 } })).json().code).toBe('bad_number');
    expect((await mk({ action: { kind: 'teleport' } })).json().code).toBe('bad_action');
    expect((await call(ADMIN, 'POST', '/adverts', { title: 'x', audience: { type: 'branch', id: BR }, image: art(), action: { kind: 'item', itemId: 'itm_rosary_wood' } })).statusCode).toBe(200);
    const made = await mk({ title: 'Candle sale', action: { kind: 'checkout', itemId: 'itm_candles', qty: 2 }, link: 'https://example.org' });
    expect(made.statusCode).toBe(200);
    const id = made.json().id;
    const row = (await call(OWNER, 'GET', `/adverts/${id}`)).json();
    expect(row).toMatchObject({ action: { kind: 'checkout', qty: 2 }, actionText: 'Checkout with 2 x Candles, pack of 12', link: null }); // a link and an action are exclusive
    // an item that is switched off cannot be pointed at
    await call(ADMIN, 'PUT', '/shop/items/itm_candles', { active: false });
    expect((await mk({ action: { kind: 'item', itemId: 'itm_candles' } })).json().code).toBe('inactive');
    await call(ADMIN, 'PUT', '/shop/items/itm_candles', { active: true });
    // changing a live advert's destination takes it offline until it is approved again
    const liveId = (await mk({ title: 'Candle week', action: { kind: 'item', itemId: 'itm_candles' } })).json().id;
    await call(OWNER, 'POST', `/adverts/${liveId}/submit`);
    expect((await call(ADMIN, 'POST', `/adverts/${liveId}/decide`, { approve: true })).json().status).toBe('approved');
    expect((await ad(JANE, 'Candle week')).action.kind).toBe('item');
    expect((await call(OWNER, 'PUT', `/adverts/${liveId}`, { action: { kind: 'shop' } })).json().status).toBe('draft');
    expect(await ad(JANE, 'Candle week')).toBeUndefined();
    await call(OWNER, 'POST', `/adverts/${liveId}/submit`);
    await call(ADMIN, 'POST', `/adverts/${liveId}/decide`, { approve: true });
    expect((await ad(JANE, 'Candle week')).action).toEqual({ kind: 'shop' });
    const events = (await call(PA1, 'GET', '/admin/audit/events?action=advert.update')).json().events;
    expect(JSON.stringify(events)).toMatch(/Opens the shop/);
  });

  it('says so when the item is sold out, and traces orders and money back to the advert', async () => {
    const bible = await ad(JANE, 'Get your own Bible');
    const sw = (await item('Bible, Swahili')).id;
    const r = (await order(PETER, [[sw, 1]], { advertId: bible.id })).json();
    expect(await wait(async () => (await myOrders(PETER)).find((o) => o.id === r.id).state === 'to_prepare')).toBe(true);
    const stats = (await call(OWNER, 'GET', '/adverts')).json().find((a: any) => a.id === bible.id).stats;
    expect(stats).toMatchObject({ orders: 1, orderTotal: 150000 });
    // sell out the wooden rosary and an advert that goes straight to checkout for it shows as unavailable
    const wood = (await item('Rosary, wooden')).id;
    const left = await stockOf('Rosary, wooden');
    await call(OWNER, 'POST', `/shop/items/${wood}/stock`, { kind: 'written_off', qty: left, reason: 'Test: sell out' });
    const direct = await mk({ title: 'Rosary again', action: { kind: 'checkout', itemId: 'itm_rosary_wood', qty: 1 } });
    await call(OWNER, 'POST', `/adverts/${direct.json().id}/submit`);
    await call(ADMIN, 'POST', `/adverts/${direct.json().id}/decide`, { approve: true });
    expect((await ad(JANE, 'Rosary again')).action.item.available).toBe(false);
    expect((await order(JANE, [[wood, 1]])).json().code).toBe('out_of_stock'); // and nothing is charged
  });
});
