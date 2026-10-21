import { deflateSync } from 'node:zlib';
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

const OWNER = '0700000001', ADMIN = '0700000003', HOPE = '0700000005', JANE = '0711000001';

// A plain coloured square PNG of the given size, made without any image library.
const crc = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }; })();
const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([len, body, c]); };
const png = (size: number, rgb = [14, 90, 82]) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(size * 3 + 1); for (let x = 0; x < size; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2]; }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
};
const body = (extra: any = {}) => ({
  logo: png(256), bgColor: '#ffffff', themeColor: '#0e5a52',
  icons: { 'icon-192.png': png(192), 'icon-512.png': png(512), 'icon-maskable.png': png(512), 'apple-touch-icon.png': png(180), 'favicon-32.png': png(32) },
  ...extra,
});

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);

describe('a church uploads its own logo (Slice 26)', () => {
  it('starts with no logo, and only the owner can see the setting is theirs', async () => {
    expect((await call(JANE, 'GET', '/me/branding')).json()).toMatchObject({ orgId: 'org_grace', hasLogo: false, canChange: false, name: 'Grace Community Church' });
    expect((await call(OWNER, 'GET', '/me/branding')).json().canChange).toBe(true);
    expect((await call(ADMIN, 'GET', '/me/branding')).json().canChange).toBe(false);
    expect((await call(null, 'GET', '/me/branding')).statusCode).toBe(401);
    expect((await call(null, 'GET', '/public/branding/org_grace/icon-192.png')).statusCode).toBe(404);
  });

  it('refuses anyone but the owner, and refuses anything that is not the right picture', async () => {
    expect((await call(ADMIN, 'PUT', '/church/branding', body())).statusCode).toBe(403);
    expect((await call(JANE, 'PUT', '/church/branding', body())).statusCode).toBeGreaterThanOrEqual(403);
    expect((await call(OWNER, 'PUT', '/church/branding', body({ logo: Buffer.from('<svg/>').toString('base64') }))).json().code).toBe('bad_image');
    expect((await call(OWNER, 'PUT', '/church/branding', body({ icons: { ...body().icons, 'icon-192.png': png(100) } }))).json().code).toBe('bad_image');
    expect((await call(OWNER, 'PUT', '/church/branding', body({ icons: { ...body().icons, 'favicon-32.png': undefined } }))).json().code).toBe('bad_image');
    expect((await call(OWNER, 'PUT', '/church/branding', body({ bgColor: 'red' }))).json().code).toBe('bad_colour');
    expect((await call(OWNER, 'PUT', '/church/branding', body({ logo: png(2000) }))).json().code).toBe('bad_image'); // too large
  });

  it('keeps the logo and serves each picture without a sign-in, with the version moving on each change', async () => {
    const r = await call(OWNER, 'PUT', '/church/branding', body());
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ hasLogo: true, version: 1, themeColor: '#0e5a52', bgColor: '#ffffff' });
    for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable.png', 512], ['apple-touch-icon.png', 180], ['favicon-32.png', 32], ['logo.png', 256]] as const) {
      const f = await call(null, 'GET', `/public/branding/org_grace/${file}`);
      expect(f.statusCode, file).toBe(200);
      expect(f.headers['content-type']).toBe('image/png');
      expect(f.rawPayload.readUInt32BE(16), file).toBe(size);
    }
    expect((await call(null, 'GET', '/public/branding/org_grace/secret.png')).statusCode).toBe(404);
    expect((await call(null, 'GET', '/public/branding/org_hope/icon-192.png')).statusCode).toBe(404); // another church has none
    expect((await call(JANE, 'GET', '/me/branding')).json()).toMatchObject({ hasLogo: true, version: 1 });
    expect((await call(HOPE, 'GET', '/me/branding')).json().hasLogo).toBe(false); // each church has its own
    expect((await call(null, 'GET', '/public/branding/org_grace')).json()).toMatchObject({ hasLogo: true, name: 'Grace Community Church' });
    expect((await call(OWNER, 'PUT', '/church/branding', body({ bgColor: '#123456' }))).json().version).toBe(2);
  });

  it('reaches the public giving page, and can be removed', async () => {
    const g = (await call(null, 'GET', '/public/church/GRC001')).json();
    expect(g.branding).toMatchObject({ orgId: 'org_grace', hasLogo: true, version: 2 });
    expect((await call(ADMIN, 'POST', '/church/branding/remove', {})).statusCode).toBe(403);
    expect((await call(OWNER, 'POST', '/church/branding/remove', {})).json()).toMatchObject({ hasLogo: false });
    expect((await call(null, 'GET', '/public/branding/org_grace/icon-192.png')).statusCode).toBe(404);
    expect((await call(OWNER, 'POST', '/church/branding/remove', {})).json().code).toBe('not_found');
    expect((await call(null, 'GET', '/public/church/GRC001')).json().branding.hasLogo).toBe(false);
    for (const a of ['church.branding', 'church.branding_removed']) expect((await call('0700000099', 'GET', `/admin/audit/events?action=${a}`)).json().events.length, a).toBeGreaterThan(0);
  });
});

describe('the logo reaches the ticket and check-in pages', () => {
  it('is on the public event and check-in responses', async () => {
    expect((await call(OWNER, 'PUT', '/church/branding', body())).statusCode).toBe(200);
    const day = new Date(ctx.clock.now().getTime() + 30 * 86_400_000).toISOString();
    const id = (await call(OWNER, 'POST', '/events', { title: 'Brand night', audience: { type: 'org' }, startsAt: day, endsAt: new Date(Date.parse(day) + 3600_000).toISOString() })).json().id;
    await call(OWNER, 'PUT', `/events/${id}/ticketing`, { ticketed: true, types: [{ name: 'Regular', price: 100, quantity: 5 }] });
    const code = (await call(OWNER, 'GET', `/events/${id}/tickets`)).json().code;
    expect((await call(null, 'GET', `/public/event/${code}`)).json().branding).toMatchObject({ orgId: 'org_grace', hasLogo: true });
    const svc = (await call(OWNER, 'POST', '/attendance/services', { branchId: 'br_grc001', name: 'Brand service', startsAt: new Date(ctx.clock.now().getTime() + 600_000).toISOString(), durationMin: 60 })).json().id;
    const door = (await call(ADMIN, 'GET', `/attendance/services/${svc}/door`)).json();
    expect((await call(null, 'GET', `/public/here/${door.url.split('/here/')[1]}`)).json().branding).toMatchObject({ hasLogo: true });
  });
});
