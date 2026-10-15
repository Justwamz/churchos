import { beforeEach, describe, expect, it } from 'vitest';
import { MockProvider } from '@churchos/payments';
import { Clock, createDb, Ledger, verifyChains, writeAudit } from './index';

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

describe('messaging wallets (L112, L113, L116)', () => {
  const topup = (id: string, amount: number) => ({ providerTxId: id, method: 'mpesa' as const, amount, reference: 'SMS#GRACE', phone: '254700000001', occurredAt: new Date().toISOString() });

  it('REVIEW FOCUS 1: a top-up credits once even if delivered twice, and stays out of collections', async () => {
    const { ledger } = await setup();
    await ledger.createWallet('w_sms', 'org1');
    expect(await ledger.receiveWalletTopup('w_sms', 'org1', topup('T1', 50000))).toBe('credited');
    expect(await ledger.receiveWalletTopup('w_sms', 'org1', topup('T1', 50000))).toBe('duplicate');
    expect(await ledger.walletBalance('w_sms')).toBe(50000);
    expect(await ledger.balance('pending', 'b1')).toBe(0);
  });

  it('REVIEW FOCUS 1: a charge never goes below zero and a repeated batch charges once', async () => {
    const { ledger } = await setup();
    await ledger.createWallet('w_sms', 'org1');
    expect(await ledger.chargeWallet('w_sms', 100, 'batch1', 'sms')).toBe(false);
    expect(await ledger.walletBalance('w_sms')).toBe(0);
    await ledger.receiveWalletTopup('w_sms', 'org1', topup('T2', 1000));
    expect(await ledger.chargeWallet('w_sms', 400, 'batch1', 'sms')).toBe(true);
    expect(await ledger.chargeWallet('w_sms', 400, 'batch1', 'sms')).toBe(true); // same batch again: no second charge
    expect(await ledger.walletBalance('w_sms')).toBe(600);
    expect(await ledger.chargeWallet('w_sms', 700, 'batch2', 'sms')).toBe(false);
    expect(await ledger.balance('sms_revenue')).toBe(400);
  });

  it('keeps SMS and WhatsApp revenue apart and each wallet separate', async () => {
    const { ledger } = await setup();
    await ledger.createWallet('w_sms', 'org1');
    await ledger.createWallet('w_wa', 'org1');
    await ledger.receiveWalletTopup('w_sms', 'org1', topup('T3', 1000));
    await ledger.receiveWalletTopup('w_wa', 'org1', topup('T4', 2000));
    await ledger.chargeWallet('w_wa', 300, 'wa1', 'whatsapp');
    expect(await ledger.walletBalance('w_sms')).toBe(1000);
    expect(await ledger.walletBalance('w_wa')).toBe(1700);
    expect(await ledger.balance('whatsapp_revenue')).toBe(300);
    expect(await ledger.balance('sms_revenue')).toBe(0);
  });

  it('transfers credit between wallets without creating or losing money', async () => {
    const { ledger } = await setup();
    await ledger.createWallet('hq', 'org1');
    await ledger.createWallet('br', 'org1');
    await ledger.receiveWalletTopup('hq', 'org1', topup('T5', 5000));
    expect(await ledger.transferWallet('hq', 'br', 2000, 'x1')).toBe(true);
    expect(await ledger.transferWallet('hq', 'br', 2000, 'x1')).toBe(true); // repeated: no second move
    expect(await ledger.walletBalance('hq')).toBe(3000);
    expect(await ledger.walletBalance('br')).toBe(2000);
    expect(await ledger.transferWallet('br', 'hq', 9999, 'x2')).toBe(false);
    expect(await ledger.transferWallet('hq', 'br', 0, 'x3')).toBe(false);
  });

  it('refunds undelivered messages once, and the books still balance', async () => {
    const { ledger } = await setup();
    await ledger.createWallet('w_sms', 'org1');
    await ledger.receiveWalletTopup('w_sms', 'org1', topup('T6', 1000));
    await ledger.chargeWallet('w_sms', 500, 'b9', 'sms');
    await ledger.refundWallet('w_sms', 200, 'b9', 'sms');
    await ledger.refundWallet('w_sms', 200, 'b9', 'sms'); // repeated: nothing
    expect(await ledger.walletBalance('w_sms')).toBe(700);
    expect(await ledger.balance('sms_revenue')).toBe(300);
  });

  it('keeps the books balanced against the PSP wallet', async () => {
    const { ledger, provider } = await setup();
    await ledger.createWallet('w_sms', 'org1');
    await provider.simulatePaybill({ phone: '0700000001', amount: 5000, reference: 'NOWHERE' }); // lands in suspense, wallet credited at the PSP
    expect((await ledger.reconcile()).ok).toBe(true);
  });
});

describe('audit log: append-only and tamper-evident (L104, L107)', () => {
  it('chains events per organisation and verifies clean', async () => {
    const { ledger, db } = await setup();
    await ledger.audit({ orgId: 'org1', actor: 'u1', action: 'member.update', entity: 'membership', entityId: 'm1' });
    await ledger.audit({ orgId: 'org1', actor: 'u1', action: 'payment.reverse', entity: 'payment', entityId: 'p1' });
    await ledger.audit({ orgId: 'org2', actor: 'u2', action: 'member.update', entity: 'membership', entityId: 'm9' });
    await ledger.audit({ action: 'settlement.run' });
    const rows = await db.query<any>(`SELECT chain, prev_hash, hash, category FROM audit_events ORDER BY seq`);
    expect(rows.map((r) => r.chain)).toEqual(['org1', 'org1', 'org2', 'platform']);
    expect(rows[0].prev_hash).toBeNull();
    expect(rows[1].prev_hash).toBe(rows[0].hash); // chained
    expect(rows[2].prev_hash).toBeNull(); // each organisation has its own chain
    expect(rows[1].category).toBe('money');
    const report = await verifyChains(db);
    expect(report.every((r) => r.ok)).toBe(true);
    expect(report.find((r) => r.chain === 'org1')!.events).toBe(2);
  });

  it('REVIEW FOCUS 1: the database refuses to change, delete or truncate an event', async () => {
    const { ledger, db } = await setup();
    await ledger.audit({ orgId: 'org1', actor: 'u1', action: 'member.update' });
    await expect(db.query(`UPDATE audit_events SET summary='nothing happened'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM audit_events`)).rejects.toThrow(/append-only/);
    await expect(db.exec(`TRUNCATE audit_events`)).rejects.toThrow(/append-only/);
    expect((await db.query<any>(`SELECT COUNT(*) AS n FROM audit_events`))[0].n).toBe(1);
  });

  it('REVIEW FOCUS 1: if someone bypasses the trigger, the integrity check names the first bad event', async () => {
    const { ledger, db } = await setup();
    for (const a of ['a.one', 'a.two', 'a.three', 'a.four']) await ledger.audit({ orgId: 'org1', actor: 'u1', action: a });
    const seqs = (await db.query<any>(`SELECT seq FROM audit_events ORDER BY seq`)).map((r) => r.seq);

    await db.exec(`ALTER TABLE audit_events DISABLE TRIGGER USER`);
    await db.query(`UPDATE audit_events SET summary='quietly edited' WHERE seq=$1`, [seqs[1]]);
    let r = (await verifyChains(db, 'org1'))[0];
    expect(r).toMatchObject({ ok: false, brokenAtSeq: seqs[1] });
    expect(r.reason).toMatch(/changed/);

    // Undo the edit, then delete an event in the middle instead.
    await db.query(`UPDATE audit_events SET summary='a two' WHERE seq=$1`, [seqs[1]]);
    expect((await verifyChains(db, 'org1'))[0].ok).toBe(true); // restoring the exact original value restores the proof
    await db.query(`DELETE FROM audit_events WHERE seq=$1`, [seqs[2]]);
    r = (await verifyChains(db, 'org1'))[0];
    expect(r.ok).toBe(false);
    await db.exec(`ALTER TABLE audit_events ENABLE TRIGGER USER`);
  });

  it('records field changes and request context in the hash', async () => {
    const { db } = await setup();
    const clock = new Date().toISOString();
    await writeAudit(db, clock, {
      orgId: 'org1', actorId: 'u1', actorName: 'Esther', actorType: 'user', action: 'member.update', entity: 'membership', entityId: 'm1',
      changes: [{ field: 'fullName', before: 'Jane', after: 'Jane W.' }, { field: 'phone', before: '254711•••001', after: '254711•••009', masked: true }],
      ip: '10.0.0.7', app: 'staff', requestId: 'req-1', reason: 'Corrected spelling', links: { paymentId: 'p1' },
    });
    const e = (await db.query<any>(`SELECT * FROM audit_events`))[0];
    expect(e.changes).toHaveLength(2);
    expect(e.ip).toBe('10.0.0.7');
    expect(e.links).toEqual({ paymentId: 'p1' });
    expect((await verifyChains(db))[0].ok).toBe(true);
  });

  it('isolates audit events by organisation at the database', async () => {
    const { ledger, db } = await setup();
    await ledger.audit({ orgId: 'org1', actor: 'u1', action: 'member.update' });
    await ledger.audit({ orgId: 'org2', actor: 'u2', action: 'member.update' });
    const mine = await db.asOrg('org1', (q) => q.query<any>(`SELECT org_id FROM audit_events`));
    expect(mine.map((r) => r.org_id)).toEqual(['org1']);
  });
});
