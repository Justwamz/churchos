import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';

let app: Awaited<ReturnType<typeof buildApp>>['app'];
let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
const tokens: Record<string, string> = {};

async function login(phone: string) {
  if (tokens[phone]) return tokens[phone];
  const r = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: '123456' } });
  expect(r.statusCode).toBe(200);
  tokens[phone] = r.json().token;
  return tokens[phone];
}
const call = async (phone: string | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: any) =>
  app.inject({ method, url, payload, headers: phone ? { authorization: `Bearer ${await login(phone)}` } : {} });

const OWNER = '0700000001', TREAS = '0700000002', ADMIN = '0700000003', COAST = '0700000004', HOPE = '0700000005';
const PA1 = '0700000099', PA2 = '0700000098', JANE = '0711000001', PETER = '0711000002';

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);

const wait = async (fn: () => Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

describe('login', () => {
  it('rejects a wrong code and unknown numbers the same way', async () => {
    expect((await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone: '0711000001', code: '000000' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone: '0799999999', code: '123456' } })).statusCode).toBe(401);
  });
  it('rejects protected routes without a token or with a tampered one', async () => {
    expect((await call(null, 'GET', '/dashboard')).statusCode).toBe(401);
    const bad = await app.inject({ method: 'GET', url: '/dashboard', headers: { authorization: `Bearer ${(await login(OWNER)).slice(0, -3)}xyz` } });
    expect(bad.statusCode).toBe(401);
  });
});

describe('public giving page', () => {
  it('unknown church code returns a friendly 404', async () => {
    const r = await call(null, 'GET', '/public/church/NOPE99');
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toMatch(/could not find/i);
  });
  it('lowercase codes work and the page lists purposes including open projects', async () => {
    const r = await call(null, 'GET', '/public/church/grc001');
    expect(r.statusCode).toBe(200);
    expect(r.json().purposes.map((p: any) => p.key)).toContain('PROJ-ROOF');
  });
  it('rejects bad phone, tiny and huge amounts', async () => {
    const give = (p: any) => call(null, 'POST', '/public/give', { code: 'GRC001', purpose: 'TITHE', ...p });
    expect((await give({ phone: '123', amount: 100 })).statusCode).toBe(400);
    expect((await give({ phone: '0712345678', amount: 1 })).json().code).toBe('amount_too_small');
    expect((await give({ phone: '0712345678', amount: 999999 })).json().code).toBe('amount_too_large');
    expect((await give({ phone: '0712345678', amount: 100, purpose: 'LOTTERY' })).json().code).toBe('unknown_purpose');
  });
  it('an STK push completes into the right ledger and shows on the live dashboard', async () => {
    const before = (await call(TREAS, 'GET', '/dashboard')).json();
    const r = await call(null, 'POST', '/public/give', { code: 'GRC001', purpose: 'TITHE', phone: '0712345678', amount: 1000 });
    expect(r.statusCode).toBe(200);
    const id = r.json().intentId;
    expect(await wait(async () => (await call(null, 'GET', `/public/give/${id}`)).json().status === 'completed')).toBe(true);
    const after = (await call(TREAS, 'GET', '/dashboard')).json();
    expect(Number(after.today.gross)).toBe(Number(before.today.gross) + 100000);
  });
  it('member-pays-fee mode charges the member on top and the church still receives the full gift', async () => {
    await call(PA1, 'PUT', '/admin/tenants/org_grace/fees', { feeBearer: 'member', feeSchedule: (await call(PA1, 'GET', '/admin/tenants')).json()[0].feeSchedule });
    const r = await call(null, 'POST', '/public/give', { code: 'GRC001', purpose: 'OFFERING', phone: '0712345679', amount: 1000 });
    expect(r.json().amountPaid).toBeGreaterThan(100000);
    await wait(async () => (await call(null, 'GET', `/public/give/${r.json().intentId}`)).json().status === 'completed');
    const p = (await ctx.db.query<any>(`SELECT net FROM payments WHERE payer_phone='254712345679'`))[0];
    expect(p.net).toBe(100000);
    await call(PA1, 'PUT', '/admin/tenants/org_grace/fees', { feeBearer: 'church', feeSchedule: (await call(PA1, 'GET', '/admin/tenants')).json()[0].feeSchedule });
  });
});

describe('tenant isolation and role scoping', () => {
  it('a Hope Chapel owner cannot read Grace data by guessing a branch', async () => {
    expect((await call(HOPE, 'GET', '/dashboard?branch=br_grc001')).statusCode).toBe(403);
    expect((await call(HOPE, 'GET', '/collections?branch=br_grc001')).statusCode).toBe(403);
    expect((await call(HOPE, 'GET', '/members?branch=br_grc001')).statusCode).toBe(403);
    const own = (await call(HOPE, 'GET', '/collections')).json();
    expect(own.rows.every((r: any) => r.branch === 'HPC001')).toBe(true);
  });
  it('the regional lead sees only her region, the owner sees all branches (HQ drill-down)', async () => {
    const coast = (await call(COAST, 'GET', '/dashboard')).json();
    expect(coast.branches.map((b: any) => b.code)).toEqual(['GRC002']);
    expect((await call(COAST, 'GET', '/dashboard?branch=br_grc001')).statusCode).toBe(403);
    const hq = (await call(OWNER, 'GET', '/dashboard')).json();
    expect(hq.branches.map((b: any) => b.code).sort()).toEqual(['GRC001', 'GRC002']);
    const one = (await call(OWNER, 'GET', '/dashboard?branch=br_grc002')).json();
    expect(one.branches).toHaveLength(1);
  });
  it('permissions are enforced: a treasurer cannot edit members, a member cannot open staff screens', async () => {
    expect((await call(TREAS, 'POST', '/members', { branchId: 'br_grc001', fullName: 'X Y' })).statusCode).toBe(403);
    expect((await call(JANE, 'GET', '/dashboard')).statusCode).toBe(403);
    expect((await call(JANE, 'GET', '/admin/tenants')).statusCode).toBe(403);
  });
  it('church users never see the platform fee split (L21)', async () => {
    const rows = (await call(TREAS, 'GET', '/collections')).json().rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r).not.toHaveProperty('platform_fee');
      expect(r).not.toHaveProperty('psp_cost');
      expect(r).toHaveProperty('fee');
    }
    const admin = (await call(PA1, 'GET', '/admin/payments')).json();
    expect(admin[0]).toHaveProperty('platform_fee');
    expect(admin[0]).toHaveProperty('psp_cost');
  });
});

describe('cash with dual sign-off', () => {
  it('needs a second person, then charges the fee against the branch ledger', async () => {
    const made = await call(TREAS, 'POST', '/cash', { branchId: 'br_grc001', amount: 20000, purpose: 'OFFERING' });
    expect(made.statusCode).toBe(200);
    const id = made.json().id;
    expect((await call(TREAS, 'POST', `/cash/${id}/signoff`, {})).json().code).toBe('same_person');
    const before = await ctx.ledger.balance('receivable', 'br_grc001');
    const ok = await call(ADMIN, 'POST', `/cash/${id}/signoff`, {});
    expect(ok.statusCode).toBe(200);
    expect(ok.json().fee).toBe(30000); // 1.5% of KES 20,000
    const after = await ctx.ledger.balance('receivable', 'br_grc001');
    expect(after).toBeGreaterThanOrEqual(before);
    expect((await call(ADMIN, 'POST', `/cash/${id}/signoff`, {})).statusCode).toBe(409);
    expect((await ctx.ledger.reconcile()).ok).toBe(true);
  });
  it('cash shows in the collections report as its own category', async () => {
    const r = (await call(TREAS, 'GET', '/collections')).json();
    expect(r.byMethod.some((m: any) => m.key === 'cash')).toBe(true);
  });
  it('rejects zero and negative counts', async () => {
    expect((await call(TREAS, 'POST', '/cash', { branchId: 'br_grc001', amount: 0 })).statusCode).toBe(400);
    expect((await call(TREAS, 'POST', '/cash', { branchId: 'br_grc001', amount: -5 })).statusCode).toBe(400);
  });
});

describe('suspense, reversal intake and maker-checker', () => {
  it('a mistyped paybill code sits in suspense and an admin can claim it', async () => {
    const s = (await call(PA1, 'GET', '/admin/suspense')).json();
    const mistyped = s.find((x: any) => x.reference === 'GRC01#TITHE');
    expect(mistyped).toBeTruthy();
    const c = await call(PA1, 'POST', `/admin/suspense/${mistyped.id}/claim`, { branchId: 'br_grc001' });
    expect(c.statusCode).toBe(200);
    expect((await call(PA1, 'POST', `/admin/suspense/${mistyped.id}/claim`, { branchId: 'br_grc001' })).statusCode).toBe(409);
  });

  it('a member can paste an SMS to ask for a reversal, but only for their own payment', async () => {
    const sim = await call(PA1, 'POST', '/admin/simulate/paybill', { phone: '0711000002', amount: 500, reference: 'WRONGCODE' });
    const code = sim.json().providerTxId;
    const sms = `${code} Confirmed. Ksh500.00 paid to CHURCHOS on 12/10/26. New balance is Ksh 2,000.`;
    expect((await call(JANE, 'POST', '/me/reversal-request', { message: sms })).json().code).toBe('not_your_payment');
    expect((await call(PETER, 'POST', '/me/reversal-request', { message: 'no code here' })).json().code).toBe('payment_not_found');
    const ok = await call(PETER, 'POST', '/me/reversal-request', { message: sms });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().found.where).toMatch(/held safely/);
    expect((await call(PETER, 'POST', '/me/reversal-request', { message: sms })).json().code).toBe('duplicate_request');
    const list = (await call(PA1, 'GET', '/admin/reversal-requests?status=pending')).json();
    const req = list.find((r: any) => r.provider_tx_id === code);
    expect((await call(PA1, 'POST', `/admin/reversal-requests/${req.id}/decide`, { approve: true, reason: 'Checked against the provider statement' })).json().status).toBe('approved');
    expect((await ctx.ledger.reconcile()).ok).toBe(true);
  });

  it('reversals above KES 50,000 need a different second admin', async () => {
    await call(PA1, 'POST', '/admin/simulate/paybill', { phone: '0711000002', amount: 60000, reference: 'GRC001#OFFERING' });
    const p = (await ctx.db.query<any>(`SELECT provider_tx_id FROM payments WHERE amount_paid = 6000000`))[0];
    const sms = `${p.provider_tx_id} Confirmed. Ksh60,000.00 paid.`;
    await call(PETER, 'POST', '/me/reversal-request', { message: sms });
    const req = (await call(PA1, 'GET', '/admin/reversal-requests?status=pending')).json().find((r: any) => r.provider_tx_id === p.provider_tx_id);
    expect((await call(PA1, 'POST', `/admin/reversal-requests/${req.id}/decide`, { approve: true, reason: 'Checked against the provider statement' })).json().status).toBe('awaiting_second');
    expect((await call(PA1, 'POST', `/admin/reversal-requests/${req.id}/decide`, { approve: true, reason: 'Checked against the provider statement' })).json().code).toBe('same_person');
    expect((await call(PA2, 'POST', `/admin/reversal-requests/${req.id}/decide`, { approve: true, reason: 'Checked against the provider statement' })).json().status).toBe('approved');
    expect((await ctx.ledger.reconcile()).ok).toBe(true);
  });
});

describe('settlement through the API', () => {
  it('holds 48h, then the admin run pays branches out and reconciliation still balances', async () => {
    const before = (await call(PA1, 'GET', '/admin/payouts')).json().length;
    await call(PA1, 'POST', '/admin/clock/advance', { hours: 49 });
    const run = (await call(PA1, 'POST', '/admin/settlement/run', {})).json();
    expect(run.results.some((r: any) => r.status === 'paid')).toBe(true);
    expect((await call(PA1, 'GET', '/admin/payouts')).json().length).toBeGreaterThan(before);
    expect((await call(PA1, 'GET', '/admin/reconcile')).json().ok).toBe(true);
    const s = (await call(TREAS, 'GET', '/settlements')).json();
    expect(s.payouts.length).toBeGreaterThan(0);
    expect(s.payouts.every((p: any) => p.branch === 'GRC001')).toBe(true);
  });
  it('the admin clock tool is rejected for non-admins', async () => {
    expect((await call(OWNER, 'POST', '/admin/clock/advance', { hours: 5 })).statusCode).toBe(403);
  });
});

describe('members and transfers', () => {
  it('a member transfers within the church keeping the number, and across churches getting a new one', async () => {
    const t = await call(PETER, 'POST', '/me/transfer-request', { toChurchCode: 'GRC002' });
    expect(t.statusCode).toBe(200);
    expect((await call(PETER, 'POST', '/me/transfer-request', { toChurchCode: 'GRC002' })).json().code).toBe('duplicate_request');
    // The Nairobi treasurer cannot approve: only the receiving branch decides.
    expect((await call(TREAS, 'POST', `/transfers/${t.json().id}/decide`, { approve: true, reason: 'Checked against the provider statement' })).statusCode).toBe(403);
    expect((await call(COAST, 'POST', `/transfers/${t.json().id}/decide`, { approve: true, reason: 'Checked against the provider statement' })).statusCode).toBe(403); // treasurers cannot approve transfers
    expect((await call(OWNER, 'POST', `/transfers/${t.json().id}/decide`, { approve: true, reason: 'Checked against the provider statement' })).statusCode).toBe(200);
    const me = (await call(PETER, 'GET', '/me')).json();
    expect(me.memberships[0].member_number).toBe('M00004');
    expect(me.memberships[0].branch_code).toBe('GRC002');

    const x = await call(PETER, 'POST', '/me/transfer-request', { toChurchCode: 'HPC001' });
    // Peter is the only guardian of Brian, so he cannot leave the organisation until Brian has another one (L125).
    const blocked = await call(HOPE, 'POST', `/transfers/${x.json().id}/decide`, { approve: true, reason: 'Checked against the provider statement' });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('sole_guardian');
    await ctx.db.query(`INSERT INTO guardians (child_id, guardian_id, org_id) VALUES ('m_brian','m_amina','org_grace')`);
    expect((await call(HOPE, 'POST', `/transfers/${x.json().id}/decide`, { approve: true, reason: 'Checked against the provider statement' })).statusCode).toBe(200);
    const after = (await call(PETER, 'GET', '/me')).json();
    expect(after.memberships).toHaveLength(1);
    expect(after.memberships[0].org_name).toBe('Hope Chapel');
    const old = await ctx.db.query<any>(`SELECT status FROM memberships WHERE id='m_peter'`);
    expect(old[0].status).toBe('closed');
  });
});

describe('projects and pledges', () => {
  it('creates a project with validation and shows raised versus target', async () => {
    expect((await call(TREAS, 'POST', '/projects', { branchId: 'br_grc001', code: '', name: 'X', target: 100 })).statusCode).toBe(400);
    expect((await call(TREAS, 'POST', '/projects', { branchId: 'br_grc001', code: 'ROOF', name: 'Dup', target: 100 })).statusCode).toBe(409);
    expect((await call(TREAS, 'POST', '/projects', { branchId: 'br_grc001', code: 'HALL', name: 'Youth Hall', target: 250000, restricted: true })).statusCode).toBe(200);
    const list = (await call(TREAS, 'GET', '/projects')).json();
    const roof = list.find((p: any) => p.code === 'ROOF');
    expect(roof.raised).toBeGreaterThan(0);
    expect(roof.pledged).toBe(5000000);
  });
  it('a member can pledge only to a project of a church they belong to', async () => {
    expect((await call(JANE, 'POST', '/me/pledges', { churchCode: 'GRC001', projectCode: 'HALL', amount: 5000 })).statusCode).toBe(200);
    expect((await call(JANE, 'POST', '/me/pledges', { churchCode: 'HPC001', projectCode: 'ROOF', amount: 5000 })).statusCode).toBe(404);
  });
});
