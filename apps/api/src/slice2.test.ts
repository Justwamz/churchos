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

const GRACE_OWNER = '0700000001', GRACE_ADMIN = '0700000003', HOPE = '0700000005', NEWHOPE = '0700000006';
const PA1 = '0700000099', JANE = '0711000001';
const pdf = Buffer.from('%PDF-1.4 test').toString('base64');
const upload = (phone: string, type: string, branchId?: string, extra: any = {}) =>
  call(phone, 'POST', '/kyc/documents', { type, branchId, filename: `${type}.pdf`, mime: 'application/pdf', data: pdf, ...extra });

const wait = async (fn: () => Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);

describe('KYC and verification (L81)', () => {
  it('REVIEW FOCUS 1: a new church collects but is not paid until every document is approved', async () => {
    await call(PA1, 'POST', '/admin/simulate/paybill', { phone: '0722000333', amount: 1000, reference: 'NHF001#TITHE' });
    await call(PA1, 'POST', '/admin/clock/advance', { hours: 49 });
    const run1 = (await call(PA1, 'POST', '/admin/settlement/run', {})).json();
    expect(run1.results.find((r: any) => r.branchId === 'br_nhf001').status).toBe('skipped');

    const decide = async (docId: string, approve = true, reason?: string) =>
      call(PA1, 'POST', `/admin/kyc/documents/${docId}/decide`, { approve, reason });
    const status = async () => (await call(NEWHOPE, 'GET', '/kyc/status')).json();
    const pending = async (type: string) => (await status()).required.find((r: any) => r.type === type).latest ?? (await status()).branches[0].payoutProof.latest;

    // Approve the seeded registration certificate, then add and approve the rest one by one, checking after each.
    const reg = (await status()).required.find((r: any) => r.type === 'registration_certificate').latest;
    expect((await decide(reg.id)).statusCode).toBe(200);
    const pin = (await upload(NEWHOPE, 'kra_pin')).json();
    const sig = (await upload(NEWHOPE, 'signatory_id')).json();
    await decide(pin.id);
    await decide(sig.id);
    expect((await status()).branches[0].verified).toBe(false); // payout proof still missing

    const proof = (await upload(NEWHOPE, 'payout_proof', 'br_nhf001')).json();
    expect((await decide(proof.id, false, 'Statement is older than 3 months')).statusCode).toBe(200);
    expect((await status()).branches[0].verified).toBe(false);
    expect((await status()).branches[0].payoutProof.latest.reason).toMatch(/older/);

    const proof2 = (await upload(NEWHOPE, 'payout_proof', 'br_nhf001')).json();
    expect((await status()).branches[0].verified).toBe(false); // resubmitted but not yet approved
    await decide(proof2.id);
    expect((await status()).branches[0].verified).toBe(true);

    const run2 = (await call(PA1, 'POST', '/admin/settlement/run', {})).json();
    expect(run2.results.find((r: any) => r.branchId === 'br_nhf001').status).toBe('paid');
    expect((await call(PA1, 'GET', '/admin/reconcile')).json().ok).toBe(true);
    void pending;
  });

  it('a later unreviewed replacement of an approved document pauses payouts again', async () => {
    const before = (await call(NEWHOPE, 'GET', '/kyc/status')).json();
    expect(before.branches[0].verified).toBe(true);
    await upload(NEWHOPE, 'kra_pin'); // newer upload, not reviewed
    expect((await call(NEWHOPE, 'GET', '/kyc/status')).json().branches[0].verified).toBe(false);
  });

  it('rejects bad uploads: wrong type, empty, too large, wrong branch, and non-managers', async () => {
    expect((await call(NEWHOPE, 'POST', '/kyc/documents', { type: 'passport', mime: 'application/pdf', data: pdf })).json().code).toBe('bad_type');
    expect((await call(NEWHOPE, 'POST', '/kyc/documents', { type: 'kra_pin', mime: 'text/html', data: pdf })).json().code).toBe('bad_file_type');
    expect((await call(NEWHOPE, 'POST', '/kyc/documents', { type: 'kra_pin', mime: 'application/pdf', data: '' })).json().code).toBe('no_file');
    const big = Buffer.alloc(3 * 1024 * 1024 + 10, 1).toString('base64');
    expect((await call(NEWHOPE, 'POST', '/kyc/documents', { type: 'kra_pin', mime: 'application/pdf', data: big })).statusCode).toBe(413);
    expect((await upload(NEWHOPE, 'payout_proof', 'br_grc001')).statusCode).toBe(403); // another church's branch
    expect((await upload(JANE, 'kra_pin')).statusCode).toBe(403); // a member
  });

  it('a rejection needs a reason, and only platform admins can review', async () => {
    const docs = (await call(PA1, 'GET', '/admin/kyc/org_newhope')).json();
    const open = docs.required.flatMap((r: any) => r.documents).find((d: any) => d.status === 'submitted');
    expect((await call(PA1, 'POST', `/admin/kyc/documents/${open.id}/decide`, { approve: false })).json().code).toBe('reason_required');
    expect((await call(NEWHOPE, 'POST', `/admin/kyc/documents/${open.id}/decide`, { approve: true })).statusCode).toBe(403);
    const file = await app.inject({ method: 'GET', url: `/admin/kyc/documents/${open.id}/file`, headers: { authorization: `Bearer ${await login(PA1)}` } });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
  });
});

describe('payout destination changes (L35, L88)', () => {
  const dest = { type: 'bank', bank: 'Equity', accountNumber: '0170555444', accountName: 'Grace Community Church' };

  it('REVIEW FOCUS 2: only the owner can ask, an admin must approve, and it applies only after the cooling-off', async () => {
    expect((await call(GRACE_ADMIN, 'POST', '/payout-destination/requests', { branchId: 'br_grc001', destination: dest })).statusCode).toBe(403);
    expect((await call(GRACE_OWNER, 'POST', '/payout-destination/requests', { branchId: 'br_grc001', destination: { type: 'bank', bank: 'X', accountNumber: 'abc', accountName: '' } })).json().code).toBe('bad_destination');
    const r = await call(GRACE_OWNER, 'POST', '/payout-destination/requests', { branchId: 'br_grc001', destination: dest });
    expect(r.statusCode).toBe(200);
    expect((await call(GRACE_OWNER, 'POST', '/payout-destination/requests', { branchId: 'br_grc001', destination: dest })).json().code).toBe('duplicate_request');
    const current = async () => (await ctx.db.query<any>(`SELECT payout_destination FROM branches WHERE id='br_grc001'`))[0].payout_destination.accountNumber;
    expect(await current()).toBe('1100234567'); // nothing changes before approval

    expect((await call(GRACE_OWNER, 'POST', `/admin/payout-requests/${r.json().id}/decide`, { approve: true })).statusCode).toBe(403);
    const ok = await call(PA1, 'POST', `/admin/payout-requests/${r.json().id}/decide`, { approve: true });
    expect(ok.json().status).toBe('approved');
    await call(PA1, 'POST', '/admin/settlement/run', {});
    expect(await current()).toBe('1100234567'); // still the old account during cooling-off

    await call(PA1, 'POST', '/admin/clock/advance', { hours: 73 });
    await call(PA1, 'POST', '/admin/settlement/run', {});
    expect(await current()).toBe('0170555444');
  });

  it('the owner sees a masked account number, never the full one', async () => {
    const r = (await call(GRACE_OWNER, 'GET', '/payout-destination')).json();
    expect(r.branches[0].destination.accountNumber).toMatch(/^••••\d{4}$/);
    expect((await call(GRACE_ADMIN, 'GET', '/payout-destination')).statusCode).toBe(403);
  });
});

describe('SMS wallet (L57 to L60, L87)', () => {
  it('shows the balance, and a staff top-up by STK credits the wallet, not collections', async () => {
    const before = (await call(GRACE_OWNER, 'GET', '/sms/wallet')).json();
    expect(before.paybillReference).toBe('SMS#GRACE');
    const collectionsBefore = Number((await call(GRACE_OWNER, 'GET', '/dashboard')).json().today.gross);
    const t = await call(GRACE_OWNER, 'POST', '/sms/topup', { amount: 200, phone: '0700000001' });
    expect(t.statusCode).toBe(200);
    expect(await wait(async () => (await call(GRACE_OWNER, 'GET', `/sms/topup/${t.json().id}`)).json().status === 'completed')).toBe(true);
    const after = (await call(GRACE_OWNER, 'GET', '/sms/wallet')).json();
    expect(after.balance).toBe(before.balance + 20000);
    expect(Number((await call(GRACE_OWNER, 'GET', '/dashboard')).json().today.gross)).toBe(collectionsBefore);
    expect((await call(GRACE_OWNER, 'POST', '/sms/topup', { amount: 5, phone: '0700000001' })).json().code).toBe('amount_too_small');
    expect((await call(GRACE_ADMIN, 'GET', '/sms/wallet')).statusCode).toBe(200); // branch admin manages SMS
    expect((await call(JANE, 'GET', '/sms/wallet')).statusCode).toBe(403);
  });

  it('REVIEW FOCUS 4: a duplicate top-up notification credits once, and an unknown wallet code is held in suspense', async () => {
    const before = (await call(GRACE_OWNER, 'GET', '/sms/wallet')).json().balance;
    await call(PA1, 'POST', '/admin/simulate/paybill', { phone: '0700000001', amount: 100, reference: 'sms#grace', duplicate: true });
    expect((await call(GRACE_OWNER, 'GET', '/sms/wallet')).json().balance).toBe(before + 10000);
    await call(PA1, 'POST', '/admin/simulate/paybill', { phone: '0700000001', amount: 100, reference: 'SMS#NOPE' });
    const s = (await call(PA1, 'GET', '/admin/suspense')).json();
    expect(s.some((x: any) => x.reference === 'SMS#NOPE')).toBe(true);
    expect((await call(PA1, 'GET', '/admin/reconcile')).json().ok).toBe(true);
  });

  it('a receipt reaches the member in-app and by SMS when the wallet has credit', async () => {
    const g = await call(null, 'POST', '/public/give', { code: 'GRC001', purpose: 'TITHE', phone: '0711000001', amount: 500 });
    await wait(async () => (await call(null, 'GET', `/public/give/${g.json().intentId}`)).json().status === 'completed');
    await wait(async () => (await call(JANE, 'GET', '/me/notifications')).json().rows.some((r: any) => r.kind === 'receipt' && /KES 500/.test(r.body)));
    const n = (await call(JANE, 'GET', '/me/notifications')).json();
    expect(n.unread).toBeGreaterThan(0);
    expect((await call(JANE, 'POST', '/me/notifications/read', {})).statusCode).toBe(200);
    expect((await call(JANE, 'GET', '/me/notifications')).json().unread).toBe(0);
    const log = (await call(GRACE_OWNER, 'GET', '/sms/wallet')).json().messages;
    expect(log.some((m: any) => m.kind === 'receipt' && m.status === 'sent')).toBe(true);
  });

  it('REVIEW FOCUS 3: with an empty wallet, gifts still succeed, the in-app notice is kept, and the balance never goes negative', async () => {
    expect((await call(HOPE, 'GET', '/sms/wallet')).json().empty).toBe(true);
    await ctx.db.query(`INSERT INTO users (id, phone, name, created_at) VALUES ('u_hopegiver','254733000999','Hope Giver',$1)`, [ctx.clock.now().toISOString()]);
    await call(PA1, 'POST', '/admin/simulate/paybill', { phone: '0733000999', amount: 300, reference: 'HPC001#TITHE' });
    const w = (await call(HOPE, 'GET', '/sms/wallet')).json();
    expect(w.balance).toBe(0);
    expect(w.messages.some((m: any) => m.status === 'skipped_no_balance')).toBe(true);
    const n = await ctx.db.query<any>(`SELECT kind FROM notifications WHERE user_id='u_hopegiver'`);
    expect(n.length).toBe(1);
    expect((await call(PA1, 'GET', '/admin/reconcile')).json().ok).toBe(true);
  });

  it('pledge reminders go to members with a balance outstanding', async () => {
    const proj = (await call(GRACE_OWNER, 'GET', '/projects')).json().find((p: any) => p.code === 'ROOF');
    const r = await call(GRACE_OWNER, 'POST', `/projects/${proj.id}/remind`, {});
    expect(r.statusCode).toBe(200);
    expect(r.json().pledges).toBeGreaterThan(0);
    expect(r.json().smsSent + r.json().smsSkippedNoBalance + r.json().alreadyPaid).toBe(r.json().pledges);
  });
});

describe('help and knowledge base (L82 to L86)', () => {
  it('lists member help to anyone and finds articles by search', async () => {
    const list = (await call(null, 'GET', '/help/articles')).json();
    expect(list.length).toBeGreaterThan(3);
    expect(list.every((a: any) => a.audiences.includes('member'))).toBe(true);
    const s = (await call(null, 'GET', '/help/search?q=wrong%20church%20refund')).json();
    expect(s.results[0].articleId).toBe('member-wrong-payment');
    expect(s.results[0].snippet.length).toBeGreaterThan(10);
  });

  it('REVIEW FOCUS 5: staff and admin articles never reach an anonymous visitor or a member', async () => {
    for (const who of [null, JANE]) {
      const q = (await call(who, 'GET', '/help/search?q=suspense%20queue%20reconcile%20maker%20checker')).json();
      expect(q.results.every((r: any) => r.articleId.startsWith('member-'))).toBe(true);
      expect((await call(who, 'GET', '/help/articles/admin-suspense')).statusCode).toBe(404);
      expect((await call(who, 'GET', '/help/articles/staff-cash-count')).statusCode).toBe(404);
      expect((await call(who, 'GET', '/help/articles?audience=admin')).json()).toEqual([]);
      expect((await call(who, 'GET', '/help/context?screen=staff.cash')).json()).toEqual([]);
    }
  });

  it('staff see staff help but not admin help; platform admins see everything', async () => {
    expect((await call(GRACE_ADMIN, 'GET', '/help/articles/staff-cash-count')).statusCode).toBe(200);
    expect((await call(GRACE_ADMIN, 'GET', '/help/articles/admin-suspense')).statusCode).toBe(404);
    expect((await call(PA1, 'GET', '/help/articles/admin-suspense')).statusCode).toBe(200);
    const ctxHelp = (await call(GRACE_ADMIN, 'GET', '/help/context?screen=staff.cash')).json();
    expect(ctxHelp.map((a: any) => a.id)).toContain('staff-cash-count');
  });

  it('the retrieval endpoint returns whole chunks with metadata for a future assistant', async () => {
    const r = (await call(GRACE_ADMIN, 'GET', '/help/search?q=cash%20second%20person&full=1')).json();
    expect(r.results.length).toBeGreaterThan(0);
    const top = r.results[0];
    expect(top).toHaveProperty('chunkId');
    expect(top).toHaveProperty('text');
    expect(top).toHaveProperty('version');
    expect(top.tags).toContain('cash');
  });

  it('empty and odd queries are harmless', async () => {
    expect((await call(null, 'GET', '/help/search?q=')).json().results).toEqual([]);
    expect((await call(null, 'GET', "/help/search?q=%27%3B%20drop%20table%20help_articles%3B--")).statusCode).toBe(200);
    expect((await call(null, 'GET', '/help/search?q=%22unterminated')).statusCode).toBe(200);
  });
});
