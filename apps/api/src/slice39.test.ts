import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { kioskFirstName } from './routes/kiosk';

/** Slice 39: kiosk mode. A paired tablet at the entrance checks people in and exposes nothing about who is a member. */

let app: Awaited<ReturnType<typeof buildApp>>['app'];
let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
const tokens: Record<string, string> = {};
async function login(phone: string) {
  if (tokens[phone]) return tokens[phone];
  const r = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: '123456' } });
  tokens[phone] = r.json().token;
  return tokens[phone];
}
const staff = async (phone: string, method: 'GET' | 'POST', url: string, payload?: any) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${await login(phone)}` } });
const kiosk = (token: string | null, method: 'GET' | 'POST', url: string, payload?: any) => app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
const q = (sql: string, p: unknown[] = []) => ctx.db.query<any>(sql, p);
const OWNER = '0700000001', HOPE = '0700000005', JANE = '0711000001';

let svc = '';
let token = '';
let deviceId = '';
async function pairNew(who = OWNER, branchId = 'br_grc001', name = 'Front door') {
  const c = (await staff(who, 'POST', '/kiosk/devices', { branchId, name })).json();
  const p = await kiosk(null, 'POST', '/kiosk/pair', { code: c.code, name });
  expect(p.statusCode).toBe(200);
  return { id: c.id as string, token: p.json().token as string };
}
const attCount = async () => Number((await q(`SELECT count(*)::int AS n FROM attendance WHERE service_id=$1`, [svc]))[0].n);

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
  const r = await staff(OWNER, 'POST', '/attendance/services', { branchId: 'br_grc001', name: 'Sunday service', startsAt: new Date(Date.now() + 5 * 60_000).toISOString(), durationMin: 90 });
  svc = r.json().id;
  const d = await pairNew();
  token = d.token;
  deviceId = d.id;
}, 60000);

describe('pairing', () => {
  it('needs attendance permission to make a code', async () => {
    expect((await kiosk(null, 'POST', '/kiosk/devices', {})).statusCode).toBe(401);
    expect((await staff(JANE, 'POST', '/kiosk/devices', { branchId: 'br_grc001' })).statusCode).toBe(403);
  });

  it('never stores the token or the code, and the device list shows neither', async () => {
    const row = (await q(`SELECT * FROM kiosk_devices WHERE id=$1`, [deviceId]))[0];
    expect(row.token_hash).toBeTruthy();
    expect(row.token_hash).not.toBe(token);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.pair_code_hash).toBeNull(); // the code works once
    const list = (await staff(OWNER, 'GET', '/kiosk/devices')).json();
    expect(JSON.stringify(list)).not.toContain(token);
    expect(list.devices.find((d: any) => d.id === deviceId)).toMatchObject({ status: 'active', branch: 'Grace Nairobi' });
  });

  it('a code works once', async () => {
    const c = (await staff(OWNER, 'POST', '/kiosk/devices', { branchId: 'br_grc001' })).json();
    expect((await kiosk(null, 'POST', '/kiosk/pair', { code: c.code })).statusCode).toBe(200);
    expect((await kiosk(null, 'POST', '/kiosk/pair', { code: c.code })).statusCode).toBe(400);
  });

  it('a wrong code is refused', async () => {
    expect((await kiosk(null, 'POST', '/kiosk/pair', { code: 'AAAA-AAAA' })).statusCode).toBe(400);
    expect((await kiosk(null, 'POST', '/kiosk/pair', {})).statusCode).toBe(400);
  });

  it('a code from another church staff member for a branch they do not hold is refused', async () => {
    expect((await staff(HOPE, 'POST', '/kiosk/devices', { branchId: 'br_grc001' })).statusCode).toBe(404);
  });
});

describe('the kiosk token', () => {
  it('shows the church, the gathering word and the open service, and nothing about people', async () => {
    const r = await kiosk(token, 'GET', '/kiosk/config');
    expect(r.statusCode).toBe(200);
    const c = r.json();
    expect(c).toMatchObject({ church: 'Grace Community Church', branch: 'Grace Nairobi', kids: false });
    expect(c.service.name).toBe('Sunday service');
    expect(c.words.oneLower).toBeTruthy();
    expect(Object.keys(c).sort()).toEqual(['branch', 'branding', 'church', 'device', 'kids', 'service', 'words']);
  });

  it('is refused on every route that is not a kiosk route', async () => {
    for (const [m, u] of [['GET', '/me/words'], ['GET', '/me/export'], ['GET', '/attendance/services'], ['GET', '/attendance/open'], ['GET', '/members'], ['GET', '/me/branding'], ['GET', '/audit/events'], ['GET', '/kiosk/devices'], ['POST', '/kiosk/devices'], ['POST', '/kiosk/devices/' + deviceId + '/revoke'], ['POST', `/attendance/services/${svc}/visitor`], ['GET', `/attendance/services/${svc}/members?q=jane`]] as const) {
      expect((await kiosk(token, m, u, {})).statusCode, `${m} ${u}`).toBe(401);
    }
  });

  it('a signed-in person token is not a kiosk token', async () => {
    expect((await kiosk(await login(OWNER), 'GET', '/kiosk/config')).statusCode).toBe(401);
    expect((await kiosk(null, 'GET', '/kiosk/config')).statusCode).toBe(401);
    expect((await kiosk('kd_forged', 'POST', '/kiosk/checkin', { phone: '0711000001' })).statusCode).toBe(401);
  });

  it('records last seen', async () => {
    expect((await q(`SELECT last_seen_at FROM kiosk_devices WHERE id=$1`, [deviceId]))[0].last_seen_at).toBeTruthy();
  });
});

describe('check-in', () => {
  it('answers a known and an unknown phone identically, so the kiosk cannot reveal who is a member', async () => {
    const known = await kiosk(token, 'POST', '/kiosk/checkin', { phone: '0711000001', firstName: 'Sam' });
    const unknown = await kiosk(token, 'POST', '/kiosk/checkin', { phone: '0799888777', firstName: 'Sam' });
    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    expect(known.json()).toEqual(unknown.json());
    expect(known.json()).toEqual({ ok: true, firstName: 'Sam', message: 'Welcome, Sam!' });
    expect(JSON.stringify(known.json())).not.toMatch(/Jane|Wanjiku/);
    // and with no name typed
    const k2 = await kiosk(token, 'POST', '/kiosk/checkin', { phone: '0711000002' });
    const u2 = await kiosk(token, 'POST', '/kiosk/checkin', { phone: '0799888555' });
    expect(k2.json()).toEqual(u2.json());
    expect(k2.json().message).toBe('Welcome! Please tell us your first name.');
    expect(JSON.stringify(k2.json())).not.toMatch(/not found|unknown|member/i);
  });

  it('records the member for the service, once only', async () => {
    const before = await attCount();
    await kiosk(token, 'POST', '/kiosk/checkin', { phone: '0711000001', firstName: 'Sam' });
    await kiosk(token, 'POST', '/kiosk/checkin', { phone: '0711000001', firstName: 'Sam' });
    expect(await attCount()).toBe(before);
    const rows = await q(`SELECT via, kind FROM attendance WHERE service_id=$1 AND membership_id='m_jane'`, [svc]);
    expect(rows).toEqual([{ via: 'kiosk', kind: 'member' }]);
    // the second tap looks the same as the first
    const again = await kiosk(token, 'POST', '/kiosk/checkin', { phone: '0711000001', firstName: 'Sam' });
    expect(again.json()).toEqual({ ok: true, firstName: 'Sam', message: 'Welcome, Sam!' });
  });

  it('a member number works the same way and an unknown number looks identical', async () => {
    const a = await kiosk(token, 'POST', '/kiosk/checkin', { memberNumber: 'm00002', firstName: 'Dave' });
    const b = await kiosk(token, 'POST', '/kiosk/checkin', { memberNumber: 'ZZ9999', firstName: 'Dave' });
    expect(a.json()).toEqual(b.json());
    expect((await q(`SELECT 1 FROM attendance WHERE service_id=$1 AND membership_id='m_david'`, [svc])).length).toBe(1);
  });

  it('a member-app QR greets by the stored first name and records once', async () => {
    const qr = (await staff(JANE, 'POST', '/me/attendance/qr', {})).json().token;
    const r = await kiosk(token, 'POST', '/kiosk/checkin', { qrToken: qr });
    expect(r.json()).toEqual({ ok: true, firstName: 'Jane', message: 'Welcome, Jane!' });
    expect((await q(`SELECT count(*)::int AS n FROM attendance WHERE service_id=$1 AND membership_id='m_jane'`, [svc]))[0].n).toBe(1);
    expect((await kiosk(token, 'POST', '/kiosk/checkin', { qrToken: 'A1.garbage' })).statusCode).toBe(400);
  });

  it('captures a visitor once with a cleaned first name', async () => {
    const r = await kiosk(token, 'POST', '/kiosk/checkin', { phone: '0733123456', firstName: "  mary-anne  http://x.co pay 123 " });
    expect(r.json()).toEqual({ ok: true, firstName: 'Mary-anne', message: 'Welcome, Mary-anne!' });
    const v = await q(`SELECT name, visits FROM visitors WHERE phone='254733123456'`);
    expect(v).toEqual([{ name: 'Mary-anne', visits: 1 }]);
    await kiosk(token, 'POST', '/kiosk/checkin', { phone: '0733123456', firstName: 'Mary' });
    expect((await q(`SELECT visits FROM visitors WHERE phone='254733123456'`))[0].visits).toBe(1);
    expect((await q(`SELECT via FROM attendance WHERE service_id=$1 AND kind='visitor'`, [svc])).every((x) => x.via === 'kiosk')).toBe(true);
  });

  it('refuses a name that has no letters left or a bad number, without saying why', async () => {
    for (const body of [{ phone: '0733000111', firstName: 'http://evil.co' }, { phone: '0733000111', firstName: '12345' }, { phone: 'abc', firstName: 'Sam' }, {}, { phone: '0733000111', memberNumber: 'M00001', firstName: 'Sam' }]) {
      const r = await kiosk(token, 'POST', '/kiosk/checkin', body);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe('Please see a greeter.');
    }
    expect(kioskFirstName('ann 123')).toBe('Ann');
    expect(kioskFirstName('x')).toBeNull();
  });

  it('answers 409 when no service is open', async () => {
    const h = await pairNew(HOPE, 'br_hpc001', 'Hope door');
    const r = await kiosk(h.token, 'POST', '/kiosk/checkin', { phone: '0711000001', firstName: 'Sam' });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('not_open');
  });
});

describe('church scope and revoking', () => {
  it("a second church's staff cannot list or revoke the first church's kiosks", async () => {
    const list = (await staff(HOPE, 'GET', '/kiosk/devices')).json();
    expect(list.devices.some((d: any) => d.id === deviceId)).toBe(false);
    expect((await staff(HOPE, 'POST', `/kiosk/devices/${deviceId}/revoke`)).statusCode).toBe(404);
    expect((await kiosk(token, 'GET', '/kiosk/config')).statusCode).toBe(200);
  });

  it("a second church's token cannot act on the first church", async () => {
    const h = await pairNew(HOPE, 'br_hpc001', 'Hope door 2');
    const cfg = (await kiosk(h.token, 'GET', '/kiosk/config')).json();
    expect(cfg.church).toBe('Hope Chapel');
    expect(cfg.service).toBeNull();
    const before = await attCount();
    await kiosk(h.token, 'POST', '/kiosk/checkin', { phone: '0711000001', firstName: 'Sam' });
    expect(await attCount()).toBe(before);
    expect((await q(`SELECT 1 FROM attendance WHERE org_id='org_hope'`)).length).toBe(0);
  });

  it('a revoked token is refused at once, and the revoke is audited', async () => {
    const d = await pairNew(OWNER, 'br_grc001', 'To revoke');
    expect((await kiosk(d.token, 'GET', '/kiosk/config')).statusCode).toBe(200);
    expect((await staff(OWNER, 'POST', `/kiosk/devices/${d.id}/revoke`)).statusCode).toBe(200);
    expect((await kiosk(d.token, 'GET', '/kiosk/config')).statusCode).toBe(401);
    expect((await kiosk(d.token, 'POST', '/kiosk/checkin', { phone: '0711000001', firstName: 'Sam' })).statusCode).toBe(401);
    const list = (await staff(OWNER, 'GET', '/kiosk/devices')).json();
    expect(list.devices.find((x: any) => x.id === d.id).status).toBe('revoked');
  });
});

describe('audit', () => {
  it('records starting, pairing, revoking and each check-in source without personal data', async () => {
    const rows = await q(`SELECT action, summary, meta::text AS meta, actor_type FROM audit_events WHERE action LIKE 'kiosk.%'`);
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ['kiosk.pairing_started', 'kiosk.paired', 'kiosk.revoked', 'kiosk.checkin']) expect(actions.has(a), a).toBe(true);
    const checkins = rows.filter((r) => r.action === 'kiosk.checkin');
    expect(checkins.length).toBeGreaterThan(3);
    for (const c of checkins) expect(c.meta).toContain('"source": "kiosk"');
    const all = JSON.stringify(rows);
    expect(all).not.toMatch(/0711000001|254711|Wanjiku|Mary/);
    expect(all).not.toContain(token);
  });
});

describe('rate limits and expiry', () => {
  it('limits a device that checks in too fast', async () => {
    const d = await pairNew(OWNER, 'br_grc001', 'Busy');
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) codes.push((await kiosk(d.token, 'POST', '/kiosk/checkin', { phone: `07220000${String(10 + i).padStart(2, '0')}`, firstName: 'Tim' })).statusCode);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes[30]).toBe(429);
    const r = await kiosk(d.token, 'POST', '/kiosk/checkin', { phone: '0722000099', firstName: 'Tim' });
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBeTruthy();
    // another device is not held back by this one
    expect((await kiosk(token, 'POST', '/kiosk/checkin', { phone: '0722000098', firstName: 'Tim' })).statusCode).toBe(200);
  });

  it('limits guesses of pairing codes per address', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 20; i++) codes.push((await kiosk(null, 'POST', '/kiosk/pair', { code: 'BBBB-BBBB' })).statusCode);
    expect(codes).toContain(429);
  });

  it('a pairing code expires after ten minutes', async () => {
    const c = (await staff(OWNER, 'POST', '/kiosk/devices', { branchId: 'br_grc001' })).json();
    expect(c.minutes).toBe(10);
    ctx.clock.advance(11 * 60_000); // also frees the address from the guessing limit above
    const r = await kiosk(null, 'POST', '/kiosk/pair', { code: c.code });
    expect(r.statusCode).toBe(400);
    const list = (await staff(OWNER, 'GET', '/kiosk/devices')).json();
    expect(list.devices.find((x: any) => x.id === c.id).status).toBe('expired');
  });
});
