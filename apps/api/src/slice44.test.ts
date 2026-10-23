import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';

/**
 * Slice 44: platform admin UX audit fixes on the API side.
 * - revealing a payer number needs a written reason (3+ characters) and the reason is kept in the audit log
 * - approving or rejecting a reversal needs a written reason; the list says how many approvals each request needs and has
 * - GET /admin/dev-tools tells the admin app whether the test tools are switched on
 * - settlement preview, and a run that would pay nothing is refused with a friendly 400
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
  app.inject({ method, url, payload, headers: phone ? { authorization: `Bearer ${await login(phone)}` } : {} });
const mock = () => ctx.provider as any;
const PA1 = '0700000099', PA2 = '0700000098', OWNER = '0700000001', JANE = '0711000001';

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 120_000);
afterAll(async () => { await app.close(); });

describe('reveal needs a reason', () => {
  it('refuses a missing or too short reason, and keeps the reason when it is given', async () => {
    const pb = await mock().simulatePaybill({ phone: '254712000555', amount: 100000, reference: 'GRC001#TITHE' });
    const pay = (await ctx.db.query<any>(`SELECT id FROM payments WHERE provider_tx_id=$1`, [pb.providerTxId]))[0];
    const none = await call(PA1, 'POST', `/admin/payments/${pay.id}/reveal`, {});
    expect(none.statusCode).toBe(400);
    expect(none.json().code).toBe('reason_required');
    expect(none.json().error).toMatch(/why/i);
    expect((await call(PA1, 'POST', `/admin/payments/${pay.id}/reveal`, { reason: ' a ' })).statusCode).toBe(400);
    const ok = await call(PA1, 'POST', `/admin/payments/${pay.id}/reveal`, { reason: 'Member called about it' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().payer_phone).toBeTruthy();
    const evt = (await call(PA1, 'GET', '/admin/audit/events?action=access.reveal')).json().events.find((e: any) => e.entity_id === pay.id);
    expect(evt.reason).toBe('Member called about it');
  });
});

describe('reversal approvals', () => {
  it('needs a reason to approve or reject, and the list shows the two-admin rule', async () => {
    const big = await mock().simulatePaybill({ phone: '254711000001', amount: 6_000_000, reference: 'GRC001#OFFERING' });
    const small = await mock().simulatePaybill({ phone: '254711000001', amount: 100000, reference: 'GRC001#OFFERING' });
    const a = (await call(JANE, 'POST', '/me/reversal-request', { message: `Wrong church ${big.providerTxId}`, reason: 'wrong church' })).json();
    const b = (await call(JANE, 'POST', '/me/reversal-request', { message: `Wrong church ${small.providerTxId}`, reason: 'wrong church' })).json();
    const list = async (s: string) => (await call(PA1, 'GET', `/admin/reversal-requests?status=${s}`)).json() as any[];
    const rowA = (await list('pending')).find((r) => r.id === a.id)!;
    const rowB = (await list('pending')).find((r) => r.id === b.id)!;
    expect(rowA).toMatchObject({ approvalsRequired: 2, approvalsDone: 0 });
    expect(rowB).toMatchObject({ approvalsRequired: 1, approvalsDone: 0 });
    expect(rowA.requested_by).toBeTruthy();

    for (const approve of [true, false]) {
      const r = await call(PA1, 'POST', `/admin/reversal-requests/${a.id}/decide`, { approve });
      expect(r.statusCode).toBe(400);
      expect(r.json().code).toBe('reason_required');
    }
    expect((await call(PA1, 'POST', `/admin/reversal-requests/${a.id}/decide`, { approve: true, reason: 'ok' })).statusCode).toBe(400);

    const first = await call(PA1, 'POST', `/admin/reversal-requests/${a.id}/decide`, { approve: true, reason: 'Matches the provider statement' });
    expect(first.json().status).toBe('awaiting_second');
    expect((await list('awaiting_second')).find((r) => r.id === a.id)).toMatchObject({ approvalsRequired: 2, approvalsDone: 1 });
    expect((await call(PA2, 'POST', `/admin/reversal-requests/${a.id}/decide`, { approve: true, reason: 'Second check done' })).json().status).toBe('approved');
    expect((await list('approved')).find((r) => r.id === a.id)).toMatchObject({ approvalsRequired: 2, approvalsDone: 2 });

    const rej = await call(PA1, 'POST', `/admin/reversal-requests/${b.id}/decide`, { approve: false, reason: 'Already refunded elsewhere' });
    expect(rej.json().status).toBe('rejected');
    const evt = (await call(PA1, 'GET', '/admin/audit/events?action=reversal.reject')).json().events[0];
    expect(evt.reason).toBe('Already refunded elsewhere');
  });
});

describe('dev tools switch', () => {
  it('reports whether the test tools are enabled, to platform admins only', async () => {
    expect((await call(PA1, 'GET', '/admin/dev-tools')).json()).toEqual({ enabled: true });
    expect((await call(OWNER, 'GET', '/admin/dev-tools')).statusCode).toBe(403);
    const env = { nodeEnv: process.env.NODE_ENV, flag: process.env.ENABLE_DEV_TOOLS };
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.ENABLE_DEV_TOOLS;
      expect((await call(PA1, 'GET', '/admin/dev-tools')).json()).toEqual({ enabled: false });
      expect((await call(PA1, 'POST', '/admin/clock/advance', { hours: 1 })).statusCode).toBe(404); // the same switch guards the tools themselves
      process.env.ENABLE_DEV_TOOLS = '1';
      expect((await call(PA1, 'GET', '/admin/dev-tools')).json()).toEqual({ enabled: true });
    } finally {
      if (env.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env.nodeEnv;
      if (env.flag === undefined) delete process.env.ENABLE_DEV_TOOLS; else process.env.ENABLE_DEV_TOOLS = env.flag;
    }
  });
});

describe('settlement preview and the empty run', () => {
  it('refuses a run that would pay nothing, previews what a run would pay, then refuses a second one', async () => {
    const empty = await call(PA1, 'GET', '/admin/settlement/preview');
    expect(empty.json()).toMatchObject({ amount: 0, branches: 0, churches: 0, payments: 0 });
    const refused = await call(PA1, 'POST', '/admin/settlement/run', {});
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe('nothing_to_settle');
    expect(refused.json().error).toMatch(/nothing to pay out/i);

    await mock().simulatePaybill({ phone: '254712000777', amount: 100000, reference: 'GRC001#TITHE' });
    await call(PA1, 'POST', '/admin/clock/advance', { hours: 49 });
    const pre = (await call(PA1, 'GET', '/admin/settlement/preview')).json();
    expect(pre.amount).toBeGreaterThan(0);
    expect(pre.branches).toBeGreaterThanOrEqual(1);
    expect(pre.churches).toBeGreaterThanOrEqual(1);
    expect(pre.payments).toBeGreaterThanOrEqual(1);
    expect((await call(PA1, 'POST', '/admin/settlement/run', {})).statusCode).toBe(200);
    expect((await call(PA1, 'POST', '/admin/settlement/run', {})).json().code).toBe('nothing_to_settle');
  });
});
