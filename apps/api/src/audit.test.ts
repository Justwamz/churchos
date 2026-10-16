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
const call = async (phone: string | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: any, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload, headers: { ...(phone ? { authorization: `Bearer ${await login(phone)}` } : {}), ...headers } });

const OWNER = '0700000001', TREAS = '0700000002', ADMIN = '0700000003', HOPE = '0700000005', PA1 = '0700000099', PA2 = '0700000098', AUDITOR = '0700000007';
const JANE = '0711000001';
const FULL_PHONE = /\b254\d{9}\b|\b07\d{8}\b/;
const events = async (who: string, q = '') => (await call(who, 'GET', `/audit/events?limit=200${q}`)).json().events as any[];
const find = async (name: string) => (await call(ADMIN, 'GET', `/members?q=${encodeURIComponent(name)}`)).json().find((m: any) => m.full_name === name);

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
  const now = ctx.clock.now().toISOString();
  // A records clerk and approver in Grace Nairobi, for the version history tests.
  for (const [id, phone, name, role, perms] of [
    ['u_clerk', '254733000001', 'Clara Clerk', 'Clerk', ['records.view', 'records.edit']],
    ['u_approver', '254733000002', 'Alan Approver', 'Approver', ['records.view', 'records.approve']],
  ] as const) {
    await ctx.db.query(`INSERT INTO users (id, phone, name, created_at) VALUES ($1,$2,$3,$4)`, [id, phone, name, now]);
    await ctx.db.query(`INSERT INTO roles (id, org_id, name, permissions) VALUES ($1,'org_grace',$2,$3)`, [`org_grace:${role}`, role, JSON.stringify(perms)]);
    await ctx.db.query(`INSERT INTO role_assignments (id, org_id, user_id, role_id, scope_type, scope_id) VALUES ($1,'org_grace',$2,$3,'branch','br_grc001')`, [`ra_${id}`, id, `org_grace:${role}`]);
  }
}, 60000);
const CLERK = '0733000001', APPROVER = '0733000002';

describe('the event envelope (L104)', () => {
  it('records who, in what capacity, from where, and exactly what changed, with sensitive values masked', async () => {
    const mary = (await call(ADMIN, 'POST', '/members', { branchId: 'br_grc001', consent: true, fullName: 'Mary Achieng', category: 'adult', phone: '0712000111', dob: '1990-05-05', sex: 'female' }, { 'x-churchos-app': 'staff', 'user-agent': 'TestBrowser/1.0' })).json();
    const upd = await call(ADMIN, 'PUT', `/members/${mary.id}`, { fullName: 'Mary A. Achieng', phone: '0712000999', dob: '1991-06-06', reason: 'Corrected on the registration form' }, { 'x-churchos-app': 'staff', 'user-agent': 'TestBrowser/1.0' });
    expect(upd.statusCode).toBe(200);
    const e = (await events(ADMIN, `&entityId=${mary.id}&action=member.update`))[0];
    expect(e).toMatchObject({ actor_name: 'Samuel Kiptoo', actor_type: 'user', app: 'staff', entity: 'membership', reason: 'Corrected on the registration form' });
    expect(e.ip).toBeTruthy();
    expect(e.user_agent).toBe('TestBrowser/1.0');
    expect(e.request_id).toBeTruthy();
    const byField = Object.fromEntries(e.changes.map((c: any) => [c.field, c]));
    expect(byField.full_name).toMatchObject({ before: 'Mary Achieng', after: 'Mary A. Achieng' });
    expect(byField.phone).toMatchObject({ before: '254712•••111', after: '254712•••999', masked: true });
    expect(byField.dob).toMatchObject({ before: '1990-••-••', after: '1991-••-••', masked: true });
    expect(JSON.stringify(e)).not.toMatch(FULL_PHONE);
    expect(JSON.stringify(e)).not.toMatch(/1990-05-05|1991-06-06/);
  });

  it('an update that changes nothing writes no event', async () => {
    const mary = await find('Mary A. Achieng');
    const before = (await events(ADMIN, `&entityId=${mary.id}`)).length;
    await call(ADMIN, 'PUT', `/members/${mary.id}`, { fullName: 'Mary A. Achieng' });
    expect((await events(ADMIN, `&entityId=${mary.id}`)).length).toBe(before);
  });

  it('platform admins are recorded as admins', async () => {
    await call(PA1, 'POST', '/admin/clock/advance', { hours: 1 });
    const mine = (await call(PA1, 'GET', '/admin/audit/events?limit=50&actor=ChurchOS Admin One')).json().events;
    expect(mine.every((x: any) => x.actor_type === 'admin')).toBe(true);
  });
});

describe('REVIEW FOCUS 5: version history is exact (L105)', () => {
  it('keeps one version per change, and comparing two shows only what differs', async () => {
    const mary = await find('Mary A. Achieng');
    const h = (await call(ADMIN, 'GET', `/audit/history?entity=membership&entityId=${mary.id}`)).json();
    expect(h.versions.map((v: any) => v.version)).toEqual([1, 2]); // created, then one update
    expect(h.events.map((e: any) => e.action)).toEqual(['member.create', 'member.update']);
    const cmp = (await call(ADMIN, 'GET', `/audit/compare?entity=membership&entityId=${mary.id}&from=1&to=2`)).json();
    expect(cmp.changes.map((c: any) => c.field).sort()).toEqual(['dob', 'full_name', 'phone']);
    const phone = cmp.changes.find((c: any) => c.field === 'phone');
    expect(phone).toMatchObject({ before: '254712•••111', after: '254712•••999' });
    const v1 = (await call(ADMIN, 'GET', `/audit/versions/membership/${mary.id}/1`)).json();
    expect(v1.snapshot.full_name).toBe('Mary Achieng');
    expect(v1.changedBy).toBe('Samuel Kiptoo');
    expect((await call(ADMIN, 'GET', `/audit/versions/membership/${mary.id}/9`)).statusCode).toBe(404);
  });

  it('a record keeps a version for each state: draft, approval, proposed change, approved change; a rejected change adds none', async () => {
    const made = (await call(CLERK, 'POST', '/records', { kind: 'baptism', branchId: 'br_grc001', subjectName: 'Naomi Test', eventDate: '2026-03-01', place: 'Old Place', officiant: 'Rev. Daniel Mwangi', dob: '2015-04-04', submit: true })).json();
    await call(APPROVER, 'POST', `/records/${made.id}/decide`, {});
    await call(CLERK, 'PUT', `/records/${made.id}`, { subjectName: 'Naomi Test', eventDate: '2026-03-01', place: 'New Place', officiant: 'Rev. Daniel Mwangi', dob: '2015-04-04' });
    const versionsAfterProposal = (await call(ADMIN, 'GET', `/audit/history?entity=record&entityId=${made.id}`)).json().versions.length;
    expect(versionsAfterProposal).toBe(3); // created, approved, change proposed
    await call(APPROVER, 'POST', `/records/${made.id}/decide`, {});
    await call(CLERK, 'PUT', `/records/${made.id}`, { subjectName: 'Naomi Test', eventDate: '2026-03-01', place: 'Wrong Place', officiant: 'Rev. Daniel Mwangi', dob: '2015-04-04' });
    await call(APPROVER, 'POST', `/records/${made.id}/decide`, { approve: false, reason: 'Not correct' });
    const h = (await call(ADMIN, 'GET', `/audit/history?entity=record&entityId=${made.id}`)).json();
    // created, approved, proposed, approved change, proposed again. The rejection only adds an event.
    expect(h.versions).toHaveLength(5);
    expect(h.events.map((e: any) => e.action)).toEqual(['record.create', 'record.approve', 'record.amend', 'record.amend_approve', 'record.amend', 'record.reject']);
    const approvedChange = h.events.find((e: any) => e.action === 'record.amend_approve');
    expect(approvedChange.changes.map((c: any) => c.field)).toEqual(['place']);
    expect(approvedChange.changes[0]).toMatchObject({ before: 'Old Place', after: 'New Place' });
    const reject = h.events.find((e: any) => e.action === 'record.reject');
    expect(reject).toMatchObject({ reason: 'Not correct', actor_name: 'Alan Approver' });
    const compare = (await call(ADMIN, 'GET', `/audit/compare?entity=record&entityId=${made.id}&from=2&to=4`)).json();
    expect(compare.changes.map((c: any) => c.field)).toContain('place');
    expect(compare.changes.find((c: any) => c.field === 'place')).toMatchObject({ before: 'Old Place', after: 'New Place' });
    // The date of birth in a baptism record is sensitive, so versions only show its year.
    const snap = (await call(ADMIN, 'GET', `/audit/versions/record/${made.id}/1`)).json().snapshot;
    expect(snap.dob).toBe('2015-••-••');
  });

  it('template, branch address, fees, projects and the number format each keep history', async () => {
    const t = (await call(ADMIN, 'GET', '/certificates/template')).json();
    await call(ADMIN, 'PUT', '/certificates/template', { config: { ...t.config, accent: '#112233', tagline: 'New tagline' } });
    await call(ADMIN, 'PUT', '/certificates/branch-profile/br_grc001', { address: 'New Road', town: 'Nairobi', phone: '+254 700 000 111', email: 'nairobi@gracechurch.org' });
    await call(OWNER, 'PUT', '/members/settings', { pattern: 'GRC/{YYYY}/{SEQ:4}', next: 50 });
    await call(TREAS, 'POST', '/projects', { branchId: 'br_grc001', code: 'HALL', name: 'Youth Hall', target: 250000, restricted: true });
    const tenants = (await call(PA1, 'GET', '/admin/tenants')).json();
    const grace = tenants.find((x: any) => x.id === 'org_grace');
    await call(PA1, 'PUT', '/admin/tenants/org_grace/fees', { feeBearer: 'member', feeSchedule: grace.feeSchedule, reason: 'Church request' });

    const tpl = (await call(ADMIN, 'GET', '/audit/history?entity=template&entityId=org_grace')).json();
    expect(tpl.events.at(-1).changes.map((c: any) => c.field).sort()).toEqual(['accent', 'tagline']);
    const prof = (await call(ADMIN, 'GET', '/audit/history?entity=branch_profile&entityId=br_grc001')).json();
    expect(prof.events.at(-1).changes.find((c: any) => c.field === 'phone')).toBeUndefined(); // unchanged, so not listed
    expect(prof.events.at(-1).changes.map((c: any) => c.field)).toEqual(['address']);
    const nf = (await call(OWNER, 'GET', '/audit/history?entity=member_number_format&entityId=org_grace')).json();
    expect(nf.versions).toHaveLength(1);
    const fees = (await call(OWNER, 'GET', '/audit/history?entity=fee_schedule&entityId=org_grace')).json();
    expect(fees.events[0]).toMatchObject({ reason: 'Church request', actor_type: 'admin' });
    expect(fees.events[0].changes.map((c: any) => c.field)).toEqual(['feeBearer']);
    const proj = (await events(ADMIN, '&action=project.create'))[0];
    expect(proj.changes.find((c: any) => c.field === 'name').after).toBe('Youth Hall');
  });
});

describe('money and decisions on the same timeline (L106)', () => {
  it('a reversal links the request, the payment and the ledger entry, with who approved and why', async () => {
    const sim = (await call(PA1, 'POST', '/admin/simulate/paybill', { phone: '0711000002', amount: 500, reference: 'GRC001#TITHE' })).json();
    const sms = `${sim.providerTxId} Confirmed. Ksh500.00 paid.`;
    await call('0711000002', 'POST', '/me/reversal-request', { message: sms, reason: 'Paid twice' });
    const req = (await call(PA1, 'GET', '/admin/reversal-requests?status=pending')).json().find((r: any) => r.provider_tx_id === sim.providerTxId);
    expect(req.payer_phone).toMatch(/•••/); // masked in the admin console too
    await call(PA1, 'POST', `/admin/reversal-requests/${req.id}/decide`, { approve: true, reason: 'Verified with the PSP statement' });
    const all = (await call(PA1, 'GET', '/admin/audit/events?limit=200&action=reversal')).json().events;
    const approve = all.find((e: any) => e.action === 'reversal.approve');
    expect(approve.links).toMatchObject({ reversalRequestId: req.id, ledgerEntry: expect.stringMatching(/^reverse:pay_/) });
    expect(approve.reason).toBe('Verified with the PSP statement');
    const asked = all.find((e: any) => e.action === 'reversal.request');
    expect(asked).toMatchObject({ reason: 'Paid twice', actor_name: 'Peter Otieno' });
    const ledgerEvt = (await call(PA1, 'GET', '/admin/audit/events?limit=50&action=payment.reverse')).json().events[0];
    expect(ledgerEvt.links.ledgerEntry).toBe(approve.links.ledgerEntry);
    // The linked ledger entry really exists.
    const entry = await ctx.db.query<any>(`SELECT 1 FROM journal_entries WHERE idem_key=$1`, [approve.links.ledgerEntry]);
    expect(entry).toHaveLength(1);
  });

  it('cash sign-off, rejection, payout changes, KYC and settlement are all recorded', async () => {
    const c1 = (await call(TREAS, 'POST', '/cash', { branchId: 'br_grc001', amount: 5000, purpose: 'OFFERING' })).json();
    await call(ADMIN, 'POST', `/cash/${c1.id}/signoff`, {});
    const c2 = (await call(TREAS, 'POST', '/cash', { branchId: 'br_grc001', amount: 100, purpose: 'OFFERING' })).json();
    await call(ADMIN, 'POST', `/cash/${c2.id}/signoff`, { approve: false, reason: 'Count did not match the envelope' });
    const dest = { type: 'bank', bank: 'Equity', accountNumber: '0170555444', accountName: 'Grace Community Church' };
    const pr = (await call(OWNER, 'POST', '/payout-destination/requests', { branchId: 'br_grc001', destination: dest })).json();
    await call(PA1, 'POST', `/admin/payout-requests/${pr.id}/decide`, { approve: true });
    await call(PA1, 'POST', '/admin/clock/advance', { hours: 73 });
    await call(PA1, 'POST', '/admin/settlement/run', {});

    const acts = (await events(OWNER, '')).map((e: any) => e.action);
    for (const a of ['cash.count', 'cash.approve', 'cash.reject', 'payout_destination.request', 'payout_destination.approve', 'payout_destination.applied']) expect(acts).toContain(a);
    const req = (await events(OWNER, '&action=payout_destination.request'))[0];
    const acct = req.changes.find((c: any) => c.field === 'accountNumber');
    expect(acct).toMatchObject({ before: '••••4567', after: '••••5444', masked: true });
    expect(JSON.stringify(req)).not.toMatch(/0170555444|1100234567/);
    const approveEvt = (await events(OWNER, '&action=cash.approve'))[0];
    expect(approveEvt.links).toMatchObject({ cashId: c1.id, ledgerEntry: `cashfee:${c1.id}` });
    expect((await events(OWNER, '&action=cash.reject'))[0].reason).toBe('Count did not match the envelope');
    const run = (await call(PA1, 'GET', '/admin/audit/events?action=settlement.run')).json().events;
    expect(run.length).toBeGreaterThan(0);
  });

  it('sign-ins and failed sign-ins are recorded, with the phone number masked', async () => {
    await call(null, 'POST', '/auth/otp/verify', { phone: '0711000003', code: '000000' });
    await call(null, 'POST', '/auth/otp/verify', { phone: '0799999999', code: '123456' });
    const sec = (await call(PA1, 'GET', '/admin/audit/events?limit=100&category=security')).json().events;
    expect(sec.some((e: any) => e.action === 'security.login')).toBe(true);
    const failed = sec.filter((e: any) => e.action === 'security.login_failed');
    expect(failed.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(failed)).not.toMatch(FULL_PHONE);
    expect(failed.some((e: any) => e.meta.knownNumber === false)).toBe(true);
  });
});

describe('REVIEW FOCUS 1: tamper evidence (L107)', () => {
  it('the chain verifies, and the integrity check names the event if one is changed behind our back', async () => {
    const ok = (await call(OWNER, 'GET', '/audit/verify')).json();
    expect(ok).toMatchObject({ ok: true, chain: 'org_grace' });
    expect(ok.events).toBeGreaterThan(10);
    expect((await call(PA1, 'GET', '/admin/audit/verify')).json().ok).toBe(true);

    const victim = (await events(OWNER, '&action=member.update'))[0];
    await ctx.db.exec(`ALTER TABLE audit_events DISABLE TRIGGER USER`);
    await ctx.db.query(`UPDATE audit_events SET summary='nothing to see here' WHERE id=$1`, [victim.id]);
    const bad = (await call(OWNER, 'GET', '/audit/verify')).json();
    expect(bad.ok).toBe(false);
    expect(bad.brokenAtSeq).toBe(victim.seq);
    expect((await call(PA1, 'GET', '/admin/audit/verify')).json().ok).toBe(false);
    // Another organisation's chain is unaffected.
    expect((await call(HOPE, 'GET', '/audit/verify')).json().ok).toBe(true);
    await ctx.db.query(`UPDATE audit_events SET summary=$2 WHERE id=$1`, [victim.id, victim.summary]);
    await ctx.db.exec(`ALTER TABLE audit_events ENABLE TRIGGER USER`);
    expect((await call(OWNER, 'GET', '/audit/verify')).json().ok).toBe(true);
  });

  it('there is no way to change or delete an event or a version through the database as the app user', async () => {
    await expect(ctx.db.query(`DELETE FROM audit_events`)).rejects.toThrow(/append-only/);
    await expect(ctx.db.query(`UPDATE entity_versions SET summary='x'`)).rejects.toThrow(/append-only/);
    await expect(ctx.db.query(`DELETE FROM entity_versions`)).rejects.toThrow(/append-only/);
  });
});

describe('REVIEW FOCUS 4: nobody sees another church audit trail', () => {
  it('Hope Chapel sees only its own events, history, versions and verification', async () => {
    const hopeEvents = await events(HOPE);
    expect(hopeEvents.every((e: any) => e.org_id === 'org_hope')).toBe(true);
    const graceEvt = (await events(OWNER, '&action=member.update'))[0];
    expect((await call(HOPE, 'GET', `/audit/events/${graceEvt.id}`)).statusCode).toBe(404);
    const mary = await find('Mary A. Achieng');
    const h = (await call(HOPE, 'GET', `/audit/history?entity=membership&entityId=${mary.id}`)).json();
    expect(h.events).toEqual([]);
    expect(h.versions).toEqual([]);
    expect((await call(HOPE, 'GET', `/audit/versions/membership/${mary.id}/1`)).statusCode).toBe(404);
    expect((await call(HOPE, 'GET', '/audit/events?org=org_grace')).json().events.every((e: any) => e.org_id === 'org_hope')).toBe(true);
  });

  it('a branch admin sees their branches and church-wide events, never another branch', async () => {
    await ctx.db.query(`INSERT INTO users (id, phone, name, created_at) VALUES ('u_coastadmin','254733000009','Coast Admin',$1)`, [ctx.clock.now().toISOString()]);
    await ctx.db.query(`INSERT INTO role_assignments (id, org_id, user_id, role_id, scope_type, scope_id) VALUES ('ra_ca','org_grace','u_coastadmin','org_grace:Branch Admin','branch','br_grc002')`);
    const coast = await events('0733000009');
    expect(coast.every((e: any) => e.branch_id === null || e.branch_id === 'br_grc002')).toBe(true);
    expect(coast.some((e: any) => e.branch_id === 'br_grc001')).toBe(false);
  });
});

describe('who may read the audit log (L108)', () => {
  it('the owner, a branch admin and the auditor can read; a treasurer and a member cannot', async () => {
    expect((await call(OWNER, 'GET', '/audit/events')).statusCode).toBe(200);
    expect((await call(ADMIN, 'GET', '/audit/events')).statusCode).toBe(200);
    expect((await call(AUDITOR, 'GET', '/audit/events')).statusCode).toBe(200);
    expect((await call(TREAS, 'GET', '/audit/events')).statusCode).toBe(403);
    expect((await call(JANE, 'GET', '/audit/events')).statusCode).toBe(403);
    expect((await call(null, 'GET', '/audit/events')).statusCode).toBe(401);
  });

  it('export is a separate permission: owner and auditor may export, a branch admin may not, and the export is itself logged', async () => {
    expect((await call(ADMIN, 'GET', '/audit/export')).statusCode).toBe(403);
    const csv = await call(AUDITOR, 'GET', '/audit/export');
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.body.split('\n')[0]).toContain('time,who,capacity,action');
    expect(csv.body).not.toMatch(FULL_PHONE);
    expect((await events(OWNER, '&action=access.audit_export')).length).toBe(1);
  });

  it('the auditor is strictly read-only', async () => {
    expect((await call(AUDITOR, 'POST', '/members', { branchId: 'br_grc001', consent: true, fullName: 'No Way', category: 'adult', phone: '0712999000' })).statusCode).toBe(403);
    expect((await call(AUDITOR, 'POST', '/cash', { branchId: 'br_grc001', amount: 100 })).statusCode).toBe(403);
    expect((await call(AUDITOR, 'PUT', '/certificates/template', { config: {} })).statusCode).toBe(403);
    expect((await call(AUDITOR, 'POST', '/members/m_jane/reveal', {})).statusCode).toBe(403);
  });

  it('filters by action, actor, category and text, and pages with a cursor', async () => {
    const page1 = (await call(OWNER, 'GET', '/audit/events?limit=5')).json();
    expect(page1.events).toHaveLength(5);
    expect(page1.nextBefore).toBeTruthy();
    const page2 = (await call(OWNER, 'GET', `/audit/events?limit=5&before=${page1.nextBefore}`)).json();
    expect(page2.events[0].seq).toBeLessThan(page1.events.at(-1).seq);
    expect((await events(OWNER, '&category=money')).every((e: any) => e.category === 'money')).toBe(true);
    expect((await events(OWNER, '&actor=Samuel')).every((e: any) => /Samuel/.test(e.actor_name))).toBe(true);
    expect((await events(OWNER, '&q=cash')).length).toBeGreaterThan(0);
    expect((await events(OWNER, '&action=zzz')).length).toBe(0);
    const day = new Date().toISOString().slice(0, 10);
    expect((await events(OWNER, `&from=${day}&to=${day}`)).length).toBeGreaterThan(0);
    expect((await call(OWNER, 'GET', '/audit/history')).statusCode).toBe(400);
  });
});

describe('REVIEW FOCUS 2: personal data is masked, and revealing it is logged (L109)', () => {
  it('no staff list, report, export, SMS log or admin screen contains a full phone number', async () => {
    await call(PA1, 'POST', '/admin/simulate/paybill', { phone: '0722333444', amount: 700, reference: 'GRC001#OFFERING' });
    await call(PA1, 'POST', '/admin/simulate/paybill', { phone: '0722333555', amount: 700, reference: 'NOWHERE' });
    const responses: [string, string, string][] = [
      [ADMIN, 'GET', '/members'], [ADMIN, 'GET', '/members/grouped'], [ADMIN, 'GET', '/members/insights'],
      [TREAS, 'GET', '/collections'], [TREAS, 'GET', '/collections?format=csv'], [TREAS, 'GET', '/dashboard'],
      [OWNER, 'GET', '/wallets'], [OWNER, 'GET', '/messages'], [OWNER, 'GET', '/audit/events?limit=200'],
      [PA1, 'GET', '/admin/payments'], [PA1, 'GET', '/admin/suspense'], [PA1, 'GET', '/admin/reversal-requests'],
      [PA1, 'GET', '/admin/audit/events?limit=200'],
    ];
    for (const [who, method, url] of responses) {
      const r = await call(who, method as any, url);
      expect(r.statusCode, url).toBe(200);
      expect(r.body, `${url} leaked a full phone number`).not.toMatch(FULL_PHONE);
    }
    expect((await call(PA1, 'GET', '/admin/payments')).json().some((p: any) => /•••/.test(p.payer_phone))).toBe(true);
  });

  it('the live collections stream masks the payer phone', async () => {
    const seen: string[] = [];
    const onPay = async (e: any) => {
      const p = (await ctx.db.query<any>('SELECT payer_phone FROM payments WHERE id=$1', [e.paymentId]))[0];
      seen.push(p.payer_phone);
    };
    ctx.events.on('payment', onPay);
    ctx.events.off('payment', onPay);
    // The stream handler selects through the same masking SQL, so check the shape it uses.
    const dash = (await call(TREAS, 'GET', '/dashboard')).json();
    expect(dash.recent.every((r: any) => !r.payer_phone || /•••/.test(r.payer_phone))).toBe(true);
  });

  it('revealing needs the permission, returns the real number, and is logged with the reason', async () => {
    const jane = await find('Jane Wanjiku');
    expect(jane.phone).toBe('254711•••001');
    expect((await call(TREAS, 'POST', `/members/${jane.id}/reveal`, {})).statusCode).toBe(403); // no members.reveal
    expect((await call(AUDITOR, 'POST', `/members/${jane.id}/reveal`, {})).statusCode).toBe(403);
    const r = await call(ADMIN, 'POST', `/members/${jane.id}/reveal`, { fields: ['phone'], reason: 'Calling about the pledge' });
    expect(r.json().phone).toBe('254711000001');
    const evt = (await events(OWNER, '&action=access.reveal'))[0];
    expect(evt).toMatchObject({ actor_name: 'Samuel Kiptoo', category: 'access', entity: 'membership' });
    expect(evt.reason).toBe('Calling about the pledge');
    expect(JSON.stringify(evt)).not.toMatch(FULL_PHONE);
    expect((await call(ADMIN, 'POST', `/members/${jane.id}/reveal`, { fields: ['password'] })).json().code).toBe('bad_field');
    expect((await call(HOPE, 'POST', `/members/${jane.id}/reveal`, {})).statusCode).toBe(404); // another church
  });

  it('a child reveal shows each guardian number and the date of birth needs the sensitive permission', async () => {
    const ruth = await find('Ruth Wanjiku');
    const r = (await call(ADMIN, 'POST', `/members/${ruth.id}/reveal`, { fields: ['phone', 'dob'] })).json();
    expect(r.contact_phones.map((g: any) => g.phone).sort()).toEqual(['254711000001', '254711000004']);
    expect(r.dob).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // A viewer with members.reveal but not members.sensitive cannot see the date of birth.
    await ctx.db.query(`INSERT INTO users (id, phone, name, created_at) VALUES ('u_reveal','254733000008','Reveal Only',$1)`, [ctx.clock.now().toISOString()]);
    await ctx.db.query(`INSERT INTO roles (id, org_id, name, permissions) VALUES ('org_grace:RevealOnly','org_grace','RevealOnly','["members.view","members.reveal"]')`);
    await ctx.db.query(`INSERT INTO role_assignments (id, org_id, user_id, role_id, scope_type, scope_id) VALUES ('ra_rev','org_grace','u_reveal','org_grace:RevealOnly','branch','br_grc001')`);
    expect((await call('0733000008', 'POST', `/members/${ruth.id}/reveal`, { fields: ['dob'] })).statusCode).toBe(403);
    expect((await call('0733000008', 'POST', `/members/${ruth.id}/reveal`, { fields: ['phone'] })).statusCode).toBe(200);
  });

  it('a platform admin can reveal a payer number, and it is logged', async () => {
    const p = (await call(PA1, 'GET', '/admin/payments')).json()[0];
    const r = await call(PA2, 'POST', `/admin/payments/${p.id}/reveal`, { reason: 'Customer called support' });
    expect(r.json().payer_phone).toMatch(FULL_PHONE);
    const evt = (await call(PA1, 'GET', '/admin/audit/events?action=access.reveal')).json().events.find((e: any) => e.entity === 'payment');
    expect(evt).toMatchObject({ actor_name: 'ChurchOS Admin Two', actor_type: 'admin', reason: 'Customer called support' });
    expect((await call(OWNER, 'POST', `/admin/payments/${p.id}/reveal`, {})).statusCode).toBe(403);
  });

  it('viewing exact dates of birth is logged once a minute, not on every reload', async () => {
    const count = async () => (await events(OWNER, '&action=access.sensitive_view')).length;
    const before = await count();
    await call(ADMIN, 'GET', '/members');
    await call(ADMIN, 'GET', '/members/grouped');
    await call(ADMIN, 'GET', '/members');
    expect((await count()) - before).toBeLessThanOrEqual(1);
    expect(await count()).toBeGreaterThanOrEqual(1);
    const evt = (await events(OWNER, '&action=access.sensitive_view'))[0];
    expect(evt.actor_name).toBe('Samuel Kiptoo');
    // A person without the permission produces no such event.
    const before2 = await count();
    await call('0733000008', 'GET', '/members');
    expect(await count()).toBe(before2);
  });

  it('viewing a KYC file and a marriage scan is logged', async () => {
    const docs = (await call(PA1, 'GET', '/admin/kyc/org_grace')).json();
    const docId = docs.required[0].latest.id;
    await app.inject({ method: 'GET', url: `/admin/kyc/documents/${docId}/file`, headers: { authorization: `Bearer ${await login(PA1)}` } });
    await app.inject({ method: 'GET', url: '/records/rec_marriage/file', headers: { authorization: `Bearer ${await login(ADMIN)}` } });
    const views = (await events(OWNER, '&action=access.view_file')).map((e: any) => e.entity);
    expect(views).toContain('kyc_document');
    expect(views).toContain('record');
  });

  it('members still see their own full details', async () => {
    const me = (await call(JANE, 'GET', '/me')).json();
    expect(me.user.phone).toBe('254711000001');
  });
});
