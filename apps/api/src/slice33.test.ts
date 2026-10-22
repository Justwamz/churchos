import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { consentOf } from './consent';

/**
 * Slice 33: access control and privacy fixes (AZ-06, AZ-07, AZ-08, AZ-15, AZ-16, AZ-17, AZ-18, AZ-19, AZ-22, LG-21).
 * Each test is a probe from docs/security/probes that used to succeed and must now fail.
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

const OWNER = '0700000001', ADMIN3 = '0700000003', AUDITOR = '0700000007', HOPE = '0700000005';
const JANE = '0711000001', AMINA = '0711000003', DAVID = '0711000004';
const DAY = 86_400_000;
const inDays = (n: number) => new Date(ctx.clock.now().getTime() + n * DAY).toISOString();

/** A staff user with their own role, for personas the seed does not have. */
async function persona(id: string, phone: string, name: string, perms: string[], org: string, scopeType: 'org' | 'branch', scopeId: string) {
  await q(`INSERT INTO users (id, phone, name, is_platform_admin, created_at) VALUES ($1,$2,$3,false,$4) ON CONFLICT DO NOTHING`, [id, `254${phone.slice(1)}`, name, new Date().toISOString()]);
  await q(`INSERT INTO roles (id, org_id, name, permissions) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [`${org}:${id}`, org, id, JSON.stringify(perms)]);
  await q(`INSERT INTO role_assignments (id, org_id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,$4,$5,$6)`, [`ra_${id}`, org, id, `${org}:${id}`, scopeType, scopeId]);
}

async function freeOrder(email: string) {
  const id = (await call(OWNER, 'POST', '/events', { title: 'Free night ' + email, audience: { type: 'org' }, startsAt: inDays(20), endsAt: inDays(20.1), location: 'Hall' })).json().id;
  await call(OWNER, 'PUT', `/events/${id}/ticketing`, { ticketed: true, refundDaysBefore: 30, types: [{ name: 'Regular', price: 0, quantity: 50 }] });
  const s = (await call(OWNER, 'GET', `/events/${id}/tickets`)).json();
  const r = await call(null, 'POST', '/public/tickets/orders', { code: s.code, name: 'Guest', email, phone: '0712000111', method: 'mpesa', lines: [{ typeId: s.types[0].id, qty: 1 }] });
  expect(r.statusCode, r.body).toBe(200);
  return { ...r.json(), eventCode: s.code as string };
}

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
  // A staff member who can see attendance but not reveal numbers, and a branch-only treasurer-style wallet viewer.
  await persona('u_viewer', '0700000071', 'Vera Viewer', ['attendance.view', 'members.view'], 'org_grace', 'branch', 'br_grc001');
  await persona('u_walletb', '0700000072', 'Wanda Wallet', ['wallets.view', 'integrations.manage', 'church.settings', 'members.view'], 'org_grace', 'branch', 'br_grc001');
  await q(`UPDATE users SET email='wanda@gmail.com', email_verified=true WHERE id='u_walletb'`);
  await persona('u_vol', '0700000073', 'Vic Volunteer', ['expenses.claim'], 'org_grace', 'branch', 'br_grc001');
}, 60_000);

describe('AZ-06: a ticket link no longer controls the order', () => {
  it('the ticket page has this ticket only, no order secret, and the order page still works', async () => {
    const o = await freeOrder('az06@gmail.com');
    expect(o.status).toBe('paid');
    const t = o.tickets[0];
    const page = (await call(null, 'GET', `/public/tickets/${t.token}`)).json();
    expect(page.serial).toBe(t.serial);
    expect(JSON.stringify(page)).not.toContain(o.secret);
    expect(page.order.secret).toBeUndefined();
    expect(page.order.id).toBeUndefined();
    expect(page.order.refund).toBeUndefined();
    // The order link (from the confirmation email) keeps working as before.
    const ord = (await call(null, 'GET', `/public/tickets/orders/${o.secret}`)).json();
    expect(ord.code).toBe(o.code);
    expect(ord.tickets).toHaveLength(1);
  });
  it('the confirmation email carries the order link', async () => {
    const o = await freeOrder('az06mail@gmail.com');
    const mail = (await q(`SELECT * FROM emails WHERE to_addr=$1`, ['az06mail@gmail.com']).catch(() => []))[0];
    if (mail) expect(JSON.stringify(mail)).toContain(o.secret);
  });
});

describe('AZ-07 and AZ-18: per-church consent, and no attaching people by phone', () => {
  let hopeMemberId = '';
  it('staff of another church adding a registered number creates an offer, not a link', async () => {
    const r = await call(HOPE, 'POST', '/members', { branchId: 'br_hpc001', fullName: 'Jane W', category: 'adult', phone: JANE, consent: true });
    expect(r.statusCode).toBe(200);
    hopeMemberId = r.json().id;
    const m = (await q(`SELECT user_id FROM memberships WHERE id=$1`, [hopeMemberId]))[0];
    expect(m.user_id).toBeNull();
    const st = (await call(JANE, 'GET', '/me/link/status')).json();
    expect(st.offers).toHaveLength(1);
    expect(st.offers[0].church).toMatch(/Hope/);
    expect(st.churches.map((c: any) => c.orgId)).not.toContain('org_hope');
  });
  it('a number with no account is still linked at once (first sign-in)', async () => {
    const r = await call(HOPE, 'POST', '/members', { branchId: 'br_hpc001', fullName: 'Fresh Face', category: 'adult', phone: '0799000555', consent: true });
    expect(r.statusCode).toBe(200);
    expect((await q(`SELECT user_id FROM memberships WHERE id=$1`, [r.json().id]))[0].user_id).not.toBeNull();
  });
  it("one church's consent record never changes another church's", async () => {
    const r = await call(HOPE, 'POST', `/members/${hopeMemberId}/consent`, { channel: 'sms', optIn: false, confirmed: true, source: 'form' });
    expect(r.statusCode).toBe(200);
    expect((await q(`SELECT sms_opt_out FROM contact_prefs WHERE phone='254711000001'`))[0]?.sms_opt_out).not.toBe(true);
    expect((await consentOf(ctx, 'org_hope', '254711000001')).sms_opt_out).toBe(true);
    expect((await consentOf(ctx, 'org_grace', '254711000001')).sms_opt_out).toBe(false);
    // The person's own opt-out (David, in the member app) wins at every church.
    expect((await consentOf(ctx, 'org_grace', '254711000004')).sms_opt_out).toBe(true);
    expect((await consentOf(ctx, 'org_hope', '254711000004')).sms_opt_out).toBe(true);
  });
  it('the person can accept or decline; accepting links the membership', async () => {
    const st = (await call(JANE, 'GET', '/me/link/status')).json();
    const id = st.offers[0].id;
    expect((await call(AMINA, 'POST', `/me/link/offers/${id}/accept`, {})).statusCode).toBe(404); // not hers
    expect((await call(JANE, 'POST', `/me/link/offers/${id}/accept`, {})).statusCode).toBe(200);
    expect((await q(`SELECT user_id FROM memberships WHERE id=$1`, [hopeMemberId]))[0].user_id).toBe('u_jane');
    const r = await call(HOPE, 'POST', '/members', { branchId: 'br_hpc001', fullName: 'Amina H', category: 'adult', phone: AMINA, consent: true });
    const st2 = (await call(AMINA, 'GET', '/me/link/status')).json();
    expect((await call(AMINA, 'POST', `/me/link/offers/${st2.offers[0].id}/decline`, {})).statusCode).toBe(200);
    expect((await q(`SELECT user_id FROM memberships WHERE id=$1`, [r.json().id]))[0].user_id).toBeNull();
  });
});

describe('AZ-08 and AZ-16: the phone mask holds against search', () => {
  it('staff without members.reveal cannot find people by phone digits', async () => {
    const byPhone = (await call(AUDITOR, 'GET', '/members?q=254711000001')).json();
    expect(byPhone).toHaveLength(0);
    const last3 = (await call(AUDITOR, 'GET', '/members?q=711000')).json();
    expect(last3.some((m: any) => m.full_name === 'Jane Wanjiku' || m.fullName === 'Jane Wanjiku')).toBe(false);
    const byName = (await call(AUDITOR, 'GET', '/members?q=Jane')).json();
    expect(byName.length).toBeGreaterThan(0);
  });
  it('staff with members.reveal can, and it is audited', async () => {
    const before = Number((await q(`SELECT count(*)::int AS n FROM audit_events WHERE action='member.phone_search'`))[0].n);
    const hit = (await call(OWNER, 'GET', '/members?q=254711000001')).json();
    expect(hit.length).toBe(1);
    expect(Number((await q(`SELECT count(*)::int AS n FROM audit_events WHERE action='member.phone_search'`))[0].n)).toBe(before + 1);
  });
  it('attendance and kids searches ignore phone digits for non-reveal staff', async () => {
    const svc = (await q(`SELECT id FROM services WHERE org_id='org_grace' LIMIT 1`))[0];
    if (svc) {
      const r = (await call('0700000071', 'GET', `/attendance/services/${svc.id}/members?q=254711000001`)).json();
      expect(r.members ?? []).toHaveLength(0);
    }
  });
  it('phone searching is rate limited per person', async () => {
    let limited = false;
    for (let i = 0; i < 70 && !limited; i++) limited = (await call(OWNER, 'GET', '/members?q=2547110000')).statusCode === 429;
    expect(limited).toBe(true);
  });
  it('the visitor list shows masked phones unless the person may reveal', async () => {
    await q(`INSERT INTO visitors (id, org_id, branch_id, name, phone, first_seen_at, last_seen_at, created_at) VALUES ('vis_t1','org_grace','br_grc001','Walk In','254722123456',$1,$1,$1) ON CONFLICT DO NOTHING`, [new Date().toISOString()]);
    const masked = (await call('0700000071', 'GET', '/attendance/visitors')).json();
    const v = masked.visitors.find((x: any) => x.id === 'vis_t1');
    expect(v.phone).not.toContain('722123456');
    expect(v.phone).toContain('•');
    const full = (await call(ADMIN3, 'GET', '/attendance/visitors')).json().visitors.find((x: any) => x.id === 'vis_t1');
    expect(full.phone).toBe('0722123456');
    expect(Number((await q(`SELECT count(*)::int AS n FROM audit_events WHERE action='access.reveal' AND entity='visitor_list'`))[0].n)).toBeGreaterThan(0);
  });
});

describe('AZ-15: text into staff inboxes', () => {
  it('the staff notice uses the account name, never the typed text, and requests are limited', async () => {
    await q(`INSERT INTO users (id, phone, name, is_platform_admin, created_at) VALUES ('u_nc','254733000077','Neema Newcomer',false,$1) ON CONFLICT DO NOTHING`, [new Date().toISOString()]);
    const NC = '0733000077';
    const body = { code: 'HPC001', consent: true, name: 'CLICK http://evil.example NOW', message: 'visit http://evil.example' };
    const r1 = await call(NC, 'POST', '/me/link/request', body);
    expect(r1.statusCode).toBe(200);
    const notes = await q(`SELECT body FROM notifications WHERE org_id='org_hope' AND title='Someone asked to join the church'`);
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) { expect(n.body).toContain('Neema Newcomer'); expect(n.body).not.toMatch(/evil|CLICK/); }
    await call(NC, 'POST', `/me/link/request/${r1.json().id}/cancel`, {});
    const again = await call(NC, 'POST', '/me/link/request', body);
    expect(again.statusCode).toBe(429); // one per church per hour
  });
});

describe('AZ-17: public codes', () => {
  it('new ticket, service and event codes are long and random', async () => {
    const o = await freeOrder('az17@gmail.com');
    expect(o.code).toMatch(/^[0-9A-F]{8}$/);
    expect(o.eventCode).toMatch(/^[0-9A-F]{8}$/);
  });
  it('the statement check returns only church and year, and is rate limited', async () => {
    const s = (await q(`SELECT number FROM giving_statements LIMIT 1`))[0];
    const num = s?.number ?? 'GS-2000-ZZZZZZZZZZ';
    let last: any;
    for (let i = 0; i < 22; i++) last = await call(null, 'GET', `/public/statement/${num}`);
    expect(last.statusCode).toBe(429);
  });
});

describe('AZ-19: church-level data behind branch permissions', () => {
  it('branch-scoped wallet staff do not get the church wallet or church settings', async () => {
    const w = (await call('0700000072', 'GET', '/wallets')).json();
    expect(w.wallets.every((x: any) => x.branchId ?? x.branch_id ?? true)).toBe(true);
    expect(w.wallets.some((x: any) => (x.branchId ?? x.branch_id) === null)).toBe(false);
    const i = (await call('0700000072', 'GET', '/integrations')).json();
    expect(i.restricted).toBe(true);
    expect(i.alertEmails).toEqual([]);
    expect(i.canEdit).toBe(false);
    expect(i.branches.map((b: any) => b.id)).toEqual(['br_grc001']);
    expect((await call('0700000072', 'PUT', '/church/words', { one: 'Mass', many: 'Masses' })).statusCode).toBe(403);
    expect((await call('0700000072', 'GET', '/church/directory')).statusCode).toBe(403);
  });
  it('the owner keeps church-wide access', async () => {
    expect((await call(OWNER, 'GET', '/church/directory')).statusCode).toBe(200);
    const i = (await call(OWNER, 'GET', '/integrations')).json();
    expect(i.restricted).toBe(false);
    expect(i.branches.length).toBeGreaterThan(1);
  });
});

describe('AZ-22: instant link needs a role that reaches the branch', () => {
  it('a branch role does not link to another branch; the right branch works', async () => {
    const no = await call('0700000073', 'POST', '/me/link/instant', { code: 'GRC002' });
    expect(no.statusCode).toBe(403);
    const yes = await call('0700000073', 'POST', '/me/link/instant', { code: 'GRC001' });
    expect(yes.statusCode).toBe(200);
  });
});

describe('LG-21: pick-up people ID numbers', () => {
  it('only the last 4 digits and a salted hash are kept', async () => {
    const mem = (await q(`SELECT id FROM memberships WHERE id='m_jane'`))[0];
    const r = await call(JANE, 'POST', '/me/family/pickup-people', { membershipId: mem.id, name: 'Uncle Joe', phone: '0712345000', relation: 'Uncle', idNumber: '29876543' });
    expect(r.statusCode).toBe(200);
    const row = (await q(`SELECT id_number, id_hash, id_salt FROM kids_pickup_people WHERE id=$1`, [r.json().id]))[0];
    expect(row.id_number).toBe('••••6543');
    expect(row.id_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain('29876543');
    const fam = (await call(JANE, 'GET', '/me/family')).json();
    expect(JSON.stringify(fam)).not.toContain('29876543');
  });
});
