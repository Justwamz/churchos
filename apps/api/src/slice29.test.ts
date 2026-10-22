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
const call = async (phone: string | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: any) =>
  app.inject({ method, url, payload, headers: phone ? { authorization: `Bearer ${await login(phone)}` } : {} });

const OWNER = '0700000001', ADMIN = '0700000003', HOPE = '0700000005', LUCY = '0700000008', PA1 = '0700000099';
const NEWBIE = '0722333444', NEWBIE2 = '0722333555';

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
  const t = ctx.clock.now().toISOString();
  for (const [id, phone, name] of [['u_newbie', '254722333444', 'Brenda Achieng'], ['u_newbie2', '254722333555', 'Collins Kiptoo']]) {
    await ctx.db.query(`INSERT INTO users (id, phone, name, created_at) VALUES ($1,$2,$3,$4)`, [id, phone, name, t]);
  }
}, 60000);

describe('finding a church by name or code', () => {
  it('finds listed churches by part of the name, the branch, or the exact code', async () => {
    const byName = (await call(null, 'GET', '/public/churches/search?q=grace')).json().churches as any[];
    expect(byName.map((c) => c.code)).toContain('GRC001');
    expect(byName[0]).toMatchObject({ church: 'Grace Community Church' });
    expect((await call(null, 'GET', '/public/churches/search?q=GRC001')).json().churches[0]).toMatchObject({ code: 'GRC001', branch: 'Grace Nairobi' });
    expect((await call(null, 'GET', '/public/churches/search?q=gr')).json().churches.length).toBe(0); // under three letters: nothing
    expect((await call(null, 'GET', '/public/churches/search?q=zzzzzz')).json().churches).toEqual([]);
    expect(JSON.stringify(byName)).not.toMatch(/org_|phone|payout/);
  });

  it('keeps a church out of the name search when the owner asks, but not out of its own code', async () => {
    expect((await call(ADMIN, 'GET', '/church/directory')).statusCode).toBe(403);
    expect((await call(ADMIN, 'PUT', '/church/directory', { listed: false })).statusCode).toBe(403);
    expect((await call(OWNER, 'GET', '/church/directory')).json()).toEqual({ listed: true });
    expect((await call(OWNER, 'PUT', '/church/directory', { listed: false })).json()).toEqual({ listed: false });
    expect((await call(null, 'GET', '/public/churches/search?q=grace')).json().churches.map((c: any) => c.church)).not.toContain('Grace Community Church');
    expect((await call(null, 'GET', '/public/churches/search?q=GRC001')).json().churches[0]?.code).toBe('GRC001');
    await call(OWNER, 'PUT', '/church/directory', { listed: true });
    expect((await call(null, 'GET', '/public/churches/search?q=grace')).json().churches.length).toBeGreaterThan(0);
  });

  it('limits how fast it can be asked', async () => {
    let last = 200;
    for (let i = 0; i < 45; i++) last = (await call(null, 'GET', `/public/churches/search?q=church${i}`)).statusCode;
    expect(last).toBe(429);
  });
});

describe('a person with no church asks to join', () => {
  let reqId = '';
  it('starts with no church, and can find one to ask', async () => {
    expect((await call(NEWBIE, 'GET', '/me/link/status')).json()).toMatchObject({ linked: false, churches: [], requests: [], canLinkAtOnce: [] });
    expect((await call(null, 'GET', '/me/link/status')).statusCode).toBe(401);
  });

  it('needs the code to be real and consent to be given', async () => {
    expect((await call(NEWBIE, 'POST', '/me/link/request', { code: 'NOPE99', consent: true })).json().code).toBe('unknown_church');
    expect((await call(NEWBIE, 'POST', '/me/link/request', { code: 'GRC001' })).json().code).toBe('consent_required');
  });

  it('sends the request, tells the church people, and refuses a second one', async () => {
    const r = await call(NEWBIE, 'POST', '/me/link/request', { code: 'GRC001', consent: true, message: 'Visiting family, now living in Nairobi' });
    expect(r.statusCode).toBe(200);
    reqId = r.json().id;
    expect((await call(NEWBIE, 'POST', '/me/link/request', { code: 'GRC001', consent: true })).json().code).toBe('duplicate_request');
    const st = (await call(NEWBIE, 'GET', '/me/link/status')).json();
    expect(st.requests[0]).toMatchObject({ status: 'pending', church: 'Grace Community Church' });
    const bell = ((await call(ADMIN, 'GET', '/me/notifications?app=staff')).json().rows as any[]).find((n) => n.title === 'Someone asked to join the church');
    expect(bell).toMatchObject({ link: 'staff:members?tab=requests', audience: 'staff' });
    expect((await call(ADMIN, 'GET', '/staff/today')).json().cards.find((c: any) => c.key === 'joins').count).toBe(1);
  });

  it('is seen only by staff of that branch who can edit members', async () => {
    const list = (await call(ADMIN, 'GET', '/members/join-requests')).json();
    expect(list.pending).toBe(1);
    expect(list.requests[0]).toMatchObject({ name: 'Brenda Achieng', status: 'pending', message: 'Visiting family, now living in Nairobi' });
    expect(list.requests[0].phone).not.toContain('722333444'); // masked
    expect((await call(HOPE, 'GET', '/members/join-requests')).json().requests).toEqual([]); // another church
    expect((await call('0711000002', 'GET', '/members/join-requests')).statusCode).toBe(403);
    expect((await call(HOPE, 'POST', `/members/join-requests/${reqId}/decide`, { approve: true })).statusCode).toBe(404);
  });

  it('can be declined with a reason, and then asked again', async () => {
    expect((await call(ADMIN, 'POST', `/members/join-requests/${reqId}/decide`, { approve: false })).json().code).toBe('bad_content');
    expect((await call(ADMIN, 'POST', `/members/join-requests/${reqId}/decide`, { approve: false, note: 'Please bring your member card on Sunday' })).json().status).toBe('declined');
    expect((await call(ADMIN, 'POST', `/members/join-requests/${reqId}/decide`, { approve: true })).json().code).toBe('already_decided');
    const mine = ((await call(NEWBIE, 'GET', '/me/notifications')).json().rows as any[]).find((n) => n.title === 'About your request to join');
    expect(mine.body).toMatch(/bring your member card/);
    ctx.clock.advance(61 * 60_000); // AZ-15: one request per church an hour
    const again = await call(NEWBIE, 'POST', '/me/link/request', { code: 'GRC001', consent: true });
    expect(again.statusCode).toBe(200);
    reqId = again.json().id;
  });

  it('makes a member when approved, who can then use the church', async () => {
    const a = await call(ADMIN, 'POST', `/members/join-requests/${reqId}/decide`, { approve: true });
    expect(a.json().status).toBe('approved');
    const st = (await call(NEWBIE, 'GET', '/me/link/status')).json();
    expect(st).toMatchObject({ linked: true });
    expect(st.churches[0]).toMatchObject({ church: 'Grace Community Church', branch: 'Grace Nairobi' });
    const me = (await call(NEWBIE, 'GET', '/me')).json();
    expect(me.memberships?.[0]?.full_name ?? me.memberships?.[0]?.name).toMatch(/Brenda Achieng/);
    expect((await call(NEWBIE, 'POST', '/me/link/request', { code: 'GRC001', consent: true })).json().code).toBe('already_member');
    const note = ((await call(NEWBIE, 'GET', '/me/notifications')).json().rows as any[]).find((n) => /Welcome to Grace/.test(n.title));
    expect(note).toMatchObject({ link: 'member:home' });
    expect((await call(NEWBIE, 'GET', '/me/statements')).statusCode).toBe(200);
  });

  it('can be cancelled by the person while it waits', async () => {
    const r = (await call(NEWBIE2, 'POST', '/me/link/request', { code: 'GRC001', consent: true })).json();
    expect((await call(NEWBIE2, 'POST', `/me/link/request/${r.id}/cancel`)).statusCode).toBe(200);
    expect((await call(NEWBIE2, 'POST', `/me/link/request/${r.id}/cancel`)).statusCode).toBe(404);
    expect((await call(ADMIN, 'GET', '/members/join-requests')).json().requests.some((x: any) => x.id === r.id && x.status === 'pending')).toBe(false);
  });
});

describe('staff link themselves at once', () => {
  it('lets the owner, who works for the church but is not on its member list, link in one step', async () => {
    const st = (await call(OWNER, 'GET', '/me/link/status')).json();
    if (st.linked) return; // the demo owner may already be a member
    expect(st.canLinkAtOnce.length).toBeGreaterThan(0);
    const r = await call(OWNER, 'POST', '/me/link/instant', { code: st.canLinkAtOnce[0].code });
    expect(r.statusCode).toBe(200);
    expect((await call(OWNER, 'GET', '/me/link/status')).json().linked).toBe(true);
  });

  it('refuses people who do not work for the church', async () => {
    expect((await call(NEWBIE2, 'POST', '/me/link/instant', { code: 'GRC001' })).json().code).toBe('not_staff');
    expect((await call(PA1, 'GET', '/admin/audit/events?action=member.join_approved')).json().events.length).toBeGreaterThan(0);
  });
});
