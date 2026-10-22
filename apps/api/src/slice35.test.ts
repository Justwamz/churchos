import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { safeSmsName } from './abuse';

/**
 * Slice 35: abuse limits (LG-04, LG-05, LG-12, LG-13, LG-18, LG-20, AZ-09, AZ-10, WEB-04). The rest of the suite runs with ABUSE_DISABLED=1
 * (vitest.config.ts); this file turns the limits on and drives them with the platform clock.
 */

let app: Awaited<ReturnType<typeof buildApp>>['app'];
let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
let savedFlag: string | undefined;
const tokens: Record<string, string> = {};
async function login(phone: string) {
  if (tokens[phone]) return tokens[phone];
  const r = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: '123456' }, remoteAddress: '10.0.0.200' });
  tokens[phone] = r.json().token;
  return tokens[phone];
}
const call = async (phone: string | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: any, ip = '10.1.1.1') =>
  app.inject({ method, url, payload, remoteAddress: ip, headers: phone ? { authorization: `Bearer ${await login(phone)}` } : {} });
const q = (sql: string, p: unknown[] = []) => ctx.db.query<any>(sql, p);
const DAY = 86_400_000;
const inDays = (n: number) => new Date(ctx.clock.now().getTime() + n * DAY).toISOString();
const OWNER = '0700000001', ADMIN = '0700000003', JANE = '0711000001', PETER = '0711000002';
let ipN = 0;
const freshIp = () => `10.9.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;
const give = (phone: string, ip: string, extra: any = {}) => call(null, 'POST', '/public/give', { code: 'GRC001', amount: 100, phone, method: 'mpesa', purpose: 'OFFERING', ...extra }, ip);

async function makeEvent(title: string, price: number, quantity = 200) {
  const id = (await call(OWNER, 'POST', '/events', { title, audience: { type: 'org' }, startsAt: inDays(20), endsAt: inDays(20.1), location: 'Hall' })).json().id;
  await call(OWNER, 'PUT', `/events/${id}/ticketing`, { ticketed: true, refundDaysBefore: 30, types: [{ name: 'Regular', price, quantity }] });
  const s = (await call(OWNER, 'GET', `/events/${id}/tickets`)).json();
  return { id, code: s.code as string, type: s.types[0].id as string };
}

beforeAll(async () => {
  savedFlag = process.env.ABUSE_DISABLED;
  process.env.ABUSE_DISABLED = '';
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);
afterAll(() => {
  if (savedFlag === undefined) delete process.env.ABUSE_DISABLED;
  else process.env.ABUSE_DISABLED = savedFlag;
});

describe('payment prompts to strangers (LG-05)', () => {
  it('allows 3 prompts to one phone in 10 minutes, then 429 with Retry-After, and recovers when the clock moves', async () => {
    const phone = '0712300001';
    for (let i = 0; i < 3; i++) expect((await give(phone, freshIp())).statusCode).toBe(200);
    const r = await give(phone, freshIp());
    expect(r.statusCode).toBe(429);
    expect(r.json()).toMatchObject({ code: 'rate_limited', error: 'Too many payment requests to this number. Please wait a few minutes.' });
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    ctx.clock.advanceHours(0.2);
    expect((await give(phone, freshIp())).statusCode).toBe(200);
  });

  it('caps one phone at 10 a day even when spread over time', async () => {
    const phone = '0712300002';
    let sent = 0;
    for (let i = 0; i < 12; i++) {
      const r = await give(phone, freshIp());
      if (r.statusCode === 200) sent++;
      else expect(r.statusCode).toBe(429);
      ctx.clock.advanceHours(0.2);
    }
    expect(sent).toBe(10);
    ctx.clock.advanceHours(24);
    expect((await give(phone, freshIp())).statusCode).toBe(200);
  });

  it('caps one IP, and a different IP is unaffected', async () => {
    const ip = freshIp();
    process.env.ABUSE_PROMPT_IP_HOUR = '5';
    try {
      for (let i = 0; i < 5; i++) expect((await give(`07123001${10 + i}`, ip)).statusCode).toBe(200);
      expect((await give('0712300199', ip)).statusCode).toBe(429);
      expect((await give('0712300198', freshIp())).statusCode).toBe(200);
    } finally {
      delete process.env.ABUSE_PROMPT_IP_HOUR;
    }
    ctx.clock.advanceHours(1.1);
    expect((await give('0712300197', ip)).statusCode).toBe(200);
  });

  it('limits a signed-in member per user, not by IP', async () => {
    process.env.ABUSE_PROMPT_USER_HOUR = '4';
    try {
      for (let i = 0; i < 4; i++) expect((await call(JANE, 'POST', '/me/give', { code: 'GRC001', amount: 100, method: 'mpesa', phone: `0712301${100 + i}` })).statusCode).toBe(200);
      const r = await call(JANE, 'POST', '/me/give', { code: 'GRC001', amount: 100, method: 'mpesa', phone: '0712301199' });
      expect(r.statusCode).toBe(429);
      expect(r.headers['retry-after']).toBeTruthy();
    } finally {
      delete process.env.ABUSE_PROMPT_USER_HOUR;
    }
    ctx.clock.advanceHours(1.1);
  });
});

describe('the welcome SMS (LG-04)', () => {
  it('cleans the typed name to letters and never lets a link through', () => {
    expect(safeSmsName('Click bit.ly/x https://evil.example')).toBe('Click');
    expect(safeSmsName('http://evil.example')).toBeNull();
    expect(safeSmsName('bit.ly/x')).toBeNull();
    expect(safeSmsName('a@b.com')).toBeNull();
    expect(safeSmsName('12345 6789')).toBeNull();
    expect(safeSmsName('J')).toBeNull();
    expect(safeSmsName("Mary-Anne O'Neil")).toBe("Mary-Anne O'Neil");
    expect(safeSmsName('Peter<script>')).toBe('Peterscript');
    expect(safeSmsName('x'.repeat(100))!.length).toBe(40);
  });

  let token = '';
  beforeAll(async () => {
    const s = await call(OWNER, 'POST', '/attendance/services', { branchId: 'br_grc001', name: 'Abuse Sunday', startsAt: new Date(ctx.clock.now().getTime() + 5 * 60_000).toISOString(), durationMin: 90 });
    expect(s.statusCode, JSON.stringify(s.json())).toBe(200);
    const door = (await call(ADMIN, 'GET', `/attendance/services/${s.json().id}/door`)).json();
    token = door.url.split('/here/')[1];
  });
  const texts = async (phone: string) => q(`SELECT body FROM sms_messages WHERE to_phone=$1 AND kind='announcement'`, [`254${phone.slice(1)}`]);
  const checkIn = (name: string, phone: string, ip: string) => call(null, 'POST', `/public/here/${token}`, { name, phone }, ip);

  it('texts a first-time visitor with a name that carries no link, and nothing to a known user', async () => {
    expect((await checkIn('Click bit.ly/x https://evil.example', '0713400001', freshIp())).statusCode).toBe(200);
    const sent = await texts('0713400001');
    expect(sent.length).toBe(1);
    expect(sent[0].body).not.toMatch(/bit\.ly|https?:|evil/i);
    expect(sent[0].body).toMatch(/^Hello Click,/);
    expect((await checkIn('Peter Visitor', PETER, freshIp())).statusCode).toBe(200);
    expect(await texts(PETER)).toHaveLength(0);
    expect((await checkIn('Bit.ly/x', '0713400003', freshIp())).statusCode).toBe(200);
    expect(await texts('0713400003')).toHaveLength(0);
    expect((await q(`SELECT welcome_status FROM visitors WHERE phone='254713400003'`))[0].welcome_status).toBe('not_sent');
  });

  it('caps welcome SMS per IP at 5 an hour, and texts a number at most once per 30 days', async () => {
    const ip = freshIp();
    let total = 0;
    for (let i = 0; i < 7; i++) {
      const phone = `07134100${10 + i}`;
      await checkIn(`Visitor${'abcdefg'[i]}`, phone, ip);
      total += (await texts(phone)).length;
    }
    expect(total).toBe(5);
    const before = (await texts('0713410010')).length;
    ctx.clock.advanceHours(24 * 31);
    await checkIn('Visitora', '0713410010', freshIp());
    expect((await texts('0713410010')).length).toBe(before);
  });
});

describe('free tickets and unpaid orders (LG-13)', () => {
  it('caps free tickets per IP and per phone for one event, whatever the email address', async () => {
    const ev = await makeEvent('Free night', 0);
    const ip = freshIp();
    let ok = 0;
    for (let i = 0; i < 12; i++) {
      const r = await call(null, 'POST', '/public/tickets/orders', { code: ev.code, name: 'Guest', email: `guest${i}@gmail.com`, phone: `07135000${10 + i}`, method: 'mpesa', lines: [{ typeId: ev.type, qty: 1 }] }, ip);
      if (r.statusCode === 200) ok++;
      else {
        expect(r.statusCode).toBe(429);
        expect(r.headers['retry-after']).toBeTruthy();
      }
    }
    expect(ok).toBe(10);
    let okPhone = 0;
    for (let i = 0; i < 12; i++) {
      const r = await call(null, 'POST', '/public/tickets/orders', { code: ev.code, name: 'Guest', email: `wanjiru.k${'abcdefghijkl'[i]}@gmail.com`, phone: '0713500099', method: 'mpesa', lines: [{ typeId: ev.type, qty: 1 }] }, freshIp());
      if (r.statusCode === 200) okPhone++;
    }
    expect(okPhone).toBe(10);
    ctx.clock.advanceHours(25);
    expect((await call(null, 'POST', '/public/tickets/orders', { code: ev.code, name: 'Guest', email: 'late@gmail.com', phone: '0713500098', method: 'mpesa', lines: [{ typeId: ev.type, qty: 1 }] }, ip)).statusCode).toBe(200);
  });

  it('holds at most 5 unpaid orders per person across events, and releases them when they lapse', async () => {
    const evs = [await makeEvent('Paid A', 500), await makeEvent('Paid B', 500)];
    const provider = ctx.provider as any;
    provider.setStkDelay(600_000);
    const order = (i: number) => call(null, 'POST', '/public/tickets/orders', { code: evs[i % 2].code, name: 'Holder', email: 'holder@gmail.com', phone: `07136${String(i).padStart(5, '0')}`, method: 'mpesa', lines: [{ typeId: evs[i % 2].type, qty: 1 }] }, freshIp());
    for (let i = 0; i < 5; i++) expect((await order(i)).statusCode, `order ${i}`).toBe(200);
    const sixth = await order(5);
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().code).toBe('too_many_unpaid');
    ctx.clock.advanceHours(0.3);
    expect((await order(6)).statusCode).toBe(200);
    provider.setStkDelay(0);
  });
});

describe('member free text, the grouped public limit and sign-in (LG-20, LG-18, LG-12, WEB-04)', () => {
  it('limits prayer requests per member and recovers', async () => {
    process.env.ABUSE_FORM_USER_HOUR = '3';
    try {
      for (let i = 0; i < 3; i++) expect((await call(PETER, 'POST', '/me/prayer', { body: `Please pray ${i}`, visibility: 'team' })).statusCode).not.toBe(429);
      const r = await call(PETER, 'POST', '/me/prayer', { body: 'one more', visibility: 'team' });
      expect(r.statusCode).toBe(429);
      expect(r.headers['retry-after']).toBeTruthy();
      ctx.clock.advanceHours(1.1);
      expect((await call(PETER, 'POST', '/me/prayer', { body: 'again', visibility: 'team' })).statusCode).not.toBe(429);
    } finally {
      delete process.env.ABUSE_FORM_USER_HOUR;
    }
  });

  it('applies the tight limit to sensitive public routes and the grouped default to the rest, with Retry-After', async () => {
    const ip = freshIp();
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await call(null, 'GET', '/public/credit/0123456789abcdef', undefined, ip)).statusCode;
    expect(last).toBe(429);
    const ip2 = freshIp();
    process.env.ABUSE_PUBLIC_MAX = '10';
    try {
      for (let i = 0; i < 10; i++) expect((await call(null, 'GET', '/public/church/GRC001', undefined, ip2)).statusCode).toBe(200);
      const r = await call(null, 'GET', '/public/church/GRC001', undefined, ip2);
      expect(r.statusCode).toBe(429);
      expect(r.json().code).toBe('rate_limited');
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      ctx.clock.advanceHours(0.02);
      expect((await call(null, 'GET', '/public/church/GRC001', undefined, ip2)).statusCode).toBe(200);
    } finally {
      delete process.env.ABUSE_PUBLIC_MAX;
    }
  });

  it('a stranger hammering sign-in from another IP does not lock the real person out (demo mode)', async () => {
    const strangerIp = freshIp();
    for (let i = 0; i < 12; i++) await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone: '0711000003', code: '000000' }, remoteAddress: strangerIp });
    const real = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone: '0711000003', code: '123456' }, remoteAddress: freshIp() });
    expect(real.statusCode).toBe(200);
  });

  it('keeps ordinary use well inside the limits', async () => {
    const ip = freshIp();
    const ev = await makeEvent('Normal use', 300);
    const free = await makeEvent('Normal free', 0);
    for (let i = 0; i < 3; i++) expect((await call(JANE, 'POST', '/me/give', { code: 'GRC001', amount: 200, method: 'mpesa', phone: '0711000001' }, ip)).statusCode).toBe(200);
    expect((await call(JANE, 'POST', '/me/tickets/orders', { eventId: free.id, method: 'mpesa', lines: [{ typeId: free.type, qty: 2 }] }, ip)).statusCode).toBe(200);
    ctx.clock.advanceHours(0.2);
    const paid = await call(JANE, 'POST', '/me/tickets/orders', { eventId: ev.id, method: 'mpesa', lines: [{ typeId: ev.type, qty: 2 }] }, ip);
    expect(paid.statusCode, paid.body).toBe(200);
    for (let i = 0; i < 20; i++) expect((await call(null, 'GET', '/public/church/GRC001', undefined, ip)).statusCode).toBe(200);
  });
});
