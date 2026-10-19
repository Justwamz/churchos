import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AirtelMoney, type AirtelConfig } from './airtel';
import { fakeFetch } from './fakefetch';
import { Paystack, paystackConfigFromEnv, type PaystackConfig } from './paystack';

const T0 = new Date('2026-10-19T09:30:05Z');
const acfg: AirtelConfig = { env: 'sandbox', clientId: 'test-id', clientSecret: 'test-secret', country: 'KE', currency: 'KES', callbackBase: 'https://api.example.test', callbackToken: 'atok' };
const atok = { json: { access_token: 'AIR1', expires_in: 3600, token_type: 'bearer' } };

describe('Airtel Money', () => {
  it('signs in, then sends the USSD push with country and currency headers and a number without 254', async () => {
    const { fetch, seen } = fakeFetch({
      'POST /auth/oauth2/token': atok,
      'POST /merchant/v2/payments/': { json: { data: { transaction: { id: 'x', status: 'Success' } }, status: { code: '200', message: 'Success', result_code: 'ESB000010', success: true } } },
    });
    const a = new AirtelMoney(acfg, fetch, () => T0);
    const r = await a.initiateStkPush({ phone: '0733000001', amount: 120050, reference: 'GRC001#TITHE' });
    expect(r.providerTxId).toMatch(/^ATL[0-9A-F]{16}$/);
    expect(seen[0].url).toBe('https://openapiuat.airtel.africa/auth/oauth2/token');
    expect(seen[0].body).toEqual({ client_id: 'test-id', client_secret: 'test-secret', grant_type: 'client_credentials' });
    expect(seen[1].headers).toMatchObject({ authorization: 'Bearer AIR1', 'x-country': 'KE', 'x-currency': 'KES' });
    expect(seen[1].body).toEqual({
      reference: 'GRC001#TITHE',
      subscriber: { country: 'KE', currency: 'KES', msisdn: '733000001' },
      transaction: { amount: 1200.5, country: 'KE', currency: 'KES', id: r.providerTxId },
    });
  });

  it('caches the token, and rejects an unsuccessful or unreachable answer with a typed error', async () => {
    const { fetch, seen } = fakeFetch({ 'POST /auth/oauth2/token': atok, 'POST /merchant/v2/payments/': { status: 400, json: { status: { success: false, message: 'bad' } } } });
    const a = new AirtelMoney(acfg, fetch, () => T0);
    await expect(a.initiateStkPush({ phone: '254733000001', amount: 10000, reference: 'A#B' })).rejects.toMatchObject({ kind: 'rejected' });
    await expect(a.initiateStkPush({ phone: '254733000001', amount: 10000, reference: 'A#B' })).rejects.toMatchObject({ kind: 'rejected' });
    expect(seen.filter((s) => s.url.includes('oauth2')).length).toBe(1);
    const noauth = fakeFetch({ 'POST /auth/oauth2/token': { status: 401, json: {} } });
    await expect(new AirtelMoney(acfg, noauth.fetch).balance()).rejects.toMatchObject({ kind: 'auth' });
  });

  it('refunds by looking up Airtel\'s own transaction id first, and reads the balance', async () => {
    const { fetch, seen } = fakeFetch({
      'POST /auth/oauth2/token': atok,
      'GET /standard/v1/payments/ATL1': { json: { data: { transaction: { airtel_money_id: 'MP1', id: 'ATL1', status: 'TS', message: 'ok' } }, status: { success: true } } },
      'POST /standard/v1/payments/refund': { json: { status: { success: true } } },
      'GET /standard/v1/users/balance': { json: { data: { balance: '1234.50', currency: 'KES' }, status: { success: true } } },
    });
    const a = new AirtelMoney(acfg, fetch, () => T0);
    expect(await a.refund('ATL1')).toEqual({ status: 'confirmed' });
    expect(seen.find((s) => s.url.endsWith('/refund'))!.body).toEqual({ transaction: { airtel_money_id: 'MP1' } });
    expect(await a.balance()).toBe(123450);
  });

  describe('callbacks', () => {
    const body = (extra: any = {}, code = 'TS') => JSON.stringify({ transaction: { id: 'ATL1', message: 'Paid', status_code: code, airtel_money_id: 'MP1' }, ...extra });
    it('only a successful callback becomes a payment, and it has no amount or phone yet', () => {
      const a = new AirtelMoney(acfg, fakeFetch({}).fetch, () => T0);
      expect(a.parse(body())).toMatchObject({ providerTxId: 'ATL1', method: 'airtel', amount: 0, phone: '' });
      expect(a.parse(body({}, 'TF'))).toBeNull();
      expect(a.parse(body({}, 'TA'))).toBeNull();
      expect(a.parse('nope')).toBeNull();
    });
    it('checks the path token, the optional IP list and the optional HMAC hash (tampering fails)', () => {
      const plain = new AirtelMoney(acfg, fakeFetch({}).fetch);
      expect(plain.verify({}, body(), { token: 'atok' })).toBe(true);
      expect(plain.verify({}, body(), { token: 'nope' })).toBe(false);
      const signed = new AirtelMoney({ ...acfg, webhookKey: 'test-webhook-key' }, fakeFetch({}).fetch);
      const hash = createHmac('sha256', 'test-webhook-key').update(JSON.stringify({ transaction: { id: 'ATL1', message: 'Paid', status_code: 'TS' } })).digest('base64');
      expect(signed.verify({}, body({ hash }), { token: 'atok' })).toBe(true);
      expect(signed.verify({}, body({ hash: 'AAAA' }), { token: 'atok' })).toBe(false);
      expect(signed.verify({}, body({}), { token: 'atok' })).toBe(false);
      expect(signed.verify({}, body({ hash }).replace('Paid', 'Paid more'), { token: 'atok' })).toBe(false);
    });
  });
});

const pcfg: PaystackConfig = { secretKey: 'test-key', fallbackEmailDomain: 'pay.example.test', currency: 'KES', bankRecipientType: 'kepss', baseUrl: 'https://api.paystack.co' };
const sign = (raw: string, k = 'test-key') => createHmac('sha512', k).update(raw).digest('hex');

describe('Paystack', () => {
  it('starts a hosted checkout in the smallest unit, with a fallback email and the church reference in metadata', async () => {
    const { fetch, seen } = fakeFetch({ 'POST /transaction/initialize': { json: { status: true, message: 'Authorization URL created', data: { authorization_url: 'https://checkout.paystack.com/abc', access_code: 'abc', reference: 'CARDX' } } } });
    const p = new Paystack(pcfg, fetch, () => T0);
    const r = await p.initiateCardCheckout({ amount: 250000, reference: 'GRC001#TITHE', phone: '0700000001' });
    expect(r).toEqual({ providerTxId: 'CARDX', checkoutUrl: 'https://checkout.paystack.com/abc' });
    expect(seen[0].headers.authorization).toBe('Bearer test-key');
    expect(seen[0].body).toMatchObject({ email: '0700000001@pay.example.test', amount: 250000, currency: 'KES', channels: ['card'], metadata: { reference: 'GRC001#TITHE', phone: '0700000001' } });
    expect(seen[0].body.reference).toMatch(/^CARD[0-9A-F]{12}$/);
    expect(p.emailFor('0700000001', 'jane@example.test')).toBe('jane@example.test');
    expect(p.emailFor(undefined, 'not-an-email')).toBe('giver@pay.example.test');
  });

  it('fails with typed errors for refusals and a bad key', async () => {
    const no = fakeFetch({ 'POST /transaction/initialize': { status: 400, json: { status: false, message: 'Invalid Amount Sent' } } });
    await expect(new Paystack(pcfg, no.fetch).initiateCardCheckout({ amount: 1, reference: 'A#B' })).rejects.toMatchObject({ kind: 'rejected' });
    const bad = fakeFetch({ 'GET /balance': { status: 401, json: { status: false } } });
    await expect(new Paystack(pcfg, bad.fetch).balance()).rejects.toMatchObject({ kind: 'auth' });
  });

  it('verifies x-paystack-signature over the raw body (HMAC-SHA512), including tamper and wrong key', () => {
    const p = new Paystack(pcfg, fakeFetch({}).fetch);
    const raw = '{"event":"charge.success","data":{"reference":"CARDX","amount":250000}}';
    expect(p.verify({ 'x-paystack-signature': sign(raw) }, raw)).toBe(true);
    expect(p.verify({ 'x-paystack-signature': sign(raw) }, raw + ' ')).toBe(false);
    expect(p.verify({ 'x-paystack-signature': sign(raw, 'other-key') }, raw)).toBe(false);
    expect(p.verify({}, raw)).toBe(false);
    expect(p.verify({ 'x-paystack-signature': 'abc' }, raw)).toBe(false);
    const ip = new Paystack({ ...pcfg, allowedIps: ['52.31.139.75'] }, fakeFetch({}).fetch);
    expect(ip.verify({ 'x-paystack-signature': sign(raw) }, raw, { ip: '203.0.113.5' })).toBe(false);
    expect(ip.verify({ 'x-paystack-signature': sign(raw) }, raw, { ip: '52.31.139.75' })).toBe(true);
  });

  it('parses charge.success into a payment and ignores everything else', () => {
    const p = new Paystack(pcfg, fakeFetch({}).fetch, () => T0);
    const ok = JSON.stringify({ event: 'charge.success', data: { id: 1, status: 'success', reference: 'CARDX', amount: 250000, currency: 'KES', paid_at: '2026-10-19T09:31:00.000Z', channel: 'card', customer: { email: 'x@example.test' }, metadata: { reference: 'GRC001#TITHE', phone: '254700000001' } } });
    expect(p.parse(ok)).toEqual({ providerTxId: 'CARDX', method: 'card', amount: 250000, reference: 'GRC001#TITHE', phone: '254700000001', occurredAt: '2026-10-19T09:31:00.000Z' });
    expect(p.parse(ok.replace('"KES"', '"USD"'))).toBeNull();
    expect(p.parse(JSON.stringify({ event: 'charge.failed', data: { reference: 'CARDX' } }))).toBeNull();
    expect(p.parse(JSON.stringify({ event: 'transfer.success', data: { reference: 'x' } }))).toBeNull();
  });

  it('refunds with the amount in the smallest unit and reads the KES balance', async () => {
    const { fetch, seen } = fakeFetch({
      'POST /refund': { json: { status: true, data: { status: 'pending' } } },
      'GET /balance': { json: { status: true, data: [{ currency: 'NGN', balance: 5 }, { currency: 'KES', balance: 987600 }] } },
      'GET /transaction/verify/CARDX': { json: { status: true, data: { status: 'success', amount: 250000 } } },
    });
    const p = new Paystack(pcfg, fetch);
    expect(await p.refund('CARDX', 240000)).toEqual({ status: 'confirmed' });
    expect(seen[0].body).toEqual({ transaction: 'CARDX', amount: 240000, currency: 'KES' });
    expect(await p.balance()).toBe(987600);
    expect(await p.verifyTransaction('CARDX')).toEqual({ paid: true, amount: 250000 });
  });

  it('bank transfer: recipient first, then the transfer with our payout id; pending until the webhook', async () => {
    const mk = (status: string) => fakeFetch({
      'POST /transferrecipient': { json: { status: true, data: { recipient_code: 'RCP_test' } } },
      'POST /transfer': { json: { status: true, data: { status, reference: 'x' } } },
    });
    const a = mk('pending');
    const p = new Paystack(pcfg, a.fetch);
    const dest = { type: 'bank' as const, bank: '63', accountNumber: '0000000001', accountName: 'Test Church' };
    expect(await p.transfer({ payoutId: 'po_abc123def456', destination: dest, amount: 500000 })).toEqual({ status: 'pending' });
    expect(a.seen[0].body).toMatchObject({ type: 'kepss', name: 'Test Church', account_number: '0000000001', bank_code: '63', currency: 'KES' });
    expect(a.seen[1].body).toMatchObject({ source: 'balance', amount: 500000, recipient: 'RCP_test', reference: 'churchos-po_abc123def456' });
    expect(await new Paystack(pcfg, mk('success').fetch).transfer({ payoutId: 'po_abc123def456', destination: dest, amount: 1 })).toEqual({ status: 'confirmed' });
    expect(await new Paystack(pcfg, mk('otp').fetch).transfer({ payoutId: 'po_abc123def456', destination: dest, amount: 1 })).toEqual({ status: 'failed' });
    await expect(p.transfer({ payoutId: 'po_x', destination: { type: 'bank' }, amount: 1 })).rejects.toMatchObject({ kind: 'rejected' });
  });

  it('reads transfer and refund outcomes keyed by our ids', () => {
    const p = new Paystack(pcfg, fakeFetch({}).fetch);
    const ev = (event: string, data: any) => JSON.stringify({ event, data });
    expect(p.parseOutcome(ev('transfer.success', { reference: 'churchos-po_abc123def456' }))).toEqual({ kind: 'transfer', id: 'po_abc123def456', ok: true });
    expect(p.parseOutcome(ev('transfer.failed', { reference: 'churchos-po_abc123def456' }))).toEqual({ kind: 'transfer', id: 'po_abc123def456', ok: false });
    expect(p.parseOutcome(ev('transfer.reversed', { reference: 'churchos-po_abc123def456' }))?.ok).toBe(false);
    expect(p.parseOutcome(ev('refund.failed', { transaction_reference: 'CARDX' }))).toEqual({ kind: 'refund', id: 'CARDX', ok: false });
    expect(p.parseOutcome(ev('charge.success', { reference: 'CARDX' }))).toBeNull();
  });

  it('env: off without a key, documented defaults with one', () => {
    expect(paystackConfigFromEnv({})).toBeNull();
    const c = paystackConfigFromEnv({ PAYSTACK_SECRET_KEY: 'test-key' })!;
    expect(c).toMatchObject({ currency: 'KES', fallbackEmailDomain: 'example.com', bankRecipientType: 'kepss' });
    expect(paystackConfigFromEnv({ PAYSTACK_SECRET_KEY: 'k', PAYSTACK_FALLBACK_EMAIL_DOMAIN: 'church.test' })!.fallbackEmailDomain).toBe('church.test');
  });
});
