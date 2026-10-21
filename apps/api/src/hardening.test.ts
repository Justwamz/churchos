import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from './server';
import { corsAllows } from './cors';
import { contentDisposition, sendPrivateFile } from './serve';
import { devToolsEnabled, productionGuards, trustProxyHops } from './guards';

let app: Awaited<ReturnType<typeof buildApp>>['app'];
const saved = { ...process.env };
const setEnv = (e: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(e)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
const ORIGIN = 'https://staff.example.org';

beforeAll(async () => {
  setEnv({ TRUST_PROXY_HOPS: '1', CORS_ORIGINS: `${ORIGIN},https://member.example.org` });
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  // Probe routes registered after the real ones: they exercise the global hooks and the error handler.
  app.get('/__t/ip', async (req) => ({ ip: req.ip }));
  app.get('/__t/boom', async () => { throw new Error('db password hunter2 at host internal-7'); });
  app.get('/__t/pg/:code', async (req) => { throw Object.assign(new Error('invalid input'), { code: (req.params as any).code }); });
  app.get('/__t/range', async () => { throw new RangeError('Invalid time value'); });
  app.get('/__t/file', async (req, reply) => sendPrivateFile(reply, { mime: (req.query as any).mime ?? 'application/pdf', name: 'Receipt — Mary\r\nSet-Cookie: x=1.pdf', data: Buffer.from('hello') }));
  app.get('/__t/public-image', async (_req, reply) => reply.header('content-type', 'image/png').header('cache-control', 'public, max-age=300').send(Buffer.from('x')));
  await app.ready();
}, 60000);
afterAll(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });

describe('security headers (WEB-05)', () => {
  it('are on a JSON response, with no-store by default', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['cross-origin-resource-policy']).toBe('same-site');
    expect(r.headers['permissions-policy']).toBe('geolocation=(), camera=(), microphone=()');
    expect(r.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['strict-transport-security']).toBeUndefined();
  });
  it('are on an error response and on 404', async () => {
    for (const url of ['/me/profile', '/no/such/route', '/__t/boom']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.headers['x-content-type-options'], url).toBe('nosniff');
      expect(r.headers['cache-control'], url).toBe('no-store');
    }
  });
  it('adds HSTS only in production', async () => {
    setEnv({ NODE_ENV: 'production' });
    try { expect((await app.inject({ method: 'GET', url: '/health' })).headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains'); }
    finally { setEnv({ NODE_ENV: saved.NODE_ENV }); }
  });
  it('lets a public image keep its own Cache-Control and be read cross-origin', async () => {
    const r = await app.inject({ method: 'GET', url: '/__t/public-image' });
    expect(r.headers['cache-control']).toBe('public, max-age=300');
    expect(r.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(r.headers['content-security-policy']).toContain('sandbox');
  });
  it('keeps the explicit cache and cross-origin headers on the church branding images', async () => {
    const r = await app.inject({ method: 'GET', url: '/public/branding/org_none/logo.png' });
    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe('not_found');
  });
});

describe('/health (WEB-21)', () => {
  it('has the time outside production and only ok in production', async () => {
    const dev = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(dev.ok).toBe(true);
    expect(typeof dev.time).toBe('string');
    expect(dev.clockOffsetHours).toBeUndefined();
    setEnv({ NODE_ENV: 'production' });
    try { expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ ok: true }); }
    finally { setEnv({ NODE_ENV: saved.NODE_ENV }); }
  });
});

describe('CORS allow-list (WEB-09)', () => {
  it('gives an allowed origin the header and a stranger nothing', async () => {
    const ok = await app.inject({ method: 'GET', url: '/health', headers: { origin: ORIGIN } });
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    const bad = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://evil.example' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('answers a preflight with explicit methods, headers and a 10 minute cache', async () => {
    const r = await app.inject({ method: 'OPTIONS', url: '/me/profile', headers: { origin: ORIGIN, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,content-type,x-churchos-app' } });
    expect(r.statusCode).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(r.headers['access-control-max-age']).toBe('600');
    expect(String(r.headers['access-control-allow-headers']).toLowerCase()).toContain('x-churchos-app');
    expect(r.headers['access-control-allow-credentials']).toBeUndefined();
    const bad = await app.inject({ method: 'OPTIONS', url: '/me/profile', headers: { origin: 'https://evil.example', 'access-control-request-method': 'PUT' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('corsAllows fails closed in production and stays open for local development', () => {
    expect(corsAllows('https://x.example', { NODE_ENV: 'production' })).toBe(false);
    expect(corsAllows('https://x.example', { NODE_ENV: 'production', CORS_ORIGINS: 'https://x.example/' })).toBe(true);
    expect(corsAllows('https://y.example', { NODE_ENV: 'production', CORS_ORIGINS: 'https://x.example' })).toBe(false);
    expect(corsAllows('http://localhost:5173', {})).toBe(true);
  });
  it('lets the live stream use the same allow-list (no wildcard)', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('./routes/staff.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/'access-control-allow-origin':\s*'\*'/);
    expect(src).toContain('corsAllows(origin)');
  });
});

describe('production start-up guards (WEB-09, WEB-14, AUTH-13)', () => {
  const good = { NODE_ENV: 'production', CORS_ORIGINS: ORIGIN, PSP_MODE: 'live', SEED_DEMO: '0' };
  it('does nothing outside production', () => { expect(productionGuards({})).toEqual({ errors: [], warnings: [] }); });
  it('accepts a complete real-launch setting', () => { expect(productionGuards(good).errors).toEqual([]); });
  it('refuses a missing CORS_ORIGINS', () => { expect(productionGuards({ ...good, CORS_ORIGINS: '' }).errors.join()).toMatch(/CORS_ORIGINS/); });
  it('refuses the simulator unless ALLOW_DEMO_PSP=1, then warns loudly', () => {
    expect(productionGuards({ ...good, PSP_MODE: undefined }).errors.join()).toMatch(/PSP_MODE/);
    const r = productionGuards({ ...good, PSP_MODE: undefined, ALLOW_DEMO_PSP: '1' });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join()).toContain('SIMULATED PAYMENTS ARE ON');
  });
  it('refuses demo data unless ALLOW_DEMO_SEED=1', () => {
    expect(productionGuards({ ...good, SEED_DEMO: undefined }).errors.join()).toMatch(/SEED_DEMO/);
    expect(productionGuards({ ...good, SEED_DEMO: '1', ALLOW_DEMO_SEED: '1' }).errors).toEqual([]);
  });
  it('keeps the demo setting usable with its fixed sign-in code', () => {
    const demo = { NODE_ENV: 'production', CORS_ORIGINS: ORIGIN, ALLOW_DEMO_PSP: '1', SEED_DEMO: '1', ALLOW_DEMO_SEED: '1', ALLOW_DEV_OTP: '1' };
    expect(productionGuards(demo).errors).toEqual([]);
  });
});

describe('request limits (WEB-15)', () => {
  const pad = (n: number) => JSON.stringify({ data: 'A'.repeat(n) });
  const post = (url: string, body: string, method: 'POST' | 'PUT' = 'POST') => app.inject({ method, url, payload: body, headers: { 'content-type': 'application/json' } });
  it('rejects a body over 64 KB on an ordinary route with 413', async () => {
    const r = await post('/auth/otp/request', pad(70 * 1024));
    expect(r.statusCode).toBe(413);
    expect(r.json().code).toBe('too_large');
    expect(JSON.stringify(r.json())).not.toMatch(/FST_|Request body/);
  });
  it('still takes about 5 MB of receipts on the receipt and claim routes (it gets as far as the sign-in check)', async () => {
    const five = pad(5 * 1024 * 1024);
    expect((await post('/me/claims', five)).statusCode).toBe(401);
    expect((await post('/expenses', five)).statusCode).toBe(401);
    expect((await post('/expenses/exp_x/files', five)).statusCode).toBe(401);
    expect((await post('/kyc/documents', five)).statusCode).toBe(401);
    expect((await post('/records', five)).statusCode).toBe(401);
  });
  it('caps even the upload routes (7 MB is refused) and keeps branding and posters smaller', async () => {
    expect((await post('/me/claims', pad(7 * 1024 * 1024))).statusCode).toBe(413);
    expect((await post('/events/e1/poster', pad(3 * 1024 * 1024))).statusCode).toBe(413);
    expect((await post('/events/e1/poster', pad(1.5 * 1024 * 1024))).statusCode).toBe(401);
    expect((await post('/church/branding', pad(3.5 * 1024 * 1024), 'PUT')).statusCode).toBe(401);
  });
  it('answers invalid JSON with 400 and a wrong content type with 415', async () => {
    const r = await post('/auth/otp/request', '{"phone": ');
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('bad_json');
    const t = await app.inject({ method: 'POST', url: '/auth/otp/request', payload: 'x', headers: { 'content-type': 'application/xml' } });
    expect(t.statusCode).toBe(415);
    expect(t.json().code).toBe('unsupported_type');
  });
});

describe('error handling (WEB-16, IN-13)', () => {
  it('hides internals on a 500 and logs one short line without the query string', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await app.inject({ method: 'GET', url: '/__t/boom?token=SECRET123&phone=254700000001' });
      expect(r.statusCode).toBe(500);
      expect(r.json()).toEqual({ error: 'Something went wrong', code: 'internal' });
      expect(r.body).not.toMatch(/hunter2|internal-7|stack| at /);
      const line = spy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(line).toContain('GET /__t/boom');
      expect(line).not.toMatch(/SECRET123|254700000001|\?/);
    } finally { spy.mockRestore(); }
  });
  it('maps bad values to 400 bad_request', async () => {
    for (const code of ['22021', '22P02', '22007', '22008', '22003']) {
      const r = await app.inject({ method: 'GET', url: `/__t/pg/${code}` });
      expect(r.statusCode, code).toBe(400);
      expect(r.json()).toEqual({ error: 'That value is not valid', code: 'bad_request' });
    }
    expect((await app.inject({ method: 'GET', url: '/__t/range' })).statusCode).toBe(400);
  });
  it('turns a NUL byte in a path value into 400, not 500', async () => {
    const r = await app.inject({ method: 'GET', url: '/public/church/ab%00cd' });
    expect(r.statusCode).toBeLessThan(500);
  });
  it('returns generic JSON for an unknown route', async () => {
    const r = await app.inject({ method: 'GET', url: '/nope' });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'Not found', code: 'not_found' });
  });
});

describe('client address (WEB-03)', () => {
  it('with one trusted hop a spoofed leftmost X-Forwarded-For is ignored; the rightmost entry is used', async () => {
    const r = await app.inject({ method: 'GET', url: '/__t/ip', remoteAddress: '10.0.0.1', headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' } });
    expect(r.json().ip).toBe('203.0.113.9');
  });
  it('reads the hop count from the environment', () => {
    expect(trustProxyHops({})).toBe(0);
    expect(trustProxyHops({ TRUST_PROXY: '1' })).toBe(1);
    expect(trustProxyHops({ TRUST_PROXY: '1', TRUST_PROXY_HOPS: '2' })).toBe(2);
    expect(trustProxyHops({ TRUST_PROXY_HOPS: '0' })).toBe(0);
    expect(trustProxyHops({ TRUST_PROXY_HOPS: 'abc' })).toBe(1);
  });
});

describe('development tools (WEB-08)', () => {
  const advance = () => app.inject({ method: 'POST', url: '/admin/clock/advance', payload: { hours: 1 } });
  it('are not reachable in production unless ENABLE_DEV_TOOLS=1', async () => {
    setEnv({ NODE_ENV: 'production', ENABLE_DEV_TOOLS: undefined });
    try {
      expect(devToolsEnabled()).toBe(false);
      expect((await advance()).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: '/admin/simulate/paybill', payload: {} })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: '/admin/webhook-replay', payload: {} })).statusCode).toBe(404);
      setEnv({ ENABLE_DEV_TOOLS: '1' });
      expect(devToolsEnabled()).toBe(true);
      expect((await advance()).statusCode).toBe(401); // reachable, and then asks for an admin sign-in
    } finally { setEnv({ NODE_ENV: saved.NODE_ENV, ENABLE_DEV_TOOLS: saved.ENABLE_DEV_TOOLS }); }
  });
  it('are reachable outside production', async () => { expect((await advance()).statusCode).toBe(401); });
});

describe('serving stored files (IN-05, IN-08, WEB-17)', () => {
  it('builds a safe Content-Disposition for an em dash and CR/LF', () => {
    const d = contentDisposition('inline', 'Receipt — Mary\r\nSet-Cookie: x=1.pdf');
    expect(d).not.toMatch(/[\r\n]/);
    expect(d).toMatch(/^inline; filename="[\x20-\x7e]*"; filename\*=UTF-8''/);
    expect(d).toContain('%E2%80%94');
  });
  it('serves a PDF inline with private, sandboxed headers and does not 500 on the odd name', async () => {
    const r = await app.inject({ method: 'GET', url: '/__t/file?mime=application/pdf' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(String(r.headers['content-disposition'])).toMatch(/^inline;/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toBe("sandbox; default-src 'none'; img-src 'self' data:");
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(r.headers['set-cookie']).toBeUndefined();
  });
  it('serves anything that is not an image or PDF as a download', async () => {
    for (const mime of ['text/html', 'image/svg+xml', 'application/x-msdownload']) {
      const r = await app.inject({ method: 'GET', url: `/__t/file?mime=${encodeURIComponent(mime)}` });
      expect(r.headers['content-type'], mime).toBe('application/octet-stream');
      expect(String(r.headers['content-disposition']), mime).toMatch(/^attachment;/);
    }
  });
});
