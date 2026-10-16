import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { nextOccurrence, runGivingJobs } from './routes/giving-plans';

let app: Awaited<ReturnType<typeof buildApp>>['app'];
let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
const tokens: Record<string, string> = {};
async function login(phone: string) {
  if (tokens[phone]) return tokens[phone];
  const r = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: '123456' } });
  tokens[phone] = r.json().token;
  return tokens[phone];
}
const call = async (phone: string | null, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: any) =>
  app.inject({ method, url, payload, headers: phone ? { authorization: `Bearer ${await login(phone)}` } : {} });

const OWNER = '0700000001', HOPE = '0700000005', PA1 = '0700000099';
const JANE = '0711000001', PETER = '0711000002';
const HOUR = 3600_000, DAY = 24 * HOUR;
const EAT = 3 * HOUR;
const wait = async (fn: () => Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
const inbox = async (who: string) => (await call(who, 'GET', '/me/notifications')).json().rows as any[];
const smsTo = (phone: string) => ctx.messaging.sent.filter((m) => m.channel === 'sms' && m.to === phone);
const eatDate = (ms: number) => new Date(ms + EAT).toISOString().slice(0, 10);
const eatWeekday = (ms: number) => ((new Date(ms + EAT).getUTCDay() + 6) % 7) + 1;
const now = () => ctx.clock.now().getTime();
const memberOf = async (who: string) => (await call(who, 'GET', '/me')).json().memberships[0].id as string;
const goTo = (iso: string) => ctx.clock.advance(Date.parse(iso) - now() + 60_000);
const plan = async (id: string, who = JANE) => (await call(who, 'GET', '/me/giving-plans')).json().plans.find((p: any) => p.id === id);

/** A weekly plan whose first prompt is tomorrow at 10:00 Nairobi time. */
const weekly = async (who = JANE, extra: any = {}) => {
  const r = await call(who, 'POST', '/me/giving-plans', { membershipId: await memberOf(who), amount: 1000, purpose: 'TITHE', frequency: 'weekly', weekday: eatWeekday(now() + DAY), time: '10:00', ...extra });
  expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
  return r.json();
};

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);

describe('when the next gift falls due', () => {
  it('finds the right date for weekly, fortnightly and monthly plans', () => {
    const w = { frequency: 'weekly', weekday: 1, month_day: null, anchor_date: null }; // Mondays
    expect(nextOccurrence(w, '2026-10-14')).toBe('2026-10-19');
    expect(nextOccurrence(w, '2026-10-19')).toBe('2026-10-19');
    const f = { frequency: 'fortnightly', weekday: 1, month_day: null, anchor_date: '2026-10-05' };
    expect(nextOccurrence(f, '2026-10-05')).toBe('2026-10-05');
    expect(nextOccurrence(f, '2026-10-06')).toBe('2026-10-19');
    expect(nextOccurrence(f, '2026-10-20')).toBe('2026-11-02');
    const m15 = { frequency: 'monthly', weekday: null, month_day: 15, anchor_date: null };
    expect(nextOccurrence(m15, '2026-10-15')).toBe('2026-10-15');
    expect(nextOccurrence(m15, '2026-10-16')).toBe('2026-11-15');
    expect(nextOccurrence(m15, '2026-12-20')).toBe('2027-01-15');
    const last = { frequency: 'monthly', weekday: null, month_day: 0, anchor_date: null };
    expect(nextOccurrence(last, '2027-02-10')).toBe('2027-02-28');
    expect(nextOccurrence(last, '2028-02-10')).toBe('2028-02-29');
    expect(nextOccurrence(last, '2026-04-30')).toBe('2026-04-30');
  });
});

describe('setting up a regular gift (L197)', () => {
  it('is for signed-in members only', async () => {
    expect((await call(null, 'POST', '/me/giving-plans', {})).statusCode).toBe(401);
    expect((await call(HOPE, 'POST', '/me/giving-plans', { membershipId: await memberOf(JANE), amount: 1000, frequency: 'weekly' })).statusCode).toBe(404);
    expect((await call(HOPE, 'GET', '/me/giving-plans')).json().plans).toEqual([]);
  });

  it('refuses what cannot be charged or does not make sense', async () => {
    const m = await memberOf(JANE);
    const post = (x: any) => call(JANE, 'POST', '/me/giving-plans', { membershipId: m, amount: 1000, purpose: 'TITHE', frequency: 'monthly', monthDay: 5, ...x });
    expect((await post({ method: 'card' })).json().code).toBe('card_not_supported');
    expect((await post({ amount: 5 })).json().code).toBe('amount_too_small');
    expect((await post({ amount: 2000000 })).json().code).toBe('amount_too_large');
    expect((await post({ time: '05:00' })).json().code).toBe('bad_time');
    expect((await post({ time: '22:30' })).json().code).toBe('bad_time');
    expect((await post({ frequency: 'daily' })).json().code).toBe('bad_frequency');
    expect((await post({ monthDay: 29 })).json().code).toBe('bad_day');
    expect((await post({ purpose: 'PROJ-NOPE' })).json().code).toBe('unknown_purpose');
    expect((await post({ purpose: 'CERT-1' })).json().code).toBe('unknown_purpose');
    expect((await post({ startDate: '2020-01-01' })).json().code).toBe('bad_date');
    expect((await post({ endDate: eatDate(now()) })).json().code).toBe('bad_date');
    expect((await post({ method: 'airtel', phone: '0711000001' })).json().code).toBe('wrong_network');
    expect((await post({ phone: '123' })).json().code).toBe('bad_phone');
  });

  it('sets up a weekly gift that starts tomorrow at 10:00 and tells the member', async () => {
    const p = await weekly();
    expect(p).toMatchObject({ amount: 100000, purpose: 'TITHE', frequency: 'weekly', time: '10:00', status: 'active', completed: 0, missed: 0 });
    expect(p.youPay).toBeGreaterThanOrEqual(100000);
    expect(p.nextRunAt).toBe(new Date(Date.parse(`${eatDate(now() + DAY)}T10:00:00Z`) - EAT).toISOString());
    expect(p.phone).toBe('0711 *** 001');
    expect((await inbox(JANE)).some((n) => /regular gift is set up/.test(n.title))).toBe(true);
    const audit = (await call(PA1, 'GET', '/admin/audit/events?action=giving.plan_created')).json().events;
    expect(audit.length).toBeGreaterThan(0);
  });
});

describe('the prompt and the gift (L198)', () => {
  let id = '';
  beforeAll(async () => { id = (await call(JANE, 'GET', '/me/giving-plans')).json().plans[0].id; });
  afterAll(async () => { await call(JANE, 'POST', `/me/giving-plans/${id}/cancel`); });

  it('sends nothing before it is due', async () => {
    expect((await runGivingJobs(ctx))).toMatchObject({ created: 0, prompted: 0 });
  });

  it('sends the prompt when due, takes the gift like any other, and counts it for the member', async () => {
    const before = (await ctx.db.query<any>(`SELECT count(*)::int AS n FROM payments`))[0].n;
    goTo((await plan(id)).nextRunAt);
    expect(await runGivingJobs(ctx)).toMatchObject({ created: 1, prompted: 1 });
    const intent = (await ctx.db.query<any>(`SELECT * FROM give_intents WHERE plan_run_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`))[0];
    expect(intent).toMatchObject({ purpose: 'TITHE', base_amount: 100000 });
    expect(await wait(async () => (await plan(id)).completed === 1)).toBe(true);
    const p = await plan(id);
    expect(p.runs[0]).toMatchObject({ status: 'completed', attempt: 1, kind: 'scheduled' });
    expect(p.totalGiven).toBe(100000);
    const pay = (await ctx.db.query<any>(`SELECT member_id, purpose, stage FROM payments WHERE id=$1`, [p.runs[0].id ? (await ctx.db.query<any>(`SELECT payment_id FROM giving_plan_runs WHERE id=$1`, [p.runs[0].id]))[0].payment_id : '']))[0];
    expect(pay).toMatchObject({ member_id: 'm_jane', purpose: 'TITHE' });
    expect((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM payments`))[0].n).toBe(before + 1);
    expect((await inbox(JANE)).some((n) => /Time for your tithe gift/.test(n.title))).toBe(true);
    expect((await inbox(JANE)).some((n) => n.title === 'Gift received')).toBe(true);
    expect((await call(JANE, 'GET', '/me/giving')).json().rows.some((r: any) => r.purpose === 'TITHE')).toBe(true);
  });

  it('schedules the next one a week later at the same time, and does not prompt twice', async () => {
    const p = await plan(id);
    expect(Date.parse(p.nextRunAt) - now()).toBeGreaterThan(6 * DAY);
    expect(Date.parse(p.nextRunAt) - now()).toBeLessThan(7 * DAY + HOUR);
    expect(await runGivingJobs(ctx)).toMatchObject({ created: 0, prompted: 0 });
    expect((await call(JANE, 'GET', `/me/giving-plans/${id}/runs`)).json().runs).toHaveLength(1);
  });
});

describe('when the prompt is not completed (L199)', () => {
  it('retries three times over two days, then marks the gift missed and tells the member', async () => {
    const created = await weekly(JANE, { amount: 500, purpose: 'OFFERING' });
    const id = created.id;
    goTo(created.nextRunAt);
    const t0 = Date.parse(created.nextRunAt);
    ctx.provider.failNextStk(4); // the prompts go out, but nobody enters a PIN
    ctx.messaging.clear();
    expect(await runGivingJobs(ctx)).toMatchObject({ created: 1, prompted: 1 });
    const attempts = async () => (await ctx.db.query<any>(`SELECT attempt, status FROM giving_plan_runs WHERE plan_id=$1`, [id]))[0];
    expect(await attempts()).toMatchObject({ attempt: 1, status: 'prompted' });
    // Nothing happens between attempts.
    ctx.clock.advance(HOUR);
    expect(await runGivingJobs(ctx)).toMatchObject({ prompted: 0, missed: 0 });
    // +3 hours, +1 day, +2 days
    ctx.clock.advance(Date.parse(new Date(t0 + 3 * HOUR).toISOString()) - now() + 60_000);
    expect(await runGivingJobs(ctx)).toMatchObject({ prompted: 1 });
    expect((await attempts()).attempt).toBe(2);
    ctx.clock.advance(t0 + DAY - now() + 60_000);
    expect(await runGivingJobs(ctx)).toMatchObject({ prompted: 1 });
    ctx.clock.advance(t0 + 2 * DAY - now() + 60_000);
    expect(await runGivingJobs(ctx)).toMatchObject({ prompted: 1 });
    expect((await attempts()).attempt).toBe(4);
    expect(smsTo('254711000001')).toHaveLength(0); // prompts arrive as the phone prompt itself, not as extra SMS
    ctx.clock.advance(t0 + 2 * DAY + 3 * HOUR - now() + 60_000);
    expect(await runGivingJobs(ctx)).toMatchObject({ missed: 1 });
    const p = await plan(id);
    expect(p).toMatchObject({ missed: 1, completed: 0, status: 'active' });
    expect(p.runs[0].status).toBe('missed');
    expect(smsTo('254711000001').some((m) => /could not collect your offering gift/.test(m.body))).toBe(true);
    expect((await inbox(JANE)).some((n) => /could not collect/.test(n.title))).toBe(true);
    expect(await runGivingJobs(ctx)).toMatchObject({ missed: 0 });
    expect((await call(PA1, 'GET', '/admin/audit/events?action=giving.run_missed')).json().events.length).toBeGreaterThan(0);
    await call(JANE, 'POST', `/me/giving-plans/${id}/cancel`);
  });

  it('gives up quietly on a prompt that was due long ago while ChurchOS was off', async () => {
    const created = await weekly();
    ctx.clock.advance(Date.parse(created.nextRunAt) - now() + 5 * DAY);
    ctx.messaging.clear();
    expect(await runGivingJobs(ctx)).toMatchObject({ created: 1, prompted: 0, missed: 1 });
    expect((await plan(created.id)).runs[0]).toMatchObject({ status: 'missed', note: 'ChurchOS was not running at the time' });
    await call(JANE, 'POST', `/me/giving-plans/${created.id}/cancel`);
  });
});

describe('looking after a plan (L200)', () => {
  let id = '';
  beforeAll(async () => { id = (await weekly()).id; });

  it('changes the amount, and the time from the next prompt', async () => {
    const before = await plan(id);
    const r = await call(JANE, 'PATCH', `/me/giving-plans/${id}`, { amount: 2500, time: '15:30' });
    expect(r.statusCode).toBe(200);
    const p = r.json();
    expect(p).toMatchObject({ amount: 250000, time: '15:30' });
    expect(Date.parse(p.nextRunAt)).toBe(Date.parse(before.nextRunAt) + 5.5 * HOUR);
    expect((await call(JANE, 'PATCH', `/me/giving-plans/${id}`, { time: '03:00' })).json().code).toBe('bad_time');
    expect((await call(JANE, 'PATCH', `/me/giving-plans/${id}`, { amount: 1 })).json().code).toBe('amount_too_small');
    expect((await call(JANE, 'PATCH', `/me/giving-plans/${id}`, { method: 'card' })).json().code).toBe('card_not_supported');
    expect((await call(PETER, 'PATCH', `/me/giving-plans/${id}`, { amount: 100000 })).statusCode).toBe(404);
  });

  it('skips one gift and goes on', async () => {
    expect((await call(JANE, 'POST', `/me/giving-plans/${id}/skip-next`, {})).json().skipNext).toBe(true);
    goTo((await plan(id)).nextRunAt);
    expect(await runGivingJobs(ctx)).toMatchObject({ created: 0, prompted: 0 });
    const p = await plan(id);
    expect(p.runs[0]).toMatchObject({ status: 'skipped', note: 'Skipped by you' });
    expect(p.skipNext).toBe(false);
    expect(Date.parse(p.nextRunAt)).toBeGreaterThan(now());
  });

  it('pauses (no prompts), then resumes from the next due date, never a missed one', async () => {
    expect((await call(JANE, 'POST', `/me/giving-plans/${id}/pause`)).json().status).toBe('paused');
    ctx.clock.advance(20 * DAY);
    expect(await runGivingJobs(ctx)).toMatchObject({ created: 0, prompted: 0 });
    const r = (await call(JANE, 'POST', `/me/giving-plans/${id}/resume`)).json();
    expect(r.status).toBe('active');
    expect(Date.parse(r.nextRunAt)).toBeGreaterThan(now());
    expect(Date.parse(r.nextRunAt)).toBeLessThan(now() + 8 * DAY);
    expect(await runGivingJobs(ctx)).toMatchObject({ created: 0 });
  });

  it('stops for good when cancelled', async () => {
    expect((await call(JANE, 'POST', `/me/giving-plans/${id}/cancel`)).json().status).toBe('cancelled');
    expect((await call(JANE, 'GET', '/me/giving-plans')).json().plans.some((p: any) => p.id === id)).toBe(false);
    ctx.clock.advance(30 * DAY);
    expect(await runGivingJobs(ctx)).toMatchObject({ created: 0 });
    expect((await call(JANE, 'POST', `/me/giving-plans/${id}/resume`)).json().code).toBe('wrong_state');
  });

  it('allows five at a time', async () => {
    for (let i = 0; i < 5; i++) await weekly(JANE, { amount: 1000 + i * 100 });
    const m = await memberOf(JANE);
    expect((await call(JANE, 'POST', '/me/giving-plans', { membershipId: m, amount: 1000, purpose: 'TITHE', frequency: 'weekly' })).json().code).toBe('too_many');
    for (const p of (await call(JANE, 'GET', '/me/giving-plans')).json().plans) await call(JANE, 'POST', `/me/giving-plans/${p.id}/cancel`);
  });
});

describe('a gift now, an end date, a project and a pledge (L201)', () => {
  it('gives the first gift at once when asked, and starts the series after today', async () => {
    const r = await call(JANE, 'POST', '/me/giving-plans', { membershipId: await memberOf(JANE), amount: 1500, purpose: 'TITHE', frequency: 'weekly', weekday: eatWeekday(now()), time: '10:00', firstNow: true });
    expect(r.statusCode).toBe(200);
    const created = r.json();
    expect(created.firstGift).toEqual({ prompted: true });
    expect(await wait(async () => (await plan(created.id)).completed === 1)).toBe(true);
    const p = await plan(created.id);
    expect(p.runs[0]).toMatchObject({ kind: 'first', status: 'completed' });
    expect(eatDate(Date.parse(p.nextRunAt))).not.toBe(eatDate(now()));
    expect(Date.parse(p.nextRunAt)).toBeGreaterThan(now());
    await call(JANE, 'POST', `/me/giving-plans/${created.id}/cancel`);
  });

  it('ends on its end date', async () => {
    const first = eatDate(now() + DAY);
    const created = await weekly(JANE, { endDate: eatDate(now() + 2 * DAY) });
    goTo(created.nextRunAt);
    await runGivingJobs(ctx);
    expect(await wait(async () => (await plan(created.id)).completed === 1)).toBe(true);
    const p = await plan(created.id);
    expect(p.status).toBe('ended');
    expect(p.nextRunAt).toBeNull();
    expect(first).toBeTruthy();
    expect(await runGivingJobs(ctx)).toMatchObject({ created: 0 });
  });

  it('counts a regular gift to a project toward the pledge', async () => {
    const before = (await call(JANE, 'GET', '/me/pledges')).json().find((x: any) => x.project_code === 'ROOF').paid;
    const created = await weekly(JANE, { amount: 2000, purpose: 'PROJ-ROOF' });
    expect(created.purposeLabel).toBe('New Sanctuary Roof');
    goTo(created.nextRunAt);
    await runGivingJobs(ctx);
    expect(await wait(async () => (await plan(created.id)).completed === 1)).toBe(true);
    const after = (await call(JANE, 'GET', '/me/pledges')).json().find((x: any) => x.project_code === 'ROOF').paid;
    expect(after).toBeGreaterThan(before);
    await call(JANE, 'POST', `/me/giving-plans/${created.id}/cancel`);
  });

  it('counts a gift for the member even when the prompt goes to another number', async () => {
    const created = await weekly(JANE, { amount: 700, phone: '0722333444', purpose: 'OFFERING' });
    goTo(created.nextRunAt);
    await runGivingJobs(ctx);
    expect(await wait(async () => (await plan(created.id)).completed === 1)).toBe(true);
    const row = (await ctx.db.query<any>(`SELECT p.member_id FROM giving_plan_runs r JOIN payments p ON p.id=r.payment_id WHERE r.plan_id=$1`, [created.id]))[0];
    expect(row.member_id).toBe('m_jane');
    await call(JANE, 'POST', `/me/giving-plans/${created.id}/cancel`);
  });
});

describe('what the church sees (L202)', () => {
  it('lists plans and the month so far, without phone numbers, for the people who see collections', async () => {
    const created = await weekly(JANE, { amount: 3000 });
    const r = (await call(OWNER, 'GET', '/giving-plans')).json();
    expect(r.summary.active).toBeGreaterThanOrEqual(1);
    expect(r.summary.collectedThisMonth).toBeGreaterThan(0);
    expect(r.summary.expectedPerMonth).toBeGreaterThan(0);
    const mine = r.plans.find((p: any) => p.amount === 300000);
    expect(mine).toMatchObject({ member: 'Jane Wanjiku', memberNumber: 'M00001', frequency: 'weekly', status: 'active' });
    expect(JSON.stringify(r)).not.toContain('254711000001');
    expect((await call(OWNER, 'GET', '/giving-plans?status=cancelled')).json().plans.every((p: any) => p.status === 'cancelled')).toBe(true);
    expect((await call(OWNER, 'GET', '/giving-plans?q=Wanjiku')).json().plans.length).toBeGreaterThan(0);
    expect((await call(OWNER, 'GET', '/giving-plans?q=Nobody')).json().plans).toEqual([]);
    expect((await call(OWNER, 'GET', '/giving-plans?csv=1')).body).toContain('Member number');
    expect((await call(JANE, 'GET', '/giving-plans')).statusCode).toBe(403);
    expect((await call(HOPE, 'GET', '/giving-plans')).json().plans).toEqual([]);
    await call(JANE, 'POST', `/me/giving-plans/${created.id}/cancel`);
  });

  it('keeps the books balanced', async () => {
    expect((await call(PA1, 'GET', '/admin/reconcile')).json().ok).toBe(true);
  });
});
