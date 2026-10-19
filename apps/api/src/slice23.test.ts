import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createProviderFromEnv, fakeFetch, RoutedProvider } from '@churchos/payments';
import { buildApp } from './server';
import { seed } from './seed';

// Live payment adapters over a fake network: every HTTP call is answered from the providers' documented shapes, nothing leaves the machine.
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
let net: ReturnType<typeof fakeFetch>;
let stkN = 0;

const ENV = {
  PSP_MODE: 'live', MPESA_CONSUMER_KEY: 'test-key', MPESA_CONSUMER_SECRET: 'test-secret', MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'test-passkey',
  MPESA_CALLBACK_BASE: 'https://api.example.test', MPESA_CALLBACK_TOKEN: 'mtok', MPESA_INITIATOR_NAME: 'testapi', MPESA_SECURITY_CREDENTIAL: 'PRE-ENCRYPTED',
  AIRTEL_CLIENT_ID: 'test-id', AIRTEL_CLIENT_SECRET: 'test-secret', AIRTEL_CALLBACK_BASE: 'https://api.example.test', AIRTEL_CALLBACK_TOKEN: 'atok',
  PAYSTACK_SECRET_KEY: 'test-key',
};

const post = (url: string, payload: any, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: typeof payload === 'string' ? payload : JSON.stringify(payload), headers: { 'content-type': 'application/json', ...headers } });
const give = async (extra: any) => {
  const r = await app.inject({ method: 'POST', url: '/public/give', payload: { code: 'GRC001', phone: '0711000001', amount: 500, purpose: 'TITHE', method: 'mpesa', ...extra } });
  expect(r.statusCode, r.body).toBe(200);
  const g = r.json();
  const intent = (await ctx.db.query<any>(`SELECT provider_tx_id, amount_paid FROM give_intents WHERE id=$1`, [g.intentId]))[0];
  return { ...g, tx: intent.provider_tx_id as string, paid: Number(intent.amount_paid) };
};
const pay = (tx: string) => ctx.db.query<any>(`SELECT method, amount_paid, reference, stage, branch_id FROM payments WHERE provider_tx_id=$1`, [tx]);
const stkCallback = (tx: string, amountKes: number, code = 0) => ({ Body: { stkCallback: {
  MerchantRequestID: 'm', CheckoutRequestID: tx, ResultCode: code, ResultDesc: code === 0 ? 'ok' : 'cancelled',
  ...(code === 0 ? { CallbackMetadata: { Item: [{ Name: 'Amount', Value: amountKes }, { Name: 'MpesaReceiptNumber', Value: 'TEST123ABC' }, { Name: 'TransactionDate', Value: 20261019123045 }, { Name: 'PhoneNumber', Value: 254711000001 }] } } : {}),
} } });
const paystackSig = (raw: string) => createHmac('sha512', 'test-key').update(raw).digest('hex');

beforeAll(async () => {
  net = fakeFetch({
    'GET /oauth/v1/generate': { json: { access_token: 'AT', expires_in: '3599' } },
    'POST /mpesa/stkpush/v1/processrequest': () => ({ json: { ResponseCode: '0', CheckoutRequestID: `ws_CO_TEST${++stkN}` } }),
    'POST /mpesa/b2c/v3/paymentrequest': { json: { ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' } },
    'POST /auth/oauth2/token': { json: { access_token: 'AIR', expires_in: 3600 } },
    'POST /merchant/v2/payments/': { json: { status: { success: true } } },
    'GET /standard/v1/payments/': { json: { data: { transaction: { airtel_money_id: 'MP1', status: 'TS' } }, status: { success: true } } },
    'POST /transaction/initialize': (r) => ({ json: { status: true, data: { authorization_url: `https://checkout.paystack.com/${r.body.reference}`, reference: r.body.reference } } }),
    'GET /transaction/verify/': (r) => ({ json: { status: true, data: { status: 'success', amount: paystackAmounts.get(r.url.split('/').pop()!) } } }),
  });
  const provider = createProviderFromEnv(ENV, net.fetch);
  expect(provider).toBeInstanceOf(RoutedProvider);
  const built = await buildApp({ provider });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);

const paystackAmounts = new Map<string, number>();

describe('live M-Pesa, Airtel and Paystack behind the same API', () => {
  it('the live card page is the provider\'s, and the simulator\'s pages and tools are closed', async () => {
    expect(ctx.provider.kind).toBe('live');
    expect((await app.inject({ method: 'GET', url: '/public/checkout/CARDX' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/public/checkout/CARDX/pay', payload: {} })).statusCode).toBe(404);
  });

  it('an M-Pesa prompt is matched by its CheckoutRequestID: the payment lands once, the duplicate is ignored', async () => {
    const g = await give({ amount: 500 });
    expect(g.tx).toMatch(/^ws_CO_TEST/);
    const stk = net.seen.find((s) => s.url.includes('stkpush'))!;
    expect(stk.body).toMatchObject({ Amount: g.paid / 100, PhoneNumber: '254711000001', AccountReference: 'GRC001#TITHE' });
    expect((await ctx.db.query<any>(`SELECT reference FROM psp_refs WHERE provider_tx_id=$1`, [g.tx]))[0].reference).toBe('GRC001#TITHE');

    const cb = stkCallback(g.tx, g.paid / 100);
    const r1 = await post('/webhooks/daraja/mtok/stk', cb);
    expect(r1.json()).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    const rows = await pay(g.tx);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ method: 'mpesa', reference: 'GRC001#TITHE', branch_id: 'br_grc001' });
    expect(Number(rows[0].amount_paid)).toBe(g.paid);
    expect((await app.inject({ method: 'GET', url: `/public/give/${g.intentId}` })).json().status).toBe('completed');

    expect((await post('/webhooks/daraja/mtok/stk', cb)).statusCode).toBe(200); // Safaricom or an attacker replays it
    expect((await pay(g.tx)).length).toBe(1);
  });

  it('a wrong token is refused, a cancelled prompt never becomes a payment, money nobody asked for is held in suspense, not lost', async () => {
    const g = await give({ amount: 600 });
    expect((await post('/webhooks/daraja/wrong/stk', stkCallback(g.tx, 600))).statusCode).toBe(401);
    expect((await pay(g.tx)).length).toBe(0);
    expect((await post('/webhooks/daraja/mtok/stk', stkCallback(g.tx, 600, 1032))).statusCode).toBe(200);
    expect((await pay(g.tx)).length).toBe(0);
    expect((await post('/webhooks/daraja/mtok/stk', stkCallback('ws_CO_NEVER_ASKED', 10))).statusCode).toBe(200);
    expect((await pay('ws_CO_NEVER_ASKED')).map((p) => p.stage)).toEqual(['suspense']); // no church reference: held, and refunded if unclaimed
  });

  it('a paybill (C2B) confirmation matches the branch by its account reference; validation just says yes', async () => {
    const body = { TransactionType: 'Pay Bill', TransID: 'TESTC2B0001', TransTime: '20261019123000', TransAmount: '1000.00', BusinessShortCode: '174379', BillRefNumber: 'GRC001#OFFERING', MSISDN: 'hashed' };
    expect((await post('/webhooks/daraja/mtok/c2b-validate', body)).json()).toMatchObject({ ResultCode: 0 });
    expect((await post('/webhooks/daraja/bad/c2b-validate', body)).statusCode).toBe(401);
    expect((await post('/webhooks/daraja/mtok/c2b', body)).statusCode).toBe(200);
    expect((await post('/webhooks/daraja/mtok/c2b', body)).statusCode).toBe(200);
    const rows = await pay('TESTC2B0001');
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ reference: 'GRC001#OFFERING', branch_id: 'br_grc001', amount_paid: 100000 });
  });

  it('a card gift goes to Paystack\'s hosted page; only a correctly signed charge.success counts, once', async () => {
    const g = await give({ amount: 800, method: 'card' });
    expect(g.checkoutUrl).toBe(`https://checkout.paystack.com/${g.tx}`);
    const init = net.seen.find((s) => s.url.endsWith('/transaction/initialize') && s.body.reference === g.tx)!;
    expect(init.body).toMatchObject({ amount: g.paid, currency: 'KES', metadata: { reference: 'GRC001#TITHE' } });
    paystackAmounts.set(g.tx, g.paid);
    const raw = JSON.stringify({ event: 'charge.success', data: { status: 'success', reference: g.tx, amount: g.paid, currency: 'KES', paid_at: '2026-10-19T09:31:00.000Z', metadata: { reference: 'GRC001#TITHE', phone: '0711000001' } } });
    expect((await post('/webhooks/paystack', raw)).statusCode).toBe(401);
    expect((await post('/webhooks/paystack', raw, { 'x-paystack-signature': paystackSig(raw + ' ') })).statusCode).toBe(401);
    expect((await pay(g.tx)).length).toBe(0);
    expect((await post('/webhooks/paystack', raw, { 'x-paystack-signature': paystackSig(raw) })).statusCode).toBe(200);
    expect((await post('/webhooks/paystack', raw, { 'x-paystack-signature': paystackSig(raw) })).statusCode).toBe(200);
    const rows = await pay(g.tx);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ method: 'card', reference: 'GRC001#TITHE' });
    const other = JSON.stringify({ event: 'customer.identification.success', data: {} });
    expect((await post('/webhooks/paystack', other, { 'x-paystack-signature': paystackSig(other) })).statusCode).toBe(200);
  });

  it('a Paystack charge whose amount differs from what Paystack itself reports is not posted', async () => {
    const g = await give({ amount: 900, method: 'card' });
    paystackAmounts.set(g.tx, 100); // Paystack says the real amount was tiny
    const raw = JSON.stringify({ event: 'charge.success', data: { status: 'success', reference: g.tx, amount: g.paid, currency: 'KES', metadata: { reference: 'GRC001#TITHE' } } });
    expect((await post('/webhooks/paystack', raw, { 'x-paystack-signature': paystackSig(raw) })).statusCode).toBe(200);
    expect((await pay(g.tx)).length).toBe(0);
  });

  it('Airtel: the callback has no amount, so it is taken from the saved request after Airtel itself confirms it', async () => {
    const g = await give({ amount: 700, method: 'airtel', phone: '0733000001' });
    expect(g.tx).toMatch(/^ATL/);
    expect(net.seen.find((s) => s.url.endsWith('/merchant/v2/payments/'))!.body.subscriber.msisdn).toBe('733000001');
    const cb = (code: string) => ({ transaction: { id: g.tx, message: 'Paid', status_code: code, airtel_money_id: 'MP1' } });
    expect((await post('/webhooks/airtel/wrong', cb('TS'))).statusCode).toBe(401);
    expect((await post('/webhooks/airtel/atok', cb('TF'))).statusCode).toBe(200);
    expect((await pay(g.tx)).length).toBe(0);
    expect((await post('/webhooks/airtel/atok', cb('TS'))).statusCode).toBe(200);
    expect((await post('/webhooks/airtel/atok', cb('TS'))).statusCode).toBe(200);
    const rows = await pay(g.tx);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ method: 'airtel', reference: 'GRC001#TITHE' });
    expect(Number(rows[0].amount_paid)).toBe(g.paid);
  });

  it('a payout the PSP only accepts keeps the money reserved, settles on the result callback, and a repeat does nothing', async () => {
    await ctx.db.query(`UPDATE branches SET payout_destination=$1, payout_verified=true, payout_paused=false WHERE id='br_grc001'`, [JSON.stringify({ type: 'mobile', phone: '254700000009' })]);
    ctx.clock.advanceHours(60);
    await ctx.ledger.releasePending();
    const available = await ctx.ledger.balance('available', 'br_grc001');
    expect(available).toBeGreaterThan(0);
    const res = (await ctx.ledger.runSettlement()).find((r) => r.branchId === 'br_grc001')!;
    expect(res.status).toBe('submitted');
    const payoutId = (res as any).payoutId as string;
    const b2c = net.seen.filter((s) => s.url.includes('/b2c/')).at(-1)!;
    expect(b2c.body).toMatchObject({ OriginatorConversationID: payoutId, PartyB: '254700000009', CommandID: 'BusinessPayment' });
    expect(await ctx.ledger.balance('in_transit')).toBe(available);
    expect((await ctx.db.query<any>(`SELECT status FROM payouts WHERE id=$1`, [payoutId]))[0].status).toBe('created');
    // nothing is paid twice while it is in flight
    expect((await ctx.ledger.runSettlement()).find((r) => r.branchId === 'br_grc001')!.status).not.toBe('paid');

    const result = (code: number) => ({ Result: { ResultType: 0, ResultCode: code, ResultDesc: 'x', OriginatorConversationID: payoutId, ConversationID: 'AG', TransactionID: 'RCPT' } });
    expect((await post('/webhooks/daraja/bad/result', result(0))).statusCode).toBe(401);
    expect((await post('/webhooks/daraja/mtok/result', result(0))).json()).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    expect((await ctx.db.query<any>(`SELECT status FROM payouts WHERE id=$1`, [payoutId]))[0].status).toBe('confirmed');
    expect(await ctx.ledger.balance('in_transit')).toBe(0);
    const walletAfter = await ctx.ledger.balance('wallet');
    await post('/webhooks/daraja/mtok/result', result(0));
    await post('/webhooks/daraja/mtok/result', result(2001)); // a late contradictory report cannot undo a confirmed payout
    expect(await ctx.ledger.balance('wallet')).toBe(walletAfter);
    expect((await ctx.db.query<any>(`SELECT status FROM payouts WHERE id=$1`, [payoutId]))[0].status).toBe('confirmed');
  });

  it('a payout that fails at the PSP returns the funds to available, once', async () => {
    await post('/webhooks/daraja/mtok/c2b', { TransID: 'TESTC2B0002', TransTime: '20261019123000', TransAmount: '5000.00', BillRefNumber: 'GRC001#OFFERING', MSISDN: 'hashed' });
    ctx.clock.advanceHours(60);
    await ctx.ledger.releasePending();
    const available = await ctx.ledger.balance('available', 'br_grc001');
    const res = (await ctx.ledger.runSettlement()).find((r) => r.branchId === 'br_grc001')!;
    expect(res.status).toBe('submitted');
    const payoutId = (res as any).payoutId as string;
    const result = { Result: { ResultCode: 2001, ResultDesc: 'The initiator information is invalid.', OriginatorConversationID: payoutId } };
    await post('/webhooks/daraja/mtok/result', result);
    await post('/webhooks/daraja/mtok/result', result);
    expect((await ctx.db.query<any>(`SELECT status FROM payouts WHERE id=$1`, [payoutId]))[0].status).toBe('failed');
    expect(await ctx.ledger.balance('available', 'br_grc001')).toBe(available);
    expect(await ctx.ledger.balance('in_transit')).toBe(0);
  });
});
