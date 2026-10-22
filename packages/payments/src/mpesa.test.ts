import { createPrivateKey, privateDecrypt, constants } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fakeFetch } from './fakefetch';
import { MpesaDaraja, darajaTimestamp, mpesaConfigFromEnv, type MpesaConfig } from './mpesa';
import { PspError } from './http';

import { makeTestCert } from './test-cert';

// A fresh throwaway key and certificate for every run: no private key is committed.
const { certPem: cert, keyPem: key } = makeTestCert();
const cfg: MpesaConfig = {
  env: 'sandbox', consumerKey: 'test-key', consumerSecret: 'test-secret', shortcode: '174379', passkey: 'test-passkey',
  callbackBase: 'https://api.example.test', callbackToken: 'tok-123', initiatorName: 'testapi', initiatorPassword: 'test-pass', certificatePem: cert,
};
const T0 = new Date('2026-10-19T09:30:05Z'); // 12:30:05 in Nairobi
const tokenReply = { json: { access_token: 'AT1', expires_in: '3599' } };
const stkOk = { json: { MerchantRequestID: 'm1', CheckoutRequestID: 'ws_CO_TEST1', ResponseCode: '0', ResponseDescription: 'Success', CustomerMessage: 'Success' } };
const stkReq = { phone: '254700000001', amount: 10000, reference: 'A#B' };

describe('Daraja STK push', () => {
  it('builds the documented request: timestamp, password, whole-shilling amount, 254 phone, callback URL with the secret token', async () => {
    const { fetch, seen } = fakeFetch({ 'GET /oauth/v1/generate': tokenReply, 'POST /mpesa/stkpush/v1/processrequest': stkOk });
    const m = new MpesaDaraja(cfg, fetch, () => T0);
    const r = await m.initiateStkPush({ phone: '0700000001', amount: 150000, reference: 'GRC001#TITHE' });
    expect(r.providerTxId).toBe('ws_CO_TEST1');
    const [tok, stk] = seen;
    expect(tok.url).toBe('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials');
    expect(tok.headers.authorization).toBe(`Basic ${Buffer.from('test-key:test-secret').toString('base64')}`);
    expect(stk.headers.authorization).toBe('Bearer AT1');
    expect(darajaTimestamp(T0)).toBe('20261019123005');
    expect(stk.body).toMatchObject({
      BusinessShortCode: '174379', Timestamp: '20261019123005', TransactionType: 'CustomerPayBillOnline', Amount: 1500,
      PartyA: '254700000001', PartyB: '174379', PhoneNumber: '254700000001', AccountReference: 'GRC001#TITHE',
      CallBackURL: 'https://api.example.test/webhooks/daraja/tok-123/stk',
    });
    expect(stk.body.Password).toBe(Buffer.from('174379test-passkey20261019123005').toString('base64'));
  });

  it('caches the token until a minute before it expires, then refreshes', async () => {
    let now = T0.getTime();
    let n = 0;
    const { fetch, seen } = fakeFetch({ 'GET /oauth/v1/generate': () => ({ json: { access_token: `AT${++n}`, expires_in: '3599' } }), 'POST /mpesa/stkpush': stkOk });
    const m = new MpesaDaraja(cfg, fetch, () => new Date(now));
    await m.initiateStkPush(stkReq);
    await m.initiateStkPush(stkReq);
    expect(seen.filter((s) => s.url.includes('oauth')).length).toBe(1);
    now += 3600_000;
    await m.initiateStkPush(stkReq);
    expect(seen.filter((s) => s.url.includes('oauth')).length).toBe(2);
    expect(seen.at(-1)!.headers.authorization).toBe('Bearer AT2');
  });

  it('refreshes once when Daraja answers 401 to a stale token', async () => {
    let n = 0;
    const { fetch, seen } = fakeFetch({
      'GET /oauth/v1/generate': () => ({ json: { access_token: `AT${++n}`, expires_in: '3599' } }),
      'POST /mpesa/stkpush': (r) => (r.headers.authorization === 'Bearer AT1' ? { status: 401, json: { errorCode: '404.001.03' } } : stkOk),
    });
    const m = new MpesaDaraja(cfg, fetch, () => T0);
    expect((await m.initiateStkPush(stkReq)).providerTxId).toBe('ws_CO_TEST1');
    expect(seen.length).toBe(4);
  });

  it('maps failures to typed errors', async () => {
    const bad = fakeFetch({ 'GET /oauth/v1/generate': { status: 400, json: {} } });
    await expect(new MpesaDaraja(cfg, bad.fetch, () => T0).initiateStkPush(stkReq)).rejects.toMatchObject({ kind: 'auth' });
    const rej = fakeFetch({ 'GET /oauth': tokenReply, 'POST /mpesa/stkpush': { status: 400, json: { requestId: 'x', errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid PhoneNumber' } } });
    await expect(new MpesaDaraja(cfg, rej.fetch, () => T0).initiateStkPush(stkReq)).rejects.toMatchObject({ kind: 'rejected' });
    const down = (async () => { throw new TypeError('fetch failed'); }) as any;
    const err = await new MpesaDaraja(cfg, down, () => T0).initiateStkPush(stkReq).catch((e) => e);
    expect(err).toBeInstanceOf(PspError);
    expect(err.kind).toBe('network');
    expect(err.message).not.toMatch(/2547/);
    await expect(new MpesaDaraja(cfg, fakeFetch({}).fetch, () => T0).initiateStkPush({ ...stkReq, phone: '12345' })).rejects.toMatchObject({ kind: 'rejected' });
    await expect(new MpesaDaraja(cfg, fakeFetch({}).fetch, () => T0).initiateStkPush({ ...stkReq, amount: 10050 })).rejects.toMatchObject({ kind: 'rejected' });
  });
});

describe('Daraja callbacks', () => {
  const m = new MpesaDaraja(cfg, fakeFetch({}).fetch, () => T0);
  const stk = (code: number, items = true) => JSON.stringify({ Body: { stkCallback: {
    MerchantRequestID: 'm1', CheckoutRequestID: 'ws_CO_TEST1', ResultCode: code, ResultDesc: code === 0 ? 'The service request is processed successfully.' : 'Request cancelled by user',
    ...(items ? { CallbackMetadata: { Item: [
      { Name: 'Amount', Value: 1500.0 }, { Name: 'MpesaReceiptNumber', Value: 'TEST123ABC' }, { Name: 'TransactionDate', Value: 20261019123045 }, { Name: 'PhoneNumber', Value: 254700000001 },
    ] } } : {}),
  } } });

  it('parses a successful STK callback (no reference in it) and ignores cancelled ones', () => {
    expect(m.parse(stk(0))).toEqual({ providerTxId: 'ws_CO_TEST1', method: 'mpesa', amount: 150000, reference: '', phone: '254700000001', occurredAt: '2026-10-19T09:30:45.000Z' });
    expect(m.parse(stk(1032, false))).toBeNull();
    expect(m.parse('not json')).toBeNull();
    expect(m.parse('{}')).toBeNull();
  });

  it('parses a C2B confirmation with its account reference', () => {
    const p = m.parse(JSON.stringify({ TransactionType: 'Pay Bill', TransID: 'TEST456DEF', TransTime: '20261019123000', TransAmount: '200.00', BusinessShortCode: '174379', BillRefNumber: 'GRC001#TITHE', MSISDN: 'hashed-value' }));
    expect(p).toMatchObject({ providerTxId: 'TEST456DEF', amount: 20000, reference: 'GRC001#TITHE', method: 'mpesa' });
  });

  it('checks the path token in constant time, and the source IP when an allowlist is set', () => {
    expect(m.verify({}, '', { token: 'tok-123' })).toBe(true);
    expect(m.verify({}, '', { token: 'tok-124' })).toBe(false);
    expect(m.verify({}, '', { token: 'tok-12' })).toBe(false);
    expect(m.verify({}, '')).toBe(false);
    const ip = new MpesaDaraja({ ...cfg, allowedIps: ['196.201.214.200'] }, fakeFetch({}).fetch);
    expect(ip.verify({}, '', { token: 'tok-123', ip: '196.201.214.200' })).toBe(true);
    expect(ip.verify({}, '', { token: 'tok-123', ip: '203.0.113.9' })).toBe(false);
    expect(ip.verify({}, '', { token: 'tok-123' })).toBe(false);
  });

  it('reads B2C results keyed by our id, and remembers a balance report', () => {
    const ok = m.parseResult(JSON.stringify({ Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: 'po_abc', ConversationID: 'AG_1', TransactionID: 'RCPT1' } }));
    expect(ok).toEqual({ id: 'po_abc', ok: true, receipt: 'RCPT1' });
    expect(m.parseResult(JSON.stringify({ Result: { ResultCode: 2001, OriginatorConversationID: 'po_abc' } }))).toEqual({ id: 'po_abc', ok: false, receipt: undefined });
    expect(m.lastBalance).toBeNull();
    const bal = m.parseResult(JSON.stringify({ Result: { ResultCode: 0, ResultParameters: { ResultParameter: [{ Key: 'AccountBalance', Value: 'Working Account|KES|700000.00|700000.00|0.00|0.00&Utility Account|KES|300.50|300.50|0.00|0.00&Charges Paid Account|KES|0.00|0.00|0.00|0.00' }] } } }));
    expect(bal).toBeNull();
    expect(m.lastBalance).toEqual({ cents: 70030050, at: T0.toISOString() });
  });
});

describe('Daraja B2C, reversal, balance, C2B registration', () => {
  it('B2C: encrypts the initiator password with the certificate and uses our payout id as the idempotency key', async () => {
    const { fetch, seen } = fakeFetch({ 'GET /oauth': tokenReply, 'POST /mpesa/b2c/v3/paymentrequest': { json: { ConversationID: 'AG_1', OriginatorConversationID: 'po_abc', ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' } } });
    const m = new MpesaDaraja(cfg, fetch, () => T0);
    expect(await m.b2c({ id: 'po_abc', phone: '0700000001', amount: 250050, remarks: 'Settlement' })).toEqual({ status: 'accepted' });
    const b = seen[1].body;
    expect(b).toMatchObject({ OriginatorConversationID: 'po_abc', InitiatorName: 'testapi', CommandID: 'BusinessPayment', Amount: 2500.5, PartyA: '174379', PartyB: '254700000001',
      ResultURL: 'https://api.example.test/webhooks/daraja/tok-123/result', QueueTimeOutURL: 'https://api.example.test/webhooks/daraja/tok-123/result' });
    const plain = privateDecrypt({ key: createPrivateKey(key), padding: constants.RSA_PKCS1_PADDING }, Buffer.from(b.SecurityCredential, 'base64')).toString();
    expect(plain).toBe('test-pass');
  });

  it('B2C refused by Daraja is failed; no initiator means not switched on', async () => {
    const { fetch } = fakeFetch({ 'GET /oauth': tokenReply, 'POST /mpesa/b2c': { status: 400, json: { errorCode: '500.001.1001', errorMessage: 'x' } } });
    expect(await new MpesaDaraja(cfg, fetch, () => T0).b2c({ id: 'po_x', phone: '254700000001', amount: 10000, remarks: 'r' })).toEqual({ status: 'failed' });
    await expect(new MpesaDaraja({ ...cfg, initiatorName: undefined }, fetch).b2c({ id: 'po_x', phone: '254700000001', amount: 10000, remarks: 'r' })).rejects.toMatchObject({ kind: 'not_configured' });
  });

  it('reversal, balance and C2B registration request shapes', async () => {
    const { fetch, seen } = fakeFetch({
      'GET /oauth': tokenReply,
      'POST /mpesa/reversal': { json: { ResponseCode: '0' } },
      'POST /mpesa/accountbalance': { json: { ResponseCode: '0' } },
      'POST /mpesa/c2b/v2/registerurl': { json: { ResponseCode: '0', ResponseDescription: 'Success' } },
    });
    const m = new MpesaDaraja({ ...cfg, securityCredential: 'PRE-ENCRYPTED', certificatePem: undefined, initiatorPassword: undefined }, fetch, () => T0);
    expect(await m.reverse({ receipt: 'TEST123ABC', amount: 150000, id: 'rf_1' })).toEqual({ status: 'accepted' });
    await m.requestBalance();
    await m.registerC2bUrls();
    expect(seen[1].body).toMatchObject({ CommandID: 'TransactionReversal', TransactionID: 'TEST123ABC', Amount: 1500, ReceiverParty: '174379', RecieverIdentifierType: '11', SecurityCredential: 'PRE-ENCRYPTED' });
    expect(seen[2].body).toMatchObject({ CommandID: 'AccountBalance', PartyA: '174379', IdentifierType: '4' });
    expect(seen[3].body).toMatchObject({ ShortCode: '174379', ResponseType: 'Completed', ConfirmationURL: 'https://api.example.test/webhooks/daraja/tok-123/c2b', ValidationURL: 'https://api.example.test/webhooks/daraja/tok-123/c2b-validate' });
  });
});

describe('Daraja config from env', () => {
  it('is null unless everything needed to collect is present, and defaults to sandbox', () => {
    expect(mpesaConfigFromEnv({})).toBeNull();
    const base = { MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's', MPESA_SHORTCODE: '1', MPESA_PASSKEY: 'p', MPESA_CALLBACK_BASE: 'https://x.test/', MPESA_CALLBACK_TOKEN: 't' };
    const c = mpesaConfigFromEnv(base)!;
    expect(c.env).toBe('sandbox');
    expect(c.callbackBase).toBe('https://x.test');
    expect(mpesaConfigFromEnv({ ...base, MPESA_ENV: 'production' })!.env).toBe('production');
  });
});
