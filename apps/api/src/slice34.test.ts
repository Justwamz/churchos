import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { gradientPng } from './artwork';
import { checkUpload, cleanFileName } from './uploads';
import { checkEmail } from './email-rules';
import { csv } from './routes/helpers';
import { dateParam, int, intParam, likeEscape, parseKes, str } from './limits';
import { safeReturn } from '../../giving/src/safeReturn';

/**
 * Slice 34: input handling fixes (IN-01 to IN-10, IN-12, IN-13, IN-15, LG-19): strict money, CSV neutralising,
 * the checkout return link, upload checks, text caps, string strictness, email suffix rules and LIKE escaping.
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
const call = async (phone: string | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: any, extra: Record<string, string> = {}) =>
  app.inject({ method, url, payload, headers: { ...(phone ? { authorization: `Bearer ${await login(phone)}` } : {}), ...extra } });

const OWNER = '0700000001', TREAS = '0700000002', ADMIN = '0700000003', JANE = '0711000001';
const today = () => new Date(ctx.clock.now().getTime() + 3 * 3600_000).toISOString().slice(0, 10);

// ---------- fixtures ----------
const jpeg = (w: number, h: number, pad = 0) => Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]),
  Buffer.alloc(pad, 7), Buffer.from([0xff, 0xd9]),
]);
const webp = (w: number, h: number) => {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0); b.writeUInt32LE(32, 4); b.write('WEBP', 8); b.write('VP8X', 12); b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return b;
};
const pdf = () => Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const png = (w = 40, h = 40) => Buffer.from(gradientPng(w, h, [200, 200, 200], [20, 20, 20]), 'base64');
/** 78-byte PNG claiming 64000 x 36000 pixels (IN-06). */
const bombPng = () => {
  const b = Buffer.alloc(78);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(64000, 16); b.writeUInt32BE(36000, 20); b[24] = 8; b[25] = 2;
  b.writeUInt32BE(10, 33); b.write('IDAT', 37);
  b.writeUInt32BE(0, 62); b.write('IEND', 66);
  return b;
};
const b64 = (b: Buffer) => b.toString('base64');

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);

describe('parseKes (IN-01, IN-02, LG-19)', () => {
  const err = (v: unknown, o?: any) => { try { parseKes(v, o); } catch (e: any) { return e; } return null; };
  it('accepts plain numbers and decimal strings', () => {
    expect(parseKes(1500)).toBe(150000);
    expect(parseKes('1500.50')).toBe(150050);
    expect(parseKes('0', { min: 0 })).toBe(0);
  });
  it('rejects the lenient forms with a 400 bad_amount', () => {
    for (const v of ['1,000', '12abc', '1e3', '0x10', '12.345', '+5', '-5', NaN, Infinity, [5], { a: 1 }, null, undefined, '']) {
      const e = err(v, { min: 1 });
      expect(e?.status, JSON.stringify(v)).toBe(400);
      expect(e?.code).toBe('bad_amount');
    }
  });
  it('gives a helpful message for commas and names the limit', () => {
    expect(err('1,000', { label: 'the pledge' })?.message).toMatch(/no commas/);
    expect(err(2_000_000, { max: 1_000_000, label: 'the price' })?.message).toMatch(/KES 1,000,000/);
    expect(err(0, { min: 1 })?.message).toMatch(/between KES 1 and/);
  });
});

describe('money routes use the strict parser', () => {
  it('a member pledging 1e17, "1,000", 12.345, 1e3, hex, array or object gets 400', async () => {
    for (const amount of [1e17, '1,000', 12.345, '1e3', '0x10', [100], { a: 1 }, 90_000_000_000_000]) {
      const r = await call(JANE, 'POST', '/me/pledges', { churchCode: 'GRC001', projectCode: 'ROOF', amount });
      expect(r.statusCode, JSON.stringify(amount)).toBe(400);
      expect(r.json().code).toBe('bad_amount');
    }
    expect((await call(JANE, 'POST', '/me/pledges', { churchCode: 'GRC001', projectCode: 'ROOF', amount: '1,000' })).json().error).toMatch(/commas/);
    expect((await call(JANE, 'POST', '/me/pledges', { churchCode: 'GRC001', projectCode: 'ROOF', amount: 5000 })).statusCode).toBe(200);
    expect((await call(JANE, 'POST', '/me/pledges', { churchCode: 'GRC001', projectCode: 'ROOF', amount: '2500.50' })).statusCode).toBe(200);
  });
  it('public and member giving', async () => {
    for (const amount of ['1,000', '12abc', 1e17, '100.123', ['100']]) {
      const r = await call(null, 'POST', '/public/give', { code: 'GRC001', purpose: 'TITHE', phone: '0712000111', amount, method: 'mpesa' });
      expect(r.statusCode, JSON.stringify(amount)).toBe(400);
    }
    expect((await call(null, 'POST', '/public/give', { code: 'GRC001', purpose: 'TITHE', phone: '0712000111', amount: 2_000_000, method: 'mpesa' })).statusCode).toBe(400);
    expect((await call(null, 'POST', '/public/give', { code: 'GRC001', purpose: 'TITHE', phone: '0712000111', amount: 100, method: 'mpesa' })).statusCode).toBe(200);
    expect((await call(null, 'GET', '/public/fee?code=GRC001&amount=1e3&method=mpesa')).statusCode).toBe(400);
  });
  it('cash counts and project targets', async () => {
    const cash = (amount: any) => call(TREAS, 'POST', '/cash', { branchId: 'br_grc001', amount, purpose: 'OFFERING' });
    for (const a of [1e17, 2 ** 53, '1,000', 10_000_001, '5.555', 0, -5]) expect((await cash(a)).statusCode, String(a)).toBe(400);
    expect((await cash(1500.5)).statusCode).toBe(200);
    const proj = (target: any, code: string) => call(OWNER, 'POST', '/projects', { branchId: 'br_grc001', code, name: 'Probe ' + code, target });
    for (const t of [1e17, '1,000,000', 2_000_000_000, 0]) expect((await proj(t, 'PRBA')).statusCode, String(t)).toBe(400);
    expect((await proj(900_000_000, 'PRBB')).statusCode).toBe(200);
  });
  it('expenses, ticket prices, shop prices, wallet top-ups, advert and booking prices', async () => {
    const cats = (await call(OWNER, 'GET', '/expenses/setup')).json().categories;
    const rec = (amount: any) => call(TREAS, 'POST', '/expenses', { branchId: 'br_grc001', date: today(), amount, categoryId: cats[0].id, payee: 'Shop', method: 'mpesa', noReceiptReason: 'small' });
    for (const a of ['1,000', 1e17, '0x1', 1_000_001, '10.001']) expect((await rec(a)).statusCode, String(a)).toBe(400);
    expect((await rec(100)).statusCode).toBe(200);

    const ev = (await call(OWNER, 'POST', '/events', { title: 'Money probe', audience: { type: 'org' }, startsAt: new Date(ctx.clock.now().getTime() + 5 * 86400_000).toISOString(), endsAt: new Date(ctx.clock.now().getTime() + 5.1 * 86400_000).toISOString(), location: 'Hall' })).json().id;
    const tick = (price: any, quantity: any = 10) => call(OWNER, 'PUT', `/events/${ev}/ticketing`, { ticketed: true, refundDaysBefore: 3, types: [{ name: 'Reg', price, quantity }] });
    for (const p of ['1,000', 1e17, 200_000, '12.345', [5]]) expect((await tick(p)).statusCode, String(p)).toBe(400);
    expect((await tick('500.50')).statusCode).toBe(200);

    const item = (price: any) => call(OWNER, 'POST', '/shop/items', { branchId: 'br_grc001', name: 'Probe item ' + Math.random(), price });
    for (const p of ['1,000', 1e17, 2_000_000, '1e2']) expect((await item(p)).statusCode, String(p)).toBe(400);

    const wallet = (await call(OWNER, 'GET', '/wallets')).json();
    const wid = (Array.isArray(wallet) ? wallet : wallet.wallets ?? [])[0]?.id;
    if (wid) {
      for (const a of ['1,000', 1e17, 'abc']) expect((await call(OWNER, 'POST', `/wallets/${wid}/topup`, { amount: a, method: 'card' })).statusCode, String(a)).toBe(400);
    }
  });
});

describe('strings must be strings (IN-13)', () => {
  it('sign-in code and event/church codes as arrays are refused', async () => {
    expect((await call(null, 'POST', '/auth/otp/verify', { phone: '0700000001', code: ['123456'] })).statusCode).toBe(400);
    expect((await call(null, 'POST', '/auth/otp/verify', { phone: ['0700000001'], code: '123456' })).statusCode).toBe(400);
    expect((await call(null, 'POST', '/public/give', { code: ['GRC001'], purpose: 'TITHE', phone: '0712000111', amount: 100, method: 'mpesa' })).statusCode).toBe(400);
    expect((await call(null, 'POST', '/public/tickets/orders', { code: ['X'], name: 'A', email: 'a@gmail.com', lines: [] })).statusCode).toBe(400);
  });
  it('a ticket quantity of [2] is refused', async () => {
    const ev = (await call(OWNER, 'POST', '/events', { title: 'Qty probe', audience: { type: 'org' }, startsAt: new Date(ctx.clock.now().getTime() + 5 * 86400_000).toISOString(), endsAt: new Date(ctx.clock.now().getTime() + 5.1 * 86400_000).toISOString(), location: 'Hall' })).json().id;
    await call(OWNER, 'PUT', `/events/${ev}/ticketing`, { ticketed: true, refundDaysBefore: 3, types: [{ name: 'Reg', price: 0, quantity: 10 }] });
    const s = (await call(OWNER, 'GET', `/events/${ev}/tickets`)).json();
    const r = await call(null, 'POST', '/public/tickets/orders', { code: s.code, name: 'Alice Test', email: 'alice.real@gmail.com', lines: [{ typeId: s.types[0].id, qty: [2] }] });
    expect(r.statusCode).toBe(400);
  });
  it('str and int helpers', () => {
    expect(str('  hi ', { max: 5 })).toBe('hi');
    expect(() => str(['a'])).toThrow();
    expect(() => str({}, {})).toThrow();
    expect(() => str('x'.repeat(10), { max: 5 })).toThrow(/too long/);
    expect(int('5')).toBe(5);
    expect(() => int([2])).toThrow();
    expect(() => int(2.5)).toThrow();
    expect(() => int(5000)).toThrow();
  });
  it('a member name over 80 characters is refused with too_long', async () => {
    const r = await call(OWNER, 'POST', '/members', { branchId: 'br_grc001', fullName: 'N'.repeat(81), category: 'adult', phone: '0722000111' });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('too_long');
  });
});

describe('CSV injection (IN-03)', () => {
  it('csv() neutralises formulas but leaves numbers alone', () => {
    const out = csv([{ a: '=1+1', b: '+254700000000', c: '-cmd', d: '@SUM(A1)', e: '\tx', f: -500, g: '-500', h: 'plain', i: 12.5, j: '=HYPERLINK("http://x","y")' }]).split('\n')[1];
    expect(out).toContain("'=1+1");
    expect(out).toContain("'+254700000000");
    expect(out).toContain("'-cmd");
    expect(out).toContain("'@SUM(A1)");
    expect(out).toContain("'\tx");
    expect(out).toContain(',-500,-500,plain,12.5,');
    expect(out).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
  });
  it('the audit export clamps the app header and neutralises payees', async () => {
    await call(OWNER, 'POST', '/church/branding/remove', {}, { 'x-churchos-app': '=cmd|calc' });
    const cats = (await call(OWNER, 'GET', '/expenses/setup')).json().categories;
    const rec = await call(TREAS, 'POST', '/expenses', { branchId: 'br_grc001', date: today(), amount: 100, categoryId: cats[0].id, payee: '=HYPERLINK("http://evil","pay")', method: 'mpesa', noReceiptReason: 'x' }, { 'x-churchos-app': '@evil' });
    expect(rec.statusCode).toBe(200);
    const exp = (await call(TREAS, 'GET', '/expenses?csv=1')).body;
    expect(exp).toContain(`'=HYPERLINK`);
    expect(exp.split('\n').some((l) => /(^|,)=HYPERLINK/.test(l))).toBe(false);
    const apps = (await q(`SELECT DISTINCT app FROM audit_events WHERE app IS NOT NULL`)).map((r) => r.app);
    expect(apps.every((a: string) => ['staff', 'member', 'giving', 'admin', 'unknown'].includes(a))).toBe(true);
    expect(apps).toContain('unknown');
    const audit = (await call(OWNER, 'GET', '/audit/export')).body;
    expect(audit.split('\n').every((l) => !/(^|,)[=@]/.test(l))).toBe(true);
  });
});
const q = (sql: string, p: unknown[] = []) => ctx.db.query<any>(sql, p);

describe('checkout return link (IN-04)', () => {
  const here = { href: 'https://give.example.org/checkout/x?return=1', origin: 'https://give.example.org', hostname: 'give.example.org' };
  it('accepts same-origin and listed origins, rebuilds from the parsed address', () => {
    expect(safeReturn('/thanks?a=1#x', here)).toBe('/thanks?a=1#x');
    expect(safeReturn('https://give.example.org/p', here)).toBe('/p');
    expect(safeReturn('https://member.example.org/#inbox', here, { allowedOrigins: ['https://member.example.org'] })).toBe('https://member.example.org/#inbox');
  });
  it('refuses javascript:, data:, other hosts, credentials and junk', () => {
    for (const bad of ['javascript://give.example.org/%0aalert(1)', 'javascript:alert(1)', 'data:text/html,x', 'https://evil.com/', '//evil.com', 'https://give.example.org@evil.com/', 'https://user:pw@give.example.org/', 'ftp://give.example.org/', '']) {
      expect(safeReturn(bad, here), bad).toBe('/');
    }
    expect(safeReturn('http://localhost:3002/x', { href: 'http://localhost:3001/', origin: 'http://localhost:3001', hostname: 'localhost' }, { dev: true })).toBe('http://localhost:3002/x');
    expect(safeReturn('http://localhost:3002/x', { href: 'http://localhost:3001/', origin: 'http://localhost:3001', hostname: 'localhost' }, { dev: false })).toBe('/');
  });
});

describe('uploads (IN-05 to IN-08)', () => {
  it('accepts valid PNG, JPEG, WebP and PDF and reports the sniffed type', () => {
    expect(checkUpload(png(), 'image/png')).toMatchObject({ mime: 'image/png', width: 40, height: 40 });
    expect(checkUpload(jpeg(800, 600), 'image/jpeg')).toMatchObject({ mime: 'image/jpeg', width: 800, height: 600 });
    expect(checkUpload(webp(1280, 720), 'image/webp')).toMatchObject({ mime: 'image/webp', width: 1280, height: 720 });
    expect(checkUpload(pdf(), 'application/pdf')).toMatchObject({ mime: 'application/pdf', kind: 'pdf' });
  });
  it('rejects mismatches, unknown bytes, wrong kinds and empty files', () => {
    expect(() => checkUpload(png(), 'image/jpeg')).toThrow();
    expect(() => checkUpload(pdf(), 'image/png')).toThrow();
    expect(() => checkUpload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml')).toThrow();
    expect(() => checkUpload(Buffer.from('MZ\x90\x00'), 'application/pdf')).toThrow();
    expect(() => checkUpload(pdf(), 'application/pdf', { kinds: ['image'] })).toThrow();
    expect(() => checkUpload(Buffer.alloc(0), 'image/png')).toThrow();
    expect(() => checkUpload(png(), 'image/png', { maxBytes: 10 })).toThrow();
  });
  it('rejects the 78-byte PNG that claims 64000 x 36000 pixels, and oversized dimensions', () => {
    const bomb = bombPng();
    expect(bomb.length).toBe(78);
    expect(() => checkUpload(bomb, 'image/png')).toThrow();
    expect(() => checkUpload(jpeg(13000, 100), 'image/jpeg')).toThrow(/too large/);
    expect(() => checkUpload(jpeg(7000, 7000), 'image/jpeg')).toThrow(/too large/); // 49 megapixels
    expect(() => checkUpload(webp(20000, 20000), 'image/webp')).toThrow(/too large/);
  });
  it('sanitises file names', () => {
    expect(cleanFileName('../../etc/passwd')).toBe('passwd');
    expect(cleanFileName('C:\\Users\\x\\scan.pdf')).toBe('scan.pdf');
    expect(cleanFileName('Receipt \u2014 Mary\r\nSet-Cookie: x.pdf')).toBe('Receipt \u2014 MarySet-Cookie: x.pdf');
    expect(cleanFileName('Mwanzo wa Maisha \u00e9\u00e8.png')).toBe('Mwanzo wa Maisha \u00e9\u00e8.png');
    expect(cleanFileName('a'.repeat(300)).length).toBe(100);
    expect(cleanFileName('\u0000\u0001')).toBe('file');
  });
  it('expense receipts: a PNG labelled JPEG or a bomb is refused; three 1.2 MB JPEGs are accepted and stored with the sniffed type', async () => {
    const cats = (await call(OWNER, 'GET', '/expenses/setup')).json().categories;
    const rec = (files: any[]) => call(TREAS, 'POST', '/expenses', { branchId: 'br_grc001', date: today(), amount: 120, categoryId: cats[0].id, payee: 'Upload test', method: 'mpesa', files });
    expect((await rec([{ name: 'r.jpg', mime: 'image/jpeg', data: b64(png()) }])).json().code).toBe('bad_file');
    expect((await rec([{ name: 'r.png', mime: 'image/png', data: b64(bombPng()) }])).json().code).toBe('bad_file');
    expect((await rec([{ name: 'r.pdf', mime: 'application/pdf', data: b64(Buffer.from('not a pdf')) }])).json().code).toBe('bad_file');
    const big = b64(jpeg(1600, 1200, 899_000));
    expect(big.length).toBeLessThanOrEqual(1_200_000);
    const ok = await rec([{ name: '../a/one.jpg', mime: 'image/jpeg', data: big }, { name: 'two.jpg', mime: 'image/jpeg', data: big }, { name: 'three.jpg', mime: 'image/jpeg', data: big }]);
    expect(ok.statusCode).toBe(200);
    const row = (await q(`SELECT name, mime FROM expense_files WHERE expense_id=$1 ORDER BY name`, [ok.json().id]));
    expect(row.map((r) => r.mime)).toEqual(['image/jpeg', 'image/jpeg', 'image/jpeg']);
    expect(row.map((r) => r.name)).toContain('one.jpg');
  });
  it('KYC documents are checked the same way', async () => {
    const up = (mime: string, data: Buffer) => call(OWNER, 'POST', '/kyc/documents', { type: 'registration_certificate', filename: 'x.pdf', mime, data: b64(data) });
    const r1 = await up('application/pdf', Buffer.from('MZ not a pdf'));
    expect(r1.statusCode).toBe(400);
    expect(r1.json().code).toBe('bad_file_type');
    expect((await up('image/png', pdf())).statusCode).toBe(400);
  });
  it('certificate logos: PNG and JPEG only, SVG refused', async () => {
    const base = (await call(ADMIN, 'GET', '/certificates/template')).json().config;
    const put = (logo: any) => call(ADMIN, 'PUT', '/certificates/template', { config: base, logo });
    const svg = (await put({ mime: 'image/svg+xml', data: b64(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')) }));
    expect(svg.statusCode).toBe(400);
    expect(svg.json().code).toBe('bad_logo');
    expect((await put({ mime: 'image/png', data: b64(Buffer.from('<svg/>')) })).json().code).toBe('bad_logo');
    expect((await put({ mime: 'image/png', data: b64(png(64, 64)) })).statusCode).toBe(200);
    expect((await put({ mime: 'image/jpeg', data: b64(jpeg(64, 64, 100)) })).statusCode).toBe(200);
  });
  it('event posters and shop pictures use the shared checker', async () => {
    const id = (await call(OWNER, 'POST', '/events', { title: 'Poster probe', audience: { type: 'org' }, startsAt: new Date(ctx.clock.now().getTime() + 6 * 86400_000).toISOString(), endsAt: new Date(ctx.clock.now().getTime() + 6.1 * 86400_000).toISOString(), location: 'Hall' })).json().id;
    const poster = (mime: string, d: Buffer) => call(OWNER, 'POST', `/events/${id}/poster`, { image: { mime, data: b64(d) } });
    expect((await poster('image/png', bombPng())).json().code).toBe('bad_artwork');
    expect((await poster('image/jpeg', jpeg(1280, 720, 100))).statusCode).toBe(200);
    expect((await poster('image/png', jpeg(1280, 720, 100))).json().code).toBe('bad_artwork');
  });
});

describe('text caps, email rules and LIKE escaping (IN-09, IN-10, IN-12, IN-15)', () => {
  it('email domains match by suffix', () => {
    for (const e of ['mary.wanjiku@sub.mailinator.com', 'mary.wanjiku@foo.example.com', 'mary.wanjiku@a.b.guerrillamail.com', 'mary.wanjiku@mailinator.com']) expect(checkEmail(e).ok, e).toBe(false);
    expect(checkEmail('mary.wanjiku@gmail.com').ok).toBe(true);
    expect(checkEmail('mary.wanjiku@notmailinator.com').ok).toBe(true);
  });
  it('likeEscape makes % and _ literal', async () => {
    expect(likeEscape('50%_off\\')).toBe('50\\%\\_off\\\\');
    const t = ctx.clock.now().toISOString();
    for (const [id, n] of [['sg_a', 'Plain words'], ['sg_b', '100% sure'], ['sg_c', 'under_score']]) {
      await q(`INSERT INTO suggestions (id, org_id, branch_id, membership_id, author_name, category, body, status, created_at, updated_at) VALUES ($1,'org_grace','br_grc001',(SELECT id FROM memberships WHERE org_id='org_grace' LIMIT 1),'Tester','other',$2,'new',$3,$3)`, [id, n, t]).catch(() => undefined);
    }
    const rows = await q(`SELECT body FROM suggestions WHERE body ILIKE $1 ESCAPE '\\'`, [`%${likeEscape('%')}%`]);
    expect(rows.every((r) => r.body.includes('%'))).toBe(true);
    const members = await call(OWNER, 'GET', '/members?q=%25%25');
    expect(members.statusCode).toBe(200);
    expect((members.json().rows ?? members.json()).length ?? 0).toBe(0);
  });
  it('intParam and dateParam', () => {
    expect(intParam('abc', { min: 1, max: 200, def: 50 })).toBe(50);
    expect(intParam('9999', { min: 1, max: 200, def: 50 })).toBe(200);
    expect(intParam('-3', { min: 1, max: 200, def: 50 })).toBe(1);
    expect(intParam(undefined, { min: 1, max: 200, def: 50 })).toBe(50);
    expect(dateParam('2026-02-30')).toBeUndefined();
    expect(dateParam('2026-02-28')).toBe('2026-02-28');
    expect(dateParam('x\u0000')).toBeUndefined();
  });
  it('list endpoints with limit=abc and bad dates answer 200 or 400, never 500', async () => {
    for (const url of ['/audit/events?limit=abc', '/audit/events?from=notadate', '/audit/events?q=%00', '/expenses?year=abc', '/help/search?q=a&limit=zzz']) {
      const r = await call(OWNER, 'GET', url);
      expect(r.statusCode, url).toBeLessThan(500);
    }
  });
  it('branding file names __proto__ and constructor give 404', async () => {
    for (const f of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect((await call(null, 'GET', `/public/branding/org_grace/${f}`)).statusCode, f).toBe(404);
    }
  });
});
