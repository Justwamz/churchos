/**
 * Scratch concurrency / money-integrity probes (NOT part of the suite). In-process only: builds its own app with fresh seed data,
 * touches no running server. Run from the repo root:
 *
 *   pnpm exec vitest run --config apps/api/vitest.config.ts --root . docs/security/probes/logic-races.scratch.test.ts
 *
 * Every test prints a line starting with "PROBE " with what was observed. Assertions are deliberately loose (they only check that the
 * harness worked), because the point is to record behaviour, not to gate on it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { buildApp } from '../../../apps/api/src/server';
import { seed } from '../../../apps/api/src/seed';
import { createReversalRequest, decideReversal } from '../../../apps/api/src/routes/reversals';
import { runTicketJobs } from '../../../apps/api/src/routes/tickets';

let app: Awaited<ReturnType<typeof buildApp>>['app'];
let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
const tokens: Record<string, string> = {};
const out = (k: string, v: unknown) => console.log('PROBE ' + k + ' ' + JSON.stringify(v));
async function login(phone: string) {
  if (tokens[phone]) return tokens[phone];
  const r = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: '123456' } });
  tokens[phone] = r.json().token;
  return tokens[phone];
}
const call = async (phone: string | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: any, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload, headers: { ...(phone ? { authorization: `Bearer ${await login(phone)}` } : {}), ...headers } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn: () => Promise<boolean>, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(40); } return false; };
const q = (sql: string, p: unknown[] = []) => ctx.db.query<any>(sql, p);

const OWNER = '0700000001', ADMIN1 = '0700000099', ADMIN2 = '0700000098';
const JANE = '0711000001', PETER = '0711000002', DAVID = '0711000004';
const DAY = 86_400_000;
const inDays = (n: number) => new Date(ctx.clock.now().getTime() + n * DAY).toISOString();
const SECRET = 'dev-psp-secret'; // MockProvider default, readable in packages/payments/src/mock.ts

async function makeEvent(title: string, days: number, price: number, quantity = 100) {
  const id = (await call(OWNER, 'POST', '/events', { title, audience: { type: 'org' }, startsAt: inDays(days), endsAt: inDays(days + 0.1), location: 'Hall' })).json().id;
  await call(OWNER, 'PUT', `/events/${id}/ticketing`, { ticketed: true, refundDaysBefore: 30, types: [{ name: 'Regular', price, quantity }] });
  const s = (await call(OWNER, 'GET', `/events/${id}/tickets`)).json();
  return { id, code: s.code as string, type: s.types[0].id as string };
}
const guestOrder = (ev: { code: string; type: string }, email: string, qty = 1, extra: any = {}) =>
  call(null, 'POST', '/public/tickets/orders', { code: ev.code, name: 'Guest ' + email.split('@')[0], email, phone: '0712000111', method: 'mpesa', lines: [{ typeId: ev.type, qty }], ...extra });
const orderStatus = async (secret: string) => (await call(null, 'GET', `/public/tickets/orders/${secret}`)).json();

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);

describe('webhook trust (mock provider)', () => {
  it('unsigned, wrongly signed and path-token-only requests are refused; a signature made with the published dev secret is accepted', async () => {
    const body = JSON.stringify({ providerTxId: 'FORGE0001', method: 'mpesa', amount: 12345, reference: 'GRC001#OFFERING', phone: '254799999999' });
    const sig = (b: string, s = SECRET) => createHmac('sha256', s).update(b).digest('hex');
    const post = (url: string, headers: Record<string, string>, b = body) => app.inject({ method: 'POST', url, payload: b, headers: { 'content-type': 'application/json', ...headers } });
    const r: Record<string, number> = {};
    r.unsigned = (await post('/psp/webhook', {})).statusCode;
    r.wrongSig = (await post('/psp/webhook', { 'x-psp-signature': sig(body, 'nope') })).statusCode;
    r.daraja_pathTokenOnly = (await post('/webhooks/daraja/anything/stk', {})).statusCode;
    r.paystack_noSig = (await post('/webhooks/paystack', {})).statusCode;
    r.airtel_noSig = (await post('/webhooks/airtel/anything', {})).statusCode;
    const before = (await q(`SELECT count(*)::int AS n FROM payments`))[0].n;
    r.forgedDevSecret = (await post('/psp/webhook', { 'x-psp-signature': sig(body) })).statusCode;
    const after = (await q(`SELECT count(*)::int AS n FROM payments`))[0].n;
    // the same forged signature also works on the Daraja path (path token is ignored by the mock provider)
    const body2 = body.replace('FORGE0001', 'FORGE0002');
    r.forgedViaDarajaPath = (await post('/webhooks/daraja/whatever/stk', { 'x-psp-signature': sig(body2) }, body2)).statusCode;
    // replay: same providerTxId, tampered amount -> ignored (first write wins)
    const body3 = body.replace('12345', '99999999');
    r.replayTamperedAmount = (await post('/psp/webhook', { 'x-psp-signature': sig(body3) }, body3)).statusCode;
    const p = await q(`SELECT amount_paid FROM payments WHERE provider_tx_id='FORGE0001'`);
    const rec = await (await call(ADMIN1, 'GET', '/admin/reconcile')).json();
    out('webhook', { ...r, paymentsCreatedByForgery: after - before, storedAmountAfterReplay: p.map((x) => Number(x.amount_paid)), reconcileOkAfterForgery: rec.ok, reconcileDiff: rec.difference });
    expect(r.unsigned).toBe(401);
  });

  it('webhook amount smaller than the order total: what happens to a ticket order?', async () => {
    const ev = await makeEvent('Underpay night', 20, 2000);
    ctx.provider.kind; // mock
    const o = (await guestOrder(ev, 'underpay@gmail.com', 1)).json();
    // Let the real mock payment land first (stkDelayMs 0), then see status; then a second order we pay short by hand.
    await wait(async () => (await orderStatus(o.secret)).status === 'paid');
    const ord = (await q(`SELECT * FROM ticket_orders WHERE id=$1`, [o.id]))[0];
    // second order, left unpaid, then a forged 1-cent payment with the right reference
    (ctx.provider as any).setStkDelay?.(60_000);
    const o2 = (await guestOrder(ev, 'underpay2@gmail.com', 1)).json();
    const row = (await q(`SELECT * FROM ticket_orders WHERE id=$1`, [o2.id]))[0];
    const body = JSON.stringify({ providerTxId: 'SHORT0001', method: 'mpesa', amount: 1000, reference: `GRC001#TKT-${row.code}`, phone: '254712000111' });
    const sig = createHmac('sha256', SECRET).update(body).digest('hex');
    await app.inject({ method: 'POST', url: '/psp/webhook', payload: body, headers: { 'content-type': 'application/json', 'x-psp-signature': sig } });
    const after = await orderStatus(o2.secret);
    (ctx.provider as any).setStkDelay?.(0);
    out('underpay', { orderTotal: Number(row.total), paidAmountCents: 1000, orderStatusAfter: after.status, ticketsIssued: after.tickets.length, firstOrderTotal: Number(ord.total) });
    expect(true).toBe(true);
  });
});

describe('double refund / double approval races', () => {
  it('approving the same reversal request twice at once: how many refunds does the PSP send?', async () => {
    const mock = ctx.provider as any;
    const walletBefore = await mock.walletBalance();
    const pb = await mock.simulatePaybill({ phone: '254700123456', amount: 500000, reference: 'GRC001#OFFERING' });
    const pay = (await q(`SELECT * FROM payments WHERE provider_tx_id=$1`, [pb.providerTxId]))[0];
    const rr = await createReversalRequest(ctx, { requestedBy: 'u_admin', source: 'staff', paymentId: pay.id, reason: 'race probe', branchIds: [pay.branch_id] });
    const w0 = await mock.walletBalance();
    const res = await Promise.allSettled([decideReversal(ctx, rr.id, 'u_admin1', true, 'a'), decideReversal(ctx, rr.id, 'u_admin1', true, 'b')]);
    const w1 = await mock.walletBalance();
    const rec = await ctx.ledger.reconcile();
    out('double-approve-reversal', { results: res.map((r) => r.status + (r.status === 'rejected' ? ':' + (r as any).reason?.message : '')), pspWalletDrop: w0 - w1, expectedDrop: pay.amount_paid - pay.psp_cost, reconcileOk: rec.ok, reconcileDiff: rec.difference, walletBefore });
    expect(true).toBe(true);
  });

  it('two settlement runs at once: how many payouts are created and what does Available show?', async () => {
    const mock = ctx.provider as any;
    await mock.simulatePaybill({ phone: '254700123458', amount: 20_000_000, reference: 'NOPE' }); // unmatched: puts spare cash in the PSP wallet so a payout can succeed
    await mock.simulatePaybill({ phone: '254700123457', amount: 2_000_000, reference: 'GRC002#OFFERING' });
    ctx.clock.advanceHours(50);
    const payoutsBefore = (await q(`SELECT count(*)::int AS n FROM payouts WHERE branch_id='br_grc002'`))[0].n;
    const sentBefore = mock.payoutsSent.length;
    const availBefore = await ctx.ledger.balance('available', 'br_grc002');
    await ctx.ledger.releasePending();
    const availReleased = await ctx.ledger.balance('available', 'br_grc002');
    const res = await Promise.all([ctx.ledger.runSettlement(), ctx.ledger.runSettlement()]);
    const payoutsAfter = (await q(`SELECT id, amount, gross, status FROM payouts WHERE branch_id='br_grc002' ORDER BY created_at DESC LIMIT 4`));
    const availAfter = await ctx.ledger.balance('available', 'br_grc002');
    const rec = await ctx.ledger.reconcile();
    out('double-settlement', { availBefore, availReleased, newPayouts: payoutsAfter.length ? (await q(`SELECT count(*)::int AS n FROM payouts WHERE branch_id='br_grc002'`))[0].n - payoutsBefore : 0, pspPayoutsSent: mock.payoutsSent.length - sentBefore, pspPayoutsToGrc002: mock.payoutsSent.slice(sentBefore).filter((x: any) => x.destination?.accountNumber === '0170199887').length, branchResults: res.map((r) => r.filter((x) => x.branchId === 'br_grc002').map((x) => x.status)), availAfter, reconcileOk: rec.ok, reconcileDiff: rec.difference });
    expect(true).toBe(true);
  });

  it('refund approved twice at once for a ticket order', async () => {
    const ev = await makeEvent('Double refund night', 40, 3000);
    const o = (await call(JANE, 'POST', '/me/tickets/orders', { eventId: ev.id, method: 'mpesa', lines: [{ typeId: ev.type, qty: 1 }] })).json();
    await wait(async () => (await orderStatus(o.secret)).status === 'paid');
    const req = await call(JANE, 'POST', `/me/tickets/orders/${o.id}/refund-request`, { reason: 'x' });
    const list = (await call(OWNER, 'GET', `/events/${ev.id}/refund-requests`)).json().requests;
    const rid = list[0].id;
    const res = await Promise.all([call(OWNER, 'POST', `/refund-requests/${rid}/decide`, { approve: true }), call(OWNER, 'POST', `/refund-requests/${rid}/decide`, { approve: true })]);
    const revs = await q(`SELECT id, status FROM reversal_requests WHERE payment_id=(SELECT id FROM payments WHERE provider_tx_id=(SELECT provider_tx_id FROM ticket_orders WHERE id=$1))`, [o.id]);
    out('double-ticket-refund-approve', { requestStatus: req.statusCode, decideStatuses: res.map((r) => r.statusCode), reversalRequestsCreated: revs.length });
    expect(true).toBe(true);
  });
});

describe('inventory and credit races', () => {
  it('the last ticket: two guests at once. Is a payment prompt sent to the loser?', async () => {
    const ev = await makeEvent('Last ticket', 30, 1500, 1);
    const stkBefore = (await q(`SELECT count(*)::int AS n FROM give_intents`))[0].n;
    const pays0 = (await q(`SELECT count(*)::int AS n FROM payments WHERE purpose LIKE 'TKT-%'`))[0].n;
    const res = await Promise.all([guestOrder(ev, 'lastone@gmail.com'), guestOrder(ev, 'lasttwo@gmail.com')]);
    await sleep(800);
    const orders = (await q(`SELECT count(*)::int AS n FROM ticket_orders WHERE event_id=$1`, [ev.id]))[0].n;
    const pays = (await q(`SELECT purpose, stage, member_id FROM payments WHERE purpose LIKE 'TKT-%' ORDER BY received_at DESC LIMIT 5`));
    const orphan = [];
    for (const p of pays) { const code = p.purpose.slice(4); if (!(await q(`SELECT 1 FROM ticket_orders WHERE code=$1`, [code])).length) orphan.push(p.purpose); }
    out('last-ticket', { statuses: res.map((r) => r.statusCode), ordersCreated: orders, paymentsForTicketsNew: pays.length, paymentsWithNoOrder: orphan.length, orphanPurposes: orphan, intentsAdded: (await q(`SELECT count(*)::int AS n FROM give_intents`))[0].n - stkBefore, pays0 });
    expect(true).toBe(true);
  });

  it('the same event credit spent by two orders at once', async () => {
    // give JANE credit 3000
    const src = await makeEvent('Credit src', 50, 3000);
    const o = (await call(JANE, 'POST', '/me/tickets/orders', { eventId: src.id, method: 'mpesa', lines: [{ typeId: src.type, qty: 1 }] })).json();
    await wait(async () => (await orderStatus(o.secret)).status === 'paid');
    const issued = await call(JANE, 'POST', `/me/tickets/orders/${o.id}/credit`, {});
    const bal0 = (await call(JANE, 'GET', '/me/credit')).json().total;
    const a = await makeEvent('Spend A', 60, 3000), b = await makeEvent('Spend B', 61, 3000);
    const res = await Promise.all([
      call(JANE, 'POST', '/me/tickets/orders', { eventId: a.id, method: 'mpesa', lines: [{ typeId: a.type, qty: 1 }] }),
      call(JANE, 'POST', '/me/tickets/orders', { eventId: b.id, method: 'mpesa', lines: [{ typeId: b.type, qty: 1 }] }),
    ]);
    await sleep(600);
    const bal1 = (await call(JANE, 'GET', '/me/credit')).json().total;
    const neg = (await q(`SELECT count(*)::int AS n FROM event_credits WHERE balance < 0`))[0].n;
    const moves = (await q(`SELECT COALESCE(SUM(amount),0) AS s FROM event_credit_moves WHERE NOT undone`))[0].s;
    out('credit-double-spend', { issued: issued.statusCode, bal0, bal1, statuses: res.map((r) => r.statusCode), bodies: res.map((r) => (r.json().creditUsed ?? r.json().code)), negativeBalances: neg, movesTotal: Number(moves) });
    expect(neg).toBe(0);
  });

  it('a guest credit code spent by two orders at once', async () => {
    const src = await makeEvent('Guest credit src', 70, 2000);
    const o = (await guestOrder(src, 'creditguest@gmail.com')).json();
    await wait(async () => (await orderStatus(o.secret)).status === 'paid');
    const iss = await call(null, 'POST', `/public/tickets/orders/${o.secret}/credit`, {});
    const code = iss.json().code as string;
    const a = await makeEvent('GSpend A', 80, 2000), b = await makeEvent('GSpend B', 81, 2000);
    const res = await Promise.all([guestOrder(a, 'gina.one@gmail.com', 1, { creditCode: code }), guestOrder(b, 'gina.two@gmail.com', 1, { creditCode: code })]);
    await sleep(600);
    const left = (await call(null, 'GET', `/public/credit/${code}`)).json();
    out('guest-credit-double-spend', { statuses: res.map((r) => r.statusCode), creditUsed: res.map((r) => r.json().creditUsed ?? r.json().code), balanceLeft: left.balance ?? left.code });
    expect(true).toBe(true);
  });

  it('free tickets: per-person limit versus email variants and many emails', async () => {
    const ev = await makeEvent('Free night', 30, 0, 500);
    const mk = async (email: string, qty: number) => (await guestOrder(ev, email, qty)).json();
    const r: any[] = [];
    r.push(['maryanne.k@gmail.com x10', (await mk('maryanne.k@gmail.com', 10)).code ?? 'ok']);
    r.push(['mary.anne.k@gmail.com +1 (same mailbox, dots)', (await mk('mary.anne.k@gmail.com', 1)).code ?? 'ok']);
    r.push(['maryannek@googlemail.com +1', (await mk('maryannek@googlemail.com', 1)).code ?? 'ok']);
    r.push(['maryannek+x@gmail.com +1 (plus)', (await mk('maryannek+x@gmail.com', 1)).code ?? 'ok']);
    r.push(['MARYANNEK@GMAIL.COM +1 (case)', (await mk('MARYANNEK@GMAIL.COM', 1)).code ?? 'ok']);
    r.push(['same person, other real inbox (own domain) x10', (await mk('person2@myowndomain.co.ke', 10)).code ?? 'ok']);
    r.push(['third address on a free provider x10', (await mk('person3@outlook.com', 10)).code ?? 'ok']);
    // 30 different invented-but-plausible addresses, 20 tickets each (MAX_PER_ORDER)
    let got = 0;
    for (let i = 0; i < 5; i++) { const x = await guestOrder(ev, `visitor${i}x${i * 7}@outlook.com`, 20); if (x.statusCode === 200) got += 20; }
    const sold = (await q(`SELECT count(*)::int AS n FROM tickets WHERE event_id=$1`, [ev.id]))[0].n;
    out('free-limit', { dbg: (await guestOrder(ev, 'zed.visitor@outlook.com', 1)).json(), attempts: r, ticketsFromFiveFreshEmails: got, ticketsHeldByOneActor: sold });
    expect(true).toBe(true);
  });

  it('anonymous guests can hold all paid inventory for 15 minutes with no limit (unpaid orders)', async () => {
    const ev = await makeEvent('Hoard night', 30, 1000, 40);
    (ctx.provider as any).setStkDelay?.(600_000); // prompts never completed
    const res = [];
    for (let i = 0; i < 4; i++) res.push((await guestOrder(ev, `hoarding.person${i}@outlook.com`, 10)).statusCode);
    (ctx.provider as any).setStkDelay?.(0);
    const t = (await call(null, 'GET', `/public/event/${ev.code}`)).json();
    const dbg = await guestOrder(ev, 'hoarding.person9@outlook.com', 1); out('hoarding', { dbg: dbg.json(), statuses: res, onSale: t.types[0].onSale, soldOut: t.types[0].soldOut });
    expect(true).toBe(true);
  });
});

describe('state machine and arithmetic', () => {
  it('payment arriving after the order was cancelled/lapsed; reversed payment reuse; voided expense paid', async () => {
    const ev = await makeEvent('Late pay', 30, 1200, 5);
    (ctx.provider as any).setStkDelay?.(600_000);
    const o = (await call(JANE, 'POST', '/me/tickets/orders', { eventId: ev.id, method: 'mpesa', lines: [{ typeId: ev.type, qty: 1 }] })).json();
    (ctx.provider as any).setStkDelay?.(0);
    await call(JANE, 'POST', `/me/tickets/orders/${o.id}/cancel`, {});
    const row = (await q(`SELECT * FROM ticket_orders WHERE id=$1`, [o.id]))[0];
    const body = JSON.stringify({ providerTxId: row.provider_tx_id, method: 'mpesa', amount: Number(row.total), reference: `GRC001#TKT-${row.code}`, phone: '254711000001' });
    const sig = createHmac('sha256', SECRET).update(body).digest('hex');
    await app.inject({ method: 'POST', url: '/psp/webhook', payload: body, headers: { 'content-type': 'application/json', 'x-psp-signature': sig } });
    const after = await orderStatus(o.secret);
    out('late-payment-after-cancel', { statusAfterLatePayment: after.status, tickets: after.tickets.length });
    expect(true).toBe(true);
  });

  it('computeFee edge cases (zero, negative, huge, fractional, fee larger than amount)', async () => {
    const { computeFee, DEFAULT_FEE_SCHEDULE, toCents } = await import('../../../packages/shared/src/index');
    const tryit = (f: () => unknown) => { try { return f(); } catch (e: any) { return 'throws: ' + e.message; } };
    const res: any = {};
    for (const [label, v] of [['0', 0], ['-100', -100], ['1', 1], ['1.5', 1.5], ['NaN', NaN], ['MAX_SAFE', Number.MAX_SAFE_INTEGER], ['1e15', 1e15]] as const)
      res['church ' + label] = tryit(() => computeFee(DEFAULT_FEE_SCHEDULE, 'card', v as number, 'church'));
    res['member 1'] = tryit(() => computeFee(DEFAULT_FEE_SCHEDULE, 'card', 1, 'member'));
    res['member 15M'] = tryit(() => computeFee(DEFAULT_FEE_SCHEDULE, 'mpesa', 15_000_000, 'member'));
    // a schedule the admin could set: fixed psp fee above the amount
    const odd: any = { platform: { type: 'flat', bps: 150 }, psp: { ...DEFAULT_FEE_SCHEDULE.psp, mpesa: { bps: 100, fixed: 5000 } } };
    res['church fee>amount (fixed 5000, amount 1000)'] = tryit(() => computeFee(odd, 'mpesa', 1000, 'church'));
    const hi: any = { platform: { type: 'flat', bps: 9000 }, psp: { ...DEFAULT_FEE_SCHEDULE.psp, mpesa: { bps: 5000, fixed: 0 } } };
    res['bps sum >100% church'] = tryit(() => computeFee(hi, 'mpesa', 100000, 'church'));
    res['bps sum >100% member (loop)'] = tryit(() => computeFee(hi, 'mpesa', 100000, 'member'));
    res.toCents = { '1e308': tryit(() => toCents('1e308')), '10abc': tryit(() => toCents('10abc')), '-5': tryit(() => toCents(-5)), '0.005': tryit(() => toCents(0.005)), '1e17': tryit(() => toCents('1e17')) };
    out('fees', res);
    expect(true).toBe(true);
  });

  it('admin tenant fee schedule validation (can a nonsense schedule be saved?)', async () => {
    const bad = { platform: { type: 'flat', bps: 20000 }, psp: { mpesa: { bps: 100, fixed: 0 }, airtel: { bps: 100, fixed: 0 }, tkash: { bps: 100, fixed: 0 }, card: { bps: 100, fixed: 0 }, cash: { bps: 0, fixed: 0 } } };
    const r = await call(ADMIN1, 'PUT', '/admin/tenants/org_hope/fees', { feeSchedule: bad, feeBearer: 'church' });
    const neg = await call(ADMIN1, 'PUT', '/admin/tenants/org_hope/fees', { feeSchedule: { ...bad, platform: { type: 'flat', bps: -500 } }, feeBearer: 'church' });
    out('fee-schedule-validation', { bps20000: r.statusCode + ' ' + JSON.stringify(r.json()).slice(0, 120), bpsNegative: neg.statusCode + ' ' + JSON.stringify(neg.json()).slice(0, 120) });
    // restore a sane schedule so later probes are not affected
    await call(ADMIN1, 'PUT', '/admin/tenants/org_hope/fees', { feeSchedule: { platform: { type: 'flat', bps: 150 }, psp: { mpesa: { bps: 100, fixed: 0 }, airtel: { bps: 120, fixed: 0 }, tkash: { bps: 120, fixed: 0 }, card: { bps: 290, fixed: 0 }, cash: { bps: 0, fixed: 0 } } }, feeBearer: 'church' });
    expect(true).toBe(true);
  });
});

describe('audit log and ledger tamper resistance (database level)', () => {
  it('can the application role alter or delete audit rows, giving ledger rows, postings and journal entries?', async () => {
    const r: Record<string, string> = {};
    const attempt = async (label: string, sql: string, asApp = false) => {
      try {
        if (asApp) await ctx.db.asOrg('org_grace', async (t) => { await t.query(sql); });
        else await ctx.db.query(sql);
        r[label] = 'ALLOWED';
      } catch (e: any) { r[label] = 'blocked: ' + String(e.message).slice(0, 60); }
    };
    await attempt('owner UPDATE audit_events', `UPDATE audit_events SET summary='x' WHERE seq=1`);
    await attempt('owner DELETE audit_events', `DELETE FROM audit_events WHERE seq=1`);
    await attempt('owner TRUNCATE audit_events', `TRUNCATE audit_events`);
    await attempt('app_user UPDATE audit_events', `UPDATE audit_events SET summary='x' WHERE seq=1`, true);
    await attempt('app_user DELETE audit_events', `DELETE FROM audit_events WHERE seq=1`, true);
    await attempt('owner UPDATE postings (tamper money ledger)', `UPDATE postings SET amount = amount WHERE id = (SELECT min(id) FROM postings)`);
    await attempt('owner DELETE journal_entries', `DELETE FROM journal_entries WHERE id = -1`);
    await attempt('owner UPDATE giving_ledger', `UPDATE giving_ledger SET amount = amount`);
    await call('0700000002', 'GET', '/members/m_jane/giving-ledger?reason=audit'); await call('0700000002', 'GET', '/members/m_jane/giving-ledger?reason=audit');
    r.accessRows = String((await q(`SELECT count(*)::int AS n FROM giving_ledger_access`))[0].n);
    await attempt('owner DELETE giving_ledger_access (rows exist)', `DELETE FROM giving_ledger_access`);
    await attempt('owner UPDATE giving_ledger_access (rows exist)', `UPDATE giving_ledger_access SET reason='x'`);
    await attempt('owner UPDATE payments.amount_paid', `UPDATE payments SET amount_paid = amount_paid WHERE id='none'`);
    // does the chain verify, and does a tampered copy get noticed?  (done on a scratch table copy, never on the real one)
    const v = await (await call(ADMIN1, 'GET', '/admin/audit/verify')).json();
    out('tamper', { ...r, chainsOk: v.ok, chains: v.chains?.length });
    expect(true).toBe(true);
  });
});

describe('who can see what (privacy)', () => {
  it('anonymous gift: where does the giver still show up?', async () => {
    const r = await call(JANE, 'POST', '/me/give', { code: 'GRC001', amount: 25, method: 'mpesa', purpose: 'TITHE', anonymous: true });
    await wait(async () => (await q(`SELECT 1 FROM payments WHERE anonymous AND amount_paid=2500`)).length > 0);
    const pay = (await q(`SELECT * FROM payments WHERE anonymous AND amount_paid=2500 ORDER BY received_at DESC LIMIT 1`))[0];
    const sms = await q(`SELECT to_phone, body FROM sms_messages WHERE body LIKE $1`, [`%${pay.provider_tx_id}%`]);
    const adminSms = (await call(ADMIN1, 'GET', '/admin/sms-outbox')).json().filter((x: any) => String(x.body).includes(pay.provider_tx_id));
    const ntf = await q(`SELECT user_id, title FROM notifications WHERE body LIKE $1`, [`%${pay.provider_tx_id}%`]);
    const ownerPayments = await call(OWNER, 'GET', '/collections');
    const leaked = JSON.stringify(ownerPayments.json()).includes('711000001') || JSON.stringify(ownerPayments.json()).includes('0711');
    const intent = (await q(`SELECT phone, anonymous FROM give_intents WHERE id=$1`, [r.json().intentId]))[0];
    const ledger = await q(`SELECT count(*)::int AS n FROM giving_ledger WHERE payment_id=$1`, [pay.id]);
    const msg = (await q(`SELECT count(*)::int AS n FROM journal_entries WHERE payment_id=$1`, [pay.id]))[0].n;
    out('anon-gift', {
      paymentPayerPhone: pay.payer_phone, paymentMemberId: pay.member_id, intentPhone: intent.phone,
      smsMessagesRowHasFullPhone: sms.map((s) => s.to_phone), adminOutboxMaskedPhone: adminSms.map((s: any) => s.to_phone), adminOutboxBody: adminSms.map((s: any) => s.body),
      notificationsReferencingTxId: ntf.length, ownerCollectionsLeaksPhone: leaked, givingLedgerRows: ledger[0].n, journalEntries: msg,
    });
    expect(true).toBe(true);
  });
});

describe('IP handling behind a proxy', () => {
  it('with TRUST_PROXY=1 a caller chooses its own req.ip (rate-limit bypass, audit ip forgery, PSP allow-list bypass)', async () => {
    process.env.TRUST_PROXY = '1';
    const built = await buildApp({ stkDelayMs: 0 });
    delete process.env.TRUST_PROXY;
    const ips: string[] = [];
    built.app.get('/__ip', async (req) => ({ ip: req.ip }));
    const get = (xff?: string) => built.app.inject({ method: 'GET', url: '/__ip', remoteAddress: '10.0.0.1', headers: xff ? { 'x-forwarded-for': xff } : {} });
    ips.push((await get()).json().ip);
    ips.push((await get('6.6.6.6')).json().ip);
    ips.push((await get('6.6.6.6, 203.0.113.9')).json().ip);       // spoofed first, real client appended by the proxy
    ips.push((await get('1.2.3.4, 5.6.7.8, 203.0.113.9')).json().ip);
    // church search: 40/min per ip. Rotate XFF per request and see whether the limiter ever trips.
    let limited = 0;
    for (let i = 0; i < 60; i++) { const r = await built.app.inject({ method: 'GET', url: '/public/churches/search?q=grace', remoteAddress: '10.0.0.1', headers: { 'x-forwarded-for': `9.9.${i}.${i}` } }); if (r.statusCode === 429) limited++; }
    // without rotating, from one address (control)
    let limited2 = 0;
    for (let i = 0; i < 60; i++) { const r = await built.app.inject({ method: 'GET', url: '/public/churches/search?q=grace', remoteAddress: '10.0.0.1', headers: { 'x-forwarded-for': `8.8.8.8` } }); if (r.statusCode === 429) limited2++; }
    // without TRUST_PROXY (current app, proxy IP shared by everyone)
    let limited3 = 0;
    for (let i = 0; i < 45; i++) { const r = await app.inject({ method: 'GET', url: '/public/churches/search?q=grace', remoteAddress: '10.0.0.1', headers: { 'x-forwarded-for': `7.7.${i}.1` } }); if (r.statusCode === 429) limited3++; }
    const other = await app.inject({ method: 'GET', url: '/public/churches/search?q=grace', remoteAddress: '10.0.0.1' });
    out('trust-proxy', { reqIpSeenWithTrustProxy: ips, limitedWhenRotatingXFF: limited, limitedSameXFF: limited2, noTrustProxy_limitedAfter45_rotating: limited3, noTrustProxy_anotherUserSameProxyIpNowBlocked: other.statusCode });
    await built.app.close();
    expect(true).toBe(true);
  });
});

describe('audit chain verifier correctness', () => {
  it('an event whose meta holds an undefined value (as kids.* events do) fails verification; 30 concurrent writes keep the chain intact', async () => {
    const { verifyChains } = await import('../../../packages/ledger/src/audit');
    const orgBefore = (await verifyChains(ctx.db, 'org_hope'))[0];
    await ctx.ledger.audit({ orgId: 'org_hope', action: 'probe.undefined_in_meta', summary: 'probe', meta: { result: 'ok', method: undefined, device: undefined } });
    const afterUndefined = (await verifyChains(ctx.db, 'org_hope'))[0];
    await ctx.ledger.audit({ orgId: 'org_hope', action: 'probe.after_the_bad_event', summary: 'probe', meta: { n: 1 } });
    // now tamper evidence after the bad event: the verifier already stopped at it, so a later change would not be reported separately
    const later = (await verifyChains(ctx.db, 'org_hope'))[0];
    await ctx.ledger.audit({ orgId: 'org_newhope', action: 'probe.clean', summary: 'probe', meta: { n: 1 } });
    await Promise.all(Array.from({ length: 30 }, (_, i) => ctx.ledger.audit({ orgId: 'org_newhope', action: 'probe.concurrent', summary: 'probe ' + i, meta: { i } })));
    const conc = (await verifyChains(ctx.db, 'org_newhope'))[0];
    out('audit-verifier', { before: orgBefore.ok, afterUndefinedMeta: afterUndefined, afterAnotherEvent: later, concurrentWritesChainOk: conc.ok, events: conc.events });
    expect(true).toBe(true);
  });
});

describe('sign-in lock (in-process, so no real demo user is locked)', () => {
  it('an anonymous caller can lock any known phone out; unknown phones add counters that are never pruned', async () => {
    const wrong = [];
    for (let i = 0; i < 6; i++) wrong.push((await call(null, 'POST', '/auth/otp/verify', { phone: '0711000002', code: '000000' })).statusCode);
    const real = await call(null, 'POST', '/auth/otp/verify', { phone: '0711000002', code: '123456' });
    // the lock also stops the owner of the phone from using the right code, from any IP
    const other = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone: '0711000002', code: '123456' }, remoteAddress: '198.51.100.7' });
    // does the lock expire if the clock advances 16 minutes? (it uses Date.now(), not the platform clock)
    out('signin-lock', { sixWrongCodes: wrong, thenCorrectCode: real.statusCode, correctCodeFromOtherIp: other.statusCode, lockMessage: real.json().error });
    expect(true).toBe(true);
  });
});
