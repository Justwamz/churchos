import { beforeAll, describe, expect, it } from 'vitest';
import { runScoped, runSystem, verifyChains } from '@churchos/ledger';
import { buildApp } from './server';
import { seed } from './seed';
import { requireSession } from './ctx';

/**
 * Slice 38: request-scoped row-level security (AZ-20) and database CHECK constraints.
 * PGlite is a superuser, which bypasses RLS, so enforcement here comes from the `churchos_app` role that the database layer switches
 * to for every scoped statement. These tests prove the policies really filter rows under that role.
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
const call = async (phone: string | null, method: 'GET' | 'POST', url: string, payload?: any) =>
  app.inject({ method, url, payload, headers: phone ? { authorization: `Bearer ${await login(phone)}` } : {} });
const q = (sql: string, p: unknown[] = []) => ctx.db.query<any>(sql, p);
const GRACE_OWNER = '0700000001', HOPE_OWNER = '0700000005', ADMIN = '0700000099';

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  // Test-only routes (registered before the first request): deliberately query with NO org filter.
  app.get('/zz/leak', { preHandler: requireSession }, async () => ({
    memberships: (await ctx.db.query<any>(`SELECT DISTINCT org_id FROM branches`)).map((r) => r.org_id),
    roles: (await ctx.db.query<any>(`SELECT DISTINCT org_id FROM roles`)).map((r) => r.org_id),
    audit: (await ctx.db.query<any>(`SELECT DISTINCT org_id FROM audit_events WHERE org_id IS NOT NULL`)).map((r) => r.org_id),
  }));
  app.post('/zz/write', { preHandler: requireSession }, async (req) => {
    try {
      await ctx.db.query(`INSERT INTO households (id, org_id) VALUES ($1,$2)`, [`hh_zz_${Date.now()}`, (req.body as any).orgId]);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, code: e.code };
    }
  });
  await seed(ctx);
}, 60000);

describe('policies are in place', () => {
  it('every table with an org_id has RLS enabled and forced, with a tenant policy', async () => {
    const rows = await q(`SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
        (SELECT count(*)::int FROM pg_policies p WHERE p.tablename=c.relname AND p.policyname='tenant_isolation') AS pol
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='org_id' AND NOT a.attisdropped WHERE c.relkind='r'`);
    expect(rows.length).toBeGreaterThan(90);
    expect(rows.filter((r) => !r.rls || !r.forced || r.pol !== 1).map((r) => r.relname)).toEqual([]);
  });

  it('child tables that lacked an org_id now have one, filled from the parent', async () => {
    for (const t of ['message_recipients', 'shop_sale_lines', 'ticket_order_lines', 'held_payments', 'reversal_requests', 'prayer_owners', 'suggestion_owners', 'anonymous_gifts', 'birthday_wishes']) {
      expect((await q(`SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='org_id'`, [t])).length).toBe(1);
    }
  });
});

describe('the database layer scopes by organisation', () => {
  it('no scope (jobs, seeds, tests) and bypass see every church', async () => {
    expect((await q(`SELECT DISTINCT org_id FROM branches ORDER BY 1`)).length).toBeGreaterThan(1);
    const all = await runSystem(() => q(`SELECT DISTINCT org_id FROM branches ORDER BY 1`));
    expect(all.length).toBeGreaterThan(1);
  });

  it('a scope sees only its church, including a query with no WHERE org_id', async () => {
    const grace = await runScoped(['org_grace'], () => q(`SELECT DISTINCT org_id FROM branches`));
    expect(grace.map((r) => r.org_id)).toEqual(['org_grace']);
    const hope = await runScoped(['org_hope'], () => q(`SELECT DISTINCT org_id FROM branches`));
    expect(hope.map((r) => r.org_id)).toEqual(['org_hope']);
    const both = await runScoped(['org_grace', 'org_hope'], () => q(`SELECT DISTINCT org_id FROM branches ORDER BY 1`));
    expect(both.map((r) => r.org_id)).toEqual(['org_grace', 'org_hope']);
  });

  it('an empty scope sees nothing and cannot write (fail closed)', async () => {
    expect(await runScoped([], () => q(`SELECT 1 FROM branches LIMIT 1`))).toEqual([]);
    expect(await runScoped([], () => q(`SELECT 1 FROM payments LIMIT 1`))).toEqual([]);
    await expect(runScoped(['org_grace'], () => q(`INSERT INTO households (id, org_id) VALUES ('hh_x','org_hope')`))).rejects.toMatchObject({ code: '42501' });
  });

  it('a transaction inside a scope stays scoped, and bypass inside it opens it', async () => {
    const r = await runScoped(['org_grace'], () => ctx.db.tx(async (t) => {
      const a = await t.query<any>(`SELECT DISTINCT org_id FROM branches`);
      const b = await runSystem(() => t.query<any>(`SELECT DISTINCT org_id FROM branches`));
      const c = await t.query<any>(`SELECT DISTINCT org_id FROM branches`);
      return [a.length, b.length > 1, c.length];
    }));
    expect(r).toEqual([1, true, 1]);
  });

  it('does not leak the scope to work outside it', async () => {
    await runScoped(['org_grace'], () => q(`SELECT 1`));
    expect((await q(`SELECT DISTINCT org_id FROM branches`)).length).toBeGreaterThan(1);
  });
});

describe('requests', () => {
  it('a church A request that forgets WHERE org_id sees only church A', async () => {
    const g = (await call(GRACE_OWNER, 'GET', '/zz/leak')).json();
    expect(g.memberships).toEqual(['org_grace']);
    expect(g.roles).toEqual(['org_grace']);
    expect(g.audit.every((o: string) => o === 'org_grace')).toBe(true);
    const h = (await call(HOPE_OWNER, 'GET', '/zz/leak')).json();
    expect(h.memberships).toEqual(['org_hope']);
    expect(h.roles).toEqual(['org_hope']);
  });

  it("a request cannot write another church's rows", async () => {
    expect((await call(GRACE_OWNER, 'POST', '/zz/write', { orgId: 'org_grace' })).json().ok).toBe(true);
    expect((await call(GRACE_OWNER, 'POST', '/zz/write', { orgId: 'org_hope' })).json()).toEqual({ ok: false, code: '42501' });
  });

  it('the platform admin runs in bypass and sees every church', async () => {
    const a = (await call(ADMIN, 'GET', '/zz/leak')).json();
    expect(a.memberships.length).toBeGreaterThan(1);
    expect((await call(ADMIN, 'GET', '/admin/tenants')).statusCode).toBe(200);
  });

  it('no sign-in on a guarded route is refused', async () => {
    expect((await call(null, 'GET', '/zz/leak')).statusCode).toBe(401);
  });

  it('public routes and the simulator webhook keep working (payment reaches the church)', async () => {
    expect((await call(null, 'GET', '/public/church/GRC001')).statusCode).toBe(200);
    const before = (await q(`SELECT count(*)::int AS n FROM payments`))[0].n;
    const pb = await (ctx.provider as any).simulatePaybill({ phone: '254711000001', amount: 100000, reference: 'GRC001#OFFERING' });
    expect(pb.providerTxId).toBeTruthy();
    for (let i = 0; i < 40 && (await q(`SELECT count(*)::int AS n FROM payments`))[0].n === before; i++) await new Promise((r) => setTimeout(r, 50));
    expect((await q(`SELECT count(*)::int AS n FROM payments`))[0].n).toBe(before + 1);
  });

  it('reconcile and the audit chains still verify', async () => {
    expect((await call(GRACE_OWNER, 'GET', '/payments')).statusCode).toBeLessThan(500);
    expect((await call(ADMIN, 'GET', '/admin/reconcile')).json().ok).toBe(true);
    expect((await verifyChains(ctx.db)).every((r) => r.ok)).toBe(true);
  });

  it('audit events written during a scoped request stay on the chain', async () => {
    const r = await call(GRACE_OWNER, 'POST', '/members', { branchId: 'br_grc001', fullName: 'Scope Test', category: 'adult', phone: '0722381001', consent: true });
    expect(r.statusCode).toBe(200);
    expect((await verifyChains(ctx.db)).every((r) => r.ok)).toBe(true);
  });
});

describe('check constraints', () => {
  it('refuse negative and absurd money and quantities', async () => {
    let tried = 0;
    for (const [t, c, v] of [['ticket_types', 'price', -1], ['shop_items', 'price', -1], ['expenses', 'amount', -1], ['pledges', 'amount', -1], ['projects', 'target', -1], ['ticket_types', 'quantity', 2000000], ['expense_budgets', 'amount', 2000000000000]] as const) {
      if ((await q(`SELECT 1 FROM ${t} LIMIT 1`)).length === 0) continue;
      tried++;
      await expect(q(`UPDATE ${t} SET ${c} = ${v} WHERE ctid = (SELECT ctid FROM ${t} LIMIT 1)`)).rejects.toMatchObject({ code: '23514' });
    }
    expect(tried).toBeGreaterThanOrEqual(3);
    // payments are guarded by their tamper trigger first; the constraint is still there
    expect((await q(`SELECT 1 FROM pg_constraint WHERE conname='chk_payments_amount_paid' AND convalidated`)).length).toBe(1);
  });

  it('the constraints exist and the signed ledger columns have none', async () => {
    const n = (await q(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname LIKE 'chk\\_%'`))[0].n;
    expect(n).toBeGreaterThan(35);
    expect((await q(`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid IN ('postings'::regclass,'giving_ledger'::regclass,'shop_movements'::regclass) AND contype='c' AND conname LIKE 'chk\\_%'`))[0].n).toBe(0);
  });
});
