import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { runPersonalPurges } from './retention';

/**
 * Slice 40: passkeys (WebAuthn) as sign-in and as the second factor for platform admins, plus automatic purges of visitor, attendance
 * and children's details. The authenticator below is software: an EC P-256 key pair, attestation "none", and assertions built with node:crypto.
 */

let app: Awaited<ReturnType<typeof buildApp>>['app'];
let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
const saved: Record<string, string | undefined> = {};
const q = (sql: string, p: unknown[] = []) => ctx.db.query<any>(sql, p);
const ORIGIN = 'http://localhost:3004';

// ---------- software authenticator ----------
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();
const hdr = (major: number, n: number) => (n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]));
function cbor(v: any): Buffer {
  if (typeof v === 'number') return v >= 0 ? hdr(0, v) : hdr(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([hdr(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([hdr(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([hdr(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor');
}
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

class Authenticator {
  privateKey: KeyObject;
  pub: any;
  credId = randomBytes(32);
  counter = 0;
  constructor() {
    const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = createPrivateKey(kp.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    this.pub = kp.publicKey.export({ format: 'jwk' });
  }
  register(options: any, o: { origin?: string; rpId?: string } = {}) {
    const rp = o.rpId ?? options.rp.id;
    const cose = new Map<any, any>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(this.pub.x, 'base64url')], [-3, Buffer.from(this.pub.y, 'base64url')]]);
    const authData = Buffer.concat([sha(rp), Buffer.from([0x45]), u32(this.counter), Buffer.alloc(16), Buffer.from([this.credId.length >> 8, this.credId.length & 255]), this.credId, cbor(cose)]);
    const att = cbor(new Map<any, any>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: o.origin ?? ORIGIN, crossOrigin: false }));
    return { id: this.credId.toString('base64url'), rawId: this.credId.toString('base64url'), type: 'public-key', response: { clientDataJSON: clientDataJSON.toString('base64url'), attestationObject: att.toString('base64url'), transports: ['internal'] } };
  }
  assert(options: any, o: { origin?: string; rpId?: string; counter?: number } = {}) {
    const rp = o.rpId ?? options.rpId;
    if (o.counter === undefined) this.counter += 1;
    const authData = Buffer.concat([sha(rp), Buffer.from([0x05]), u32(o.counter ?? this.counter)]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: o.origin ?? ORIGIN, crossOrigin: false }));
    const signature = cryptoSign('sha256', Buffer.concat([authData, sha(clientDataJSON)]), this.privateKey);
    return { id: this.credId.toString('base64url'), rawId: this.credId.toString('base64url'), type: 'public-key', response: { clientDataJSON: clientDataJSON.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url') } };
  }
}

// ---------- helpers ----------
let ipN = 0;
const freshIp = () => `10.40.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;
const post = (url: string, payload: any, token?: string) => app.inject({ method: 'POST', url, payload, remoteAddress: freshIp(), headers: token ? { authorization: `Bearer ${token}` } : {} });
const get = (url: string, token: string) => app.inject({ method: 'GET', url, remoteAddress: freshIp(), headers: { authorization: `Bearer ${token}` } });
const del = (url: string, token: string) => app.inject({ method: 'DELETE', url, remoteAddress: freshIp(), headers: { authorization: `Bearer ${token}` } });
const demoLogin = async (phone: string) => (await post('/auth/otp/verify', { phone, code: '123456' })).json();

/** Sign in by SMS code in sms mode: a code is written straight into the table (the real sender is not used). */
async function smsLogin(phone: string) {
  const norm = '254' + phone.slice(1);
  const salt = randomBytes(8).toString('hex');
  const code = '482913';
  const now = ctx.clock.now();
  await q(`INSERT INTO otp_codes (id, phone, code_hash, salt, expires_at, attempts, created_at) VALUES ($1,$2,$3,$4,$5,0,$6)`, [
    `otp_t${++ipN}`, norm, sha(`${salt}:${code}`).toString('hex'), salt, new Date(now.getTime() + 300_000).toISOString(), now.toISOString(),
  ]);
  return (await post('/auth/otp/verify', { phone, code })).json();
}

async function addPasskey(token: string, a: Authenticator, name = 'Test key') {
  const o = (await post('/auth/passkeys/register/options', {}, token)).json();
  const r = await post('/auth/passkeys/register/verify', { state: o.state, credential: a.register(o.options), name }, token);
  return r;
}
async function passkeyLogin(a: Authenticator, o: { origin?: string; rpId?: string; counter?: number } = {}) {
  const opt = (await post('/auth/passkeys/login/options', {})).json();
  return post('/auth/passkeys/login/verify', { state: opt.state, credential: a.assert(opt.options, o) });
}

beforeAll(async () => {
  for (const k of ['AUTH_MODE', 'REQUIRE_ADMIN_PASSKEY', 'RETENTION_DRY_RUN', 'CORS_ORIGINS', 'WEBAUTHN_RP_ID']) { saved[k] = process.env[k]; delete process.env[k]; }
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);
afterAll(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

describe('passkeys: register, sign in, refusals (demo mode)', () => {
  const jane = new Authenticator();
  let janeToken = '';

  it('registers a passkey for a signed-in person and lists it', async () => {
    janeToken = (await demoLogin('0711000001')).token;
    const r = await addPasskey(janeToken, jane, 'Jane phone');
    expect(r.statusCode).toBe(200);
    const list = (await get('/auth/passkeys', janeToken)).json();
    expect(list.passkeys).toHaveLength(1);
    expect(list.passkeys[0]).toMatchObject({ name: 'Jane phone' });
    expect(JSON.stringify(list)).not.toContain('public');
    const opt = (await post('/auth/passkeys/register/options', {}, janeToken)).json();
    expect(opt.options.rp.id).toBe('localhost');
    expect(opt.options.attestation).toBe('none');
    expect(opt.options.excludeCredentials).toHaveLength(1);
  });

  it('refuses a registration with another origin or another rp id, and one that is not signed in', async () => {
    const other = new Authenticator();
    const o = (await post('/auth/passkeys/register/options', {}, janeToken)).json();
    expect((await post('/auth/passkeys/register/verify', { state: o.state, credential: other.register(o.options, { origin: 'https://evil.example' }) }, janeToken)).statusCode).toBe(400);
    const o2 = (await post('/auth/passkeys/register/options', {}, janeToken)).json();
    expect((await post('/auth/passkeys/register/verify', { state: o2.state, credential: other.register(o2.options, { rpId: 'evil.example' }) }, janeToken)).statusCode).toBe(400);
    expect((await post('/auth/passkeys/register/options', {})).statusCode).toBe(401);
    expect((await get('/auth/passkeys', janeToken)).json().passkeys).toHaveLength(1);
  });

  it('signs in with a passkey and no code, and the session works', async () => {
    const r = await passkeyLogin(jane);
    expect(r.statusCode).toBe(200);
    const { token, user } = r.json();
    expect(user.name).toBe('Jane Wanjiku');
    expect((await get('/auth/passkeys', token)).statusCode).toBe(200);
    const row = (await q(`SELECT counter, last_used_at FROM passkeys`))[0];
    expect(Number(row.counter)).toBe(1);
    expect(row.last_used_at).toBeTruthy();
    expect((await q(`SELECT 1 FROM audit_events WHERE action='security.login' AND summary LIKE '%with a passkey%'`)).length).toBeGreaterThan(0);
  });

  it('refuses a counter that goes backwards (a copied key) and one that does not move', async () => {
    expect((await passkeyLogin(jane)).statusCode).toBe(200); // counter 2
    expect((await passkeyLogin(jane)).statusCode).toBe(200); // counter 3
    expect((await passkeyLogin(jane, { counter: 2 })).statusCode).toBe(401);
    expect((await passkeyLogin(jane, { counter: 3 })).statusCode).toBe(401);
    expect(Number((await q(`SELECT counter FROM passkeys`))[0].counter)).toBe(3);
    jane.counter = 3;
    expect((await passkeyLogin(jane)).statusCode).toBe(200);
  });

  it('refuses a wrong origin, a wrong rp id, an unknown key and a bad signature', async () => {
    expect((await passkeyLogin(jane, { origin: 'https://evil.example' })).statusCode).toBe(401);
    expect((await passkeyLogin(jane, { rpId: 'evil.example' })).statusCode).toBe(401);
    expect((await passkeyLogin(new Authenticator())).statusCode).toBe(401);
    const opt = (await post('/auth/passkeys/login/options', {})).json();
    const cred = jane.assert(opt.options);
    cred.response.signature = Buffer.from(cred.response.signature, 'base64url').reverse().toString('base64url');
    const r = await post('/auth/passkeys/login/verify', { state: opt.state, credential: cred });
    expect(r.statusCode).toBe(401);
    expect(r.json().token).toBeUndefined();
  });

  it('refuses an expired challenge, a replayed one, a tampered one and one of the wrong kind', async () => {
    const opt = (await post('/auth/passkeys/login/options', {})).json();
    const cred = jane.assert(opt.options);
    expect((await post('/auth/passkeys/login/verify', { state: opt.state, credential: cred })).statusCode).toBe(200);
    const replay = await post('/auth/passkeys/login/verify', { state: opt.state, credential: cred });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().code).toBe('challenge_expired');

    const old = (await post('/auth/passkeys/login/options', {})).json();
    const oldCred = jane.assert(old.options);
    ctx.clock.advanceHours(0.2); // 12 minutes, past the 5 minute limit
    const late = await post('/auth/passkeys/login/verify', { state: old.state, credential: oldCred });
    expect(late.statusCode).toBe(400);
    expect(late.json().code).toBe('challenge_expired');

    const fresh = (await post('/auth/passkeys/login/options', {})).json();
    const tampered = fresh.state.slice(0, -3) + (fresh.state.endsWith('AAA') ? 'BBB' : 'AAA');
    expect((await post('/auth/passkeys/login/verify', { state: tampered, credential: jane.assert(fresh.options) })).statusCode).toBe(400);
    const reg = (await post('/auth/passkeys/register/options', {}, janeToken)).json();
    expect((await post('/auth/passkeys/login/verify', { state: reg.state, credential: jane.assert(reg.options, { rpId: 'localhost' }) })).statusCode).toBe(400);
  });

  it('removes a passkey, only your own', async () => {
    const peterToken = (await demoLogin('0711000002')).token;
    const id = (await get('/auth/passkeys', janeToken)).json().passkeys[0].id;
    expect((await del(`/auth/passkeys/${id}`, peterToken)).statusCode).toBe(404);
    expect((await del(`/auth/passkeys/${id}`, janeToken)).statusCode).toBe(200);
    expect((await get('/auth/passkeys', janeToken)).json().passkeys).toHaveLength(0);
    expect((await passkeyLogin(jane)).statusCode).toBe(401);
  });

  it('demo sign-in with the fixed code is unchanged, even for an admin with a passkey', async () => {
    const admin = new Authenticator();
    const t = (await demoLogin('0700000099')).token;
    expect((await addPasskey(t, admin)).statusCode).toBe(200);
    const again = await demoLogin('0700000099');
    expect(again.token).toBeTruthy();
    expect(again.needsPasskey).toBeUndefined();
    expect(again.user.isAdmin).toBe(true);
    process.env.REQUIRE_ADMIN_PASSKEY = '1';
    const noKey = await demoLogin('0700000098'); // an admin with no passkey, demo mode, flag on
    delete process.env.REQUIRE_ADMIN_PASSKEY;
    expect(noKey.token).toBeTruthy();
    expect((await get('/auth/mode', t)).json().mode).toBe('demo');
    await q(`DELETE FROM passkeys`);
  });
});

describe('passkeys as the second factor in sms mode', () => {
  const admin = new Authenticator();
  beforeAll(() => { process.env.AUTH_MODE = 'sms'; });
  afterAll(() => { delete process.env.AUTH_MODE; delete process.env.REQUIRE_ADMIN_PASSKEY; });

  it('lets an admin without a passkey in, and the API says whether passkeys are required', async () => {
    const r = await smsLogin('0700000099');
    expect(r.token).toBeTruthy();
    const info = (await get('/auth/passkeys', r.token)).json();
    expect(info).toMatchObject({ mode: 'sms', isAdmin: true, passkeyRequiredForAdmins: false, passkeys: [] });
    expect((await addPasskey(r.token, admin, 'Admin key')).statusCode).toBe(200);
  });

  it('asks an admin with a passkey for it after the code: no session until it is shown', async () => {
    const r = await smsLogin('0700000099');
    expect(r.needsPasskey).toBe(true);
    expect(r.token).toBeUndefined();
    expect(typeof r.pending).toBe('string');
    expect((await get('/auth/passkeys', r.pending)).statusCode).toBe(401); // the pending token is not a session

    const opt = (await post('/auth/passkeys/second/options', { pending: r.pending })).json();
    expect(opt.options.allowCredentials).toHaveLength(1);
    // The wrong key, the wrong origin and a made-up pending token are refused.
    const stranger = new Authenticator();
    stranger.credId = admin.credId;
    expect((await post('/auth/passkeys/verify-second', { pending: r.pending, state: opt.state, credential: stranger.assert(opt.options) })).statusCode).toBe(401);
    const opt2 = (await post('/auth/passkeys/second/options', { pending: r.pending })).json();
    expect((await post('/auth/passkeys/verify-second', { pending: r.pending, state: opt2.state, credential: admin.assert(opt2.options, { origin: 'https://evil.example' }) })).statusCode).toBe(401);
    expect((await post('/auth/passkeys/second/options', { pending: 'x.y' })).statusCode).toBe(401);

    const opt3 = (await post('/auth/passkeys/second/options', { pending: r.pending })).json();
    const ok = await post('/auth/passkeys/verify-second', { pending: r.pending, state: opt3.state, credential: admin.assert(opt3.options) });
    expect(ok.statusCode).toBe(200);
    expect((await get('/auth/passkeys', ok.json().token)).statusCode).toBe(200);
    // The pending sign-in works once.
    const opt4 = (await post('/auth/passkeys/second/options', { pending: r.pending })).json();
    expect((await post('/auth/passkeys/verify-second', { pending: r.pending, state: opt4.state, credential: admin.assert(opt4.options) })).statusCode).toBe(401);
  });

  it('a passkey from another person cannot finish the sign-in, and the pending token from a code alone is useless for sign-in', async () => {
    const jane = new Authenticator();
    const jt = (await smsLogin('0711000001')).token; // a member: no second factor asked
    expect(jt).toBeTruthy();
    expect((await addPasskey(jt, jane)).statusCode).toBe(200);
    expect((await smsLogin('0711000001')).needsPasskey).toBeUndefined(); // members are never asked
    const r = await smsLogin('0700000099');
    const opt = (await post('/auth/passkeys/second/options', { pending: r.pending })).json();
    expect((await post('/auth/passkeys/verify-second', { pending: r.pending, state: opt.state, credential: jane.assert(opt.options) })).statusCode).toBe(401);
  });

  it('REQUIRE_ADMIN_PASSKEY=1 blocks an admin without a passkey until one is added', async () => {
    process.env.REQUIRE_ADMIN_PASSKEY = '1';
    const r = await smsLogin('0700000098');
    expect(r.needsEnrolment).toBe(true);
    expect(r.token).toBeUndefined();
    const second = new Authenticator();
    const o = (await post('/auth/passkeys/register/options', { pending: r.pending })).json();
    const done = await post('/auth/passkeys/register/verify', { pending: r.pending, state: o.state, credential: second.register(o.options), name: 'First key' });
    expect(done.statusCode).toBe(200);
    expect(done.json().token).toBeTruthy();
    expect(done.json().user.isAdmin).toBe(true);
    // The enrolment token works once.
    const o2 = (await post('/auth/passkeys/register/options', { pending: r.pending })).json();
    expect((await post('/auth/passkeys/register/verify', { pending: r.pending, state: o2.state, credential: new Authenticator().register(o2.options) })).statusCode).toBe(401);
    // The last passkey of a required admin cannot be removed.
    const id = (await get('/auth/passkeys', done.json().token)).json().passkeys[0].id;
    expect((await get('/auth/passkeys', done.json().token)).json().passkeyRequiredForAdmins).toBe(true);
    const blocked = await del(`/auth/passkeys/${id}`, done.json().token);
    expect(blocked.statusCode).toBe(409);
    // A member is not affected by the gate.
    expect((await smsLogin('0711000002')).token).toBeTruthy();
    delete process.env.REQUIRE_ADMIN_PASSKEY;
  });

  it('a signed-in passkey login in sms mode needs no code', async () => {
    const r = await passkeyLogin(admin);
    expect(r.statusCode).toBe(200);
    expect(r.json().user.isAdmin).toBe(true);
  });
});

describe('automatic purges of personal details', () => {
  const YEAR = 365.25 * 86_400_000;
  const ago = (ms: number) => new Date(ctx.clock.now().getTime() - ms).toISOString();
  const MONTH = YEAR / 12;
  const counts = async () => ({
    payments: Number((await q(`SELECT count(*)::int AS n FROM payments`))[0].n),
    ledger: Number((await q(`SELECT count(*)::int AS n FROM giving_ledger`))[0].n),
  });

  async function plant() {
    const v = (id: string, status: string, last: string, membership: string | null = null) =>
      q(`INSERT INTO visitors (id, org_id, branch_id, name, phone, first_seen_at, last_seen_at, visits, status, note, membership_id, created_at) VALUES ($1,'org_grace','br_grc001','Visitor '||$1,'0799'||$1,$2,$2,3,$3,'a note',$4,$2)`, [id, last, status, membership]);
    await v('v40a', 'returning', ago(14 * MONTH));
    await v('v40b', 'returning', ago(2 * MONTH));
    await v('v40c', 'member', ago(20 * MONTH));
    await v('v40d', 'returning', ago(20 * MONTH), 'm_jane');
    const att = (id: string, svc: string, at: string, membership: string | null, visitor: string | null) =>
      q(`INSERT INTO attendance (id, org_id, branch_id, service_id, kind, membership_id, visitor_id, name, mode, via, at, by_name) VALUES ($1,'org_grace','br_grc001',$2,$3,$4,$5,$6,'in_person','usher',$7,'Usher')`, [id, svc, visitor ? 'visitor' : 'member', membership, visitor, `Name ${id}`, at]);
    await att('a40_old1', 'svc40_old', ago(4 * YEAR), 'm_jane', null);
    await att('a40_old2', 'svc40_old', ago(4 * YEAR), 'm_peter', null);
    await att('a40_oldv', 'svc40_old', ago(4 * YEAR), null, 'v40a');
    await att('a40_new', 'svc40_new', ago(1 * YEAR), 'm_jane', null);
    await att('a40_vnew', 'svc40_new', ago(MONTH), null, 'v40a');
    const kc = (id: string, at: string) =>
      q(`INSERT INTO kids_checkins (id, org_id, branch_id, session_id, class_id, child_id, child_name, tag, status, in_at, in_by, in_by_name, in_method, dropper_id, dropper_name, out_at, collector_id, collector_name) VALUES ($1,'org_grace','br_grc001','ks40','kc40','child_'||$1,'Child '||$1,'A1','out',$2,'staff1','Teacher','tag','g_'||$1,'Parent '||$1,$2,'g_'||$1,'Parent '||$1)`, [id, at]);
    await kc('kci40_old', ago(8 * YEAR));
    await kc('kci40_new', ago(1 * YEAR));
    const kl = (id: string, at: string) =>
      q(`INSERT INTO kids_log (id, org_id, branch_id, at, action, result, class_name, staff_name, subject_id, subject_name, children, detail) VALUES ($1,'org_grace','br_grc001',$2,'collect','ok','Sparks','Teacher','g_'||$1,'Parent '||$1,'Child '||$1,'Collected by '||$1)`, [id, at]);
    await kl('kl40_old', ago(8 * YEAR));
    await kl('kl40_new', ago(1 * YEAR));
    await q(`INSERT INTO kids_codes (id, org_id, session_id, checkin_ids, kind, to_name, to_phone, subject_kind, subject_id, code_hash, created_at, expires_at) VALUES ('kcode40_old','org_grace','ks40','[]','collect','Parent X','254799000001','guardian','g_x','h',$1,$1)`, [ago(8 * YEAR)]);
  }

  it('anonymises old visitor, attendance and children details, keeps the rows and the counts, audits once', async () => {
    await plant();
    const distinctBefore = (await q(`SELECT count(DISTINCT membership_id) FILTER (WHERE kind='member')::int AS m, count(DISTINCT visitor_id)::int AS v, count(*)::int AS n FROM attendance WHERE service_id='svc40_old'`))[0];
    const money = await counts();
    const auditBefore = Number((await q(`SELECT count(*)::int AS n FROM audit_events`))[0].n);

    const r = await runPersonalPurges(ctx);
    expect(r).toMatchObject({ dryRun: false, visitors: 1, attendance: 3, kidsCheckins: 1, kidsLog: 1, kidsCodes: 1 });

    const vis = Object.fromEntries((await q(`SELECT id, name, phone, note, visits, status FROM visitors WHERE id LIKE 'v40%'`)).map((x) => [x.id, x]));
    expect(vis.v40a).toMatchObject({ name: 'Former visitor', phone: 'anon-v40a', note: null, visits: 3, status: 'returning' });
    expect(vis.v40b.name).toBe('Visitor v40b'); // seen two months ago
    expect(vis.v40c.name).toBe('Visitor v40c'); // already a member
    expect(vis.v40d.name).toBe('Visitor v40d'); // linked to a membership
    const att = Object.fromEntries((await q(`SELECT id, name, membership_id, visitor_id, by_name FROM attendance WHERE id LIKE 'a40%'`)).map((x) => [x.id, x]));
    expect(att.a40_old1).toMatchObject({ name: 'Anonymised', membership_id: 'anon_a40_old1', by_name: null });
    expect(att.a40_oldv).toMatchObject({ name: 'Anonymised', visitor_id: 'anon_a40_oldv' });
    expect(att.a40_new.name).toBe('Name a40_new');
    expect(att.a40_vnew.name).toBe('Former visitor'); // recent attendance of a visitor who was anonymised
    const distinctAfter = (await q(`SELECT count(DISTINCT membership_id) FILTER (WHERE kind='member')::int AS m, count(DISTINCT visitor_id)::int AS v, count(*)::int AS n FROM attendance WHERE service_id='svc40_old'`))[0];
    expect(distinctAfter).toEqual(distinctBefore); // counts per service still add up

    const kci = Object.fromEntries((await q(`SELECT id, child_name, child_id, dropper_name, collector_name, tag, status FROM kids_checkins WHERE id LIKE 'kci40%'`)).map((x) => [x.id, x]));
    expect(kci.kci40_old).toMatchObject({ child_name: 'Anonymised', child_id: 'anon_kci40_old', dropper_name: 'Anonymised', collector_name: 'Anonymised', tag: 'A1', status: 'out' });
    expect(kci.kci40_new.child_name).toBe('Child kci40_new');
    const kl = Object.fromEntries((await q(`SELECT id, subject_name, children, detail, action, result FROM kids_log WHERE id LIKE 'kl40%'`)).map((x) => [x.id, x]));
    expect(kl.kl40_old).toMatchObject({ subject_name: 'Anonymised', children: null, detail: null, action: 'collect', result: 'ok' });
    expect(kl.kl40_new.children).toBe('Child kl40_new');
    expect((await q(`SELECT to_name, to_phone FROM kids_codes WHERE id='kcode40_old'`))[0]).toEqual({ to_name: 'Anonymised', to_phone: '' });

    expect(await counts()).toEqual(money);
    expect(Number((await q(`SELECT count(*)::int AS n FROM audit_events`))[0].n)).toBe(auditBefore + 1);
    const ev = (await q(`SELECT summary, meta FROM audit_events WHERE action='retention.purge_personal'`))[0];
    expect(ev.summary).toContain('1 visitors');
    expect(JSON.stringify(ev)).not.toContain('Visitor v40a');

    // Idempotent: a second run finds nothing and writes nothing.
    expect(await runPersonalPurges(ctx)).toMatchObject({ visitors: 0, attendance: 0, kidsCheckins: 0, kidsLog: 0, kidsCodes: 0 });
    expect(Number((await q(`SELECT count(*)::int AS n FROM audit_events`))[0].n)).toBe(auditBefore + 1);
  });

  it('follows the platform clock and the environment limits', async () => {
    ctx.clock.advanceHours(24 * 366 * 2); // two years on: the one-year-old rows are past the limits that are shorter
    process.env.RETENTION_ATTENDANCE_YEARS = '3';
    const r = await runPersonalPurges(ctx);
    expect(r.attendance).toBeGreaterThanOrEqual(1); // a40_new is now 3 years old
    expect(r.visitors).toBeGreaterThanOrEqual(1); // v40b is now past 12 months
    expect((await q(`SELECT name FROM visitors WHERE id='v40c'`))[0].name).toBe('Visitor v40c');
    expect((await q(`SELECT name FROM visitors WHERE id='v40d'`))[0].name).toBe('Visitor v40d');
    delete process.env.RETENTION_ATTENDANCE_YEARS;
  });

  it('dry run only audits counts and changes nothing', async () => {
    await q(`INSERT INTO visitors (id, org_id, branch_id, name, phone, first_seen_at, last_seen_at, visits, status, created_at) VALUES ('v40dry','org_grace','br_grc001','Dry Visitor','0799dry','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z',1,'new','2000-01-01T00:00:00.000Z')`);
    await q(`INSERT INTO attendance (id, org_id, branch_id, service_id, kind, membership_id, name, mode, via, at) VALUES ('a40dry','org_grace','br_grc001','svc40_dry','member','m_jane','Dry Name','in_person','usher','2000-01-01T00:00:00.000Z')`);
    process.env.RETENTION_DRY_RUN = '1';
    const money = await counts();
    try {
      const r = await runPersonalPurges(ctx);
      expect(r.dryRun).toBe(true);
      expect(r.visitors).toBeGreaterThanOrEqual(1);
      expect(r.attendance).toBeGreaterThanOrEqual(1);
    } finally { delete process.env.RETENTION_DRY_RUN; }
    expect((await q(`SELECT name FROM visitors WHERE id='v40dry'`))[0].name).toBe('Dry Visitor');
    expect((await q(`SELECT name, membership_id FROM attendance WHERE id='a40dry'`))[0]).toEqual({ name: 'Dry Name', membership_id: 'm_jane' });
    expect((await q(`SELECT 1 FROM audit_events WHERE action='retention.purge_personal_dry_run'`)).length).toBe(1);
    expect(await counts()).toEqual(money);
    // Switched off, the next run does the work.
    expect((await runPersonalPurges(ctx)).visitors).toBeGreaterThanOrEqual(1);
    expect((await q(`SELECT name FROM visitors WHERE id='v40dry'`))[0].name).toBe('Former visitor');
  });
});
