import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEGAL_VERSION, OPERATOR } from '@churchos/shared';
import { buildApp } from './server';
import { seed } from './seed';
import { dpaRequiredForBulk } from './legal';
import { dbScope } from '@churchos/ledger';

/**
 * Slice 42: legal documents and consent. Acceptances (Terms and Privacy Notice, the church's Data Processing Agreement, a guardian's
 * agreement for a child), the current-version rule, the launch switch ENFORCE_LEGAL_ACCEPTANCE, the export, erasure, row-level security,
 * the audit event, the DPA rule for bulk messages and the version stored with a gift.
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
  app.inject({ method, url, payload, headers: phone ? { authorization: `Bearer ${await login(phone)}`, 'user-agent': 'vitest-browser/1.0' } : {} });
const q = (sql: string, p: unknown[] = []) => ctx.db.query<any>(sql, p);
const OWNER = '0700000001', BRANCH_ADMIN = '0700000003', HOPE = '0700000005', JANE = '0711000001', PETER = '0711000002', AMINA = '0711000003';
const ERIN = '0722421001';
const uidOf = async (phone: string) => (await q(`SELECT id FROM users WHERE phone=$1`, [`254${phone.slice(1)}`]))[0]?.id as string;
const accept = (phone: string, body: any = {}) => call(phone, 'POST', '/legal/accept', { doc: 'terms_privacy', version: LEGAL_VERSION, app: 'member', ...body });
const saved = { enforce: process.env.ENFORCE_LEGAL_ACCEPTANCE, dpa: process.env.ENFORCE_DPA_BULK };

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);
afterAll(() => {
  if (saved.enforce === undefined) delete process.env.ENFORCE_LEGAL_ACCEPTANCE; else process.env.ENFORCE_LEGAL_ACCEPTANCE = saved.enforce;
  if (saved.dpa === undefined) delete process.env.ENFORCE_DPA_BULK; else process.env.ENFORCE_DPA_BULK = saved.dpa;
});

describe('public legal details', () => {
  it('GET /public/legal needs no sign-in and returns the version and the operator', async () => {
    const r = await call(null, 'GET', '/public/legal');
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.version).toBe(LEGAL_VERSION);
    expect(b.operator).toEqual({ name: OPERATOR.name, email: OPERATOR.email, address: OPERATOR.address, postalAddress: OPERATOR.postalAddress, odpcStatus: OPERATOR.odpcStatus, odpcNumber: OPERATOR.odpcNumber });
    expect(b.documents).toContain('dpa');
  });
});

describe('POST /legal/accept', () => {
  it('needs a sign-in', async () => {
    expect((await call(null, 'POST', '/legal/accept', { doc: 'terms_privacy', version: LEGAL_VERSION })).statusCode).toBe(401);
    expect((await call(null, 'GET', '/legal/status')).statusCode).toBe(401);
  });

  it('shows what is required and accepts the current version once (idempotent)', async () => {
    const before = (await call(JANE, 'GET', '/legal/status')).json();
    expect(before.version).toBe(LEGAL_VERSION);
    expect(before.required[0]).toMatchObject({ doc: 'terms_privacy', accepted: false });
    expect(before.operator.name).toBe(OPERATOR.name);
    const first = await accept(JANE);
    expect(first.statusCode, JSON.stringify(first.json())).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, alreadyAccepted: false });
    const again = await accept(JANE);
    expect(again.json()).toMatchObject({ ok: true, alreadyAccepted: true });
    expect((await q(`SELECT count(*)::int AS n FROM legal_acceptances WHERE user_id='u_jane' AND doc='terms_privacy'`))[0].n).toBe(1);
    const after = (await call(JANE, 'GET', '/legal/status')).json();
    expect(after.required[0]).toMatchObject({ accepted: true });
    expect(after.required[0].acceptedAt).toBeTruthy();
  });

  it('refuses an old, missing or invented version and an unknown document', async () => {
    const old = await accept(PETER, { version: '2020-01-01' });
    expect(old.statusCode).toBe(409);
    expect(old.json().code).toBe('legal_version_mismatch');
    expect((await accept(PETER, { version: undefined })).json().code).toBe('legal_version_mismatch');
    expect((await accept(PETER, { doc: 'nonsense' })).json().code).toBe('bad_doc');
    expect((await q(`SELECT count(*)::int AS n FROM legal_acceptances WHERE user_id='u_peter'`))[0].n).toBe(0);
  });

  it('stores a keyed hash of the address and a short browser description, never the raw address', async () => {
    const r = (await q(`SELECT ip_hash, user_agent, app FROM legal_acceptances WHERE user_id='u_jane'`))[0];
    expect(r.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.ip_hash).not.toContain('127.0.0.1');
    expect(r.user_agent).toBe('vitest-browser/1.0');
    expect(r.app).toBe('member');
  });

  it('writes the audit event legal.accepted once', async () => {
    const e = await q(`SELECT actor_id, summary, meta FROM audit_events WHERE action='legal.accepted' AND actor_id='u_jane'`);
    expect(e.length).toBe(1);
    expect(e[0].summary).toContain(LEGAL_VERSION);
  });
});

describe('the launch switch ENFORCE_LEGAL_ACCEPTANCE', () => {
  it('is off by default: nothing is blocked', async () => {
    delete process.env.ENFORCE_LEGAL_ACCEPTANCE;
    expect((await call(PETER, 'GET', '/me/giving')).statusCode).toBe(200);
  });

  it('when on, answers 403 legal_acceptance_required until accepted, except for sign-in, legal, basic profile, export and erasure', async () => {
    process.env.ENFORCE_LEGAL_ACCEPTANCE = '1';
    try {
      const blocked = await call(PETER, 'GET', '/me/giving');
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().code).toBe('legal_acceptance_required');
      expect((await call(PETER, 'GET', '/me')).statusCode).toBe(200);
      expect((await call(PETER, 'GET', '/legal/status')).statusCode).toBe(200);
      expect((await call(PETER, 'GET', '/me/export')).statusCode).toBe(200);
      expect((await call(PETER, 'GET', '/me/erasure-preview')).statusCode).toBe(200);
      expect((await call(PETER, 'GET', '/auth/sessions')).statusCode).toBe(200);
      expect((await call(PETER, 'GET', '/messages')).json().code).toBe('legal_acceptance_required');
      // A person who accepted is not blocked, and neither is the admin once they accept.
      expect((await call(JANE, 'GET', '/me/giving')).statusCode).toBe(200);
      expect((await accept(PETER)).statusCode).toBe(200);
      expect((await call(PETER, 'GET', '/me/giving')).statusCode).toBe(200);
    } finally { delete process.env.ENFORCE_LEGAL_ACCEPTANCE; }
  });

  it('an old acceptance does not count once the version changes', async () => {
    process.env.ENFORCE_LEGAL_ACCEPTANCE = '1';
    try {
      await q(`UPDATE legal_acceptances SET version='2020-01-01' WHERE user_id='u_peter'`);
      expect((await call(PETER, 'GET', '/me/giving')).json().code).toBe('legal_acceptance_required');
      expect((await call(PETER, 'GET', '/legal/status')).json().required[0].accepted).toBe(false);
      await q(`UPDATE legal_acceptances SET version=$1 WHERE user_id='u_peter'`, [LEGAL_VERSION]);
      expect((await call(PETER, 'GET', '/me/giving')).statusCode).toBe(200);
    } finally { delete process.env.ENFORCE_LEGAL_ACCEPTANCE; }
  });
});

describe('the Data Processing Agreement and bulk messages', () => {
  const bulk = (phone = OWNER) => call(phone, 'POST', '/messages', { audience: { scope: { type: 'org' }, who: 'all' }, channels: ['inapp'], title: 'Everyone', body: 'Hello {name}, all welcome.' });

  it('defaults: off for tests and demos, on for a real launch (production with demo data off)', () => {
    expect(dpaRequiredForBulk({} as any)).toBe(false);
    expect(dpaRequiredForBulk({ NODE_ENV: 'production', SEED_DEMO: '1' } as any)).toBe(false);
    expect(dpaRequiredForBulk({ NODE_ENV: 'production', SEED_DEMO: '0' } as any)).toBe(true);
    expect(dpaRequiredForBulk({ ENFORCE_DPA_BULK: '1' } as any)).toBe(true);
    expect(dpaRequiredForBulk({ NODE_ENV: 'production', SEED_DEMO: '0', ENFORCE_DPA_BULK: '0' } as any)).toBe(false);
  });

  it('the owner sees the agreement as outstanding, other staff do not', async () => {
    const st = (await call(OWNER, 'GET', '/legal/status')).json();
    expect(st.required.find((r: any) => r.doc === 'dpa')).toMatchObject({ orgId: 'org_grace', accepted: false });
    expect((await call(BRANCH_ADMIN, 'GET', '/legal/status')).json().required.some((r: any) => r.doc === 'dpa')).toBe(false);
  });

  it('refuses a bulk message with a friendly error until the owner accepts, then sends', async () => {
    process.env.ENFORCE_DPA_BULK = '1';
    try {
      const r = await bulk();
      expect(r.statusCode).toBe(409);
      expect(r.json().code).toBe('dpa_required');
      expect(r.json().error).toContain('Organisation Owner');
      // Only the owner of that church can accept it.
      expect((await call(BRANCH_ADMIN, 'POST', '/legal/accept', { doc: 'dpa', version: LEGAL_VERSION, orgId: 'org_grace' })).statusCode).toBe(403);
      expect((await call(OWNER, 'POST', '/legal/accept', { doc: 'dpa', version: LEGAL_VERSION, orgId: 'org_hope' })).statusCode).toBe(403);
      expect((await call(OWNER, 'POST', '/legal/accept', { doc: 'dpa', version: LEGAL_VERSION })).statusCode).toBe(403);
      const ok = await call(OWNER, 'POST', '/legal/accept', { doc: 'dpa', version: LEGAL_VERSION, orgId: 'org_grace', app: 'staff' });
      expect(ok.statusCode, JSON.stringify(ok.json())).toBe(200);
      expect((await call(OWNER, 'POST', '/legal/accept', { doc: 'dpa', version: LEGAL_VERSION, orgId: 'org_grace', app: 'staff' })).json().alreadyAccepted).toBe(true);
      const sent = await bulk();
      expect(sent.statusCode, JSON.stringify(sent.json())).toBe(200);
      // Another church is still refused.
      const hope = await call(HOPE, 'POST', '/messages', { audience: { scope: { type: 'org' }, who: 'all' }, channels: ['inapp'], title: 'Hi', body: 'Hello {name}' });
      expect(hope.json().code).toBe('dpa_required');
    } finally { delete process.env.ENFORCE_DPA_BULK; }
    const row = (await q(`SELECT org_id, doc, app FROM legal_acceptances WHERE user_id='u_owner' AND doc='dpa'`))[0];
    expect(row).toMatchObject({ org_id: 'org_grace', doc: 'dpa', app: 'staff' });
  });
});

describe("a guardian's agreement for a child", () => {
  it('is recorded with who ticked, when and the version, and a stale version is refused', async () => {
    const mary = (await q(`SELECT id FROM memberships WHERE org_id='org_grace' AND category='adult' AND phone IS NOT NULL AND status='active' ORDER BY id LIMIT 1`))[0];
    const base = { branchId: 'br_grc001', fullName: 'Little Legal', category: 'child', dob: '2018-03-03', guardianIds: [mary.id], consent: true };
    const stale = await call(OWNER, 'POST', '/members', { ...base, guardianNoticeVersion: '2020-01-01' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('legal_version_mismatch');
    const r = await call(OWNER, 'POST', '/members', { ...base, guardianNoticeVersion: LEGAL_VERSION });
    expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
    const kid = r.json().id;
    const m = (await q(`SELECT consent_by, consent_at, consent_notice_version FROM memberships WHERE id=$1`, [kid]))[0];
    expect(m).toMatchObject({ consent_by: 'u_owner', consent_notice_version: LEGAL_VERSION });
    expect(m.consent_at).toBeTruthy();
    const a = (await q(`SELECT user_id, org_id, doc, version, subject_id FROM legal_acceptances WHERE doc='kids_guardian'`))[0];
    expect(a).toMatchObject({ user_id: 'u_owner', org_id: 'org_grace', doc: 'kids_guardian', version: LEGAL_VERSION, subject_id: kid });
    // Two children registered by the same worker are two records.
    const r2 = await call(OWNER, 'POST', '/members', { ...base, fullName: 'Little Legal Two', guardianNoticeVersion: LEGAL_VERSION });
    expect(r2.statusCode).toBe(200);
    expect((await q(`SELECT count(*)::int AS n FROM legal_acceptances WHERE doc='kids_guardian'`))[0].n).toBe(2);
  });

  it('an older client that sends no version still registers the child as before', async () => {
    const mary = (await q(`SELECT id FROM memberships WHERE org_id='org_grace' AND category='adult' AND phone IS NOT NULL AND status='active' ORDER BY id LIMIT 1`))[0];
    const r = await call(OWNER, 'POST', '/members', { branchId: 'br_grc001', fullName: 'Little Plain', category: 'child', dob: '2017-05-05', guardianIds: [mary.id], consent: true });
    expect(r.statusCode).toBe(200);
    expect((await q(`SELECT consent_notice_version FROM memberships WHERE id=$1`, [r.json().id]))[0].consent_notice_version).toBeNull();
  });
});

describe('a gift records the version the payer was shown', () => {
  it('stores legalVersion with the payment intent', async () => {
    const r = await call(null, 'POST', '/public/give', { code: 'GRC001', purpose: 'OFFERING', phone: '0712345611', amount: 500, method: 'mpesa', legalVersion: LEGAL_VERSION });
    expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
    const i = (await q(`SELECT legal_version, legal_accepted_at FROM give_intents WHERE id=$1`, [r.json().intentId]))[0];
    expect(i.legal_version).toBe(LEGAL_VERSION);
    expect(i.legal_accepted_at).toBeTruthy();
  });

  it('stores nothing when the client sends nothing or garbage', async () => {
    const a = await call(null, 'POST', '/public/give', { code: 'GRC001', purpose: 'OFFERING', phone: '0712345612', amount: 500, method: 'mpesa' });
    const b = await call(null, 'POST', '/public/give', { code: 'GRC001', purpose: 'OFFERING', phone: '0712345613', amount: 500, method: 'mpesa', legalVersion: "x'; drop table" });
    for (const r of [a, b]) {
      expect(r.statusCode).toBe(200);
      expect((await q(`SELECT legal_version FROM give_intents WHERE id=$1`, [r.json().intentId]))[0].legal_version).toBeNull();
    }
  });
});

describe('export, erasure and retention', () => {
  it("'Download my data' includes the person's acceptances, and nobody else's", async () => {
    const d = (await call(JANE, 'GET', '/me/export')).json();
    expect(d.legalAcceptances.length).toBe(1);
    expect(d.legalAcceptances[0]).toMatchObject({ document: 'terms_privacy', version: LEGAL_VERSION, app: 'member' });
    expect(JSON.stringify(d.legalAcceptances)).not.toContain('ip_hash');
    const o = (await call(OWNER, 'GET', '/me/export')).json();
    expect(o.legalAcceptances.some((a: any) => a.document === 'dpa' && a.church)).toBe(true);
    expect(o.legalAcceptances.some((a: any) => a.document === 'kids_guardian')).toBe(true);
    expect(JSON.stringify(d)).not.toContain('Little Legal');
  });

  it('the erasure preview lists the acceptance record as kept', async () => {
    const p = (await call(JANE, 'GET', '/me/erasure-preview')).json();
    expect(JSON.stringify(p.kept)).toContain('accepted our Terms of Use');
  });

  it('acceptances survive an erasure and point at the anonymised account', async () => {
    const add = await call(OWNER, 'POST', '/members', { branchId: 'br_grc001', fullName: 'Erin Legal', category: 'adult', phone: ERIN, consent: true });
    expect(add.statusCode, JSON.stringify(add.json())).toBe(200);
    expect((await accept(ERIN)).statusCode).toBe(200);
    const uid = await uidOf(ERIN);
    const req = await call(ERIN, 'POST', '/me/erasure-request', { confirm: true });
    expect(req.statusCode, JSON.stringify(req.json())).toBe(200);
    const done = await call(OWNER, 'POST', `/erasure-requests/${req.json().id}/decide`, { decision: 'approve' });
    expect(done.statusCode, JSON.stringify(done.json())).toBe(200);
    expect((await q(`SELECT name FROM users WHERE id=$1`, [uid]))[0].name).toBe('Former member');
    const rows = await q(`SELECT user_id, doc, version, ip_hash FROM legal_acceptances WHERE user_id=$1`, [uid]);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ doc: 'terms_privacy', version: LEGAL_VERSION });
    expect(rows[0].ip_hash).toBeTruthy();
  });

  it('no retention job deletes acceptances', async () => {
    const { runRetentionJobs, runPersonalPurges } = await import('./retention');
    const n = (await q(`SELECT count(*)::int AS n FROM legal_acceptances`))[0].n;
    await q(`UPDATE legal_acceptances SET accepted_at='2001-01-01T00:00:00Z'`);
    await runRetentionJobs(ctx);
    await runPersonalPurges(ctx);
    expect((await q(`SELECT count(*)::int AS n FROM legal_acceptances`))[0].n).toBe(n);
  });
});

describe('row-level security', () => {
  const as = <T>(orgIds: string[], fn: () => Promise<T>) => dbScope.run({ bypass: false, orgIds }, fn);
  it('is on and forced, with the tenant policy', async () => {
    const t = (await q(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='legal_acceptances'`))[0];
    expect(t).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    expect((await q(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename='legal_acceptances' AND policyname='tenant_isolation'`))[0].n).toBe(1);
  });

  it("one church cannot read another church's agreement rows, while a person's own organisation-free rows stay reachable", async () => {
    const other = await as(['org_hope'], () => q(`SELECT doc, org_id FROM legal_acceptances`));
    expect(other.some((r) => r.org_id === 'org_grace')).toBe(false);
    expect(other.some((r) => r.org_id === null)).toBe(true); // terms and privacy rows carry no church
    const own = await as(['org_grace'], () => q(`SELECT doc, org_id FROM legal_acceptances WHERE org_id='org_grace'`));
    expect(own.some((r) => r.doc === 'dpa')).toBe(true);
    // A request from another church's owner never returns Grace's rows.
    const st = (await call(HOPE, 'GET', '/legal/status')).json();
    expect(st.required.find((r: any) => r.doc === 'dpa')).toMatchObject({ orgId: 'org_hope', accepted: false });
    // Amina can accept for herself.
    expect((await accept(AMINA)).statusCode).toBe(200);
  });
});
