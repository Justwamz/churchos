import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';

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

const OWNER = '0700000001', TREAS = '0700000002', ADMIN = '0700000003', COAST = '0700000004', HOPE = '0700000005', PA1 = '0700000099';
const JANE = '0711000001', PETER = '0711000002', DAVID = '0711000004';
const DAY = 86_400_000;
const wait = async (fn: () => Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
};
const give = async (who: string, body: any = {}) => {
  const before = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM payments`))[0].n);
  const r = await call(who, 'POST', '/me/give', { code: 'GRC001', amount: 1000, purpose: 'TITHE', method: 'mpesa', ...body });
  expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
  expect(await wait(async () => Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM payments`))[0].n) > before)).toBe(true);
};
const year = () => new Date(ctx.clock.now().getTime() + 3 * 3600_000).getUTCFullYear();
const pdfText = (b: string) => b;

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);

describe('annual giving statements, on request only (L245 to L249)', () => {
  let y1 = 0;
  let base = { gifts: 0, total: 0 }; // the demo data already has gifts for Jane
  let id1 = '';
  let number1 = '';

  it('makes nothing by itself, and has nothing for a year without gifts', async () => {
    y1 = year();
    const r = (await call(JANE, 'GET', '/me/statements')).json();
    base = r.churches[0].years.find((x: any) => x.year === y1) ?? base;
    expect(r.issued).toEqual([]);
    expect((await call(JANE, 'POST', '/me/statements', { year: y1 - 1 })).json().code).toBe('no_gifts');
    expect((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM giving_statements`))[0].n).toBe(0);
  });

  it('lists the years with gifts and makes a PDF on request, kept exactly as issued', async () => {
    await give(JANE, { amount: 1000, purpose: 'TITHE' });
    await give(JANE, { amount: 500, purpose: 'OFFERING' });
    await give(JANE, { amount: 2000, purpose: 'TITHE', anonymous: true }); // never on a statement
    const list = (await call(JANE, 'GET', '/me/statements')).json();
    expect(list.churches[0].years[0]).toMatchObject({ year: y1, gifts: base.gifts + 2, total: base.total + 150000 });
    expect(list.note).toMatch(/Anonymous/);
    expect((await call(JANE, 'POST', '/me/statements', { year: 1999 })).json().code).toBe('bad_year');
    expect((await call(JANE, 'POST', '/me/statements', { year: y1 + 1 })).json().code).toBe('bad_year');
    const made = await call(JANE, 'POST', '/me/statements', { year: y1 });
    expect(made.statusCode).toBe(200);
    expect(made.json()).toMatchObject({ year: y1, total: base.total + 150000, gifts: base.gifts + 2 });
    id1 = made.json().id;
    number1 = made.json().number;
    expect(number1).toMatch(/^GS-\d{4}-[0-9A-F]{10}$/);
    const pdf = await call(JANE, 'GET', `/me/statements/${id1}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const body = pdf.rawPayload;
    expect(body.subarray(0, 8).toString('latin1')).toMatch(/^%PDF-1\.4/);
    expect(body.subarray(body.length - 6).toString('latin1')).toContain('%%EOF');
    const t = pdfText(body.toString('latin1'));
    expect(t).toContain('Giving statement');
    expect(t).toContain(number1);
    expect(t).toContain(((base.total + 150000) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2 })); // the total, with no anonymous gift added in
    expect(t).not.toContain(((base.total + 350000) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2 }));
    expect(t).toContain('Grace Community Church');
    // the same document comes back the second time
    expect((await call(JANE, 'GET', `/me/statements/${id1}/pdf`)).rawPayload.equals(body)).toBe(true);
    expect((await call(JANE, 'GET', '/me/statements')).json().issued[0]).toMatchObject({ number: number1, by: 'You', total: base.total + 150000 });
  });

  it('is private to the member and the church people with the right', async () => {
    expect((await call(PETER, 'GET', `/me/statements/${id1}/pdf`)).statusCode).toBe(404);
    expect((await call(null, 'GET', `/me/statements/${id1}/pdf`)).statusCode).toBe(401);
    expect((await call(HOPE, 'GET', `/statements/${id1}/pdf`)).statusCode).toBeGreaterThanOrEqual(403);
    expect((await call(ADMIN, 'GET', `/statements/${id1}/pdf`)).statusCode).toBeGreaterThanOrEqual(403); // the branch admin has no giving-record right
    expect((await call(COAST, 'GET', `/statements/${id1}/pdf`)).statusCode).toBeGreaterThanOrEqual(403);
  });

  it('is checked by its number: church and year only', async () => {
    const v = (await call(null, 'GET', `/public/statement/${number1}`)).json();
    // AZ-17: only church and year come back now (no total, no initials, no date)
    expect(v).toMatchObject({ valid: true, church: 'Grace Community Church', year: y1 });
    expect(v.total).toBeUndefined();
    expect(v.memberInitials).toBeUndefined();
    expect(JSON.stringify(v)).not.toMatch(/Jane Wanjiku|0711/);
    expect((await call(null, 'GET', '/public/statement/GS-2000-ZZZZZZ')).json()).toEqual({ valid: false });
  });

  it('makes the right statement for each year, with reversals netted off', async () => {
    ctx.clock.advance(100 * DAY); // into the next year
    const y2 = year();
    expect(y2).toBe(y1 + 1);
    await give(JANE, { amount: 3000, purpose: 'TITHE' });
    const mine = (await call(JANE, 'GET', '/me/statements')).json().churches[0].years;
    expect(mine.map((r: any) => [r.year, r.total])).toEqual([[y2, 300000], [y1, base.total + 150000]]);
    const s2 = (await call(JANE, 'POST', '/me/statements', { year: y2 })).json();
    expect(s2).toMatchObject({ year: y2, total: 300000, gifts: 1 });
    const body = (await call(JANE, 'GET', `/me/statements/${s2.id}/pdf`)).rawPayload.toString('latin1');
    expect(body).toContain('so far this year');
    const first = (await call(JANE, 'POST', '/me/statements', { year: y1 })).json();
    expect(first.total).toBe(base.total + 150000);
    expect(first.number).not.toBe(number1); // each request is its own numbered statement
  });

  it('lets a treasurer make one on request, with a reason the member can see, and tells the member', async () => {
    const member = (await ctx.db.query<any>(`SELECT id FROM memberships WHERE user_id='u_jane' AND org_id='org_grace'`))[0].id;
    expect((await call(TREAS, 'POST', `/members/${member}/statements`, { year: y1 })).json().code).toBe('reason_required');
    expect((await call(TREAS, 'POST', `/members/${member}/statements`, { year: y1, reason: 'other' })).json().code).toBe('reason_required');
    expect((await call(ADMIN, 'POST', `/members/${member}/statements`, { year: y1, reason: 'statement_request' })).statusCode).toBeGreaterThanOrEqual(403);
    expect((await call(COAST, 'POST', `/members/${member}/statements`, { year: y1, reason: 'statement_request' })).statusCode).toBeGreaterThanOrEqual(403);
    const r = await call(TREAS, 'POST', `/members/${member}/statements`, { year: y1, reason: 'statement_request', note: 'Jane asked at the office' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ year: y1, total: base.total + 150000 });
    const pdf = await call(TREAS, 'GET', `/statements/${r.json().id}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.toString('latin1')).toContain(r.json().number);
    const log = (await call(JANE, 'GET', '/me/giving/access-log')).json().log as any[];
    expect(log.some((l) => /Esther/.test(l.who) && /Statement GS-/.test(l.note ?? ''))).toBe(true);
    const inbox = (await call(JANE, 'GET', '/me/notifications')).json().rows as any[];
    expect(inbox.some((n) => /giving statement for/.test(n.title))).toBe(true);
    const mineList = (await call(JANE, 'GET', '/me/statements')).json().issued as any[];
    expect(mineList.some((s) => s.by === 'Esther Njeri')).toBe(true);
    const staffList = (await call(TREAS, 'GET', `/members/${member}/statements`)).json().statements as any[];
    expect(staffList.map((s) => s.by)).toEqual(expect.arrayContaining(['The member', 'Esther Njeri']));
    expect(staffList.find((s) => s.by === 'Esther Njeri')?.reason).toMatch(/statement was requested/);
    const events = (await call(PA1, 'GET', '/admin/audit/events?action=statement.staff')).json().events as any[];
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].reason).toMatch(/Jane asked at the office/);
  });

  it('includes cash the church counted for the member, and cannot be asked for too often', async () => {
    const c = await call(TREAS, 'POST', '/cash', { branchId: 'br_grc001', amount: 5000, purpose: 'TITHE', gifts: [{ membershipId: 'm_david', amount: 2500 }] });
    if (c.statusCode === 200) await call(ADMIN, 'POST', `/cash/${c.json().id}/signoff`, {});
    const mem = (await call(DAVID, 'GET', '/me/statements')).json();
    expect(mem.churches[0].years[0].total).toBeGreaterThanOrEqual(250000);
    const s = (await call(DAVID, 'POST', '/me/statements', { year: year() })).json();
    expect(s.total).toBeGreaterThanOrEqual(250000);
    for (let i = 0; i < 9; i++) expect((await call(DAVID, 'POST', '/me/statements', { year: year() })).statusCode).toBe(200);
    expect((await call(DAVID, 'POST', '/me/statements', { year: year() })).json().code).toBe('too_many');
  });

  it('puts the church details and a signature on the statement when the church sets them', async () => {
    expect((await call(ADMIN, 'GET', '/statements/settings')).statusCode).toBeGreaterThanOrEqual(403);
    expect((await call(OWNER, 'PUT', '/statements/settings', { registrationNo: 'NGO/2012/4471', kraPin: 'P051234567Z', signatoryName: 'Esther Njeri', signatoryTitle: 'Treasurer', footer: 'Thank you for your faithful giving.' })).statusCode).toBe(200);
    expect((await call(TREAS, 'PUT', '/statements/settings', { footer: 'x' })).statusCode).toBe(403); // AZ-19: church-level settings need every branch
    expect((await call(OWNER, 'GET', '/statements/settings')).json()).toMatchObject({ registrationNo: 'NGO/2012/4471', signatoryName: 'Esther Njeri' });
    const s = (await call(PETER, 'POST', '/me/statements', { year: year() })).json();
    expect(s.code).toBe('no_gifts'); // Peter has given nothing as a member yet
    await give(PETER, { amount: 700, purpose: 'OFFERING' });
    const made = (await call(PETER, 'POST', '/me/statements', { year: year() })).json();
    const t = (await call(PETER, 'GET', `/me/statements/${made.id}/pdf`)).rawPayload.toString('latin1');
    expect(t).toContain('NGO/2012/4471');
    expect(t).toContain('Thank you for your faithful giving.');
    expect(t).toContain('Treasurer');
  });

  it('is in the audit trail and leaves the books balanced', async () => {
    expect((await call(PA1, 'GET', '/admin/audit/events?action=statement.member')).json().events.length).toBeGreaterThan(0);
    expect((await call(PA1, 'GET', '/admin/audit/events?action=statement.settings')).json().events.length).toBe(1);
    expect((await call(PA1, 'GET', '/admin/reconcile')).json().ok).toBe(true);
  });
});
