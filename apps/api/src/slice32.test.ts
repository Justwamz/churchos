import { beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyChains } from '@churchos/ledger';
import { PspError, RoutedProvider } from '@churchos/payments';
import { buildApp } from './server';
import { seed } from './seed';
import { createReversalRequest, decideReversal } from './routes/reversals';

/**
 * Slice 32: the money-path security fixes (LG-01, LG-02, LG-03, LG-07, LG-08, LG-09, LG-14, LG-15, LG-17, LG-22, WEB-01, AZ-02, AZ-03, AZ-04,
 * AZ-05, AZ-14, AUTH-08). Built from docs/security/probes/logic-races.scratch.test.ts: every proven exploit is now a test that must fail.
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
const q = (sql: string, p: unknown[] = []) => ctx.db.query<any>(sql, p);
const mock = () => ctx.provider as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn: () => Promise<boolean>, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(40); } return false; };

const OWNER = '0700000001', ADMIN3 = '0700000003', HOPE = '0700000005', PA1 = '0700000099', PA2 = '0700000098';
const JANE = '0711000001', AMINA = '0711000003';
const DAY = 86_400_000;
const inDays = (n: number) => new Date(ctx.clock.now().getTime() + n * DAY).toISOString();

async function makeEvent(title: string, days: number, price: number, quantity = 100) {
  const id = (await call(OWNER, 'POST', '/events', { title, audience: { type: 'org' }, startsAt: inDays(days), endsAt: inDays(days + 0.1), location: 'Hall' })).json().id;
  await call(OWNER, 'PUT', `/events/${id}/ticketing`, { ticketed: true, refundDaysBefore: 30, types: [{ name: 'Regular', price, quantity }] });
  const s = (await call(OWNER, 'GET', `/events/${id}/tickets`)).json();
  return { id, code: s.code as string, type: s.types[0].id as string };
}
/** An order the prompt of which never completes by itself, so the test decides what is paid. */
async function pendingGuestOrder(ev: { code: string; type: string }, email: string) {
  mock().setStkDelay(600_000);
  const r = await call(null, 'POST', '/public/tickets/orders', { code: ev.code, name: 'Guest ' + email.split('@')[0], email, phone: '0712000111', method: 'mpesa', lines: [{ typeId: ev.type, qty: 1 }] });
  mock().setStkDelay(0);
  expect(r.statusCode).toBe(200);
  const o = r.json();
  const row = (await q(`SELECT * FROM ticket_orders WHERE id=$1`, [o.id]))[0];
  return { ...o, row, ref: `GRC001#TKT-${row.code}` };
}
const orderStatus = async (secret: string) => (await call(null, 'GET', `/public/tickets/orders/${secret}`)).json();
const pay = (reference: string, amount: number, phone = '254712000111') => mock().simulatePaybill({ phone, amount, reference });
const heldFor = async (purpose: string) => q(`SELECT * FROM held_payments WHERE purpose=$1 ORDER BY created_at`, [purpose]);
const auditCount = async (action: string) => Number((await q(`SELECT count(*)::int AS n FROM audit_events WHERE action=$1`, [action]))[0].n);

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);

describe('the amount must satisfy the order before it is fulfilled (LG-01)', () => {
  it('a short payment for a ticket order does not issue tickets, is recorded and announced, and a top-up completes it', async () => {
    const ev = await makeEvent('Underpay night', 20, 2000);
    const o = await pendingGuestOrder(ev, 'underpay@gmail.com');
    const total = Number(o.row.total);
    expect(total).toBeGreaterThan(200000);
    const underBefore = await auditCount('ticket.underpaid');
    await pay(o.ref, 1000);
    const st = await orderStatus(o.secret);
    expect(st.status).not.toBe('paid');
    expect(st.tickets).toHaveLength(0);
    const held = await heldFor(`TKT-${o.row.code}`);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ kind: 'underpaid' });
    expect(Number(held[0].expected)).toBe(total);
    expect(await auditCount('ticket.underpaid')).toBe(underBefore + 1);
    // the money is on the books, honestly: the payment exists and the ledger still balances
    expect((await q(`SELECT amount_paid FROM payments WHERE purpose=$1`, [`TKT-${o.row.code}`])).map((p) => Number(p.amount_paid))).toEqual([1000]);
    expect((await ctx.ledger.reconcile()).ok).toBe(true);
    // the payer sends the difference: payments add up and the order completes
    await pay(o.ref, total - 1000);
    expect(await wait(async () => (await orderStatus(o.secret)).status === 'paid')).toBe(true);
    expect((await orderStatus(o.secret)).tickets.length).toBe(1);
  });

  it('an exact payment fulfils as before, and an overpayment fulfils and is recorded for refund handling', async () => {
    const ev = await makeEvent('Exact and over night', 22, 1500);
    const exact = await pendingGuestOrder(ev, 'exact@gmail.com');
    await pay(exact.ref, Number(exact.row.total));
    expect(await wait(async () => (await orderStatus(exact.secret)).status === 'paid')).toBe(true);
    expect(await heldFor(`TKT-${exact.row.code}`)).toHaveLength(0);
    const over = await pendingGuestOrder(ev, 'over@gmail.com');
    await pay(over.ref, Number(over.row.total) + 5000);
    expect(await wait(async () => (await orderStatus(over.secret)).status === 'paid')).toBe(true);
    const held = await heldFor(`TKT-${over.row.code}`);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ kind: 'overpaid' });
    expect(Number(held[0].paid) - Number(held[0].expected)).toBe(5000);
    expect(await auditCount('ticket.overpaid')).toBeGreaterThan(0);
  });

  it('a payment that arrives after the order lapsed is checked too', async () => {
    const ev = await makeEvent('Late and short', 24, 1800);
    const o = await pendingGuestOrder(ev, 'late@gmail.com');
    await q(`UPDATE ticket_orders SET status='lapsed', hold_until=NULL WHERE id=$1`, [o.id]);
    await pay(o.ref, 500);
    expect((await q(`SELECT status FROM ticket_orders WHERE id=$1`, [o.id]))[0].status).toBe('lapsed');
    expect((await heldFor(`TKT-${o.row.code}`))[0]).toMatchObject({ kind: 'underpaid' });
    await pay(o.ref, Number(o.row.total) - 500);
    expect((await q(`SELECT status FROM ticket_orders WHERE id=$1`, [o.id]))[0].status).toBe('paid');
  });

  it('a short payment does not complete a shop sale, a booking, an advert or a certificate copy; the right amount does', async () => {
    const now = ctx.clock.now().toISOString();
    const hold = new Date(ctx.clock.now().getTime() + 3600_000).toISOString();
    // shop sale
    await q(`INSERT INTO shop_sales (id, code, receipt_no, org_id, branch_id, buyer_name, method, status, total, hold_until, sold_by, created_at) VALUES ('sal_s32','S32SHOP','GRC001-S32','org_grace','br_grc001','Buyer','mpesa','awaiting_payment',250000,$1,'u_treas',$2)`, [hold, now]);
    await pay('GRC001#SHOP-S32SHOP', 1000);
    expect((await q(`SELECT status FROM shop_sales WHERE id='sal_s32'`))[0].status).toBe('awaiting_payment');
    expect((await heldFor('SHOP-S32SHOP'))[0]).toMatchObject({ kind: 'underpaid' });
    await pay('GRC001#SHOP-S32SHOP', 249000);
    expect((await q(`SELECT status FROM shop_sales WHERE id='sal_s32'`))[0].status).toBe('completed');
    // booking
    await q(`INSERT INTO bookings (id, code, org_id, branch_id, requester_id, requester_name, title, starts_at, ends_at, status, price, hold_until, created_at, updated_at) VALUES ('bk_s32','S32BOOK','org_grace','br_grc001','u_jane','Jane','Hall hire',$1,$1,'awaiting_payment',300000,$2,$3,$3)`, [inDays(5), hold, now]);
    await pay('GRC001#BK-S32BOOK', 1000);
    expect((await q(`SELECT status FROM bookings WHERE id='bk_s32'`))[0].status).toBe('awaiting_payment');
    expect((await heldFor('BK-S32BOOK'))[0]).toMatchObject({ kind: 'underpaid' });
    await pay('GRC001#BK-S32BOOK', 300000);
    expect((await q(`SELECT status FROM bookings WHERE id='bk_s32'`))[0].status).toBe('confirmed');
    expect((await heldFor('BK-S32BOOK')).some((h) => h.kind === 'overpaid')).toBe(true); // 3,010 paid for 3,000
    // advert
    await q(`INSERT INTO adverts (id, code, org_id, branch_id, title, image_mime, image_data, width, height, audience, starts_at, advertiser_name, price, status, created_by, created_at, updated_at) VALUES ('ad_s32','S32ADVT','org_grace','br_grc001','Ad','image/png','x',1,1,'{"type":"org"}',$1,'Shop Ltd',400000,'awaiting_payment','u_owner',$2,$2)`, [now, now]);
    await pay('GRC001#AD-S32ADVT', 1000);
    expect((await q(`SELECT status FROM adverts WHERE id='ad_s32'`))[0].status).toBe('awaiting_payment');
    await pay('GRC001#AD-S32ADVT', 399000);
    expect((await q(`SELECT status FROM adverts WHERE id='ad_s32'`))[0].status).toBe('approved');
    // certificate copy
    await q(`INSERT INTO sacramental_records (id, org_id, branch_id, kind, subject_name, event_date, place, officiant, status, serial, created_by, last_edited_by, created_at, updated_at) VALUES ('rec_s32','org_grace','br_grc001','baptism','Test Person','2020-01-01','Nairobi','Rev','approved','S32CERT1','u_owner','u_owner',$1,$1)`, [now]);
    await q(`INSERT INTO record_issues (id, record_id, org_id, kind, status, fee, requested_by, created_at) VALUES ('iss_s32','rec_s32','org_grace','copy','awaiting_payment',50000,'u_jane',$1)`, [now]);
    await pay('GRC001#CERT-S32CERT1', 1000);
    expect((await q(`SELECT status FROM record_issues WHERE id='iss_s32'`))[0].status).toBe('awaiting_payment');
    await pay('GRC001#CERT-S32CERT1', 49000);
    expect((await q(`SELECT status FROM record_issues WHERE id='iss_s32'`))[0].status).toBe('issued');
    expect((await ctx.ledger.reconcile()).ok).toBe(true);
  });

  it('a plain gift of any amount is simply received', async () => {
    const before = Number((await q(`SELECT count(*)::int AS n FROM held_payments`))[0].n);
    await pay('GRC001#OFFERING', 1234);
    expect(Number((await q(`SELECT count(*)::int AS n FROM held_payments`))[0].n)).toBe(before);
  });

  it('a payment sent to one church for another church\'s order does not fulfil it', async () => {
    const ev = await makeEvent('Cross church', 26, 1000);
    const o = await pendingGuestOrder(ev, 'cross@gmail.com');
    await pay(`HPC001#TKT-${o.row.code}`, Number(o.row.total));
    expect((await q(`SELECT status FROM ticket_orders WHERE id=$1`, [o.id]))[0].status).toBe('awaiting_payment');
  });
});

describe('the simulator webhook (WEB-01, AZ-02, LG-17)', () => {
  const body = () => JSON.stringify({ providerTxId: 'FORGE' + Math.random().toString(36).slice(2, 8).toUpperCase(), method: 'mpesa', amount: 12345, reference: 'GRC001#OFFERING', phone: '254799999999' });
  const post = (b: string, headers: Record<string, string> = {}, url = '/psp/webhook') => app.inject({ method: 'POST', url, payload: b, headers: { 'content-type': 'application/json', ...headers } });

  it('a signature made with the old published secret is refused, and nothing is credited', async () => {
    const before = Number((await q(`SELECT count(*)::int AS n FROM payments`))[0].n);
    const b = body();
    expect((await post(b, { 'x-psp-signature': createHmac('sha256', 'dev-psp-secret').update(b).digest('hex') })).statusCode).toBe(401);
    const viaDaraja = body();
    expect((await post(viaDaraja, { 'x-psp-signature': createHmac('sha256', 'dev-psp-secret').update(viaDaraja).digest('hex') }, '/webhooks/daraja/anything/stk')).statusCode).toBeGreaterThanOrEqual(400);
    expect((await post(b, {})).statusCode).toBe(401);
    expect(Number((await q(`SELECT count(*)::int AS n FROM payments`))[0].n)).toBe(before);
  });

  it('the simulator still signs its own deliveries, so the app keeps working', async () => {
    await mock().simulatePaybill({ phone: '254700123499', amount: 5000, reference: 'GRC001#OFFERING' });
    expect((await ctx.ledger.reconcile()).zeroSum).toBe(true);
  });

  it('with a live provider the public route is gone', async () => {
    const live = await buildApp({ provider: new RoutedProvider({}) });
    const r = await live.app.inject({ method: 'POST', url: '/psp/webhook', payload: body(), headers: { 'content-type': 'application/json', 'x-psp': 'mpesa', 'x-psp-token': 'x', 'x-psp-ip': '1.2.3.4' } });
    expect(r.statusCode).toBe(404);
    await live.app.close();
  });
});

describe('one settlement run, one payout set (LG-02)', () => {
  it('three runs at once create one payout set and send one payout', async () => {
    const m = mock();
    await m.simulatePaybill({ phone: '254700123458', amount: 20_000_000, reference: 'NOPE' }); // spare cash in the provider wallet
    await m.simulatePaybill({ phone: '254700123457', amount: 2_000_000, reference: 'GRC002#OFFERING' });
    ctx.clock.advanceHours(50);
    await ctx.ledger.releasePending();
    const before = Number((await q(`SELECT count(*)::int AS n FROM payouts WHERE branch_id='br_grc002'`))[0].n);
    const sent = m.payoutsSent.length;
    const res = await Promise.allSettled([ctx.ledger.runSettlement(), ctx.ledger.runSettlement(), ctx.ledger.runSettlement()]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(res.filter((r) => r.status === 'rejected').map((r: any) => r.reason.code)).toEqual(['settlement_running', 'settlement_running']);
    expect(Number((await q(`SELECT count(*)::int AS n FROM payouts WHERE branch_id='br_grc002'`))[0].n)).toBe(before + 1);
    expect(m.payoutsSent.slice(sent).filter((x: any) => x.destination?.accountNumber === '0170199887')).toHaveLength(1); // Mombasa is paid once
    expect(await ctx.ledger.balance('available', 'br_grc002')).toBeGreaterThanOrEqual(0);
    expect((await ctx.ledger.reconcile()).ok).toBe(true);
  });

  it('the route answers 409 while a run holds the lock, and the lock is released afterwards', async () => {
    await q(`INSERT INTO locks (key, holder, expires_at) VALUES ('settlement','other-process',$1) ON CONFLICT (key) DO UPDATE SET holder='other-process', expires_at=$1`, [new Date(Date.now() + 60_000).toISOString()]);
    const busy = await call(PA1, 'POST', '/admin/settlement/run');
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toBe('A settlement run is already in progress');
    await q(`DELETE FROM locks WHERE key='settlement'`);
    expect((await call(PA1, 'POST', '/admin/settlement/run')).statusCode).toBe(200);
    expect(Number((await q(`SELECT count(*)::int AS n FROM locks WHERE key='settlement'`))[0].n)).toBe(0);
    // simultaneous calls over HTTP never double up: each answers 200, 409 or (nothing left to pay) 400
    const codes = (await Promise.all([call(PA1, 'POST', '/admin/settlement/run'), call(PA2, 'POST', '/admin/settlement/run')])).map((r) => r.statusCode);
    expect(codes.every((c) => c === 200 || c === 409 || c === 400)).toBe(true);
  });

  it('Available can never be driven below zero', async () => {
    await expect(
      ctx.db.tx((t) => ctx.ledger.postEntry(t, { idemKey: 'overdraw:test', kind: 'test', postings: [{ accountId: 'br_grc001:available', amount: 999_999_999 }, { accountId: 'platform:wallet', amount: -999_999_999 }] })),
    ).rejects.toThrow(/available balance cannot go below zero/);
  });
});

describe('one refund per payment, and the requester cannot approve (LG-03, AUTH-08, AZ-05)', () => {
  it('approving the same reversal twice at once sends one refund', async () => {
    const m = mock();
    const pb = await m.simulatePaybill({ phone: '254700123456', amount: 500000, reference: 'GRC001#OFFERING' });
    const p = (await q(`SELECT * FROM payments WHERE provider_tx_id=$1`, [pb.providerTxId]))[0];
    const rr = await createReversalRequest(ctx, { requestedBy: 'u_owner', source: 'staff', paymentId: p.id, reason: 'race', branchIds: [p.branch_id] });
    const w0 = await m.walletBalance();
    const res = await Promise.allSettled([decideReversal(ctx, rr.id, 'u_pa2', true, 'a'), decideReversal(ctx, rr.id, 'u_pa2', true, 'b')]);
    const w1 = await m.walletBalance();
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.status ?? lost.reason.statusCode).toBe(409);
    expect(w0 - w1).toBe(p.amount_paid - p.psp_cost);
    expect((await ctx.ledger.reconcile()).ok).toBe(true);
  });

  it('two direct reversals of one payment at the ledger refund once', async () => {
    const m = mock();
    const pb = await m.simulatePaybill({ phone: '254700123455', amount: 300000, reference: 'GRC001#OFFERING' });
    const p = (await q(`SELECT * FROM payments WHERE provider_tx_id=$1`, [pb.providerTxId]))[0];
    const w0 = await m.walletBalance();
    const res = await Promise.allSettled([ctx.ledger.reverse(p.id, { reason: 'x' }), ctx.ledger.reverse(p.id, { reason: 'y' })]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(w0 - (await m.walletBalance())).toBe(p.amount_paid - p.psp_cost);
  });

  it('the person who requested a reversal cannot approve it, for member and staff requests alike', async () => {
    const m = mock();
    // the admin paid from their own phone and asked as a member
    const pb = await m.simulatePaybill({ phone: '254700000099', amount: 100000, reference: 'GRC001#OFFERING' });
    const req = await call(PA1, 'POST', '/me/reversal-request', { message: `Paid to the wrong church ${pb.providerTxId}`, reason: 'wrong church' });
    expect(req.statusCode).toBe(200);
    const self = await call(PA1, 'POST', `/admin/reversal-requests/${req.json().id}/decide`, { approve: true, reason: 'Checked against the provider statement' });
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe('same_person');
    expect((await call(PA2, 'POST', `/admin/reversal-requests/${req.json().id}/decide`, { approve: true, reason: 'Checked against the provider statement' })).statusCode).toBe(200);
    // a staff request made by an admin account
    const pb2 = await m.simulatePaybill({ phone: '254700123454', amount: 100000, reference: 'GRC001#OFFERING' });
    const p2 = (await q(`SELECT * FROM payments WHERE provider_tx_id=$1`, [pb2.providerTxId]))[0];
    const rr = await createReversalRequest(ctx, { requestedBy: 'u_pa1', source: 'staff', paymentId: p2.id, reason: 'x', branchIds: [p2.branch_id] });
    await expect(decideReversal(ctx, rr.id, 'u_pa1', true)).rejects.toMatchObject({ code: 'same_person' });
  });

  it('church staff cannot ask for an unclaimed (suspense) payment back', async () => {
    const pb = await mock().simulatePaybill({ phone: '254700123453', amount: 100000, reference: 'NOPE' });
    const r = await call(OWNER, 'POST', '/reversal-requests', { message: `code ${pb.providerTxId}`, reason: 'mine' });
    expect(r.statusCode).toBe(403);
    // the payer still can, from their own phone
    const mine = await mock().simulatePaybill({ phone: '254711000001', amount: 100000, reference: 'NOPE2' });
    expect((await call(JANE, 'POST', '/me/reversal-request', { message: `code ${mine.providerTxId}`, reason: 'wrong' })).statusCode).toBe(200);
  });
});

describe('self-approval and scope rules (AZ-03, AZ-04, AZ-05, AZ-14)', () => {
  async function giveCreditRow(userId: string, orgId: string, kes: number) {
    await q(`INSERT INTO event_credits (id, org_id, user_id, secret, amount, balance, created_at) VALUES ($1,$2,$3,$4,$5,$5,$6)`, [`ecr_${userId}_${kes}`, orgId, userId, `SECRET${userId}${kes}`, kes * 100, ctx.clock.now().toISOString()]);
  }

  it('a credit refund is seen and decided only by staff who manage the member\'s branch, and the phone is masked until it must be paid', async () => {
    await giveCreditRow('u_amina', 'org_grace', 2000); // Amina belongs to Mombasa
    const r = await call(AMINA, 'POST', '/me/credit/refund-request', { amount: 1500, reason: 'Moving' });
    expect(r.statusCode).toBe(200);
    const id = r.json().id;
    expect((await q(`SELECT branch_id FROM credit_refunds WHERE id=$1`, [id]))[0].branch_id).toBe('br_grc002');
    // the Nairobi branch admin cannot see or decide it
    expect((await call(ADMIN3, 'GET', '/credit/refunds')).json().refunds.map((x: any) => x.id)).not.toContain(id);
    expect((await call(ADMIN3, 'POST', `/credit/refunds/${id}/decide`, { approve: true, reason: 'Checked against the provider statement' })).statusCode).toBe(404);
    expect((await call(ADMIN3, 'POST', `/credit/refunds/${id}/paid`, { reference: 'X' })).statusCode).toBe(404);
    // church-wide staff see it with the phone masked
    const pending = (await call(OWNER, 'GET', '/credit/refunds')).json().refunds.find((x: any) => x.id === id);
    expect(pending.phone).toMatch(/•/);
    expect(pending.phone).not.toContain('711000003');
    expect((await call(OWNER, 'POST', `/credit/refunds/${id}/decide`, { approve: true, reason: 'Checked against the provider statement' })).statusCode).toBe(200);
    // approved: the number is shown to pay it, and that is logged once
    const a1 = (await call(OWNER, 'GET', '/credit/refunds')).json().refunds.find((x: any) => x.id === id);
    expect(a1.phone).toBe('254711000003');
    await call(OWNER, 'GET', '/credit/refunds');
    expect(Number((await q(`SELECT count(*)::int AS n FROM audit_events WHERE action='access.reveal' AND entity='credit_refund' AND entity_id=$1`, [id]))[0].n)).toBe(1);
    expect((await call(OWNER, 'POST', `/credit/refunds/${id}/paid`, { reference: 'MPESA123' })).statusCode).toBe(200);
  });

  it('a staff member cannot decide or pay their own credit refund request', async () => {
    await giveCreditRow('u_owner', 'org_grace', 1000);
    const r = await call(OWNER, 'POST', '/me/credit/refund-request', { amount: 500 });
    expect(r.statusCode).toBe(200);
    const id = r.json().id;
    const dec = await call(OWNER, 'POST', `/credit/refunds/${id}/decide`, { approve: true, reason: 'Checked against the provider statement' });
    expect(dec.statusCode).toBe(403);
    expect(dec.json().code).toBe('same_person');
    // someone else approves; the requester still cannot mark it paid
    await q(`UPDATE credit_refunds SET status='approved' WHERE id=$1`, [id]);
    const paid = await call(OWNER, 'POST', `/credit/refunds/${id}/paid`, { reference: 'SELF1' });
    expect(paid.statusCode).toBe(403);
    expect(paid.json().code).toBe('same_person');
  });

  it('a staff member who bought the tickets cannot approve their own ticket refund', async () => {
    const ev = await makeEvent('Own refund night', 60, 3000);
    // Jane is a member and also holds a church-wide events role, so she can both buy and decide.
    await q(`INSERT INTO role_assignments (id, org_id, user_id, role_id, scope_type, scope_id) VALUES ('ra_jane_pastor','org_grace','u_jane','org_grace:Pastor','org','org_grace')`);
    const o = (await call(JANE, 'POST', '/me/tickets/orders', { eventId: ev.id, method: 'mpesa', lines: [{ typeId: ev.type, qty: 1 }] })).json();
    expect(await wait(async () => (await orderStatus(o.secret)).status === 'paid')).toBe(true);
    expect((await call(JANE, 'POST', `/me/tickets/orders/${o.id}/refund-request`, { reason: 'x' })).statusCode).toBe(200);
    const rid = (await call(JANE, 'GET', `/events/${ev.id}/refund-requests`)).json().requests[0].id;
    const self = await call(JANE, 'POST', `/refund-requests/${rid}/decide`, { approve: true, reason: 'Checked against the provider statement' });
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe('same_person');
    expect((await q(`SELECT status FROM ticket_refunds WHERE id=$1`, [rid]))[0].status).toBe('pending');
  });

  it('two approvals of one ticket refund at once create one reversal', async () => {
    const ev = await makeEvent('Double ticket refund', 62, 3000);
    const o = (await call(JANE, 'POST', '/me/tickets/orders', { eventId: ev.id, method: 'mpesa', lines: [{ typeId: ev.type, qty: 1 }] })).json();
    expect(await wait(async () => (await orderStatus(o.secret)).status === 'paid')).toBe(true);
    await call(JANE, 'POST', `/me/tickets/orders/${o.id}/refund-request`, { reason: 'x' });
    const rid = (await call(OWNER, 'GET', `/events/${ev.id}/refund-requests`)).json().requests[0].id;
    const res = await Promise.all([call(OWNER, 'POST', `/refund-requests/${rid}/decide`, { approve: true, reason: 'Checked against the provider statement' }), call(OWNER, 'POST', `/refund-requests/${rid}/decide`, { approve: true })]);
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const revs = await q(`SELECT id FROM reversal_requests WHERE payment_id=(SELECT id FROM payments WHERE provider_tx_id=(SELECT provider_tx_id FROM ticket_orders WHERE id=$1))`, [o.id]);
    expect(revs).toHaveLength(1);
  });

  it('removing a role needs every permission in it, and removing an Owner is a security event', async () => {
    const now = ctx.clock.now().toISOString();
    await q(`INSERT INTO users (id, phone, name, created_at) VALUES ('u_clerk','254722999001','Team Clerk',$1),('u_owner2','254722999002','Second Owner',$1)`, [now]);
    await q(`INSERT INTO roles (id, org_id, name, permissions) VALUES ('org_grace:Team clerk','org_grace','Team clerk','["team.view","team.manage"]')`);
    await q(`INSERT INTO role_assignments (id, org_id, user_id, role_id, scope_type, scope_id) VALUES ('ra_clerk','org_grace','u_clerk','org_grace:Team clerk','org','org_grace'),('ra_owner2','org_grace','u_owner2','org_grace:Organisation Owner','org','org_grace')`);
    const refused = await call('0722999001', 'POST', '/team/assignments/ra_owner2/remove');
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('cannot_escalate');
    expect((await q(`SELECT 1 FROM role_assignments WHERE id='ra_owner2'`)).length).toBe(1);
    expect((await call(OWNER, 'POST', '/team/assignments/ra_owner2/remove')).statusCode).toBe(200);
    const ev = await q(`SELECT category FROM audit_events WHERE action='security.owner_removed' AND entity_id='u_owner2'`);
    expect(ev).toHaveLength(1);
    expect(ev[0].category).toBe('security');
  });
});

describe('the audit chain and the ledger tables (LG-07, LG-08, LG-09)', () => {
  it('an event written with undefined values in its meta (like the kids events) verifies, and a later change is still caught', async () => {
    await ctx.ledger.audit({ orgId: 'org_hope', action: 'kids.checkin', summary: 'kids style', meta: { result: 'ok', method: undefined, device: undefined, nested: { a: undefined, b: [undefined, 1] } } });
    await ctx.ledger.audit({ orgId: 'org_hope', action: 'kids.after', summary: 'next', meta: { n: 1 } });
    const r = (await verifyChains(ctx.db, 'org_hope'))[0];
    expect(r.ok).toBe(true);
    expect(r.breaks ?? []).toEqual([]);
    // the shape the dashboards read is unchanged
    expect(Object.keys(r)).toEqual(expect.arrayContaining(['chain', 'events', 'ok']));
  });

  it('verification reports every break, not only the first', async () => {
    for (let i = 0; i < 5; i++) await ctx.ledger.audit({ orgId: 'org_newhope', action: 'probe.event', summary: 'e' + i, meta: { i } });
    const seqs = (await q(`SELECT seq FROM audit_events WHERE chain='org_newhope' ORDER BY seq`)).map((r) => Number(r.seq));
    await q(`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_change`);
    try {
      await q(`UPDATE audit_events SET summary='tampered' WHERE seq=$1 OR seq=$2`, [seqs[1], seqs[3]]);
    } finally {
      await q(`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_change`);
    }
    const r = (await verifyChains(ctx.db, 'org_newhope'))[0];
    expect(r.ok).toBe(false);
    expect(r.brokenAtSeq).toBe(seqs[1]);
    expect(r.breaks!.map((b) => b.seq)).toEqual([seqs[1], seqs[3]]);
    expect((await call(PA1, 'GET', '/admin/audit/verify')).statusCode).toBe(200);
  });

  it('postings, journal entries and payment amounts cannot be changed or deleted; allowed payment columns still update', async () => {
    const pay1 = (await q(`SELECT id, stage FROM payments WHERE stage IN ('pending','available') LIMIT 1`))[0];
    await expect(q(`UPDATE postings SET amount = amount WHERE id = (SELECT min(id) FROM postings)`)).rejects.toThrow(/append-only/);
    await expect(q(`DELETE FROM postings WHERE id = (SELECT min(id) FROM postings)`)).rejects.toThrow(/append-only/);
    await expect(q(`UPDATE journal_entries SET kind = kind WHERE id = (SELECT min(id) FROM journal_entries)`)).rejects.toThrow(/append-only/);
    await expect(q(`DELETE FROM journal_entries WHERE id = (SELECT min(id) FROM journal_entries)`)).rejects.toThrow(/append-only/);
    await expect(q(`UPDATE payments SET amount_paid = amount_paid + 1 WHERE id=$1`, [pay1.id])).rejects.toThrow(/cannot be changed/);
    await expect(q(`UPDATE payments SET provider_tx_id = 'X' WHERE id=$1`, [pay1.id])).rejects.toThrow(/cannot be changed/);
    await expect(q(`UPDATE payments SET method = 'card' WHERE id=$1`, [pay1.id])).rejects.toThrow(/cannot be changed/);
    await expect(q(`UPDATE payments SET org_id = 'org_hope' WHERE id=$1`, [pay1.id])).rejects.toThrow(/cannot be changed/);
    await expect(q(`DELETE FROM payments WHERE id=$1`, [pay1.id])).rejects.toThrow(/cannot be deleted/);
    await q(`UPDATE payments SET member_id = member_id, project_id = project_id WHERE id=$1`, [pay1.id]);
    expect((await ctx.ledger.reconcile()).ok).toBe(true);
  });

  it('an anonymous gift leaves no phone or reference in the SMS log, but the giver keeps an in-app receipt', async () => {
    const smsBefore = Number((await q(`SELECT count(*)::int AS n FROM sms_messages`))[0].n);
    const r = await call(JANE, 'POST', '/me/give', { code: 'GRC001', amount: 25, method: 'mpesa', purpose: 'TITHE', anonymous: true });
    expect(r.statusCode).toBe(200);
    expect(await wait(async () => (await q(`SELECT 1 FROM payments WHERE anonymous AND amount_paid=2500`)).length > 0)).toBe(true);
    const p = (await q(`SELECT * FROM payments WHERE anonymous AND amount_paid=2500 ORDER BY received_at DESC LIMIT 1`))[0];
    await sleep(100);
    expect(p.payer_phone).toBeNull();
    expect(await q(`SELECT 1 FROM sms_messages WHERE body LIKE $1`, [`%${p.provider_tx_id}%`])).toHaveLength(0);
    expect(Number((await q(`SELECT count(*)::int AS n FROM sms_messages`))[0].n)).toBe(smsBefore);
    const inbox = ((await call(JANE, 'GET', '/me/notifications')).json().rows as any[]).filter((n) => /Gift received/.test(n.title));
    expect(inbox.length).toBeGreaterThan(0);
  });
});

describe('races and limits (LG-14, LG-15, LG-22)', () => {
  it('the order and its reservation exist before the payment prompt is sent, and a refused prompt releases it', async () => {
    const ev = await makeEvent('Prompt order night', 30, 1500, 1);
    const real = mock().initiateStkPush.bind(mock());
    let seenAtPrompt: any[] = [];
    mock().initiateStkPush = async () => {
      seenAtPrompt = await q(`SELECT status FROM ticket_orders WHERE event_id=$1`, [ev.id]);
      throw new PspError('rejected', 'The provider would not take it');
    };
    try {
      const r = await call(null, 'POST', '/public/tickets/orders', { code: ev.code, name: 'Guest A', email: 'prompt.a@gmail.com', phone: '0712000111', method: 'mpesa', lines: [{ typeId: ev.type, qty: 1 }] });
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      expect(seenAtPrompt.map((x) => x.status)).toEqual(['awaiting_payment']); // the order was there first
      expect((await q(`SELECT status FROM ticket_orders WHERE event_id=$1`, [ev.id])).map((x) => x.status)).toEqual(['lapsed']); // and was released
    } finally {
      mock().initiateStkPush = real;
    }
    // the only ticket is available again
    const again = await call(null, 'POST', '/public/tickets/orders', { code: ev.code, name: 'Guest B', email: 'prompt.b@gmail.com', phone: '0712000111', method: 'mpesa', lines: [{ typeId: ev.type, qty: 1 }] });
    expect(again.statusCode).toBe(200);
  });

  it('credit refund decisions are atomic: two at once, one wins', async () => {
    await q(`INSERT INTO event_credits (id, org_id, user_id, secret, amount, balance, created_at) VALUES ('ecr_race','org_grace','u_david','RACECODE1',100000,100000,$1)`, [ctx.clock.now().toISOString()]);
    const r = await call('0711000004', 'POST', '/me/credit/refund-request', { amount: 500 });
    const id = r.json().id;
    const res = await Promise.all([call(OWNER, 'POST', `/credit/refunds/${id}/decide`, { approve: false, note: 'no' }), call(OWNER, 'POST', `/credit/refunds/${id}/decide`, { approve: false, note: 'no' })]);
    expect(res.map((x) => x.statusCode).sort()).toEqual([200, 409]);
    const bal = Number((await q(`SELECT balance FROM event_credits WHERE id='ecr_race'`))[0].balance);
    expect(bal).toBe(100000); // restored exactly once
  });

  it('expenses split below the approval limit still need approval', async () => {
    const setup = (await call(OWNER, 'GET', '/expenses/setup')).json();
    const cat = (setup.categories ?? [])[0];
    expect(cat).toBeTruthy();
    await call(OWNER, 'PUT', '/expenses/settings', { approvalMode: 'above_limit', approvalLimit: 5000, twoApproverLimit: null, receiptRequiredAbove: 100000 });
    const rec = (amount: number, payee = 'Same Vendor') => call(OWNER, 'POST', '/expenses', { branchId: 'br_grc001', date: new Date().toISOString().slice(0, 10), amount, categoryId: cat.id, payee, method: 'mpesa', reference: 'QWE123', noReceiptReason: 'Small' });
    expect((await rec(3000)).json().status).toBe('approved');
    const second = (await rec(3000)).json(); // 6,000 to the same payee in a day: above the 5,000 limit together
    expect(second.status).toBe('submitted');
    expect((await rec(3000, 'Another Vendor')).json().status).toBe('approved'); // a different payee is a different payment
  });

  it('the books balance after all of this', async () => {
    const rec = await ctx.ledger.reconcile();
    expect(rec.zeroSum).toBe(true);
    expect(rec.ok).toBe(true);
  });
});
