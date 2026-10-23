import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { seedAttendanceDemo } from './seed-attendance';
import { seedExpensesDemo } from './seed-expenses';

/**
 * Slice 43: ENFORCE_LEGAL_ACCEPTANCE=1 must not stop the API starting.
 * The demo seeding signs in as demo users through the API before they could have accepted the Terms; it carries an internal key.
 */

let app: Awaited<ReturnType<typeof buildApp>>['app'];
const before = process.env.ENFORCE_LEGAL_ACCEPTANCE;
let jane = '';
let owner = '';

beforeAll(async () => {
  process.env.ENFORCE_LEGAL_ACCEPTANCE = '1';
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  await seed(built.ctx);
  await seedAttendanceDemo(built.app, built.ctx);
  await seedExpensesDemo(built.app, built.ctx);
  const login = async (phone: string) => (await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: '123456' } })).json().token as string;
  jane = await login('0711000001');
  owner = await login('0700000001');
}, 120_000);

afterAll(() => {
  if (before === undefined) delete process.env.ENFORCE_LEGAL_ACCEPTANCE;
  else process.env.ENFORCE_LEGAL_ACCEPTANCE = before;
});

const get = (tok: string, url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tok}`, ...headers } });

describe('legal acceptance enforced', () => {
  it('the demo data loaded with enforcement on (the seeds were not blocked)', async () => {
    const r = await get(owner, '/expenses/setup', {});
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('legal_acceptance_required');
  });

  it('a person who has not accepted is refused, but can read the legal status and their profile', async () => {
    expect((await get(jane, '/me/giving')).statusCode).toBe(403);
    expect((await get(jane, '/legal/status')).statusCode).toBe(200);
    expect((await get(jane, '/me')).statusCode).toBe(200);
  });

  it('accepting lets them in', async () => {
    const a = await app.inject({ method: 'POST', url: '/legal/accept', payload: { doc: 'terms_privacy', version: '2026-10-23', app: 'member' }, headers: { authorization: `Bearer ${jane}` } });
    expect(a.statusCode).toBe(200);
    expect((await get(jane, '/me/giving')).statusCode).toBe(200);
  });

  it('a made-up internal header does not get past enforcement', async () => {
    const r = await get(owner, '/expenses/setup', { 'x-churchos-internal-seed': 'guess' });
    expect(r.statusCode).toBe(403);
  });
});
