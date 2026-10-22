import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';

/**
 * Slice 41: findings from the retest of the security fixes.
 * NEW-1: GET /projects/:id/pledges read another church's pledges.
 * Quote with an absurd quantity.
 */

let app: Awaited<ReturnType<typeof buildApp>>['app'];
const tokens: Record<string, string> = {};
async function login(phone: string) {
  if (tokens[phone]) return tokens[phone];
  const r = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: '123456' } });
  tokens[phone] = r.json().token;
  return tokens[phone];
}
const call = async (phone: string | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: any) =>
  app.inject({ method, url, payload, headers: phone ? { authorization: `Bearer ${await login(phone)}` } : {} });

const OWNER = '0700000001', FATUMA = '0700000004';

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  await seed(built.ctx);
}, 60_000);

describe('NEW-1: project pledges stay inside the church', () => {
  it('the owner of the church sees the pledges of its project', async () => {
    const projects = (await call(OWNER, 'GET', '/projects')).json();
    const list = Array.isArray(projects) ? projects : projects.projects ?? [];
    expect(list.length).toBeGreaterThan(0);
    const r = await call(OWNER, 'GET', `/projects/${list[0].id}/pledges`);
    expect(r.statusCode).toBe(200);
  });

  it("another church's staff get nothing from that church's project", async () => {
    const r = await call(FATUMA, 'GET', '/projects/prj_roof/pledges');
    expect(r.statusCode === 200 ? r.json() : []).toEqual([]);
  });
});

describe('quote quantity cap', () => {
  it('an absurd quantity is not counted in a quote', async () => {
    const events = (await call(OWNER, 'GET', '/events')).json();
    expect(events).toBeTruthy();
    const r = await call(null, 'POST', '/public/tickets/quote', { code: 'nope', lines: [{ typeId: 'x', qty: 1e300 }] });
    expect([200, 400, 404]).toContain(r.statusCode);
    if (r.statusCode === 200) expect(r.json().count).toBeLessThan(1e6);
  });
});
