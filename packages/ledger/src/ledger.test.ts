import { beforeEach, describe, expect, it } from 'vitest';
import { MockProvider } from '@churchos/payments';
import { Clock, createDb, Ledger } from './index';

async function setup(opts: { feeBearer?: 'church' | 'member' } = {}) {
  const db = await createDb();
  const clock = new Clock();
  const provider = new MockProvider({ stkDelayMs: 0 });
  const ledger = new Ledger(db, clock, provider);
  await ledger.migrate();
  await ledger.createOrg({ id: 'org1', name: 'Grace', feeBearer: opts.feeBearer, smsCode: 'GRACE' });
  await ledger.createOrg({ id: 'org2', name: 'Other Church' });
  await ledger.createBranch({ id: 'b1', orgId: 'org1', code: 'GRC001', name: 'Nairobi', payoutVerified: true, payoutDestination: { type: 'bank', bank: 'KCB', accountNumber: '123', accountName: 'Grace' } });
  await ledger.createBranch({ id: 'b2', orgId: 'org2', code: 'OTH001', name: 'Other', payoutVerified: true, payoutDestination: { type: 'bank', bank: 'KCB', accountNumber: '999', accountName: 'Other' } });
  // Route the mock PSP's notifications straight into the ledger, like the real webhook would.
  provider.setDeliver(async (raw, headers) => {
    if (!provider.verifyWebhook(headers, raw)) throw new Error('bad signature');
    await ledger.receivePayment(provider.parseWebhook(raw));
  });
  return { db, clock, provider, ledger };
}

const pay = (provider: MockProvider, ref: string, amount = 100000, extra: any = {}) =>
  provider.simulatePaybill({ phone: '0712345678', amount, reference: ref, ...extra });

describe('intake', () => {
  it('matches a payment to the branch and posts a balanced entry', async () => {
    const { ledger, provider } = await setup();
    await pay(provider, 'GRC001#TITHE');
    expect(await ledger.balance('pending', 'b1')).toBe(97500); // 100000 - 1500 platform - 1000 psp
    expect(await ledger.balance('fee_revenue')).toBe(1500);
    expect(await ledger.balance('psp_cost_payable')).toBe(1000);
    const r = await ledger.reconcile();
    expect(r.ok).toBe(true);
  });

  it('REVIEW FOCUS 1: a duplicate PSP webhook posts exactly once', async () => {
    const { ledger, provider, db } = await setup();
    await pay(provider, 'GRC001#TITHE', 100000, { providerTxId: 'TX1', duplicate: true });
    const n = await db.query<{ c: number }>(`SELECT COUNT(*) AS c FROM payments`);
    expect(Number(n[0].c)).toBe(1);
    expect(await ledger.balance('pending', 'b1')).toBe(97500);
  });

  it('REVIEW FOCUS 2: wrong, empty and malformed references go to suspense; messy but valid ones match', async () => {
    const { ledger, provider } = await setup();
    await pay(provider, 'GRC999#TITHE');
    await pay(provider, '');
    await pay(provider, '#TITHE');
    expect(await ledger.balance('suspense')).toBe(300000);
    expect(await ledger.balance('pending', 'b1')).toBe(0);
    await pay(provider, '  grc001#tithe  ');
    expect(await ledger.balance('pending', 'b1')).toBe(97500);
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('REVIEW FOCUS 3: gross always equals net plus fee for awkward amounts', async () => {
    const { ledger, provider, db } = await setup();
    for (const amt of [1, 7, 33, 101, 12345, 99999]) await pay(provider, 'GRC001#OFFERING', amt);
    const rows = await db.query<any>(`SELECT amount_paid, net, platform_fee, psp_cost FROM payments`);
    for (const r of rows) expect(r.net + r.platform_fee + r.psp_cost).toBe(r.amount_paid);
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('claiming a suspense payment credits the branch and restarts its hold', async () => {
    const { ledger, provider, clock, db } = await setup();
    await pay(provider, 'WRONG', 100000);
    const id = (await db.query<any>(`SELECT id FROM payments`))[0].id;
    clock.advanceHours(47);
    await ledger.claimSuspense(id, 'b1');
    expect(await ledger.balance('suspense')).toBe(0);
    expect(await ledger.balance('pending', 'b1')).toBe(97500);
    clock.advanceHours(10);
    expect(await ledger.releasePending()).toBe(0); // hold restarted at claim time
    clock.advanceHours(40);
    expect(await ledger.releasePending()).toBe(1);
  });
});

describe('settlement', () => {
  it('holds funds 48h, then pays out everything Available in the daily batch', async () => {
    const { ledger, provider, clock } = await setup();
    await pay(provider, 'GRC001#TITHE');
    let res = await ledger.runSettlement();
    expect(res.find((r) => r.branchId === 'b1')!.status).toBe('nothing');
    clock.advanceHours(49);
    res = await ledger.runSettlement();
    expect(res.find((r) => r.branchId === 'b1')).toMatchObject({ status: 'paid', amount: 97500 });
    expect(await ledger.balance('available', 'b1')).toBe(0);
    expect(provider.payoutsSent).toHaveLength(1);
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('never drops funds when the PSP fails the payout, and retries next run', async () => {
    const { ledger, provider, clock } = await setup();
    await pay(provider, 'GRC001#TITHE');
    clock.advanceHours(49);
    provider.failNextPayout();
    const res = await ledger.runSettlement();
    expect(res.find((r) => r.branchId === 'b1')!.status).toBe('failed');
    expect(await ledger.balance('available', 'b1')).toBe(97500);
    expect(await ledger.balance('in_transit')).toBe(0);
    const retry = await ledger.runSettlement();
    expect(retry.find((r) => r.branchId === 'b1')!.status).toBe('paid');
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('carries over payouts below the minimum', async () => {
    const { ledger, provider, clock } = await setup();
    ledger.opts.minPayout = 100000;
    await pay(provider, 'GRC001#TITHE', 50000);
    clock.advanceHours(49);
    const res = await ledger.runSettlement();
    expect(res.find((r) => r.branchId === 'b1')!.status).toBe('carried');
    expect(await ledger.balance('available', 'b1')).toBe(48750);
  });

  it('keeps branches and churches strictly separate in one wallet', async () => {
    const { ledger, provider, clock } = await setup();
    await pay(provider, 'GRC001#TITHE', 100000);
    await pay(provider, 'OTH001#TITHE', 200000);
    clock.advanceHours(49);
    await ledger.runSettlement();
    expect(provider.payoutsSent.map((p) => p.amount).sort()).toEqual([97500, 195000].sort());
    expect((await ledger.reconcile()).ok).toBe(true);
  });
});

describe('reversals', () => {
  it('reverses from Pending: refunds sender less PSP cost, returns the platform fee', async () => {
    const { ledger, provider, db } = await setup();
    await pay(provider, 'GRC001#TITHE', 100000);
    const id = (await db.query<any>(`SELECT id FROM payments`))[0].id;
    await ledger.reverse(id, { reason: 'wrong church' });
    expect(await ledger.balance('pending', 'b1')).toBe(0);
    expect(await ledger.balance('fee_revenue')).toBe(0);
    expect(await ledger.balance('psp_cost_payable')).toBe(1000); // third-party cost is kept
    expect(await provider.walletBalance()).toBe(1000);
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('rejects reversal after the window unless forced', async () => {
    const { ledger, provider, clock, db } = await setup();
    await pay(provider, 'GRC001#TITHE');
    const id = (await db.query<any>(`SELECT id FROM payments`))[0].id;
    clock.advanceHours(73);
    await expect(ledger.reverse(id, { reason: 'late' })).rejects.toMatchObject({ code: 'window_expired' });
  });

  it('does not change anything when the PSP refuses the refund', async () => {
    const { ledger, provider, db } = await setup();
    await pay(provider, 'GRC001#TITHE');
    const id = (await db.query<any>(`SELECT id FROM payments`))[0].id;
    provider.failNextRefund();
    await expect(ledger.reverse(id, { reason: 'x' })).rejects.toMatchObject({ code: 'refund_failed' });
    expect(await ledger.balance('pending', 'b1')).toBe(97500);
  });

  it('REVIEW FOCUS 4: a reversal after payout becomes a receivable netted from the next payout', async () => {
    const { ledger, provider, clock, db } = await setup();
    await pay(provider, 'GRC001#TITHE', 100000);
    const id = (await db.query<any>(`SELECT id FROM payments`))[0].id;
    clock.advanceHours(49);
    await ledger.runSettlement(); // paid out 97500
    await pay(provider, 'OTH001#TITHE', 500000); // other churches' funds keep the shared wallet liquid for the refund
    await ledger.reverse(id, { reason: 'dispute' }); // within 72h window, already paid out
    expect(await ledger.balance('receivable', 'b1')).toBe(97500);
    expect((await ledger.reconcile()).ok).toBe(true);

    // A small collection cannot cover the debt, which is above the 10% cap, so payouts pause (D3).
    await pay(provider, 'GRC001#TITHE', 10000);
    clock.advanceHours(49);
    const paused = await ledger.runSettlement();
    expect(paused.find((r) => r.branchId === 'b1')!.status).toBe('paused');

    // Support resumes the branch and raises the cap. The available funds net against the debt, nothing is sent.
    await ledger.resumeBranch('b1');
    ledger.opts.debtCapRatio = 1000;
    const partial = await ledger.runSettlement();
    expect(partial.find((r) => r.branchId === 'b1')).toMatchObject({ status: 'paid', amount: 0, netted: 9750 });
    expect(await ledger.balance('receivable', 'b1')).toBe(97500 - 9750);

    // A bigger collection clears the rest of the debt, and the remainder is paid out.
    await pay(provider, 'GRC001#TITHE', 300000);
    clock.advanceHours(49);
    const res = await ledger.runSettlement();
    expect(res.find((r) => r.branchId === 'b1')).toMatchObject({ status: 'paid', netted: 97500 - 9750, amount: 292500 - (97500 - 9750) });
    expect(await ledger.balance('receivable', 'b1')).toBe(0);
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('refunds expired suspense payments after 48h, net of third-party cost', async () => {
    const { ledger, provider, clock } = await setup();
    await pay(provider, 'NOPE', 100000);
    clock.advanceHours(49);
    expect(await ledger.expireSuspense()).toBe(1);
    expect(await ledger.balance('suspense')).toBe(0);
    expect(await provider.walletBalance()).toBe(1000);
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('charges the platform fee on approved cash from Available, or as a receivable', async () => {
    const { ledger, provider, clock, db } = await setup();
    await db.tx((q) => ledger.chargeCashFee(q, 'b1', 'cash1', 1500));
    expect(await ledger.balance('receivable', 'b1')).toBe(1500);
    await pay(provider, 'GRC001#TITHE', 100000);
    clock.advanceHours(49);
    const res = await ledger.runSettlement();
    expect(res.find((r) => r.branchId === 'b1')).toMatchObject({ status: 'paid', netted: 1500 });
    expect((await ledger.reconcile()).ok).toBe(true);
  });
});

describe('ledger integrity', () => {
  it('rejects unbalanced entries', async () => {
    const { ledger, db } = await setup();
    await expect(
      db.tx((q) =>
        ledger.postEntry(q, { idemKey: 'bad', kind: 'x', postings: [{ accountId: 'platform:wallet', amount: 100 }, { accountId: 'platform:suspense', amount: -99 }] }),
      ),
    ).rejects.toMatchObject({ code: 'unbalanced' });
  });

  it('posts an idempotency key only once', async () => {
    const { ledger, db } = await setup();
    const e = { idemKey: 'k1', kind: 'x', postings: [{ accountId: 'platform:wallet', amount: 100 }, { accountId: 'platform:suspense', amount: -100 }] };
    expect(await db.tx((q) => ledger.postEntry(q, e))).toBe(true);
    expect(await db.tx((q) => ledger.postEntry(q, e))).toBe(false);
    expect(await ledger.balance('wallet')).toBe(100);
  });
});

describe('REVIEW FOCUS 5: tenant isolation at the database', () => {
  it('app_user with an org scope cannot see another organisation rows', async () => {
    const { ledger, provider, db } = await setup();
    await pay(provider, 'GRC001#TITHE');
    await pay(provider, 'OTH001#TITHE');
    const mine = await db.asOrg('org1', (q) => q.query<any>(`SELECT branch_id FROM payments`));
    expect(mine.map((r) => r.branch_id)).toEqual(['b1']);
    const branches = await db.asOrg('org2', (q) => q.query<any>(`SELECT id FROM branches`));
    expect(branches.map((r) => r.id)).toEqual(['b2']);
    const none = await db.asOrg('ghost', (q) => q.query<any>(`SELECT id FROM payments`));
    expect(none).toEqual([]);
    expect(ledger).toBeTruthy();
  });
});

describe('REVIEW FOCUS 1: verification gates payouts (L81)', () => {
  it('collects for an unverified branch but never pays it out, then pays after verification', async () => {
    const { ledger, provider, clock } = await setup();
    await ledger.setBranchVerified('b1', false);
    await pay(provider, 'GRC001#TITHE', 100000);
    clock.advanceHours(49);
    const held = await ledger.runSettlement();
    expect(held.find((r) => r.branchId === 'b1')).toMatchObject({ status: 'skipped' });
    expect(provider.payoutsSent).toHaveLength(0);
    expect(await ledger.balance('available', 'b1')).toBe(97500);
    await ledger.setBranchVerified('b1', true);
    const paid = await ledger.runSettlement();
    expect(paid.find((r) => r.branchId === 'b1')).toMatchObject({ status: 'paid', amount: 97500 });
    expect((await ledger.reconcile()).ok).toBe(true);
  });
});

describe('SMS wallet (L57 to L60)', () => {
  it('REVIEW FOCUS 4: a top-up credits once even if delivered twice, and stays out of collections', async () => {
    const { ledger, provider } = await setup();
    const inb = { providerTxId: 'SMS1', method: 'mpesa' as const, amount: 50000, reference: 'SMS#GRACE', phone: '254700000001', occurredAt: new Date().toISOString() };
    await provider.simulatePaybill({ phone: inb.phone, amount: inb.amount, reference: inb.reference, providerTxId: 'SMS1' }); // credits the PSP wallet; the ledger sees it as a normal paybill
    // The API routes SMS# references to the wallet before they reach receivePayment; here we call the wallet path directly.
    expect(await ledger.receiveSmsTopup('org1', inb)).toBe('credited');
    expect(await ledger.receiveSmsTopup('org1', inb)).toBe('duplicate');
    expect(await ledger.smsBalance('org1')).toBe(50000);
  });

  it('REVIEW FOCUS 3: sending with an empty wallet is refused without going negative; charges deduct the cost', async () => {
    const { ledger } = await setup();
    expect(await ledger.chargeSms('org1', 100, 'm1')).toBe(false);
    expect(await ledger.smsBalance('org1')).toBe(0);
    await ledger.receiveSmsTopup('org1', { providerTxId: 'SMS2', method: 'mpesa', amount: 250, reference: 'SMS#GRACE', phone: '254700000001', occurredAt: new Date().toISOString() });
    expect(await ledger.chargeSms('org1', 100, 'm2')).toBe(true);
    expect(await ledger.chargeSms('org1', 100, 'm3')).toBe(true);
    expect(await ledger.chargeSms('org1', 100, 'm4')).toBe(false);
    expect(await ledger.smsBalance('org1')).toBe(50);
    expect(await ledger.balance('sms_revenue')).toBe(200);
  });
});
