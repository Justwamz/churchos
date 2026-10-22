import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyChains } from '@churchos/ledger';
import { buildApp } from './server';
import { seed } from './seed';
import { errLine, maskPhone3, requestErrorLine, scrub } from './redact';
import { runRetentionJobs } from './retention';

/**
 * Slice 37: data protection (LG-16, LG-23). Export of a person's own data, closing an account with erasure, the automatic purges of
 * short-lived data, and log redaction. The money tables, the giving ledger and the audit log must come through an erasure untouched.
 */

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
const OWNER = '0700000001', ADMIN = '0700000099', JANE = '0711000001', PETER = '0711000002', DAVID = '0711000004';
const wait = async (fn: () => Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
};
const ERIN = '0722371001', ERIN_FULL = '254722371001';
const addMember = (name: string, phone: string) => call(OWNER, 'POST', '/members', { branchId: 'br_grc001', fullName: name, category: 'adult', phone, consent: true });
const uidOf = async (phone: string) => (await q(`SELECT id FROM users WHERE phone=$1`, [`254${phone.slice(1)}`]))[0]?.id as string;
const snapshot = async () => ({
  ledger: (await q(`SELECT count(*)::int AS n, md5(COALESCE(string_agg(hash, ',' ORDER BY seq), '')) AS h FROM giving_ledger`))[0],
  postings: (await q(`SELECT count(*)::int AS n, COALESCE(sum(amount),0)::text AS s, md5(COALESCE(string_agg(id || ':' || account_id || ':' || amount, ',' ORDER BY id), '')) AS h FROM postings`))[0],
  payments: (await q(`SELECT count(*)::int AS n, md5(COALESCE(string_agg(id || ':' || amount_paid || ':' || stage || ':' || COALESCE(payer_phone,'') || ':' || COALESCE(member_id,''), ',' ORDER BY id), '')) AS h FROM payments`))[0],
  audit: (await q(`SELECT count(*)::int AS n, max(seq) AS maxseq FROM audit_events`))[0],
});

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);

describe('export (LG-16)', () => {
  it('needs a sign-in', async () => {
    expect((await call(null, 'GET', '/me/export')).statusCode).toBe(401);
  });

  it("holds only the person's own data and not another member's", async () => {
    const r = await call(JANE, 'GET', '/me/export');
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['content-disposition'])).toContain('attachment');
    const d = r.json();
    expect(d.profile).toMatchObject({ name: 'Jane Wanjiku', phone: '254711000001' });
    expect(d.memberships.length).toBeGreaterThan(0);
    expect(d.household.length).toBeGreaterThan(0);
    // Household members are names only.
    for (const h of d.household) expect(Object.keys(h).sort()).toEqual(['name', 'relationship']);
    const text = JSON.stringify(d);
    expect(text).not.toContain('254711000002'); // Peter
    expect(text).not.toContain('Peter Otieno');
    expect(text).not.toContain('254711000004'); // David's phone
    // No session ids or tokens in the list of sessions.
    expect(d.sessions.length).toBeGreaterThan(0);
    for (const s of d.sessions) expect(Object.keys(s).sort()).toEqual(['device', 'endedAt', 'expiresAt', 'lastSeenAt', 'signedInAt']);
    // Staff-only notes are counted by category, never included.
    expect(d.heldByChurchesForTheirWork.every((x: any) => typeof x.category === 'string' && typeof x.count === 'number')).toBe(true);
    const logged = await q(`SELECT actor_id, action FROM audit_events WHERE action='data.export'`);
    expect(logged.some((e) => e.actor_id === 'u_jane')).toBe(true);
    // Peter's export does not carry Jane's phone or name.
    const p = JSON.stringify((await call(PETER, 'GET', '/me/export')).json());
    expect(p).not.toContain('254711000001');
    expect(p).not.toContain('Jane Wanjiku');
  });

  it("lists the person's own gifts only", async () => {
    const before = Number((await q(`SELECT count(*)::int AS n FROM giving_ledger`))[0].n);
    const r = await call(JANE, 'POST', '/me/give', { code: 'GRC001', amount: 1000, purpose: 'TITHE', method: 'mpesa' });
    expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
    expect(await wait(async () => Number((await q(`SELECT count(*)::int AS n FROM giving_ledger`))[0].n) > before)).toBe(true);
    const d = (await call(JANE, 'GET', '/me/export')).json();
    const own = await q(`SELECT count(*)::int AS n FROM giving_ledger WHERE membership_id IN (SELECT id FROM memberships WHERE user_id='u_jane')`);
    expect(d.giving.ledger.length).toBe(Number(own[0].n));
    expect(d.giving.ledger.length).toBeGreaterThan(0);
    expect(d.giving.payments.length).toBeGreaterThan(0);
    for (const l of d.giving.ledger) expect(Object.keys(l)).not.toContain('recorded_by');
  });

  it('is limited to 3 a day for each person, and recovers when the clock moves', async () => {
    for (let i = 0; i < 3; i++) expect((await call(DAVID, 'GET', '/me/export')).statusCode).toBe(200);
    const r = await call(DAVID, 'GET', '/me/export');
    expect(r.statusCode).toBe(429);
    expect(r.json().code).toBe('rate_limited');
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    // Another person is not affected.
    expect((await call(PETER, 'GET', '/me/export')).statusCode).toBe(200);
    ctx.clock.advanceHours(25);
    expect((await call(DAVID, 'GET', '/me/export')).statusCode).toBe(200);
  });
});

describe('closing an account (LG-16)', () => {
  let erin: string;
  let before: Awaited<ReturnType<typeof snapshot>>;
  let reqId: string;

  beforeAll(async () => {
    expect((await addMember('Erin Eraser', ERIN)).statusCode).toBe(200);
    erin = await uidOf(ERIN);
    expect(erin).toBeTruthy();
    const m = (await q(`SELECT id FROM memberships WHERE user_id=$1`, [erin]))[0];
    expect(m, 'the new member is linked to their account').toBeTruthy();
    await q(`INSERT INTO event_credits (id, org_id, user_id, secret, amount, balance, reason, created_at) VALUES ('ec_erin','org_grace',$1,'erinsecret0000000000000000000001',50000,30000,'test credit',$2)`, [erin, ctx.clock.now().toISOString()]);
    const plan = await call(ERIN, 'POST', '/me/giving-plans', { membershipId: m.id, amount: 1000, purpose: 'TITHE', frequency: 'weekly', weekday: 3, time: '10:00' });
    expect(plan.statusCode, JSON.stringify(plan.json())).toBe(200);
    expect((await call(ERIN, 'POST', '/me/prayer', { body: 'Please pray for my mother Wanjiru', audience: 'team' })).statusCode).toBe(200);
    expect((await call(ERIN, 'POST', '/me/suggestions', { body: 'Please start a second service in the afternoon', category: 'other' })).statusCode).toBe(200);
    const pay = Number((await q(`SELECT count(*)::int AS n FROM giving_ledger`))[0].n);
    expect((await call(ERIN, 'POST', '/me/give', { code: 'GRC001', amount: 2000, purpose: 'OFFERING', method: 'mpesa' })).statusCode).toBe(200);
    expect(await wait(async () => Number((await q(`SELECT count(*)::int AS n FROM giving_ledger`))[0].n) > pay)).toBe(true);
  });

  it('shows what will be forfeited and cancelled before the person confirms', async () => {
    const r = await call(ERIN, 'GET', '/me/erasure-preview');
    expect(r.statusCode).toBe(200);
    const p = r.json();
    expect(p.canRequest).toBe(true);
    expect(p.forfeitedCredit.map((c: any) => c.balance)).toEqual([30000]);
    expect(p.activeGivingPlans).toBe(1);
    expect(p.approval).toBe('church');
    expect(p.approvalText).toContain('must approve');
    expect(p.kept.length).toBeGreaterThan(3);
    expect(JSON.stringify(p.kept)).toContain('7 years');
    expect((await call(null, 'GET', '/me/erasure-preview')).statusCode).toBe(401);
  });

  it('needs a confirmation, then waits for the church and tells the church owner', async () => {
    expect((await call(ERIN, 'POST', '/me/erasure-request', { reason: 'moving away' })).json().code).toBe('confirm_required');
    const r = await call(ERIN, 'POST', '/me/erasure-request', { reason: 'moving away', confirm: true });
    expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
    expect(r.json()).toMatchObject({ status: 'pending', approval: 'church' });
    reqId = r.json().id;
    expect((await call(ERIN, 'POST', '/me/erasure-request', { confirm: true })).json().code).toBe('already_requested');
    // Nothing has changed yet.
    expect((await q(`SELECT name FROM users WHERE id=$1`, [erin]))[0].name).toBe('Erin Eraser');
    const tell = await q(`SELECT title, body, link, audience FROM notifications WHERE user_id='u_owner' AND link='staff:data-requests'`);
    expect(tell.length).toBe(1);
    expect(tell[0].audience).toBe('staff');
    expect(JSON.stringify(tell)).not.toContain('Erin');
  });

  it('can be decided only by the church owner or a platform admin, never by the person or a member without rights', async () => {
    expect((await call(PETER, 'GET', '/erasure-requests')).statusCode).toBe(403);
    expect((await call(PETER, 'POST', `/erasure-requests/${reqId}/decide`, { decision: 'approve' })).statusCode).toBe(403);
    expect((await call(ERIN, 'POST', `/erasure-requests/${reqId}/decide`, { decision: 'approve' })).statusCode).toBe(403);
    const list = (await call(OWNER, 'GET', '/erasure-requests')).json().requests;
    const mine = list.find((x: any) => x.id === reqId);
    expect(mine).toMatchObject({ name: 'Erin Eraser', status: 'pending', canDecide: true, needsPlatformAdmin: false });
    expect((await call(OWNER, 'POST', `/erasure-requests/${reqId}/decide`, { decision: 'maybe' })).statusCode).toBe(400);
  });

  it('a declined request changes nothing and tells the person why', async () => {
    expect((await addMember('Dina Decline', '0722371002')).statusCode).toBe(200);
    const dina = '0722371002';
    const r = (await call(dina, 'POST', '/me/erasure-request', { confirm: true })).json();
    expect((await call(OWNER, 'POST', `/erasure-requests/${r.id}/decide`, { decision: 'decline' })).json().code).toBe('note_required');
    const d = await call(OWNER, 'POST', `/erasure-requests/${r.id}/decide`, { decision: 'decline', note: 'Please see the office first' });
    expect(d.json()).toMatchObject({ status: 'declined' });
    expect((await q(`SELECT name FROM users WHERE phone='254722371002'`))[0].name).toBe('Dina Decline');
    const n = await q(`SELECT body FROM notifications WHERE user_id=(SELECT id FROM users WHERE phone='254722371002') AND title='Your data request was not approved'`);
    expect(n[0].body).toBe('Please see the office first');
    expect((await call(OWNER, 'POST', `/erasure-requests/${r.id}/decide`, { decision: 'approve' })).statusCode).toBe(409);
  });

  it('approval anonymises the person and leaves ledger, payments, postings and audit exactly as they were', async () => {
    before = await snapshot();
    expect(before.ledger.n).toBeGreaterThan(0);
    const r = await call(OWNER, 'POST', `/erasure-requests/${reqId}/decide`, { decision: 'approve', note: 'Confirmed with the member' });
    expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
    expect(r.json()).toMatchObject({ status: 'completed' });
    expect(r.json().kept.length).toBeGreaterThan(3);
    expect(r.json().result.forfeitedCreditCents).toBe(30000);
    expect((await call(OWNER, 'POST', `/erasure-requests/${reqId}/decide`, { decision: 'approve' })).statusCode).toBe(409);

    const after = await snapshot();
    expect(after.ledger).toEqual(before.ledger);
    expect(after.postings).toEqual(before.postings);
    expect(after.payments).toEqual(before.payments);
    expect(Number(after.audit.n)).toBeGreaterThan(Number(before.audit.n)); // only new events were added
    const reports = await verifyChains(ctx.db);
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.every((c) => c.ok), JSON.stringify(reports.filter((c) => !c.ok))).toBe(true);
    expect((await call(ADMIN, 'GET', '/admin/reconcile')).json().ok).toBe(true);
    const done = (await q(`SELECT action, summary FROM audit_events WHERE action='data.erasure_completed'`))[0];
    expect(done).toBeTruthy();
    expect(JSON.stringify(done)).not.toContain('Erin');
  });

  it('removes the name and phone from the account and from member views and staff lists', async () => {
    const u = (await q(`SELECT name, phone, email FROM users WHERE id=$1`, [erin]))[0];
    expect(u.name).toBe('Former member');
    expect(u.phone).toMatch(/^erased-/);
    expect(u.email).toBeNull();
    const m = (await q(`SELECT full_name, phone, dob, user_id, status FROM memberships WHERE member_number IN (SELECT member_number FROM memberships WHERE full_name='Former member')`));
    expect(m.length).toBeGreaterThan(0);
    const staff = await call(OWNER, 'GET', '/members?q=Erin');
    expect(staff.json()).toEqual([]);
    const all = JSON.stringify((await call(OWNER, 'GET', '/members')).json());
    expect(all).not.toContain('Erin');
    expect(all).not.toContain('722371001');
    expect(JSON.stringify((await call(OWNER, 'GET', '/members/grouped')).json())).not.toContain('Erin');
    // Nothing personal is left in the tables that held it.
    const none: [string, unknown[]][] = [
      [`SELECT count(*)::int AS n FROM memberships WHERE full_name LIKE 'Erin%' OR phone=$1`, [ERIN_FULL]],
      [`SELECT count(*)::int AS n FROM giving_plans WHERE phone=$1 OR (user_id=$2 AND status <> 'cancelled')`, [ERIN_FULL, erin]],
      [`SELECT count(*)::int AS n FROM prayer_requests WHERE body LIKE '%Wanjiru%'`, []],
      [`SELECT count(*)::int AS n FROM suggestions WHERE body LIKE '%second service%'`, []],
      [`SELECT count(*)::int AS n FROM notifications WHERE user_id=$1`, [erin]],
      [`SELECT count(*)::int AS n FROM event_credits WHERE user_id=$1 OR (balance <> 0 AND id='ec_erin')`, [erin]],
      [`SELECT count(*)::int AS n FROM sessions WHERE user_id=$1 AND revoked_at IS NULL`, [erin]],
    ];
    for (const [sql, p] of none) expect(Number((await q(sql, p))[0].n), sql).toBe(0);
    expect((await q(`SELECT amount FROM event_credits WHERE id='ec_erin'`))[0].amount).toBe(50000);
    const req = (await q(`SELECT status, subject_name, subject_phone, decided_by, note FROM erasure_requests WHERE id=$1`, [reqId]))[0];
    expect(req).toMatchObject({ status: 'completed', subject_name: null, subject_phone: null, decided_by: 'u_owner', note: 'Confirmed with the member' });
  });

  it('signs the person out everywhere and keeps the old number from signing in to the old account', async () => {
    expect((await call(ERIN, 'GET', '/me')).statusCode).toBe(401);
    const v = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone: ERIN, code: '123456' } });
    expect(v.statusCode).toBe(401);
  });

  it('lets the same number register again as a new, empty account', async () => {
    expect((await addMember('Erin Again', ERIN)).statusCode).toBe(200);
    delete tokens[ERIN];
    const me = (await call(ERIN, 'GET', '/me')).json();
    expect(me.user.name).toBe('Erin Again');
    expect(me.user.id).not.toBe(erin);
    expect(me.memberships.length).toBe(1);
    expect((await call(ERIN, 'GET', '/me/giving')).json().rows).toEqual([]);
    expect((await call(ERIN, 'GET', '/me/credit')).json().churches ?? []).toEqual([]);
    const text = JSON.stringify((await call(ERIN, 'GET', '/me/export')).json());
    expect(text).not.toContain('Erin Eraser');
    expect(text).not.toContain('Wanjiru');
  });

  it('closes a person with no church, no credit and no money in progress straight away', async () => {
    await q(`INSERT INTO users (id, phone, name, is_platform_admin, created_at) VALUES ('u_loner','254733000099','Lone Wolf',false,$1)`, [ctx.clock.now().toISOString()]);
    const p = (await call('0733000099', 'GET', '/me/erasure-preview')).json();
    expect(p).toMatchObject({ approval: 'none', canRequest: true });
    const r = await call('0733000099', 'POST', '/me/erasure-request', { confirm: true });
    expect(r.json()).toMatchObject({ status: 'completed', approval: 'none' });
    expect((await call('0733000099', 'GET', '/me')).statusCode).toBe(401);
    expect((await q(`SELECT name FROM users WHERE id='u_loner'`))[0].name).toBe('Former member');
  });

  it('sends a person at two churches to a platform admin, and does not let one church decide', async () => {
    expect((await addMember('Gus Both', '0722371003')).statusCode).toBe(200);
    const gus = await uidOf('0722371003');
    const hopeBranch = (await q(`SELECT id FROM branches WHERE org_id='org_hope' LIMIT 1`))[0].id;
    await q(`INSERT INTO memberships (id, org_id, branch_id, user_id, full_name, phone, member_number, category, joined_at) VALUES ('m_gus2','org_hope',$1,$2,'Gus Both','254722371003','H-GUS','adult',$3)`, [hopeBranch, gus, ctx.clock.now().toISOString()]);
    const p = (await call('0722371003', 'GET', '/me/erasure-preview')).json();
    expect(p.approval).toBe('platform');
    const r = (await call('0722371003', 'POST', '/me/erasure-request', { confirm: true })).json();
    expect(r).toMatchObject({ status: 'pending', approval: 'platform' });
    const listed = (await call(OWNER, 'GET', '/erasure-requests')).json().requests.find((x: any) => x.id === r.id);
    expect(listed).toMatchObject({ needsPlatformAdmin: true, canDecide: false });
    expect((await call(OWNER, 'POST', `/erasure-requests/${r.id}/decide`, { decision: 'approve' })).statusCode).toBe(403);
    expect((await q(`SELECT count(*)::int AS n FROM notifications WHERE user_id='u_admin' OR user_id IN (SELECT id FROM users WHERE is_platform_admin=true)`))[0].n).toBeGreaterThan(0);
    const d = await call(ADMIN, 'POST', `/erasure-requests/${r.id}/decide`, { decision: 'approve' });
    expect(d.json()).toMatchObject({ status: 'completed' });
    expect((await q(`SELECT full_name, phone FROM memberships WHERE id='m_gus2'`))[0]).toMatchObject({ full_name: 'Former member', phone: null });
  });

  it('holds back the only church owner and platform admins', async () => {
    const o = (await call(OWNER, 'GET', '/me/erasure-preview')).json();
    expect(o.canRequest).toBe(false);
    expect(o.blockers.join(' ')).toContain('only Organisation Owner');
    expect((await call(OWNER, 'POST', '/me/erasure-request', { confirm: true })).statusCode).toBe(409);
    const a = (await call(ADMIN, 'GET', '/me/erasure-preview')).json();
    expect(a.canRequest).toBe(false);
  });
});

describe('automatic purges (LG-16)', () => {
  const hours = (n: number) => new Date(Date.now() - n * 3600_000).toISOString();
  it('deletes only what is past its limit, never money or audit, and is safe to run twice', async () => {
    const day = 24;
    const clockHours = (n: number) => new Date(ctx.clock.now().getTime() - n * 3600_000).toISOString();
    const otp = (id: string, expired: string) => q(`INSERT INTO otp_codes (id, phone, code_hash, salt, expires_at, attempts, created_at) VALUES ($1,'254700000001','x','y',$2,0,$2)`, [id, expired]);
    await otp('otp_old', clockHours(25));
    await otp('otp_recent', clockHours(1));
    await otp('otp_live', new Date(ctx.clock.now().getTime() + 3600_000).toISOString());
    const ses = (id: string, expires: string, revoked: string | null) => q(`INSERT INTO sessions (id, user_id, created_at, expires_at, revoked_at) VALUES ($1,'u_jane',$2,$3,$4)`, [id, hours(100 * day), expires, revoked]);
    await ses('ses_old_expired', hours(31 * day), null);
    await ses('ses_old_revoked', hours(2 * day), hours(31 * day));
    await ses('ses_recent_expired', hours(5 * day), null);
    await ses('ses_live', new Date(Date.now() + 3600_000).toISOString(), null);
    const ntf = (id: string, at: string) => q(`INSERT INTO notifications (id, org_id, user_id, kind, title, body, created_at) VALUES ($1,'org_grace','u_jane','announcement','t','b',$2)`, [id, at]);
    await ntf('ntf_old', clockHours(91 * day));
    await ntf('ntf_recent', clockHours(10 * day));
    await q(`INSERT INTO held_payments (id, payment_id, purpose, expected, paid, kind, created_at) VALUES ('hp_keep','p_none','X',100,50,'underpaid',$1)`, [clockHours(400 * day)]);
    const money = await snapshot();
    const held = Number((await q(`SELECT count(*)::int AS n FROM held_payments`))[0].n);

    const r = await runRetentionJobs(ctx);
    expect(r.otpCodes).toBe(1);
    expect(r.sessions).toBe(2);
    expect(r.notifications).toBe(1);
    const ids = async (t: string, col = 'id') => (await q(`SELECT ${col} AS id FROM ${t}`)).map((x) => x.id);
    expect(await ids('otp_codes')).toEqual(expect.arrayContaining(['otp_recent', 'otp_live']));
    expect(await ids('otp_codes')).not.toContain('otp_old');
    const s = await ids('sessions');
    expect(s).toEqual(expect.arrayContaining(['ses_recent_expired', 'ses_live']));
    expect(s).not.toContain('ses_old_expired');
    expect(s).not.toContain('ses_old_revoked');
    const n = await ids('notifications');
    expect(n).toContain('ntf_recent');
    expect(n).not.toContain('ntf_old');
    expect(Number((await q(`SELECT count(*)::int AS n FROM held_payments`))[0].n)).toBe(held);
    const after = await snapshot();
    expect(after.ledger).toEqual(money.ledger);
    expect(after.postings).toEqual(money.postings);
    expect(after.payments).toEqual(money.payments);
    expect(Number(after.audit.n)).toBe(Number(money.audit.n) + 1); // the purge itself is logged, nothing is removed
    expect(await runRetentionJobs(ctx)).toEqual({ otpCodes: 0, sessions: 0, notifications: 0 });
  });

  it('follows the platform clock for notifications but never deletes a live session when the clock jumps ahead', async () => {
    ctx.clock.advanceHours(100 * 24);
    const r = await runRetentionJobs(ctx);
    expect(r.notifications).toBeGreaterThan(0); // the 10-day-old one is now over 90 days
    expect((await q(`SELECT id FROM sessions WHERE id='ses_live'`)).length).toBe(1);
    expect((await q(`SELECT id FROM notifications WHERE id='ntf_recent'`)).length).toBe(0);
  });
});

describe('log redaction (LG-23)', () => {
  it('masks a phone to its last 3 digits and scrubs free text', () => {
    expect(maskPhone3('254711000001')).toBe('•••001');
    expect(maskPhone3('0711 000 001')).toBe('•••001');
    expect(maskPhone3('')).toBe('•••');
    expect(maskPhone3(null)).toBe('•••');
    const s = scrub('Key (phone)=(254711000001) already exists for jane@example.com token abcdefghijklmnopqrstuvwxyz12345');
    expect(s).not.toContain('254711000001');
    expect(s).not.toContain('jane@example.com');
    expect(s).not.toContain('abcdefghijklmnopqrstuvwxyz12345');
    expect(s).toContain('•••001');
  });

  it('error lines carry the method, path without the query, request id and error name only', () => {
    const line = requestErrorLine({ method: 'GET', url: '/members?q=0711000001&token=abc', id: 'req-1' }, new TypeError('boom 0711000001'));
    expect(line).toBe('error GET /members id=req-1 TypeError');
    expect(errLine(Object.assign(new Error('phone 254711000001 failed'), { code: 'XX' }))).toBe('Error [XX]: phone •••001 failed');
  });

  it('no console call in the API source prints a whole error object or a payload', () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p); } };
    walk(__dirname);
    const bad: string[] = [];
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((l, i) => { if (/console\.(error|warn|log)\(.*,\s*(e|err|error|body|req)\)/.test(l)) bad.push(`${f}:${i + 1}`); });
    }
    expect(bad).toEqual([]);
  });
});
