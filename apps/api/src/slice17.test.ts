import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { seedKidsDemo } from './seed-kids';

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

const OWNER = '0700000001', TREAS = '0700000002', ADMIN = '0700000003', COAST = '0700000004', HOPE = '0700000005', PA1 = '0700000099', LUCY = '0700000008';
const JANE = '0711000001', PETER = '0711000002', DAVID = '0711000004';
const HOUR = 3600_000;
const wait = async (fn: () => Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
};
const paymentsOf = async (where: string, params: unknown[] = []) => ctx.db.query<any>(`SELECT * FROM payments WHERE ${where} ORDER BY received_at DESC`, params);
const give = async (who: string, body: any) => {
  const before = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM payments`))[0].n);
  const r = await call(who, 'POST', '/me/give', { code: 'GRC001', amount: 1000, purpose: 'TITHE', method: 'mpesa', ...body });
  expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
  expect(await wait(async () => Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM payments`))[0].n) > before)).toBe(true);
  return r.json();
};
const lastPayment = async () => (await ctx.db.query<any>(`SELECT * FROM payments ORDER BY received_at DESC, id DESC LIMIT 1`))[0];
const staffLedger = (who: string, member: string, extra = 'reason=statement_request') => call(who, 'GET', `/members/${member}/giving-ledger?${extra}`);
const todayStart = () => new Date(ctx.clock.now().getTime() - 24 * HOUR).toISOString().slice(0, 10);

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
  await seedKidsDemo(ctx);
}, 60000);

describe('giving anonymously (L217, L218)', () => {
  it('is for members of the church, in the app only', async () => {
    expect((await call(null, 'POST', '/me/give', { code: 'GRC001', amount: 1000, anonymous: true })).statusCode).toBe(401);
    expect((await call(HOPE, 'POST', '/me/give', { code: 'GRC001', amount: 1000, purpose: 'TITHE', method: 'mpesa', anonymous: true })).json().code).toBe('not_a_member');
    expect((await call(JANE, 'POST', '/me/give', { code: 'GRC001', amount: 1000, purpose: 'CERT-X', method: 'mpesa', anonymous: true })).json().code).toBe('anonymous_purpose');
    expect((await call(JANE, 'POST', '/me/give', { code: 'GRC001', amount: 1000, purpose: 'BK-X', method: 'mpesa', anonymous: true })).json().code).toBe('anonymous_purpose');
  });

  it('ignores the anonymous setting on the public giving page', async () => {
    const before = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM payments`))[0].n);
    const r = await call(null, 'POST', '/public/give', { code: 'GRC001', amount: 500, purpose: 'OFFERING', method: 'mpesa', phone: '0711 000 002', anonymous: true });
    expect(r.statusCode).toBe(200);
    expect(await wait(async () => Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM payments`))[0].n) > before)).toBe(true);
    const p = await lastPayment();
    expect(p).toMatchObject({ anonymous: false, payer_phone: '254711000002', member_id: 'm_peter' });
  });

  it('takes an anonymous gift without the church ever learning who gave it', async () => {
    await give(JANE, { amount: 1000, purpose: 'TITHE', anonymous: true });
    const p = await lastPayment();
    expect(p).toMatchObject({ anonymous: true, payer_phone: null, member_id: null, purpose: 'TITHE' });
    const intent = (await ctx.db.query<any>(`SELECT phone, anonymous FROM give_intents WHERE provider_tx_id=$1`, [p.provider_tx_id]))[0];
    expect(intent).toMatchObject({ phone: '', anonymous: true });
    const link = (await ctx.db.query<any>(`SELECT * FROM anonymous_gifts WHERE payment_id=$1`, [p.id]))[0];
    expect(link).toMatchObject({ user_id: 'u_jane', phone: '254711000001' });
    expect((await ctx.db.query<any>(`SELECT 1 FROM giving_ledger WHERE payment_id=$1`, [p.id])).length).toBe(0);
    // Nothing the church can read mentions Jane's number for this gift.
    const rows = JSON.stringify(await ctx.db.query<any>(`SELECT * FROM payments WHERE id=$1`, [p.id]));
    expect(rows).not.toContain('254711000001');
  });

  it('shows the giver their own gift, marked anonymous, and sends them the receipt', async () => {
    const mine = (await call(JANE, 'GET', '/me/giving')).json();
    expect(mine.rows[0]).toMatchObject({ anonymous: true, purpose: 'TITHE' });
    expect(mine.total).toBeGreaterThan(0);
    const led = (await call(JANE, 'GET', '/me/giving/ledger')).json();
    expect(led.anonymous).toHaveLength(1);
    expect(led.anonymous[0]).toMatchObject({ anonymous: true, amount: 100000, purpose: 'TITHE' });
    expect(led.anonymousTotal).toBe(100000);
    expect((await call(JANE, 'GET', '/me/notifications')).json().rows.some((n: any) => n.title === 'Gift received')).toBe(true);
    expect((await call(PETER, 'GET', '/me/giving/ledger')).json().anonymous).toEqual([]);
  });

  it('reaches the church only as one total for the day, in every list it can read', async () => {
    await give(JANE, { amount: 2000, purpose: 'TITHE', anonymous: true });
    const c = (await call(OWNER, 'GET', `/collections?from=${todayStart()}`)).json();
    const anon = c.rows.filter((r: any) => r.method === 'anonymous');
    expect(anon).toHaveLength(1);
    expect(anon[0]).toMatchObject({ purpose: 'TITHE', member: 'Anonymous (2 gifts)', gross: 300000, phone: null, receipt: null });
    expect(c.rows.filter((r: any) => r.amount_paid === 100000 && r.purpose === 'TITHE' && !r.member && r.method === 'mpesa' && r.phone)).toEqual([]);
    expect(c.totals.gross).toBeGreaterThanOrEqual(300000);
    const dash = JSON.stringify((await call(OWNER, 'GET', '/dashboard')).json());
    expect(dash).not.toContain('254711000001');
    const csv = (await call(OWNER, 'GET', `/collections?format=csv&from=${todayStart()}`)).body;
    expect(csv).toContain('Anonymous (2 gifts)');
    expect(csv).not.toContain('254711000001');
  });

  it('does not count toward a pledge, but the project still receives it', async () => {
    const before = (await call(JANE, 'GET', '/me/pledges')).json().find((x: any) => x.project_code === 'ROOF').paid;
    const proj = (await call(null, 'GET', '/public/church/GRC001')).json().projects.find((x: any) => x.code === 'ROOF').raised;
    await give(JANE, { amount: 3000, purpose: 'PROJ-ROOF', anonymous: true });
    expect((await call(JANE, 'GET', '/me/pledges')).json().find((x: any) => x.project_code === 'ROOF').paid).toBe(before);
    expect((await call(null, 'GET', '/public/church/GRC001')).json().projects.find((x: any) => x.code === 'ROOF').raised).toBeGreaterThan(proj);
  });

  it('lets only the giver ask for it back, and ChurchOS look up who gave it, with a reason that is recorded', async () => {
    const p = await lastPayment();
    expect((await call(PETER, 'POST', '/me/reversal-request', { message: p.provider_tx_id })).json().code).toBe('not_your_payment');
    const r = await call(JANE, 'POST', '/me/reversal-request', { message: p.provider_tx_id, reason: 'Wrong church' });
    expect(r.statusCode).toBe(200);
    expect((await call(PA1, 'POST', `/admin/payments/${p.id}/reveal`, {})).json().code).toBe('reason_required');
    const who = await call(PA1, 'POST', `/admin/payments/${p.id}/reveal`, { reason: 'Fraud check on a large anonymous gift' });
    expect(who.json()).toMatchObject({ payer_phone: '254711000001', anonymous: true });
    const log = (await call(PA1, 'GET', '/admin/audit/events?action=access.reveal_anonymous')).json().events;
    expect(log[0].reason).toBe('Fraud check on a large anonymous gift');
    expect((await call(OWNER, 'POST', `/admin/payments/${p.id}/reveal`, {})).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('can be a regular gift too', async () => {
    const m = (await call(JANE, 'GET', '/me')).json().memberships[0].id;
    const plan = await call(JANE, 'POST', '/me/giving-plans', { membershipId: m, amount: 700, purpose: 'OFFERING', frequency: 'weekly', weekday: ((new Date(ctx.clock.now().getTime() + 24 * HOUR + 3 * HOUR).getUTCDay() + 6) % 7) + 1, time: '10:00', method: 'mpesa', anonymous: true });
    expect(plan.statusCode).toBe(200);
    expect(plan.json().anonymous).toBe(true);
    const { runGivingJobs } = await import('./routes/giving-plans');
    ctx.clock.advance(Date.parse(plan.json().nextRunAt) - ctx.clock.now().getTime() + 60_000);
    await runGivingJobs(ctx);
    expect(await wait(async () => (await ctx.db.query<any>(`SELECT 1 FROM payments WHERE anonymous AND purpose='OFFERING'`)).length > 0)).toBe(true);
    const p = (await ctx.db.query<any>(`SELECT * FROM payments WHERE anonymous AND purpose='OFFERING'`))[0];
    expect(p).toMatchObject({ payer_phone: null, member_id: null });
    expect((await call(JANE, 'GET', '/me/giving-plans')).json().plans.find((x: any) => x.id === plan.json().id).anonymous).toBe(true);
    await call(JANE, 'POST', `/me/giving-plans/${plan.json().id}/cancel`);
  });
});

describe("the member giving ledger (L219 to L224)", () => {
  it('writes a line for every gift that can be tied to a member, with the amount given', async () => {
    const r = await give(JANE, { amount: 1500, purpose: 'TITHE' });
    expect(r.intentId).toBeTruthy();
    const p = await lastPayment();
    const line = (await ctx.db.query<any>(`SELECT * FROM giving_ledger WHERE payment_id=$1`, [p.id]))[0];
    expect(line).toMatchObject({ kind: 'gift', membership_id: 'm_jane', amount: 150000, purpose: 'TITHE', method: 'mpesa', ref: p.provider_tx_id });
    expect(line.hash).toMatch(/^[0-9a-f]{64}$/);
    await give(JANE, { amount: 2500, purpose: 'PROJ-ROOF' });
    const lines = await ctx.db.query<any>(`SELECT * FROM giving_ledger WHERE membership_id='m_jane' ORDER BY seq`);
    expect(lines.some((l) => l.purpose === 'PROJ-ROOF' && l.project_id === 'prj_roof')).toBe(true);
  });

  it('is only for people with the right, in their own places, and needs a reason', async () => {
    expect((await staffLedger(OWNER, 'm_jane')).statusCode).toBe(200);
    expect((await staffLedger(TREAS, 'm_jane')).statusCode).toBe(200);
    for (const who of [ADMIN, PETER, LUCY]) expect((await staffLedger(who, 'm_jane')).statusCode, who).toBeGreaterThanOrEqual(403);
    expect((await staffLedger(HOPE, 'm_jane')).statusCode).toBe(404);
    expect((await staffLedger(COAST, 'm_jane')).statusCode).toBe(404); // Mombasa's treasurer, not Nairobi's
    expect((await call(OWNER, 'GET', '/members/m_jane/giving-ledger')).json().code).toBe('reason_required');
    expect((await staffLedger(OWNER, 'm_jane', 'reason=because')).json().code).toBe('reason_required');
    expect((await staffLedger(OWNER, 'm_jane', 'reason=other')).json().code).toBe('reason_required');
    expect((await staffLedger(OWNER, 'm_jane', 'reason=other&note=Family%20asked')).statusCode).toBe(200);
  });

  it("shows the member's lines and totals, and never an anonymous gift", async () => {
    const r = (await staffLedger(TREAS, 'm_jane', 'reason=statement_request')).json();
    expect(r.member).toMatchObject({ name: 'Jane Wanjiku', memberNumber: 'M00001' });
    expect(r.lines.length).toBeGreaterThanOrEqual(2);
    expect(r.lines.every((l: any) => l.kind === 'gift')).toBe(true);
    expect(r.totals.given).toBe(r.lines.reduce((s: number, l: any) => s + l.amount, 0));
    expect(r.totals.byPurpose.TITHE).toBeGreaterThan(0);
    expect(r.integrity).toMatchObject({ ok: true });
    const anonIds = (await ctx.db.query<any>(`SELECT payment_id FROM anonymous_gifts WHERE payment_id IS NOT NULL`)).map((x) => x.payment_id);
    expect(r.lines.some((l: any) => anonIds.includes(l.ref))).toBe(false);
    expect(JSON.stringify(r)).not.toContain('254711000001');
  });

  it('records every look and export, with who and why, and the member can see them', async () => {
    const log = (await call(PA1, 'GET', '/admin/audit/events?action=giving_ledger.viewed')).json().events;
    expect(log.length).toBeGreaterThanOrEqual(3);
    expect(log[0]).toMatchObject({ entity: 'membership', entity_id: 'm_jane' });
    expect(log.some((e: any) => /Family asked/.test(e.reason ?? ''))).toBe(true);
    const csv = await call(TREAS, 'GET', '/members/m_jane/giving-ledger?reason=audit&format=csv');
    expect(csv.body).toContain('Reference');
    expect((await call(PA1, 'GET', '/admin/audit/events?action=giving_ledger.exported')).json().events.length).toBe(1);
    const mine = (await call(JANE, 'GET', '/me/giving/access-log')).json().log;
    expect(mine.length).toBeGreaterThanOrEqual(5);
    expect(mine[0]).toMatchObject({ who: 'Esther Njeri', action: 'exported', reason: 'Audit or review', church: 'Grace Community Church' });
    expect(mine.some((e: any) => e.who === 'Daniel Mwangi' && e.reason === 'Other reason' && e.note === 'Family asked')).toBe(true);
    expect((await call(PETER, 'GET', '/me/giving/access-log')).json().log).toEqual([]);
    expect(JSON.stringify(mine)).not.toContain('254700000');
  });

  it('cancels a reversed gift with a new line and leaves the original alone', async () => {
    await give(JANE, { amount: 4000, purpose: 'OFFERING' });
    const p = await lastPayment();
    const before = (await ctx.db.query<any>(`SELECT * FROM giving_ledger WHERE payment_id=$1 AND kind='gift'`, [p.id]))[0];
    const req = await call(JANE, 'POST', '/me/reversal-request', { message: p.provider_tx_id, reason: 'Paid by mistake' });
    expect(req.statusCode).toBe(200);
    const dec = await call(PA1, 'POST', `/admin/reversal-requests/${req.json().id}/decide`, { approve: true, reason: 'Checked against the provider statement' });
    expect(dec.statusCode).toBe(200);
    const lines = await ctx.db.query<any>(`SELECT * FROM giving_ledger WHERE payment_id=$1 ORDER BY seq`, [p.id]);
    expect(lines.map((l) => [l.kind, l.amount])).toEqual([['gift', 400000], ['reversal', -400000]]);
    expect(lines[1].reverses).toBe(before.id);
    expect(lines[0].hash).toBe(before.hash);
    const r = (await staffLedger(OWNER, 'm_jane', 'reason=reconciliation')).json();
    expect(r.lines.filter((l: any) => l.reverses === before.id)).toHaveLength(1);
    expect(r.totals.given).toBe(r.lines.reduce((s: number, l: any) => s + l.amount, 0));
  });

  it('cannot be changed or deleted, and the chain checks out', async () => {
    await expect(ctx.db.query(`UPDATE giving_ledger SET amount=1 WHERE membership_id='m_jane'`)).rejects.toThrow(/append-only/);
    await expect(ctx.db.query(`DELETE FROM giving_ledger WHERE membership_id='m_jane'`)).rejects.toThrow(/append-only/);
    await expect(ctx.db.query(`TRUNCATE giving_ledger`)).rejects.toThrow(/append-only/);
    await expect(ctx.db.query(`UPDATE giving_ledger_access SET reason='audit'`)).rejects.toThrow(/append-only/);
    await expect(ctx.db.query(`DELETE FROM giving_ledger_access`)).rejects.toThrow(/append-only/);
    const v = (await call(OWNER, 'GET', '/giving-ledger/verify')).json();
    expect(v).toMatchObject({ ok: true, brokenAt: null });
    expect(v.lines).toBeGreaterThan(3);
    expect((await call(TREAS, 'GET', '/giving-ledger/verify')).json().ok).toBe(true); // a branch treasurer can check it too
    expect((await call(ADMIN, 'GET', '/giving-ledger/verify')).statusCode).toBe(403);
    expect((await call(PA1, 'GET', '/admin/audit/events?action=giving_ledger.verified')).json().events.length).toBeGreaterThan(0);
  });

  it('puts cash a church knows the givers of into their giving records, once the count is signed off', async () => {
    const count = (extra: any) => call(TREAS, 'POST', '/cash', { branchId: 'br_grc001', amount: 10000, purpose: 'TITHE', ...extra });
    expect((await count({ gifts: [{ membershipId: 'm_jane', amount: 6000 }, { membershipId: 'm_david', amount: 5000 }] })).json().code).toBe('gifts_too_much');
    expect((await count({ purpose: 'SOMETHING', gifts: [{ membershipId: 'm_jane', amount: 100 }] })).json().code).toBe('gifts_purpose');
    expect((await count({ gifts: [{ membershipId: 'nobody', amount: 100 }] })).json().code).toBe('unknown_member');
    expect((await count({ gifts: [{ membershipId: 'm_jane', amount: 0 }] })).json().code).toBe('bad_amount');
    const made = await count({ note: 'Sunday envelopes', gifts: [{ membershipId: 'm_jane', amount: 2000 }, { membershipId: 'm_david', amount: 3000 }, { membershipId: 'm_jane', amount: 500 }] });
    expect(made.statusCode).toBe(200);
    const cash = (await call(TREAS, 'GET', '/cash')).json().find((c: any) => c.id === made.json().id);
    expect(cash).toMatchObject({ known_gifts: 2, status: 'counted' });
    expect(Number(cash.known_total)).toBe(550000);
    expect((await ctx.db.query<any>(`SELECT 1 FROM giving_ledger WHERE cash_entry_id=$1`, [made.json().id])).length).toBe(0); // nothing until a second person signs off
    expect((await call(TREAS, 'POST', `/cash/${made.json().id}/signoff`, {})).json().code).toBe('same_person');
    expect((await call(ADMIN, 'POST', `/cash/${made.json().id}/signoff`, {})).statusCode).toBe(200);
    const lines = await ctx.db.query<any>(`SELECT * FROM giving_ledger WHERE cash_entry_id=$1 ORDER BY membership_id`, [made.json().id]);
    expect(lines.map((l) => [l.membership_id, l.kind, l.amount, l.method, l.purpose])).toEqual([['m_david', 'cash_gift', 300000, 'cash', 'TITHE'], ['m_jane', 'cash_gift', 250000, 'cash', 'TITHE']]);
    expect(lines[0].recorded_by).toBe('u_treas');
    expect((await call(ADMIN, 'POST', `/cash/${made.json().id}/signoff`, {})).json().code).toBe('already_decided');
    const mine = (await call(DAVID, 'GET', '/me/giving/ledger')).json();
    expect(mine.lines.find((l: any) => l.kind === 'cash_gift')).toMatchObject({ amount: 300000, source: 'Cash recorded by the church' });
    const rejected = await count({ gifts: [{ membershipId: 'm_peter', amount: 1000 }] });
    expect((await call(ADMIN, 'POST', `/cash/${rejected.json().id}/signoff`, { approve: false, reason: 'Count did not match' })).json().status).toBe('rejected');
    expect((await ctx.db.query<any>(`SELECT 1 FROM giving_ledger WHERE cash_entry_id=$1`, [rejected.json().id])).length).toBe(0);
    expect((await call(OWNER, 'GET', '/giving-ledger/verify')).json().ok).toBe(true);
  });

  it('lets a treasurer find a member without being able to see every member', async () => {
    const found = (await call(TREAS, 'GET', '/members/lookup?q=Wanjiku')).json().members;
    expect(found.map((m: any) => m.name)).toEqual(expect.arrayContaining(['Jane Wanjiku', 'David Wanjiku']));
    expect(found.every((m: any) => m.name !== 'Ruth Wanjiku')).toBe(true); // children have no giving
    expect(found[0]).toEqual({ id: expect.any(String), name: expect.any(String), memberNumber: expect.any(String), branch: 'Grace Nairobi' });
    expect(JSON.stringify(found)).not.toMatch(/phone|254/);
    expect((await call(TREAS, 'GET', '/members/lookup?q=J')).json().members).toEqual([]);
    expect((await call(TREAS, 'GET', '/members')).statusCode).toBe(403); // she still cannot list members
    expect((await call(COAST, 'GET', '/members/lookup?q=Wanjiku')).json().members).toEqual([]); // Mombasa's treasurer sees only Mombasa
    for (const who of [PETER, LUCY]) expect((await call(who, 'GET', '/members/lookup?q=Wanjiku')).statusCode, who).toBe(403);
  });

  it('keeps the books balanced', async () => {
    expect((await call(PA1, 'GET', '/admin/reconcile')).json().ok).toBe(true);
  });
});
