import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { signData, signToken, verifyData } from './auth';
import { authMode } from './otp';
import { MemoryLimiter } from './ratelimit';

type Built = Awaited<ReturnType<typeof buildApp>>;

const OWNER = '0700000001', PA1 = '0700000099', JANE = '0711000001', PETER = '0711000002', AMINA = '0711000003';
const norm = (p: string) => `254${p.slice(1)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function helpers(b: Built) {
  const { app, ctx } = b;
  const verify = (phone: string, code: string, extra: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code }, ...extra });
  const login = async (phone: string) => {
    const r = await verify(phone, '123456');
    expect(r.statusCode).toBe(200);
    return r.json().token as string;
  };
  const get = (url: string, token?: string) => app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const post = (url: string, token?: string, payload: any = {}) => app.inject({ method: 'POST', url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { app, ctx, verify, login, get, post };
}

describe('demo mode (the public demo keeps its fixed code)', () => {
  let h: ReturnType<typeof helpers>;
  beforeAll(async () => {
    const b = await buildApp({ stkDelayMs: 0 });
    await seed(b.ctx);
    h = helpers(b);
  }, 60000);

  it('reports its mode, returns the dev helpers outside production, and the fixed code works for members and platform admins', async () => {
    expect(authMode()).toBe('demo');
    expect((await h.get('/auth/mode')).json()).toEqual({ mode: 'demo' });
    const r = (await h.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: JANE } })).json();
    expect(r).toEqual({ sent: true, devCode: '123456', known: true });
    expect((await h.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: '0799999999' } })).json().known).toBe(false);
    expect(await h.login(JANE)).toBeTruthy();
    const adm = await h.verify(PA1, '123456');
    expect(adm.statusCode).toBe(200);
    expect(adm.json().user.isAdmin).toBe(true);
  });

  it('refuses a wrong code and an unknown number the same way', async () => {
    expect((await h.verify(JANE, '000000')).statusCode).toBe(401);
    expect((await h.verify('0799999999', '123456')).statusCode).toBe(401);
  });

  it('locks only the same phone and address after five wrong codes: a stranger elsewhere cannot lock the real person out', async () => {
    const stranger = { remoteAddress: '10.9.9.9' };
    for (let i = 0; i < 5; i++) expect((await h.verify(PETER, '000000', stranger)).statusCode).toBe(401);
    expect((await h.verify(PETER, '123456', stranger)).statusCode).toBe(429);
    // The real person, from their own address, is not affected.
    expect((await h.verify(PETER, '123456', { remoteAddress: '10.1.1.1' })).statusCode).toBe(200);
  });

  it('in production the demo code is only on when ALLOW_DEV_OTP=1, and still returns no devCode or known flag', async () => {
    const env = { n: process.env.NODE_ENV, a: process.env.ALLOW_DEV_OTP, m: process.env.AUTH_MODE };
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.ALLOW_DEV_OTP;
      delete process.env.AUTH_MODE;
      expect(authMode()).toBe('sms');
      process.env.ALLOW_DEV_OTP = '1';
      expect(authMode()).toBe('demo');
      const r = (await h.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: AMINA } })).json();
      expect(r).toEqual({ sent: true });
      expect((await h.verify(AMINA, '123456')).statusCode).toBe(200);
      process.env.AUTH_MODE = 'sms'; // an explicit setting wins
      expect(authMode()).toBe('sms');
    } finally {
      for (const [k, v] of [['NODE_ENV', env.n], ['ALLOW_DEV_OTP', env.a], ['AUTH_MODE', env.m]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  describe('sessions', () => {
    it('logout revokes this session only; logout-all revokes every session of the person', async () => {
      const a = await h.login(AMINA);
      const b = await h.login(AMINA);
      expect((await h.get('/me/attendance', a)).statusCode).toBe(200);
      expect((await h.post('/auth/logout', a)).statusCode).toBe(200);
      expect((await h.get('/me/attendance', a)).statusCode).toBe(401);
      expect((await h.get('/me/attendance', b)).statusCode).toBe(200);
      const c = await h.login(AMINA);
      const list = (await h.get('/auth/sessions', b)).json().sessions;
      expect(list.length).toBeGreaterThanOrEqual(2);
      expect(list.some((s: any) => s.current)).toBe(true);
      expect((await h.post('/auth/logout-all', b)).json().revoked).toBeGreaterThanOrEqual(2);
      expect((await h.get('/me/attendance', b)).statusCode).toBe(401);
      expect((await h.get('/me/attendance', c)).statusCode).toBe(401);
    });

    it('a person can revoke one of their other sessions but nobody else\'s', async () => {
      const a = await h.login(JANE);
      const b = await h.login(JANE);
      const other = await h.login(PETER);
      const sessions = (await h.get('/auth/sessions', a)).json().sessions;
      const notMine = sessions.find((s: any) => !s.current).id;
      const otherSid = (await h.get('/auth/sessions', other)).json().sessions[0].id;
      expect((await h.post(`/auth/sessions/${otherSid}/revoke`, a)).statusCode).toBe(404);
      expect((await h.post(`/auth/sessions/${notMine}/revoke`, a)).statusCode).toBe(200);
      expect((await h.get('/me/attendance', other)).statusCode).toBe(200);
      void b;
    });

    it('a demoted platform admin loses /admin access at once', async () => {
      const t = await h.login(PA1);
      expect((await h.get('/admin/tenants', t)).statusCode).toBe(200);
      await h.ctx.db.query(`UPDATE users SET is_platform_admin=false WHERE phone=$1`, [norm(PA1)]);
      try {
        expect((await h.get('/admin/tenants', t)).statusCode).toBe(403);
      } finally {
        await h.ctx.db.query(`UPDATE users SET is_platform_admin=true WHERE phone=$1`, [norm(PA1)]);
      }
    });

    it('tokens without a session id, forged, or expired are refused; admin sessions last 4 hours, others 12', async () => {
      const uid = (await h.ctx.db.query<any>(`SELECT id FROM users WHERE phone=$1`, [norm(JANE)]))[0].id;
      const noSid = signData({ uid, e: Date.now() + 3600_000 }, 'session');
      expect((await h.get('/me/attendance', noSid)).statusCode).toBe(401);
      const unknownSid = signToken({ uid, sid: 'ses_nope', expiresAt: Date.now() + 3600_000 });
      expect((await h.get('/me/attendance', unknownSid)).statusCode).toBe(401);
      const expired = signToken({ uid, sid: 'ses_nope', expiresAt: Date.now() - 1000 });
      expect((await h.get('/me/attendance', expired)).statusCode).toBe(401);
      await h.login(JANE);
      await h.login(PA1);
      const len = async (phone: string) => {
        const r = (await h.ctx.db.query<any>(`SELECT s.created_at, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.phone=$1 ORDER BY s.created_at DESC LIMIT 1`, [norm(phone)]))[0];
        return (new Date(r.expires_at).getTime() - new Date(r.created_at).getTime()) / 3600_000;
      };
      expect(await len(PA1)).toBe(4);
      expect(await len(JANE)).toBe(12);
    });
  });

  describe('separate keys per purpose', () => {
    it('a token made for one purpose does not verify as another, and verifyData checks expiry itself', async () => {
      const e = Date.now() + 60_000;
      const door = signData({ k: 'd', s: 'x', e }, 'door');
      for (const p of ['session', 'qr', 'invite', 'guardian', 'scan', 'download'] as const) expect(verifyData(door, p)).toBeNull();
      expect(verifyData(door, 'door')?.typ).toBe('door');
      const qr = signData({ k: 'a', m: 'm', e }, 'qr');
      expect(verifyData(qr, 'door')).toBeNull();
      expect(verifyData(signData({ e: Date.now() - 1 }, 'qr'), 'qr')).toBeNull();
      expect(verifyData(signData({ e: Date.now() - 1 }, 'qr'), 'qr', Date.now(), { allowExpired: true })).not.toBeNull();
      expect(verifyData(signData({ k: 'x' } as any, 'qr'), 'qr')).toBeNull(); // no expiry at all
      // used as a bearer token, a door or QR token is nothing.
      expect((await h.get('/me/attendance', door)).statusCode).toBe(401);
      expect((await h.get('/me/attendance', qr)).statusCode).toBe(401);
      // and a sign-in token is not a QR code or a door code.
      const t = await h.login(JANE);
      expect(verifyData(t, 'qr')).toBeNull();
      expect(verifyData(t, 'door')).toBeNull();
      // a tampered signature fails
      expect(verifyData(`${door.slice(0, -2)}xx`, 'door')).toBeNull();
    });

    it('a member QR code is scanned by an usher, and a door token is refused where a member code is expected', async () => {
      const jane = await h.login(JANE);
      const code = (await h.post('/me/attendance/qr', jane)).json().token as string;
      expect(code.startsWith('A1.')).toBe(true);
      expect(verifyData(code.slice(3), 'qr')?.k).toBe('a');
      expect(verifyData(code.slice(3), 'door')).toBeNull();
    });
  });

  describe('download tickets (no more ?token=)', () => {
    it('works for the right path and user, not for another path, not on POST or /auth, and ?token= is gone', async () => {
      const t = await h.login(JANE);
      const tk = await h.post('/auth/download-ticket', t, { path: '/me/attendance' });
      expect(tk.statusCode).toBe(200);
      const url = tk.json().url as string;
      expect(url.startsWith('/me/attendance?t=')).toBe(true);
      expect((await h.get(url)).statusCode).toBe(200);
      // another path
      expect((await h.get(`/me/credit?t=${url.split('t=')[1]}`)).statusCode).toBe(401);
      // not on POST, never on /auth
      expect((await h.app.inject({ method: 'POST', url: `/me/attendance/qr?t=${url.split('t=')[1]}` })).statusCode).toBe(401);
      expect((await h.app.inject({ method: 'GET', url: `/auth/sessions?t=${url.split('t=')[1]}` })).statusCode).toBe(401);
      expect((await h.post('/auth/download-ticket', t, { path: '/auth/sessions' })).statusCode).toBe(400);
      // the old query-string token is no longer a credential
      expect((await h.get(`/me/attendance?token=${t}`)).statusCode).toBe(401);
      // a ticket needs a header session to be issued
      expect((await h.post('/auth/download-ticket', undefined, { path: '/me/attendance' })).statusCode).toBe(401);
      // paths with a query keep it
      const q = (await h.post('/auth/download-ticket', t, { path: '/me/attendance?x=1' })).json().url as string;
      expect(q.startsWith('/me/attendance?x=1&t=')).toBe(true);
      // after sign-out the ticket is dead too
      const t2 = await h.login(JANE);
      const u2 = (await h.post('/auth/download-ticket', t2, { path: '/me/attendance' })).json().url as string;
      await h.post('/auth/logout', t2);
      expect((await h.get(u2)).statusCode).toBe(401);
    });

    it('expires after 60 seconds', async () => {
      const t = await h.login(JANE);
      const url = (await h.post('/auth/download-ticket', t, { path: '/me/attendance' })).json().url as string;
      expect((await h.get(url)).statusCode).toBe(200);
      h.ctx.clock.advance(61_000);
      expect((await h.get(url)).statusCode).toBe(401);
    });
  });

  describe('live collections stream', () => {
    const open = async (token: string) => {
      const url = (await h.post('/auth/download-ticket', token, { path: '/stream/collections' })).json().url as string;
      return h.app.inject({ method: 'GET', url });
    };
    it('needs a ticket and the collections permission when it opens', async () => {
      expect((await h.get('/stream/collections')).statusCode).toBe(401);
      const jane = await h.login(JANE);
      expect((await open(jane)).statusCode).toBe(403);
    });
    it('closes when the session is revoked', async () => {
      process.env.STREAM_CHECK_MS = '60';
      try {
        const owner = await h.login(OWNER);
        const pending = open(owner);
        await sleep(150);
        await h.post('/auth/logout', owner);
        const res = await Promise.race([pending, sleep(3000).then(() => 'still open' as const)]);
        expect(res).not.toBe('still open');
        expect((res as any).statusCode).toBe(200);
      } finally { delete process.env.STREAM_CHECK_MS; }
    });
    it('closes after 30 minutes', async () => {
      process.env.STREAM_CHECK_MS = '60';
      try {
        const owner = await h.login(OWNER);
        const pending = open(owner);
        await sleep(150);
        h.ctx.clock.advance(31 * 60_000);
        const res = await Promise.race([pending, sleep(3000).then(() => 'still open' as const)]);
        expect(res).not.toBe('still open');
      } finally { delete process.env.STREAM_CHECK_MS; }
    });
  });
});

describe('sms mode (real codes, with the simulated messaging provider)', () => {
  let h: ReturnType<typeof helpers>;
  let prev: string | undefined;
  beforeAll(async () => {
    prev = process.env.AUTH_MODE;
    process.env.AUTH_MODE = 'sms';
    const b = await buildApp({ stkDelayMs: 0 });
    await seed(b.ctx);
    h = helpers(b);
  }, 60000);
  afterAll(() => { if (prev === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = prev; delete process.env.OTP_DAILY_CAP; });

  const sentTo = (phone: string) => h.ctx.messaging.sent.filter((m) => m.to === norm(phone));
  /** Starts from clean limiter windows (an hour passes), asks for a code and reads it from the simulated SMS. */
  const codeFor = async (phone: string, fresh = true) => {
    if (fresh) h.ctx.clock.advance(3600_000 + 1000);
    const before = sentTo(phone).length;
    const r = await h.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone } });
    expect(r.statusCode).toBe(200);
    for (let i = 0; i < 40 && sentTo(phone).length === before; i++) await sleep(10);
    const m = sentTo(phone).at(-1)!;
    return /code is (\d{6})\./.exec(m.body)![1];
  };

  it('answers /auth/mode with sms and never returns the code or a known flag', async () => {
    expect((await h.get('/auth/mode')).json()).toEqual({ mode: 'sms' });
    h.ctx.clock.advance(3700_000);
    const r = await h.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: JANE } });
    expect(r.json()).toEqual({ sent: true });
  });

  it('sends a 6 digit code by SMS to a registered number only, with the same answer for an unknown number', async () => {
    h.ctx.clock.advance(3700_000);
    const known = await h.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: PETER } });
    const total = h.ctx.messaging.sent.length;
    const unknown = await h.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: '0733000000' } });
    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.json()).toEqual(known.json());
    await sleep(60);
    expect(h.ctx.messaging.sent.length).toBe(total);
    expect(sentTo('0733000000')).toHaveLength(0);
    const m = sentTo(PETER).at(-1)!;
    expect(m.channel).toBe('sms');
    expect(m.body).toMatch(/^Your ChurchOS code is \d{6}\. It expires in 5 minutes\. Never share it\.$/);
    // the code is not stored in clear
    const row = (await h.ctx.db.query<any>(`SELECT * FROM otp_codes WHERE phone=$1 ORDER BY created_at DESC LIMIT 1`, [norm(PETER)]))[0];
    expect(JSON.stringify(row)).not.toContain(/code is (\d{6})/.exec(m.body)![1] + '"');
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs in with the right code once; the fixed demo code is refused', async () => {
    const code = await codeFor(JANE);
    const bad = code === '123456' ? '654321' : '123456';
    expect((await h.verify(JANE, bad)).statusCode).toBe(401);
    const ok = await h.verify(JANE, code);
    expect(ok.statusCode).toBe(200);
    expect((await h.get('/me/attendance', ok.json().token)).statusCode).toBe(200);
    expect((await h.verify(JANE, code)).statusCode).toBe(401); // single use
  });

  it('a code expires after 5 minutes', async () => {
    const code = await codeFor(JANE);
    h.ctx.clock.advance(5 * 60_000 + 1000);
    expect((await h.verify(JANE, code)).statusCode).toBe(401);
    const code2 = await codeFor(JANE);
    h.ctx.clock.advance(4 * 60_000);
    expect((await h.verify(JANE, code2)).statusCode).toBe(200);
  });

  it('five wrong tries kill that code but not the phone: a new code works, and a new code retires the old one', async () => {
    const code = await codeFor(AMINA);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await h.verify(AMINA, wrong)).statusCode).toBe(401);
    expect((await h.verify(AMINA, code)).statusCode).toBe(401); // the right code is dead now
    const next = await codeFor(AMINA);
    h.ctx.clock.advance(31_000);
    const newer = await codeFor(AMINA, false);
    if (newer !== next) expect((await h.verify(AMINA, next)).statusCode).toBe(401); // replaced
    expect((await h.verify(AMINA, newer)).statusCode).toBe(200);
  });

  it('writes one audit row per phone per hour for failures, and one for the sign-in', async () => {
    const code = await codeFor(PETER);
    const before = (await h.ctx.db.query<any>(`SELECT count(*)::int AS n FROM audit_events WHERE action='security.login_failed'`))[0].n;
    for (let i = 0; i < 4; i++) await h.verify(PETER, code === '000000' ? '111111' : '000000');
    const after = (await h.ctx.db.query<any>(`SELECT count(*)::int AS n FROM audit_events WHERE action='security.login_failed'`))[0].n;
    expect(after - before).toBe(1);
    expect((await h.verify(PETER, code)).statusCode).toBe(200);
    expect((await h.ctx.db.query<any>(`SELECT count(*)::int AS n FROM audit_events WHERE action='security.login'`))[0].n).toBeGreaterThan(0);
  });

  it('limits requests: 30 seconds apart and 5 an hour per phone', async () => {
    h.ctx.clock.advance(3700_000);
    const req = () => h.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: OWNER } });
    expect((await req()).statusCode).toBe(200);
    expect((await req()).statusCode).toBe(429); // too soon
    for (let i = 0; i < 4; i++) { h.ctx.clock.advance(31_000); expect((await req()).statusCode).toBe(200); }
    h.ctx.clock.advance(31_000);
    const sixth = await req();
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error).toMatch(/hour/);
  });

  it('limits requests per address: 20 an hour', async () => {
    h.ctx.clock.advance(3700_000);
    let last = 200;
    for (let i = 0; i < 21; i++) last = (await h.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: `07220000${String(i).padStart(2, '0')}` }, remoteAddress: '10.5.5.5' })).statusCode;
    expect(last).toBe(429);
    // a different address is not affected
    expect((await h.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: '0722000099' }, remoteAddress: '10.6.6.6' })).statusCode).toBe(200);
  });

  it('limits wrong guesses per address: 30 per 10 minutes', async () => {
    h.ctx.clock.advance(3700_000);
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await h.verify('0733000001', '000000', { remoteAddress: '10.7.7.7' })).statusCode;
    expect(last).toBe(429);
  });

  it('pauses sign-in codes at the daily cap and records it once', async () => {
    h.ctx.clock.advance(25 * 3600_000);
    process.env.OTP_DAILY_CAP = '2';
    const req = (phone: string) => h.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone } });
    expect((await req(JANE)).statusCode).toBe(200);
    expect((await req(PETER)).statusCode).toBe(200);
    const a = await req(AMINA);
    expect(a.statusCode).toBe(503);
    expect(a.json().error).toBe('Sign-in codes are paused, try again later');
    await req(OWNER);
    const n = (await h.ctx.db.query<any>(`SELECT count(*)::int AS n FROM audit_events WHERE action='security.otp_cap'`))[0].n;
    expect(n).toBe(1);
    delete process.env.OTP_DAILY_CAP;
  });
});

describe('rate limiter', () => {
  it('counts per key inside a window and tells when to retry', () => {
    let t = 1_000_000;
    const l = new MemoryLimiter(() => t, 100, 0);
    expect(l.hit('a', { max: 2, windowMs: 10_000 }).ok).toBe(true);
    expect(l.hit('a', { max: 2, windowMs: 10_000 }).ok).toBe(true);
    const third = l.hit('a', { max: 2, windowMs: 10_000 });
    expect(third.ok).toBe(false);
    expect(third.retryAfterSec).toBe(10);
    expect(l.hit('b', { max: 2, windowMs: 10_000 }).ok).toBe(true);
    t += 10_001;
    expect(l.hit('a', { max: 2, windowMs: 10_000 }).ok).toBe(true);
  });

  it('prunes expired windows and never grows past its cap', () => {
    let t = 0;
    const l = new MemoryLimiter(() => t, 50, 0);
    for (let i = 0; i < 40; i++) l.hit(`k${i}`, { max: 1, windowMs: 1000 });
    expect(l.size()).toBe(40);
    t += 2000;
    l.prune();
    expect(l.size()).toBe(0);
    for (let i = 0; i < 500; i++) l.hit(`z${i}`, { max: 1, windowMs: 60_000 });
    expect(l.size()).toBeLessThanOrEqual(50);
    l.stop();
  });
});
