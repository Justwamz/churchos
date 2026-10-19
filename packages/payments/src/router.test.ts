import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AirtelMoney } from './airtel';
import { fakeFetch } from './fakefetch';
import { MockProvider } from './mock';
import { MpesaDaraja } from './mpesa';
import { Paystack } from './paystack';
import { RoutedProvider, createProviderFromEnv, friendlyPspMessage, refundId } from './router';

const T0 = new Date('2026-10-19T09:30:05Z');
const mcfg = { env: 'sandbox' as const, consumerKey: 'k', consumerSecret: 's', shortcode: '174379', passkey: 'p', callbackBase: 'https://api.example.test', callbackToken: 'tok', securityCredential: 'CRED', initiatorName: 'testapi' };
const tokens = { 'GET /oauth/v1/generate': { json: { access_token: 'AT', expires_in: '3599' } } };

describe('RoutedProvider', () => {
  it('routes prompts by method and refuses what is not available', async () => {
    const f = fakeFetch({ ...tokens, 'POST /mpesa/stkpush': { json: { ResponseCode: '0', CheckoutRequestID: 'ws_1' } } });
    const r = new RoutedProvider({ mpesa: new MpesaDaraja(mcfg, f.fetch, () => T0) });
    expect(await r.initiateStkPush({ phone: '254700000001', amount: 10000, reference: 'A#B', method: 'mpesa' })).toEqual({ providerTxId: 'ws_1' });
    await expect(r.initiateStkPush({ phone: '254733000001', amount: 10000, reference: 'A#B', method: 'airtel' })).rejects.toMatchObject({ kind: 'not_configured', message: 'Airtel Money payments are not switched on yet' });
    await expect(r.initiateStkPush({ phone: '254777000001', amount: 10000, reference: 'A#B', method: 'tkash' })).rejects.toMatchObject({ kind: 'unsupported' });
    await expect(r.initiateCardCheckout({ amount: 10000, reference: 'A#B' })).rejects.toMatchObject({ message: 'Card payments are not switched on yet' });
    expect(friendlyPspMessage(await r.initiateCardCheckout({ amount: 1, reference: 'x' }).catch((e) => e))).toBe('Card payments are not switched on yet');
    expect(f.seen.length).toBe(2);
  });

  it('dispatches webhooks on x-psp: a Paystack signature does not open the M-Pesa door and vice versa', () => {
    const ps = new Paystack({ secretKey: 'test-key', fallbackEmailDomain: 'x.test', currency: 'KES', bankRecipientType: 'kepss', baseUrl: 'https://api.paystack.co' }, fakeFetch({}).fetch, () => T0);
    const r = new RoutedProvider({ mpesa: new MpesaDaraja(mcfg, fakeFetch({}).fetch, () => T0), paystack: ps });
    const raw = JSON.stringify({ event: 'charge.success', data: { status: 'success', reference: 'CARDX', amount: 5000, currency: 'KES', metadata: { reference: 'A#B' } } });
    const sig = createHmac('sha512', 'test-key').update(raw).digest('hex');
    expect(r.verifyWebhook({ 'x-psp': 'paystack', 'x-paystack-signature': sig }, raw)).toBe(true);
    expect(r.verifyWebhook({ 'x-psp': 'mpesa', 'x-psp-token': 'tok' }, raw)).toBe(true);
    expect(r.verifyWebhook({ 'x-psp': 'mpesa', 'x-paystack-signature': sig }, raw)).toBe(false);
    expect(r.verifyWebhook({ 'x-psp': 'airtel', 'x-psp-token': 'tok' }, raw)).toBe(false); // not configured
    expect(r.verifyWebhook({ 'x-paystack-signature': sig }, raw)).toBe(false); // no x-psp
    expect(r.parseWebhook(raw, { 'x-psp': 'paystack' })).toMatchObject({ providerTxId: 'CARDX', amount: 5000 });
    expect(r.parseWebhook(raw, {})).toBeNull();
  });

  it('payout: mobile goes to M-Pesa B2C and stays pending; bank goes to Paystack; neither configured is a friendly error', async () => {
    const f = fakeFetch({ ...tokens, 'POST /mpesa/b2c/v3/paymentrequest': { json: { ResponseCode: '0' } } });
    const r = new RoutedProvider({ mpesa: new MpesaDaraja(mcfg, f.fetch, () => T0) });
    expect(await r.payout({ payoutId: 'po_1', destination: { type: 'mobile', phone: '0700000001' }, amount: 100000 })).toEqual({ status: 'pending' });
    expect(f.seen.at(-1)!.body.OriginatorConversationID).toBe('po_1');
    await expect(r.payout({ payoutId: 'po_2', destination: { type: 'bank', bank: '63', accountNumber: '1' }, amount: 100000 })).rejects.toMatchObject({ message: 'Bank payouts are not switched on yet' });
    const refused = fakeFetch({ ...tokens, 'POST /mpesa/b2c': { status: 400, json: {} } });
    expect(await new RoutedProvider({ mpesa: new MpesaDaraja(mcfg, refused.fetch, () => T0) }).payout({ payoutId: 'po_3', destination: { type: 'mobile', phone: '0700000001' }, amount: 100000 })).toEqual({ status: 'failed' });
    await expect(new RoutedProvider({}).payout({ payoutId: 'po_4', destination: { type: 'mobile', phone: '0700000001' }, amount: 1 })).rejects.toMatchObject({ kind: 'not_configured' });
  });

  it('refund goes back the way the money came', async () => {
    const f = fakeFetch({ ...tokens, 'POST /mpesa/b2c/v3/paymentrequest': { json: { ResponseCode: '0' } }, 'POST /refund': { json: { status: true } } });
    const ps = new Paystack({ secretKey: 'test-key', fallbackEmailDomain: 'x.test', currency: 'KES', bankRecipientType: 'kepss', baseUrl: 'https://api.paystack.co' }, f.fetch);
    const r = new RoutedProvider({ mpesa: new MpesaDaraja(mcfg, f.fetch, () => T0), paystack: ps });
    expect(await r.refund({ providerTxId: 'ws_1', amount: 99000, method: 'mpesa', phone: '254700000001' })).toEqual({ status: 'confirmed' });
    const b2c = f.seen.find((s) => s.url.includes('b2c'))!.body;
    expect(b2c).toMatchObject({ OriginatorConversationID: refundId('ws_1'), Amount: 990, PartyB: '254700000001' });
    expect(refundId('ws_1')).toBe(refundId('ws_1'));
    expect(await r.refund({ providerTxId: 'ws_2', amount: 99000, method: 'mpesa' })).toEqual({ status: 'failed' }); // no number to send it to
    expect(await r.refund({ providerTxId: 'CARDX', amount: 5000, method: 'card' })).toEqual({ status: 'confirmed' });
    await expect(r.refund({ providerTxId: 'a', amount: 1, method: 'airtel' })).rejects.toMatchObject({ kind: 'not_configured' });
    await expect(r.refund({ providerTxId: 'a', amount: 1, method: 'cash' })).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('turns async results into outcomes: B2C for payouts, rf_ for refunds, Paystack transfers', () => {
    const m = new MpesaDaraja(mcfg, fakeFetch({}).fetch, () => T0);
    const r = new RoutedProvider({ mpesa: m });
    const res = (id: string, code = 0) => JSON.stringify({ Result: { ResultCode: code, OriginatorConversationID: id } });
    expect(r.parseOutcome({ 'x-psp': 'mpesa' }, res('po_9'))).toEqual({ kind: 'payout', id: 'po_9', ok: true });
    expect(r.parseOutcome({ 'x-psp': 'mpesa' }, res(refundId('ws_1'), 2001))).toEqual({ kind: 'refund', id: refundId('ws_1'), ok: false });
    expect(r.parseOutcome({}, res('po_9'))).toBeNull();
  });

  it('walletBalance sums Paystack and Airtel live and M-Pesa as last reported', async () => {
    const f = fakeFetch({
      ...tokens,
      'POST /auth/oauth2/token': { json: { access_token: 'A', expires_in: 3600 } },
      'GET /standard/v1/users/balance': { json: { data: { balance: '10.00' } } },
      'GET /balance': { json: { status: true, data: [{ currency: 'KES', balance: 5000 }] } },
      'POST /mpesa/accountbalance': { json: { ResponseCode: '0' } },
    });
    const m = new MpesaDaraja(mcfg, f.fetch, () => T0);
    const r = new RoutedProvider({ mpesa: m, airtel: new AirtelMoney({ env: 'sandbox', clientId: 'a', clientSecret: 'b', country: 'KE', currency: 'KES', callbackBase: 'https://x.test', callbackToken: 't' }, f.fetch, () => T0), paystack: new Paystack({ secretKey: 'test-key', fallbackEmailDomain: 'x.test', currency: 'KES', bankRecipientType: 'kepss', baseUrl: 'https://api.paystack.co' }, f.fetch) });
    expect(await r.walletBalance()).toBe(1000 + 5000);
    m.parseResult(JSON.stringify({ Result: { ResultCode: 0, ResultParameters: { ResultParameter: [{ Key: 'AccountBalance', Value: 'Working Account|KES|20.00|20.00|0.00|0.00' }] } } }));
    expect(await r.walletBalance()).toBe(1000 + 5000 + 2000);
  });
});

describe('createProviderFromEnv', () => {
  const live = { PSP_MODE: 'live', PAYSTACK_SECRET_KEY: 'test-key' };
  it('is the simulator unless PSP_MODE=live', () => {
    expect(createProviderFromEnv({})).toBeInstanceOf(MockProvider);
    expect(createProviderFromEnv({ PSP_MODE: 'mock', PAYSTACK_SECRET_KEY: 'test-key' }).kind).toBe('mock');
  });
  it('builds the router from whatever is configured, and refuses live with nothing configured', () => {
    const p = createProviderFromEnv(live, fakeFetch({}).fetch) as RoutedProvider;
    expect(p.kind).toBe('live');
    expect(Object.keys(p.adapters).filter((k) => (p.adapters as any)[k])).toEqual(['paystack']);
    expect(() => createProviderFromEnv({ PSP_MODE: 'live' })).toThrow(/no payment provider is configured/);
  });
});
