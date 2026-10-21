import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { gradientPng } from './artwork';

let app: Awaited<ReturnType<typeof buildApp>>['app'];
let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
const tokens: Record<string, string> = {};
async function login(phone: string) {
  if (tokens[phone]) return tokens[phone];
  const r = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: '123456' } });
  tokens[phone] = r.json().token;
  return tokens[phone];
}
const call = async (phone: string | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: any) =>
  app.inject({ method, url, payload, headers: phone ? { authorization: `Bearer ${await login(phone)}` } : {} });

const OWNER = '0700000001', TREAS = '0700000002', ADMIN = '0700000003', COAST = '0700000004', HOPE = '0700000005', PA1 = '0700000099', LUCY = '0700000008';
const AUDITOR = '0700000007', VOL = '0700000558';
const PETER = '0711000002';
const JANE = '0711000001';
const inbox = async (who: string, app: 'member' | 'staff' = 'member') => (await call(who, 'GET', `/me/notifications?app=${app}`)).json().rows as any[];
const png = () => ({ name: 'receipt.png', mime: 'image/png', data: gradientPng(40, 40, [200, 200, 200], [20, 20, 20]) });
const today = () => new Date(ctx.clock.now().getTime() + 3 * 3600_000).toISOString().slice(0, 10);
let cats: Record<string, string> = {};
const setup = async (who = TREAS) => (await call(who, 'GET', '/expenses/setup')).json();
const rec = (who: string, extra: any = {}) => call(who, 'POST', '/expenses', { branchId: 'br_grc001', date: today(), amount: 500, categoryId: cats['Supplies'], payee: 'Mama Njeri Stores', method: 'mpesa', reference: 'QWE123', ...extra });
const rules = (extra: any = {}) => call(OWNER, 'PUT', '/expenses/settings', { approvalMode: 'above_limit', approvalLimit: 5000, twoApproverLimit: null, receiptRequiredAbove: 1000, ...extra });

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
  const t = ctx.clock.now().toISOString();
  await ctx.db.query(`INSERT INTO users (id, phone, name, created_at) VALUES ('u_vol','254700000558','Volunteer Vera',$1)`, [t]);
  await ctx.db.query(`INSERT INTO role_assignments (id, org_id, user_id, role_id, scope_type, scope_id) VALUES ('ra_vol','org_grace','u_vol','org_grace:Volunteer','branch','br_grc001')`);
  cats = Object.fromEntries((await setup(OWNER)).categories.map((c: any) => [c.name, c.id]));
}, 60000);

describe('who can do what (L244)', () => {
  it('gives each person their own rights', async () => {
    expect((await setup(OWNER)).can).toEqual({ view: true, record: true, approve: true, manage: true, settings: true });
    expect((await setup(TREAS)).can).toEqual({ view: true, record: true, approve: false, manage: true, settings: false });
    expect((await setup(ADMIN)).can).toEqual({ view: true, record: true, approve: true, manage: true, settings: false });
    expect((await setup(AUDITOR)).can).toMatchObject({ view: true, record: false, approve: false, manage: false, settings: false });
    for (const who of [PETER, JANE, VOL]) expect((await call(who, 'GET', '/expenses/setup')).statusCode, who).toBeGreaterThanOrEqual(403);
    expect((await call(null, 'GET', '/expenses/setup')).statusCode).toBe(401);
  });

  it('starts with standard categories and lets the treasurer manage them, in the church only', async () => {
    const s = await setup(TREAS);
    expect(s.categories.map((c: any) => c.name)).toEqual(expect.arrayContaining(['Salaries and allowances', 'Utilities', 'Supplies', 'Welfare']));
    expect((await call(TREAS, 'POST', '/expenses/categories', { name: 'utilities' })).json().code).toBe('duplicate');
    expect((await call(TREAS, 'POST', '/expenses/categories', { name: '' })).json().code).toBe('bad_content');
    const made = await call(TREAS, 'POST', '/expenses/categories', { name: 'Hospitality' });
    expect(made.statusCode).toBe(200);
    expect((await call(TREAS, 'PATCH', `/expenses/categories/${made.json().id}`, { name: 'Visitors and hospitality' })).statusCode).toBe(200);
    expect((await call(TREAS, 'PATCH', `/expenses/categories/${made.json().id}`, { active: false })).statusCode).toBe(200);
    expect((await setup(TREAS)).categories.find((c: any) => c.id === made.json().id)).toMatchObject({ name: 'Visitors and hospitality', active: false });
    expect((await call(AUDITOR, 'POST', '/expenses/categories', { name: 'X' })).statusCode).toBe(403);
    expect((await call(HOPE, 'PATCH', `/expenses/categories/${made.json().id}`, { name: 'Hijack' })).statusCode).toBe(404);
    expect((await call(HOPE, 'GET', '/expenses/setup')).json().categories.map((c: any) => c.name)).not.toContain('Visitors and hospitality');
  });

  it('keeps the approval rules with the owner', async () => {
    expect((await setup(OWNER)).settings.standard).toBe(true);
    expect((await call(TREAS, 'PUT', '/expenses/settings', { approvalMode: 'all', approvalLimit: 0, receiptRequiredAbove: 1000 })).statusCode).toBe(403);
    expect((await call(ADMIN, 'PUT', '/expenses/settings', { approvalMode: 'all', approvalLimit: 0, receiptRequiredAbove: 1000 })).statusCode).toBe(403);
    expect((await call(OWNER, 'PUT', '/expenses/settings', { approvalMode: 'sometimes' })).json().code).toBe('bad_mode');
    expect((await call(OWNER, 'PUT', '/expenses/settings', { approvalMode: 'above_limit', approvalLimit: 5000, twoApproverLimit: 4000, receiptRequiredAbove: 1000 })).json().code).toBe('bad_amount');
    expect((await rules()).statusCode).toBe(200);
    expect((await setup(OWNER)).settings).toMatchObject({ approvalMode: 'above_limit', approvalLimit: 500000, twoApproverLimit: null, receiptRequiredAbove: 100000, standard: false });
  });
});

describe('recording an expense (L235, L237, L239)', () => {
  it('approves a small one on the spot, and asks for approval above the limit', async () => {
    const small = await rec(TREAS, { amount: 800 });
    expect(small.json()).toMatchObject({ status: 'approved', autoApproved: true });
    const big = await rec(TREAS, { amount: 6000, noReceiptReason: 'Paid at the market, no receipt given' });
    expect(big.json()).toMatchObject({ status: 'submitted', autoApproved: false });
    const list = (await call(TREAS, 'GET', '/expenses')).json().expenses;
    expect(list.find((e: any) => e.id === small.json().id)).toMatchObject({ status: 'approved', autoApproved: true, approver: 'Approved automatically (under the limit)', recordedBy: 'Esther Njeri' });
    expect((await inbox(ADMIN, 'staff')).some((n) => /needs approval/.test(n.title) && /Esther Njeri/.test(n.body))).toBe(true);
    expect((await inbox(TREAS, 'staff')).some((n) => /needs approval/.test(n.title))).toBe(false);
  });

  it('asks for approval on every expense when the owner says so', async () => {
    await rules({ approvalMode: 'all' });
    expect((await rec(TREAS, { amount: 100 })).json()).toMatchObject({ status: 'submitted', autoApproved: false });
    await rules();
  });

  it('refuses mistakes', async () => {
    const t = today();
    expect((await rec(TREAS, { date: '2099-01-01' })).json().code).toBe('bad_date');
    expect((await rec(TREAS, { date: '2001-01-01' })).json().code).toBe('bad_date');
    expect((await rec(TREAS, { date: 'yesterday' })).json().code).toBe('bad_date');
    expect((await rec(TREAS, { amount: 0 })).json().code).toBe('bad_amount');
    expect((await rec(TREAS, { amount: 'lots' })).json().code).toBe('bad_amount');
    expect((await rec(TREAS, { categoryId: 'nope' })).json().code).toBe('bad_category');
    expect((await rec(TREAS, { payee: '' })).json().code).toBe('bad_content');
    expect((await rec(TREAS, { method: 'barter' })).json().code).toBe('bad_method');
    expect((await rec(TREAS, { branchId: 'br_grc002' })).statusCode).toBe(404); // Esther records for Nairobi only
    expect((await rec(TREAS, { projectId: 'prj_nope' })).json().code).toBe('bad_project');
    expect((await rec(AUDITOR)).statusCode).toBe(403);
    expect((await rec(JANE)).statusCode).toBe(403);
    expect(t).toBeTruthy();
  });

  it('needs a receipt above the limit, or a reason there is none', async () => {
    expect((await rec(TREAS, { amount: 1500 })).json().code).toBe('receipt_required');
    expect((await rec(TREAS, { amount: 1000 })).statusCode).toBe(200); // not above the limit
    expect((await rec(TREAS, { amount: 1500, noReceiptReason: 'Market stall' })).statusCode).toBe(200);
    const ok = await rec(TREAS, { amount: 1500, files: [png()] });
    expect(ok.statusCode).toBe(200);
    expect((await call(TREAS, 'GET', `/expenses/${ok.json().id}`)).json().files).toBe(1);
  });

  it('checks the receipts it is given', async () => {
    expect((await rec(TREAS, { files: [{ name: 'x.exe', mime: 'application/x-msdownload', data: 'AAAA' }] })).json().code).toBe('bad_file');
    expect((await rec(TREAS, { files: [png(), png(), png(), png()] })).json().code).toBe('too_many_files');
    expect((await rec(TREAS, { files: [{ name: 'huge.png', mime: 'image/png', data: 'A'.repeat(1_700_000) }] })).json().code).toBe('file_too_big');
    expect((await rec(TREAS, { files: [{ name: 'empty.png', mime: 'image/png', data: '' }] })).json().code).toBe('file_too_big');
  });

  it('lets the recorder add receipts until it is approved, and shows them to the people who may see them', async () => {
    const e = await rec(TREAS, { amount: 7000, noReceiptReason: 'Paid first, photo later' });
    const id = e.json().id;
    expect((await call(TREAS, 'POST', `/expenses/${id}/files`, png())).statusCode).toBe(200);
    expect((await call(ADMIN, 'POST', `/expenses/${id}/files`, png())).statusCode).toBe(404); // only the recorder
    const detail = (await call(ADMIN, 'GET', `/expenses/${id}`)).json();
    expect(detail.fileList).toHaveLength(1);
    const f = await call(AUDITOR, 'GET', `/expenses/${id}/files/${detail.fileList[0].id}`);
    expect(f.statusCode).toBe(200);
    expect(f.headers['content-type']).toBe('image/png');
    expect((await call(JANE, 'GET', `/expenses/${id}/files/${detail.fileList[0].id}`)).statusCode).toBe(404);
    expect((await call(HOPE, 'GET', `/expenses/${id}`)).statusCode).toBe(404);
    expect((await call(ADMIN, 'POST', `/expenses/${id}/decide`, { approve: true })).statusCode).toBe(200);
    expect((await call(TREAS, 'POST', `/expenses/${id}/files`, png())).json().code).toBe('locked');
  });
});

describe('approving, rejecting and voiding (L237, L238)', () => {
  let id = '';
  it('needs a different person, and a reason to reject', async () => {
    const own = (await rec(ADMIN, { amount: 9000, noReceiptReason: 'Hall rent paid in cash' })).json().id;
    expect((await call(ADMIN, 'POST', `/expenses/${own}/decide`, { approve: true })).json().code).toBe('same_person'); // Samuel can record and approve, but not his own
    expect((await call(ADMIN, 'GET', '/expenses?status=submitted')).json().expenses.find((e: any) => e.id === own).mayApprove).toBe(false);
    expect((await call(OWNER, 'POST', `/expenses/${own}/decide`, { approve: true })).json().status).toBe('approved');
    id = (await rec(TREAS, { amount: 9000, noReceiptReason: 'Hall rent paid in cash' })).json().id;
    expect((await call(TREAS, 'POST', `/expenses/${id}/decide`, { approve: true })).statusCode).toBe(404); // Esther holds no approval right
    expect((await call(AUDITOR, 'POST', `/expenses/${id}/decide`, { approve: true })).statusCode).toBe(404);
    expect((await call(COAST, 'POST', `/expenses/${id}/decide`, { approve: true })).statusCode).toBe(404);
    expect((await call(ADMIN, 'POST', `/expenses/${id}/decide`, { approve: false })).json().code).toBe('bad_content');
    const list = (await call(ADMIN, 'GET', '/expenses?status=submitted')).json();
    expect(list.expenses.find((e: any) => e.id === id).mayApprove).toBe(true);
    expect((await call(TREAS, 'GET', '/expenses?status=submitted')).json().expenses.find((e: any) => e.id === id).mayApprove).toBe(false);
    expect(list.summary.toApprove).toBeGreaterThanOrEqual(1);
    expect((await call(ADMIN, 'POST', `/expenses/${id}/decide`, { approve: true, note: 'Checked the invoice' })).json()).toMatchObject({ status: 'approved' });
    expect((await inbox(TREAS, 'staff')).some((n) => n.title === 'An expense was approved')).toBe(true);
    expect((await call(ADMIN, 'POST', `/expenses/${id}/decide`, { approve: true })).json().code).toBe('already_decided');
  });

  it('rejects with a reason the recorder is told', async () => {
    const r = (await rec(TREAS, { amount: 12000, noReceiptReason: 'None' })).json().id;
    expect((await call(ADMIN, 'POST', `/expenses/${r}/decide`, { approve: false, note: 'This was already paid last month' })).json().status).toBe('rejected');
    expect((await inbox(TREAS, 'staff')).some((n) => n.title === 'An expense was not approved' && /already paid last month/.test(n.body))).toBe(true);
    expect((await call(TREAS, 'GET', `/expenses/${r}`)).json()).toMatchObject({ status: 'rejected', decisionNote: 'This was already paid last month' });
  });

  it('cannot be edited once approved: a mistake is voided with a reason, keeping the original', async () => {
    expect((await call(TREAS, 'PATCH', `/expenses/${id}`, { amount: 1 })).statusCode).toBe(404); // there is no way to edit
    expect((await call(TREAS, 'PUT', `/expenses/${id}`, { amount: 1 })).statusCode).toBe(404);
    expect((await call(TREAS, 'POST', `/expenses/${id}/void`, { reason: 'Wrong amount' })).statusCode).toBe(404); // the recorder cannot void an approved one
    expect((await call(ADMIN, 'POST', `/expenses/${id}/void`, { reason: 'no' })).json().code).toBe('bad_content');
    expect((await call(ADMIN, 'POST', `/expenses/${id}/void`, { reason: 'Recorded twice by mistake' })).json().status).toBe('voided');
    expect((await call(ADMIN, 'POST', `/expenses/${id}/void`, { reason: 'Again please' })).json().code).toBe('wrong_state');
    const row = (await call(TREAS, 'GET', `/expenses/${id}`)).json();
    expect(row).toMatchObject({ status: 'voided', amount: 900000, voidReason: 'Recorded twice by mistake', voidedBy: 'Samuel Kiptoo' });
    expect((await inbox(TREAS, 'staff')).some((n) => n.title === 'An expense was voided')).toBe(true);
  });

  it('lets the recorder withdraw one that is waiting', async () => {
    const w = (await rec(TREAS, { amount: 8000, noReceiptReason: 'x' })).json().id;
    expect((await call(TREAS, 'POST', `/expenses/${w}/void`, { reason: 'Changed my mind' })).json().status).toBe('voided');
  });

  it('asks for two different approvers above the owner\'s amount', async () => {
    await rules({ twoApproverLimit: 20000 });
    const e = (await rec(TREAS, { amount: 30000, noReceiptReason: 'Invoice to follow' })).json().id;
    expect((await call(ADMIN, 'POST', `/expenses/${e}/decide`, { approve: true })).json().status).toBe('awaiting_second');
    expect((await call(ADMIN, 'POST', `/expenses/${e}/decide`, { approve: true })).json().code).toBe('same_person');
    expect((await call(TREAS, 'POST', `/expenses/${e}/decide`, { approve: true })).statusCode).toBeGreaterThanOrEqual(403);
    expect((await inbox(OWNER, 'staff')).some((n) => n.title === 'A second approval is needed')).toBe(true);
    expect((await call(OWNER, 'POST', `/expenses/${e}/decide`, { approve: true })).json().status).toBe('approved');
    expect((await call(OWNER, 'GET', `/expenses/${e}`)).json()).toMatchObject({ firstApprover: 'Samuel Kiptoo', approver: 'Daniel Mwangi', status: 'approved' });
    await rules();
  });
});

describe('restricted funds (L242)', () => {
  it('stops a restricted project being overspent, unless the owner gives a reason', async () => {
    const roof = () => setup(TREAS).then((s) => s.projects.find((p: any) => p.code === 'ROOF'));
    const before = await roof();
    expect(before.restricted).toBe(true);
    const avail = before.available / 100; // KES
    expect(avail).toBeGreaterThan(0);
    const over = await rec(TREAS, { amount: avail + 1000, projectId: before.id, noReceiptReason: 'x' });
    expect(over.statusCode).toBe(409);
    expect(over.json().code).toBe('fund_short');
    expect(over.json().error).toMatch(/restricted fund has KES/);
    expect((await rec(OWNER, { amount: avail + 1000, projectId: before.id, noReceiptReason: 'x', overrideReason: 'short' })).json().code).toBe('fund_short'); // reason too short
    expect((await rec(TREAS, { amount: avail + 1000, projectId: before.id, noReceiptReason: 'x', overrideReason: 'Roof contractor needs paying before pledges arrive' })).json().code).toBe('fund_short'); // only the owner can override
    const ok = await rec(OWNER, { amount: avail + 1000, projectId: before.id, noReceiptReason: 'Deposit to contractor', overrideReason: 'Roof contractor needs paying before pledges arrive' });
    expect(ok.statusCode).toBe(200);
    const row = (await call(OWNER, 'GET', `/expenses/${ok.json().id}`)).json();
    expect(row).toMatchObject({ overridden: true, overrideReason: 'Roof contractor needs paying before pledges arrive' });
    const audit = (await call(PA1, 'GET', '/admin/audit/events?action=expense.recorded')).json().events;
    expect(audit.some((e: any) => /restricted fund overridden/.test(e.summary))).toBe(true);
    expect((await roof()).available).toBeLessThan(0);
  });

  it('counts what is waiting, and checks again when approving', async () => {
    await call(OWNER, 'POST', '/projects', { branchId: 'br_grc001', code: 'TANK', name: 'Water tank', target: 500000, restricted: true });
    const proj = (await setup(TREAS)).projects.find((p: any) => p.name === 'Water tank');
    expect(proj).toMatchObject({ restricted: true, available: 0 });
    expect((await rec(TREAS, { amount: 100, projectId: proj.id })).json().code).toBe('fund_short'); // nothing raised yet
    const plain = await call(OWNER, 'POST', '/projects', { branchId: 'br_grc001', code: 'OPEN', name: 'Open fund', target: 500000, restricted: false });
    const open = (await setup(TREAS)).projects.find((p: any) => p.name === 'Open fund');
    expect((await rec(TREAS, { amount: 100, projectId: open.id })).statusCode).toBe(200); // not restricted: no limit
    expect(plain.statusCode).toBeLessThan(500);
  });
});

describe('budgets and alerts (L241)', () => {
  it('sets a yearly budget by category and a project budget, and shows how much is spent', async () => {
    const year = Number(today().slice(0, 4));
    const util = cats['Utilities'];
    expect((await call(AUDITOR, 'PUT', '/expenses/budgets', { branchId: 'br_grc001', year, categories: [{ categoryId: util, amount: 10000 }] })).statusCode).toBe(403);
    expect((await call(COAST, 'PUT', '/expenses/budgets', { branchId: 'br_grc001', year, categories: [] })).statusCode).toBe(404);
    expect((await call(TREAS, 'PUT', '/expenses/budgets', { branchId: 'br_grc001', year, categories: [{ categoryId: 'nope', amount: 1 }] })).statusCode).toBe(404);
    expect((await call(TREAS, 'PUT', '/expenses/budgets', { branchId: 'br_grc001', year, categories: [{ categoryId: util, amount: 10000 }] })).statusCode).toBe(200);
    const b = (await call(TREAS, 'GET', `/expenses/budgets?year=${year}&branchId=br_grc001`)).json();
    expect(b.categories.find((c: any) => c.categoryId === util)).toMatchObject({ budget: 1000000, spent: 0, percent: 0 });
    expect(b.canManage).toBe(true);
    const roof = (await setup(TREAS)).projects.find((p: any) => p.code === 'ROOF');
    expect((await call(TREAS, 'PUT', '/expenses/project-budget', { projectId: roof.id, amount: 'abc' })).json().code).toBe('bad_amount');
    expect((await call(TREAS, 'PUT', '/expenses/project-budget', { projectId: roof.id, amount: 40000 })).statusCode).toBe(200);
    expect((await call(TREAS, 'GET', `/expenses/budgets?year=${year}&branchId=br_grc001`)).json().projects.find((p: any) => p.code === 'ROOF').budget).toBe(4000000);
  });

  it('tells the people who manage expenses once at 80% and once at 100%', async () => {
    const util = cats['Utilities'];
    let vendor = 0; // a different payee each time: the same person paying one payee repeatedly counts together toward the approval limit (LG-22)
    const spend = async (amount: number) => { const e = await rec(ADMIN, { amount, categoryId: util, noReceiptReason: 'Bill paid online', payee: `Utility vendor ${++vendor}` }); expect(e.statusCode).toBe(200); expect(e.json().status).toBe('approved'); };
    const alerts = async (who = TREAS) => (await inbox(who, 'staff')).filter((n) => /Utilities/.test(n.title) && /Budget alert|Over budget/.test(n.title));
    await spend(4000); // 40% of KES 10,000
    expect(await alerts()).toHaveLength(0);
    await spend(4000); // 80%
    let a = await alerts();
    expect(a).toHaveLength(1);
    expect(a[0].title).toMatch(/Budget alert/);
    expect(a[0].body).toMatch(/80%.*KES 8,000 of KES 10,000/);
    await spend(200); // 82%: no second alert
    expect(await alerts()).toHaveLength(1);
    await spend(2000); // 102%
    a = await alerts();
    expect(a).toHaveLength(2);
    expect(a.some((n) => /Over budget/.test(n.title))).toBe(true);
    await spend(500);
    expect(await alerts()).toHaveLength(2);
    expect((await alerts(OWNER)).length).toBe(2);
    expect(await alerts(AUDITOR)).toHaveLength(0);
    const b = (await call(TREAS, 'GET', `/expenses/budgets?year=${today().slice(0, 4)}&branchId=br_grc001`)).json();
    expect(b.categories.find((c: any) => c.categoryId === util)).toMatchObject({ budget: 1000000, spent: 1070000, percent: 107 });
  });

  it('also watches a project budget', async () => {
    await call(OWNER, 'POST', '/projects', { branchId: 'br_grc001', code: 'ROBES', name: 'Choir robes', target: 500000, restricted: false });
    const p = (await setup(TREAS)).projects.find((x: any) => x.name === 'Choir robes');
    await call(TREAS, 'PUT', '/expenses/project-budget', { projectId: p.id, amount: 1000 });
    expect((await rec(ADMIN, { amount: 900, projectId: p.id, payee: 'Robes tailor A' })).json().status).toBe('approved');
    expect((await inbox(TREAS, 'staff')).some((n) => /Budget alert: the project Choir robes/.test(n.title))).toBe(true);
    expect((await rec(ADMIN, { amount: 200, projectId: p.id, payee: 'Robes tailor B' })).json().status).toBe('approved');
    expect((await inbox(TREAS, 'staff')).some((n) => /Over budget: the project Choir robes/.test(n.title))).toBe(true);
    const row = (await call(TREAS, 'GET', '/projects')).json().find((x: any) => x.name === 'Choir robes');
    expect(row).toMatchObject({ budget: 100000, spent: 110000 });
  });
});

describe('claims from the app (L240)', () => {
  let id = '';
  const claim = (who: string, extra: any = {}) => call(who, 'POST', '/me/claims', { branchId: 'br_grc001', date: today(), amount: 800, categoryId: cats['Transport'], payee: 'Bus fare to the printers', note: 'Collected the Easter programmes', ...extra });

  it('is for people given the right to claim', async () => {
    expect((await call(VOL, 'GET', '/me/claims/setup')).json()).toMatchObject({ allowed: true, receiptRequiredAbove: 100000 });
    expect((await call(VOL, 'GET', '/me/claims/setup')).json().categories.length).toBeGreaterThan(5);
    expect((await call(JANE, 'GET', '/me/claims/setup')).json()).toEqual({ allowed: false });
    expect((await claim(JANE)).statusCode).toBe(403);
    expect((await call(VOL, 'GET', '/expenses')).statusCode).toBe(403); // a claimant cannot see the church's expenses
  });

  it('always needs an approver, even when small, and a receipt above the limit', async () => {
    expect((await claim(VOL, { amount: 1500 })).json().code).toBe('receipt_required');
    const r = await claim(VOL);
    expect(r.json()).toMatchObject({ status: 'submitted', autoApproved: false });
    id = r.json().id;
    expect((await call(VOL, 'GET', '/me/claims')).json().claims.find((c: any) => c.id === id)).toMatchObject({ kind: 'claim', status: 'submitted', amount: 80000, recordedBy: 'Volunteer Vera', paid: false });
    expect((await inbox(ADMIN, 'staff')).some((n) => n.title === 'An expense claim needs approval')).toBe(true);
    expect((await claim(VOL, { amount: 2500, files: [png()] })).statusCode).toBe(200);
  });

  it('is approved by someone else, then marked paid with the payment reference', async () => {
    expect((await call(VOL, 'POST', `/expenses/${id}/decide`, { approve: true })).statusCode).toBe(404);
    expect((await call(ADMIN, 'POST', `/expenses/${id}/paid`, { reference: 'ABC1' })).json().code).toBe('wrong_state'); // not approved yet
    expect((await call(ADMIN, 'POST', `/expenses/${id}/decide`, { approve: true })).json().status).toBe('approved');
    expect((await inbox(VOL, 'staff')).some((n) => n.title === 'Your claim was approved')).toBe(true);
    expect((await call(TREAS, 'GET', '/expenses?unpaid=1')).json().expenses.map((e: any) => e.id)).toContain(id);
    expect((await call(AUDITOR, 'POST', `/expenses/${id}/paid`, { reference: 'ABC1' })).statusCode).toBeGreaterThanOrEqual(403);
    expect((await call(TREAS, 'POST', `/expenses/${id}/paid`, {})).json().code).toBe('bad_content');
    ctx.messaging.clear();
    expect((await call(TREAS, 'POST', `/expenses/${id}/paid`, { reference: 'SGH7K2L9' })).json().paid).toBe(true);
    expect((await call(TREAS, 'POST', `/expenses/${id}/paid`, { reference: 'AGAIN' })).json().code).toBe('already_paid');
    expect((await call(VOL, 'GET', '/me/claims')).json().claims.find((c: any) => c.id === id)).toMatchObject({ paid: true, paidReference: 'SGH7K2L9', paidBy: 'Esther Njeri' });
    expect((await inbox(VOL, 'staff')).some((n) => n.title === 'Your claim was paid')).toBe(true);
    expect(ctx.messaging.sent.some((m) => m.to === '254700000558' && /SGH7K2L9/.test(m.body))).toBe(true);
    expect((await call(TREAS, 'GET', '/expenses?unpaid=1')).json().expenses.map((e: any) => e.id)).not.toContain(id);
    expect((await call(ADMIN, 'POST', `/expenses/${id}/void`, { reason: 'Voiding after it was paid' })).json().code).toBe('paid');
    const plain = (await rec(TREAS, { amount: 100 })).json().id;
    expect((await call(TREAS, 'POST', `/expenses/${plain}/paid`, { reference: 'X1' })).json().code).toBe('wrong_state'); // only claims are marked paid
  });

  it('can be rejected with a reason the claimant sees, and the claimant can read their own receipts', async () => {
    const r = (await claim(VOL, { amount: 3000, files: [png()] })).json().id;
    expect((await call(ADMIN, 'POST', `/expenses/${r}/decide`, { approve: false, note: 'This was a personal trip' })).json().status).toBe('rejected');
    expect((await call(VOL, 'GET', '/me/claims')).json().claims.find((c: any) => c.id === r)).toMatchObject({ status: 'rejected', decisionNote: 'This was a personal trip' });
    const files = (await call(ADMIN, 'GET', `/expenses/${r}`)).json().fileList;
    expect((await call(VOL, 'GET', `/expenses/${r}/files/${files[0].id}`)).statusCode).toBe(200);
    expect((await call(JANE, 'GET', `/expenses/${r}/files/${files[0].id}`)).statusCode).toBe(404);
  });
});

describe('the list and the reports (L243)', () => {
  it('filters, searches and downloads the list', async () => {
    const all = (await call(TREAS, 'GET', '/expenses')).json().expenses;
    expect(all.length).toBeGreaterThan(10);
    const util = (await call(TREAS, 'GET', `/expenses?category=${cats['Utilities']}`)).json().expenses;
    expect(util.length).toBeGreaterThan(0);
    expect(util.every((e: any) => e.category === 'Utilities')).toBe(true);
    expect((await call(TREAS, 'GET', '/expenses?q=Mama')).json().expenses.every((e: any) => /Mama/.test(e.payee))).toBe(true);
    expect((await call(TREAS, 'GET', '/expenses?kind=claim')).json().expenses.every((e: any) => e.kind === 'claim')).toBe(true);
    expect((await call(TREAS, 'GET', '/expenses?status=voided')).json().expenses.every((e: any) => e.status === 'voided')).toBe(true);
    expect((await call(TREAS, 'GET', '/expenses?from=2099-01-01')).json().expenses).toEqual([]);
    expect((await call(TREAS, 'GET', '/expenses?csv=1')).body).toContain('Recorded by');
    expect((await call(HOPE, 'GET', '/expenses')).json().expenses).toEqual([]);
    expect((await call(COAST, 'GET', '/expenses')).json().expenses).toEqual([]); // Mombasa's treasurer sees only Mombasa, where nothing has been recorded
  });

  it('adds up by category, project, branch and month, counts receipts, and sets income against spending', async () => {
    const r = (await call(AUDITOR, 'GET', '/expenses/summary')).json();
    expect(r.totals.count).toBeGreaterThan(5);
    expect(r.totals.amount).toBeGreaterThan(1000000);
    expect(r.byCategory[0].amount).toBeGreaterThanOrEqual(r.byCategory[r.byCategory.length - 1].amount);
    expect(r.byCategory.find((c: any) => c.name === 'Utilities').amount).toBe(1070000);
    expect(r.byProject.map((p: any) => p.name)).toEqual(expect.arrayContaining(['No project', 'Choir robes']));
    expect(r.byBranch.map((b: any) => b.name)).toEqual(['Grace Nairobi']);
    expect(r.byMonth.length).toBeGreaterThan(0);
    expect(r.totals.receiptShare).toBeGreaterThan(0);
    expect(r.totals.receiptShare).toBeLessThan(100);
    expect(r.income.giving).toBeGreaterThan(0);
    expect(r.balance).toBe(r.income.total - r.totals.amount);
    expect((await call(AUDITOR, 'GET', '/expenses/summary?branchId=br_grc002')).json().totals.count).toBe(0); // the auditor sees every branch
    expect((await call(COAST, 'GET', '/expenses/summary?branchId=br_grc001')).statusCode).toBe(404); // Mombasa's treasurer does not see Nairobi
    expect((await call(TREAS, 'GET', '/expenses/summary?from=2099-01-01&to=2099-12-31')).json().totals).toMatchObject({ count: 0, amount: 0, receiptShare: null });
    expect((await call(HOPE, 'GET', '/expenses/summary')).json().totals.count).toBe(0);
    expect((await call(PETER, 'GET', '/expenses/summary')).statusCode).toBe(403);
    const voided = (await call(TREAS, 'GET', '/expenses?status=voided,rejected')).json().expenses.length;
    expect(voided).toBeGreaterThan(0); // voided and rejected expenses are not in the totals above
  });

  it('leaves every step in the audit log, and keeps the books balanced', async () => {
    const actions = new Set<string>();
    for (const a of ['expense.recorded', 'expense.approved', 'expense.rejected', 'expense.voided', 'expense.claimed', 'expense.claim_paid', 'expense.settings', 'expense.first_approval', 'expense.budgets', 'expense.category_added']) {
      if ((await call(PA1, 'GET', `/admin/audit/events?action=${a}`)).json().events.length) actions.add(a);
    }
    expect([...actions].sort()).toEqual(['expense.approved', 'expense.budgets', 'expense.category_added', 'expense.claim_paid', 'expense.claimed', 'expense.first_approval', 'expense.recorded', 'expense.rejected', 'expense.settings', 'expense.voided']);
    expect((await call(PA1, 'GET', '/admin/reconcile')).json().ok).toBe(true);
  });
});
