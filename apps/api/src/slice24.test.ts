import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { seedKidsDemo } from './seed-kids';
import { seedExpensesDemo } from './seed-expenses';

let app: Awaited<ReturnType<typeof buildApp>>['app'];
let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
const tokens: Record<string, string> = {};
async function login(phone: string) {
  if (tokens[phone]) return tokens[phone];
  const r = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: '123456' } });
  tokens[phone] = r.json().token;
  return tokens[phone];
}
const call = async (phone: string | null, method: 'GET' | 'POST', url: string, payload?: any) =>
  app.inject({ method, url, payload, headers: phone ? { authorization: `Bearer ${await login(phone)}` } : {} });

const OWNER = '0700000001', TREAS = '0700000002', ADMIN = '0700000003', USHER = '0700000556', HOPE = '0700000005';
const JANE = '0711000001';
const keys = (r: any) => (r.json().cards as any[]).map((c) => c.key);

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
  await seedKidsDemo(ctx);
  await seedExpensesDemo(app, ctx);
  const t = ctx.clock.now().toISOString();
  await ctx.db.query(`INSERT INTO users (id, phone, name, created_at) VALUES ('u_usher','254700000556','Usher Peter',$1)`, [t]);
  await ctx.db.query(`INSERT INTO role_assignments (id, org_id, user_id, role_id, scope_type, scope_id) VALUES ('ra_usher','org_grace','u_usher','org_grace:Usher','branch','br_grc001')`);
}, 60000);

describe('Today on the staff phone (Slice 24)', () => {
  it('needs a sign-in, and gives a plain member nothing', async () => {
    expect((await call(null, 'GET', '/staff/today')).statusCode).toBe(401);
    const r = await call(JANE, 'GET', '/staff/today');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ cards: [], services: [], kids: [], total: 0 });
  });

  it('shows each person only what their rights cover', async () => {
    const admin = await call(ADMIN, 'GET', '/staff/today');
    expect(keys(admin)).toEqual(expect.arrayContaining(['expenses', 'claims']));
    expect((admin.json().cards as any[]).find((c) => c.key === 'expenses').count).toBeGreaterThanOrEqual(1);
    const treas = await call(TREAS, 'GET', '/staff/today');
    expect(keys(treas)).toContain('claims');
    expect(keys(treas)).not.toContain('expenses'); // the treasurer records but does not approve
    const usher = await call(USHER, 'GET', '/staff/today');
    expect(usher.json().cards).toEqual([]);
    expect(Array.isArray(usher.json().services)).toBe(true);
  });

  it('does not count what the person recorded themselves, or what another church holds', async () => {
    const hope = await call(HOPE, 'GET', '/staff/today');
    expect((hope.json().cards as any[]).every((c) => c.count === 0 || c.key === 'visitors')).toBe(true);
    const owner = await call(OWNER, 'GET', '/staff/today');
    expect(owner.json().total).toBeGreaterThan(0);
    // Esther recorded the repairs bill, so she is never asked to approve it, and neither is a person who is not allowed to
    const asEsther = (await call(TREAS, 'GET', '/staff/today')).json().cards as any[];
    expect(asEsther.find((c) => c.key === 'expenses')).toBeUndefined();
  });

  it('lists services today and open children classes', async () => {
    const now = ctx.clock.now().getTime();
    const mk = await call(OWNER, 'POST', '/attendance/services', { branchId: 'br_grc001', name: 'Today service', startsAt: new Date(now + 20 * 60_000).toISOString(), durationMin: 60 });
    expect(mk.statusCode).toBe(200);
    const usher = (await call(USHER, 'GET', '/staff/today')).json();
    expect(usher.services.some((s: any) => s.name === 'Today service' && s.state === 'open')).toBe(true);
  });
});

describe('what the church calls its gatherings (Slice 25)', () => {
  const put = (who: string, body: any) => app.inject({ method: 'PUT', url: '/church/words', payload: body, headers: { authorization: `Bearer ${tokens[who] ?? ''}` } });

  it('is Service until the owner changes it, and everyone in the church can read it', async () => {
    await login(OWNER); await login(ADMIN); await login(JANE);
    const j = (await call(JANE, 'GET', '/me/words')).json();
    expect(j).toMatchObject({ one: 'Service', many: 'Services', oneLower: 'service', canChange: false });
    expect(j.presets.map((p: any) => p.one)).toContain('Mass');
    expect((await call(OWNER, 'GET', '/me/words')).json().canChange).toBe(true);
    expect((await call(ADMIN, 'GET', '/me/words')).json().canChange).toBe(false); // a branch admin cannot rename it
  });

  it('is changed only by the owner, with sensible words', async () => {
    expect((await put(ADMIN, { one: 'Mass', many: 'Masses' })).statusCode).toBe(403);
    expect((await put(JANE, { one: 'Mass', many: 'Masses' })).statusCode).toBeGreaterThanOrEqual(403);
    expect((await put(OWNER, { one: 'M', many: 'Masses' })).json().code).toBe('bad_word');
    expect((await put(OWNER, { one: 'Mass<b>', many: 'Masses' })).json().code).toBe('bad_word');
    const ok = await put(OWNER, { one: 'mass', many: 'masses' });
    expect(ok.json()).toMatchObject({ one: 'Mass', many: 'Masses', manyLower: 'masses' });
    expect((await call(JANE, 'GET', '/me/words')).json()).toMatchObject({ one: 'Mass', many: 'Masses' });
    const events = (await call('0700000099', 'GET', '/admin/audit/events?action=church.words')).json().events as any[];
    expect(events.length).toBe(1);
  });

  it('reaches the public check-in pages', async () => {
    const mk = await call(OWNER, 'POST', '/attendance/services', { branchId: 'br_grc001', name: 'Words mass', startsAt: new Date(ctx.clock.now().getTime() + 600_000).toISOString(), durationMin: 60 });
    const door = (await call(ADMIN, 'GET', `/attendance/services/${mk.json().id}/door`)).json();
    const pub = (await call(null, 'GET', `/public/here/${door.url.split('/here/')[1]}`)).json();
    expect(pub.words).toMatchObject({ one: 'Mass', many: 'Masses' });
  });
});
