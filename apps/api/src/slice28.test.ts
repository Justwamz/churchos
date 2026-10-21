import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { addNotification } from './notifications';

/** Staff messages sit in the staff app and the others in the member app, and every message with something to do carries a link (L28x). */
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

const OWNER = '0700000001', TREAS = '0700000002', SAMUEL = '0700000003', VOL = '0700000558';
const JANE = '0711000001';
const DAY = 86_400_000;
const wait = async (fn: () => Promise<boolean>, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
const feed = async (who: string, app?: 'member' | 'staff') => (await call(who, 'GET', app ? `/me/notifications?app=${app}` : '/me/notifications')).json() as { unread: number; rows: any[] };
const today = () => new Date(ctx.clock.now().getTime() + 3 * 3600_000).toISOString().slice(0, 10);
const inDays = (n: number) => new Date(ctx.clock.now().getTime() + n * DAY).toISOString();

/** Every page the links may point at: the staff ids are read from the staff app's page list, the member ones are listed here. */
const STAFF_PAGES = new Set([...readFileSync(resolve(__dirname, '../../staff/src/nav.tsx'), 'utf8').matchAll(/\{ id: '([a-z-]+)', label:/g)].map((m) => m[1]));
const MEMBER_PAGES = new Set(['home', 'give', 'services', 'kids', 'inbox', 'groups', 'me', 'notices', 'events', 'book', 'bookings', 'shop', 'tickets', 'credit', 'prayer', 'suggestions']);
const MEMBER_GIVE_SUBS = new Set(['give', 'pledges', 'history', 'regular']);

function parseLink(link: string) {
  const m = /^(staff|member):([a-z-]+)(?:\?(.+))?$/.exec(link);
  expect(m, `link ${link} is well formed`).not.toBeNull();
  return { app: m![1], page: m![2], query: new URLSearchParams(m![3] ?? '') };
}

let cats: Record<string, string> = {};
const rec = (who: string, extra: any = {}) => call(who, 'POST', '/expenses', { branchId: 'br_grc001', date: today(), amount: 9000, categoryId: cats['Supplies'], payee: 'Mama Njeri Stores', method: 'mpesa', reference: 'QWE123', receiptRequiredAbove: 0, files: [], ...extra });

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
  const t = ctx.clock.now().toISOString();
  await ctx.db.query(`INSERT INTO users (id, phone, name, created_at) VALUES ('u_vol','254700000558','Volunteer Vera',$1)`, [t]);
  await ctx.db.query(`INSERT INTO role_assignments (id, org_id, user_id, role_id, scope_type, scope_id) VALUES ('ra_vol','org_grace','u_vol','org_grace:Volunteer','branch','br_grc001')`);
  expect((await call(OWNER, 'PUT', '/expenses/settings', { approvalMode: 'above_limit', approvalLimit: 5000, twoApproverLimit: null, receiptRequiredAbove: 100000 })).statusCode).toBe(200);
  cats = Object.fromEntries((await call(OWNER, 'GET', '/expenses/setup')).json().categories.map((c: any) => [c.name, c.id]));
}, 60000);

describe('staff tasks stay out of the member inbox', () => {
  let expenseId = '';

  it('shows an expense awaiting approval only in the staff list of a person who is also a member', async () => {
    await addNotification(ctx, { orgId: 'org_grace', userId: 'u_admin', kind: 'announcement', title: 'A personal note', body: 'Just for Samuel the member' });
    const r = await rec(TREAS);
    expect(r.statusCode).toBe(200);
    expenseId = r.json().id;
    const staff = await feed(SAMUEL, 'staff');
    const ask = staff.rows.find((n) => n.title === 'An expense needs approval');
    expect(ask).toBeTruthy();
    expect(ask).toMatchObject({ audience: 'staff', link: `staff:expenses?open=${expenseId}` });
    const member = await feed(SAMUEL);
    expect(member.rows.some((n) => /needs approval/.test(n.title))).toBe(false);
    expect(member.rows.map((n) => n.title)).toContain('A personal note');
    expect((await feed(SAMUEL, 'member')).rows.every((n) => n.audience === 'member')).toBe(true);
    expect(staff.rows.every((n) => n.audience === 'staff')).toBe(true);
    expect(staff.rows.some((n) => n.title === 'A personal note')).toBe(false);
  });

  it('counts unread per audience and only marks the chosen audience read', async () => {
    const before = { staff: await feed(SAMUEL, 'staff'), member: await feed(SAMUEL, 'member') };
    expect(before.staff.unread).toBe(before.staff.rows.filter((n) => !n.read).length);
    expect(before.staff.unread).toBeGreaterThan(0);
    expect(before.member.unread).toBeGreaterThan(0);
    expect((await call(SAMUEL, 'POST', '/me/notifications/read?app=staff')).statusCode).toBe(200);
    expect((await feed(SAMUEL, 'staff')).unread).toBe(0);
    expect((await feed(SAMUEL, 'member')).unread).toBe(before.member.unread); // the member app is untouched
    expect((await call(SAMUEL, 'POST', '/me/notifications/read')).statusCode).toBe(200); // the default is the member app
    expect((await feed(SAMUEL)).unread).toBe(0);
  });

  it('puts a claim decision in the staff app of the claimant, linked to My expense claims', async () => {
    const c = await call(VOL, 'POST', '/me/claims', { branchId: 'br_grc001', date: today(), amount: 800, categoryId: cats['Transport'], payee: 'Bus fare', note: 'Programmes' });
    expect(c.statusCode).toBe(200);
    const id = c.json().id;
    const ask = (await feed(SAMUEL, 'staff')).rows.find((n) => n.title === 'An expense claim needs approval');
    expect(ask).toMatchObject({ link: `staff:expenses?open=${id}` });
    expect((await call(SAMUEL, 'POST', `/expenses/${id}/decide`, { approve: true })).json().status).toBe('approved');
    const approved = (await feed(VOL, 'staff')).rows.find((n) => n.title === 'Your claim was approved');
    expect(approved).toMatchObject({ audience: 'staff', link: 'staff:my-claims' });
    expect((await feed(VOL)).rows.some((n) => /claim/.test(n.title))).toBe(false);
    expect((await call(TREAS, 'POST', `/expenses/${id}/paid`, { reference: 'SGH7K2L9' })).json().paid).toBe(true);
    expect((await feed(VOL, 'staff')).rows.find((n) => n.title === 'Your claim was paid')).toMatchObject({ link: 'staff:my-claims' });
  });
});

describe('links to the page the message is about', () => {
  it('links a ticket confirmation, event credit and a credit refund request', async () => {
    const ev = (await call(OWNER, 'POST', '/events', { title: 'Link night', audience: { type: 'org' }, startsAt: inDays(50), endsAt: inDays(50.1), location: 'Hall' })).json().id;
    await call(OWNER, 'PUT', `/events/${ev}/ticketing`, { ticketed: true, refundDaysBefore: 30, types: [{ name: 'Regular', price: 2000, quantity: 100 }] });
    const s = (await call(OWNER, 'GET', `/events/${ev}/tickets`)).json();
    const r = (await call(JANE, 'POST', '/me/tickets/orders', { eventId: ev, method: 'mpesa', lines: [{ typeId: s.types[0].id, qty: 1 }] })).json();
    const paid = async () => (await call(null, 'GET', `/public/tickets/orders/${r.secret}`)).json().status === 'paid';
    expect(await wait(paid)).toBe(true);
    const tickets = (await feed(JANE, 'member')).rows.find((n) => /^Your tickets for Link night/.test(n.title));
    expect(tickets).toMatchObject({ audience: 'member', link: 'member:tickets' });
    expect((await call(JANE, 'POST', `/me/tickets/orders/${r.id}/credit`, {})).statusCode).toBe(200);
    const credit = (await feed(JANE, 'member')).rows.find((n) => /^Your event credit/.test(n.title));
    expect(credit).toMatchObject({ audience: 'member', link: 'member:credit' });
    expect((await call(JANE, 'POST', '/me/credit/refund-request', { amount: 500 })).statusCode).toBe(200);
    const ask = (await feed(OWNER, 'staff')).rows.find((n) => n.title === 'Event credit refund request');
    expect(ask).toMatchObject({ audience: 'staff', link: 'staff:credit?tab=refunds' });
    expect((await feed(OWNER, 'member')).rows.some((n) => n.title === 'Event credit refund request')).toBe(false);
  });

  it('only ever points at pages that exist, in the right app', async () => {
    const rows = await ctx.db.query<any>(`SELECT DISTINCT link, audience FROM notifications WHERE link IS NOT NULL`);
    expect(rows.length).toBeGreaterThan(5);
    expect(STAFF_PAGES.has('expenses') && STAFF_PAGES.has('my-claims') && STAFF_PAGES.has('credit')).toBe(true);
    for (const row of rows) {
      const l = parseLink(row.link);
      expect(l.app, row.link).toBe(row.audience);
      expect((l.app === 'staff' ? STAFF_PAGES : MEMBER_PAGES).has(l.page), row.link).toBe(true);
      if (l.app === 'member' && l.page === 'give' && l.query.has('sub')) expect(MEMBER_GIVE_SUBS.has(l.query.get('sub')!), row.link).toBe(true);
      expect(row.link).not.toMatch(/[0-9]{9,}|@/); // no phone numbers or emails
    }
  });
});

describe('marking one message read', () => {
  it('marks only the messages named, and everything when none are named', async () => {
    const t = ctx.clock.now().toISOString();
    for (const [id, title] of [['ntf_one1', 'One'], ['ntf_one2', 'Two']]) {
      await ctx.db.query(`INSERT INTO notifications (id, org_id, user_id, kind, title, body, created_at) VALUES ($1,'org_grace','u_jane','announcement',$2,'b',$3)`, [id, title, t]);
    }
    const tok = (await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone: '0711000001', code: '123456' } })).json().token;
    const h = { authorization: `Bearer ${tok}` };
    const before = (await app.inject({ method: 'GET', url: '/me/notifications', headers: h })).json();
    await app.inject({ method: 'POST', url: '/me/notifications/read', payload: { ids: ['ntf_one1'] }, headers: h });
    const mid = (await app.inject({ method: 'GET', url: '/me/notifications', headers: h })).json();
    expect(mid.unread).toBe(before.unread - 1);
    expect(mid.rows.find((r: any) => r.id === 'ntf_one1').read).toBe(true);
    expect(mid.rows.find((r: any) => r.id === 'ntf_one2').read).toBe(false);
    await app.inject({ method: 'POST', url: '/me/notifications/read', payload: {}, headers: h });
    expect((await app.inject({ method: 'GET', url: '/me/notifications', headers: h })).json().unread).toBe(0);
  });
});
