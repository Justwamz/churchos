import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MockEmailProvider, MockMessagingProvider, OnfonSms, ResendEmail, createEmailFromEnv, createMessagingFromEnv, idempotencyKey,
  isValidSenderId, normalizePhone, parseOnfonDlr, parseResendEvent, smsSegments, verifyOnfonCallbackSecret, verifyResendWebhook,
  type FetchLike,
} from './index';

type Call = { url: string; init: any };
function fakeFetch(responses: (((c: Call) => any) | any)[]) {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => {
    const c = { url, init };
    calls.push(c);
    let r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (typeof r === 'function') r = await r(c);
    const status = r.status ?? 200;
    const body = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    const hdrs = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return { status, ok: status >= 200 && status < 300, headers: { get: (n: string) => hdrs[n.toLowerCase()] ?? null }, text: async () => body };
  };
  return { f, calls };
}

const cfg = { apiKey: 'test-key', clientId: 'test-client', accessKey: 'test-access', defaultSenderId: 'CHURCH' };
const okRows = (nums: string[]) => ({ body: { ErrorCode: 0, ErrorDescription: 'Success', Data: nums.map((n, i) => ({ MessageErrorCode: 0, MessageErrorDescription: 'Success', MobileNumber: n, MessageId: `id-${n}-${i}` })) } });

describe('phone numbers and sender ids', () => {
  it('normalises Kenyan formats', () => {
    for (const s of ['0712 345 678', '+254 712 345 678', '254712345678', '712345678', '0712-345-678']) expect(normalizePhone(s)).toBe('254712345678');
    expect(normalizePhone('0112345678')).toBe('254112345678');
    expect(normalizePhone('+254112345678')).toBe('254112345678');
  });
  it('rejects junk', () => {
    for (const s of ['', 'abc', '0212345678', '25471234567', '07123', '254212345678']) expect(normalizePhone(s)).toBeNull();
  });
  it('sender id rules', () => {
    expect(isValidSenderId('GRACECHURCH')).toBe(true);
    expect(isValidSenderId('GRACECHURCH1')).toBe(false);
    expect(isValidSenderId('Grace Church')).toBe(false);
    expect(isValidSenderId('')).toBe(false);
  });
});

describe('smsSegments', () => {
  it('counts GSM-7 and UCS-2', () => {
    expect(smsSegments('a'.repeat(160))).toEqual({ encoding: 'GSM-7', length: 160, segments: 1 });
    expect(smsSegments('a'.repeat(161)).segments).toBe(2);
    expect(smsSegments('a'.repeat(307)).segments).toBe(3);
    expect(smsSegments('{').length).toBe(2);
    expect(smsSegments('a'.repeat(70) + '’')).toMatchObject({ encoding: 'UCS-2', segments: 2 });
    expect(smsSegments('’'.repeat(70)).segments).toBe(1);
  });
});

describe('OnfonSms', () => {
  it('sends the documented request and maps results in order', async () => {
    const { f, calls } = fakeFetch([okRows(['254700000001', '254700000002'])]);
    const sms = new OnfonSms(cfg, f);
    const r = await sms.send('sms', [{ to: '0700000001', body: 'Hello' }, { to: '+254 700 000 002', body: 'Hi', from: 'GRACE' }]);
    // two sender ids so two requests
    expect(calls.length).toBe(2);
    expect(calls[0].url).toBe('https://api.onfonmedia.co.ke/v1/sms/SendBulkSMS');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.AccessKey).toBe('test-access');
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
    const b = JSON.parse(calls[0].init.body);
    expect(b).toEqual({ SenderId: 'CHURCH', MessageParameters: [{ Number: '254700000001', Text: 'Hello' }], ApiKey: 'test-key', ClientId: 'test-client' });
    expect(JSON.parse(calls[1].init.body).SenderId).toBe('GRACE');
    expect(r.map((x) => x.status)).toEqual(['sent', 'sent']);
  });

  it('keeps order across batch boundaries', async () => {
    const { f, calls } = fakeFetch([(c: Call) => okRows(JSON.parse(c.init.body).MessageParameters.map((m: any) => m.Number))]);
    const sms = new OnfonSms({ ...cfg, batchSize: 3 }, f);
    const batch = Array.from({ length: 7 }, (_, i) => ({ to: `25470000000${i}`, body: 'x' }));
    const r = await sms.send('sms', batch);
    expect(calls.map((c) => JSON.parse(c.init.body).MessageParameters.length)).toEqual([3, 3, 1]);
    r.forEach((x, i) => expect(x.providerMessageId).toContain(`25470000000${i}`));
  });

  it('exactly the batch size is one request', async () => {
    const { f, calls } = fakeFetch([(c: Call) => okRows(JSON.parse(c.init.body).MessageParameters.map((m: any) => m.Number))]);
    await new OnfonSms({ ...cfg, batchSize: 2 }, f).send('sms', [{ to: '254700000001', body: 'a' }, { to: '254700000002', body: 'b' }]);
    expect(calls.length).toBe(1);
  });

  it('reports partial failure and invalid inputs per message', async () => {
    const { f, calls } = fakeFetch([{ body: { ErrorCode: 0, Data: [{ MessageErrorCode: 0, MobileNumber: '254700000001', MessageId: 'A1' }, { MessageErrorCode: 13, MessageErrorDescription: 'Invalid MobileNumber', MobileNumber: '254700000003' }] } }]);
    const r = await new OnfonSms(cfg, f).send('sms', [
      { to: '0700000001', body: 'a' }, { to: 'nope', body: 'b' }, { to: '0700000003', body: 'c' }, { to: '0700000004', body: '  ' }, { to: '0700000005', body: 'd', from: 'Too Long Sender Id' },
    ]);
    expect(calls.length).toBe(1);
    expect(r[0]).toEqual({ status: 'sent', providerMessageId: 'A1' });
    expect(r[1].error).toMatch(/invalid phone/);
    expect(r[2].status).toBe('failed');
    expect(r[2].error).toMatch(/13/);
    expect(r[3].error).toMatch(/empty/);
    expect(r[4].error).toMatch(/sender id/);
  });

  it('refuses unapproved sender ids when a list is set', async () => {
    const { f, calls } = fakeFetch([okRows(['254700000001'])]);
    const r = await new OnfonSms({ ...cfg, approvedSenderIds: ['CHURCH'] }, f).send('sms', [{ to: '0700000001', body: 'a', from: 'OTHER' }]);
    expect(r[0].error).toMatch(/not approved/);
    expect(calls.length).toBe(0);
  });

  it('whole-request errors fail every message without throwing', async () => {
    for (const resp of [{ status: 500, body: 'oops' }, { status: 401, body: { ErrorDescription: 'bad key' } }, { body: { ErrorCode: 7, ErrorDescription: 'Invalid ApiKey' } }, { body: 'not json' }]) {
      const { f } = fakeFetch([resp]);
      const r = await new OnfonSms(cfg, f).send('sms', [{ to: '0700000001', body: 'a' }, { to: '0700000002', body: 'b' }]);
      expect(r.every((x) => x.status === 'failed' && x.error)).toBe(true);
    }
  });

  it('handles network errors and timeouts without leaking numbers', async () => {
    const boom: FetchLike = async () => { throw new Error('connect ECONNRESET 254700000001'); };
    const r1 = await new OnfonSms(cfg, boom).send('sms', [{ to: '0700000001', body: 'a' }]);
    expect(r1[0].status).toBe('failed');
    expect(r1[0].error).not.toContain('254700000001');
    const hang: FetchLike = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const r2 = await new OnfonSms({ ...cfg, timeoutMs: 20 }, hang).send('sms', [{ to: '0700000001', body: 'a' }]);
    expect(r2[0].error).toMatch(/timed out/);
  });

  it('does not do WhatsApp', async () => {
    const { f, calls } = fakeFetch([{}]);
    const r = await new OnfonSms(cfg, f).send('whatsapp', [{ to: '0700000001', body: 'a' }]);
    expect(r[0].error).toMatch(/WhatsApp is not provided/);
    expect(calls.length).toBe(0);
  });

  it('honours custom base url, path and header name', async () => {
    const { f, calls } = fakeFetch([okRows(['254700000001'])]);
    await new OnfonSms({ ...cfg, baseUrl: 'https://sms.example.org/api/', sendPath: '/send', accessKeyHeader: 'X-Access' }, f).send('sms', [{ to: '0700000001', body: 'a' }]);
    expect(calls[0].url).toBe('https://sms.example.org/api/send');
    expect(calls[0].init.headers['X-Access']).toBe('test-access');
  });
});

describe('Onfon delivery reports', () => {
  it('parses statuses from objects, JSON strings and forms', () => {
    expect(parseOnfonDlr({ MessageId: 'abc', Status: 'DELIVRD' })).toEqual({ providerMessageId: 'abc', status: 'delivered' });
    expect(parseOnfonDlr({ messageId: 'abc', status: 'UNDELIV', errorDescription: 'handset off' })).toEqual({ providerMessageId: 'abc', status: 'failed', error: 'handset off' });
    expect(parseOnfonDlr('{"message_id":"x1","status":"ENROUTE"}')?.status).toBe('sent');
    expect(parseOnfonDlr('MessageId=x2&Status=Delivered')).toEqual({ providerMessageId: 'x2', status: 'delivered' });
    expect(parseOnfonDlr([{ MessageId: 'z', Status: 'EXPIRED' }])?.status).toBe('failed');
  });
  it('returns null without an id', () => {
    expect(parseOnfonDlr({ Status: 'DELIVRD' })).toBeNull();
    expect(parseOnfonDlr(null)).toBeNull();
  });
  it('shared secret check', () => {
    expect(verifyOnfonCallbackSecret('s3cret', 's3cret')).toBe(true);
    expect(verifyOnfonCallbackSecret('s3creT', 's3cret')).toBe(false);
    expect(verifyOnfonCallbackSecret(undefined, 's3cret')).toBe(false);
  });
});

const mail = { to: 'office@example.org', subject: 'Hello', body: 'Plain', html: '<p>Plain</p>' };
const rcfg = { apiKey: 'test-key', from: 'ChurchOS <no-reply@example.org>', replyTo: 'office@example.org', sleep: async () => {} };

describe('ResendEmail', () => {
  it('sends the documented request', async () => {
    const { f, calls } = fakeFetch([{ body: { id: 'em_1' } }]);
    const r = await new ResendEmail(rcfg, f).send(mail);
    expect(r).toEqual({ status: 'sent', providerMessageId: 'em_1' });
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-key');
    expect(calls[0].init.headers['Idempotency-Key']).toMatch(/^churchos-[0-9a-f]{48}$/);
    expect(JSON.parse(calls[0].init.body)).toEqual({ from: rcfg.from, to: ['office@example.org'], subject: 'Hello', text: 'Plain', html: '<p>Plain</p>', reply_to: 'office@example.org' });
  });
  it('idempotency key is stable and content-sensitive', () => {
    expect(idempotencyKey(mail)).toBe(idempotencyKey({ ...mail }));
    expect(idempotencyKey(mail)).toBe(idempotencyKey({ ...mail, to: 'OFFICE@example.org' }));
    expect(idempotencyKey(mail)).not.toBe(idempotencyKey({ ...mail, body: 'Other' }));
  });
  it('retries once on 429 honouring Retry-After, with the same key', async () => {
    const waits: number[] = [];
    const { f, calls } = fakeFetch([{ status: 429, headers: { 'retry-after': '2' }, body: { name: 'rate_limit_exceeded', message: 'slow down' } }, { body: { id: 'em_2' } }]);
    const r = await new ResendEmail({ ...rcfg, sleep: async (ms) => void waits.push(ms) }, f).send(mail);
    expect(r.status).toBe('sent');
    expect(waits).toEqual([2000]);
    expect(calls.length).toBe(2);
    expect(calls[0].init.headers['Idempotency-Key']).toBe(calls[1].init.headers['Idempotency-Key']);
  });
  it('retries once on 5xx then gives up', async () => {
    const { f, calls } = fakeFetch([{ status: 503, body: 'down' }]);
    const r = await new ResendEmail(rcfg, f).send(mail);
    expect(calls.length).toBe(2);
    expect(r.status).toBe('failed');
  });
  it('does not retry 4xx or quota errors', async () => {
    const a = fakeFetch([{ status: 422, body: { name: 'validation_error', message: 'The from address is not verified' } }]);
    const r = await new ResendEmail(rcfg, a.f).send(mail);
    expect(a.calls.length).toBe(1);
    expect(r.error).toMatch(/validation_error/);
    const b = fakeFetch([{ status: 429, body: { name: 'daily_quota_exceeded', message: 'limit' } }]);
    await new ResendEmail(rcfg, b.f).send(mail);
    expect(b.calls.length).toBe(1);
  });
  it('timeout and network errors become failed results after one retry', async () => {
    const hang: FetchLike = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))));
    const r = await new ResendEmail({ ...rcfg, timeoutMs: 10 }, hang).send(mail);
    expect(r).toMatchObject({ status: 'failed' });
    expect(r.error).toMatch(/timed out/);
  });
  it('rejects bad addresses without calling out', async () => {
    const { f, calls } = fakeFetch([{}]);
    expect((await new ResendEmail(rcfg, f).send({ ...mail, to: 'nope' })).error).toBe('invalid address');
    expect(calls.length).toBe(0);
  });
});

describe('Resend webhooks (Svix)', () => {
  const secret = 'whsec_' + Buffer.from('test-signing-key-0123456789').toString('base64');
  const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 'em_1', to: ['office@example.org'], bounce: { message: 'mailbox full' } } });
  const now = 1_800_000_000_000;
  const sign = (id: string, ts: string, b: string, s = secret) => 'v1,' + createHmac('sha256', Buffer.from(s.slice(6), 'base64')).update(`${id}.${ts}.${b}`).digest('base64');
  const hdrs = (ts = String(now / 1000), sig?: string) => ({ 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': sig ?? sign('msg_1', ts, body) });

  it('accepts a valid signature, including among several', () => {
    expect(verifyResendWebhook(hdrs(), body, secret, { now })).toBe(true);
    expect(verifyResendWebhook(hdrs(undefined, 'v1,AAAA ' + sign('msg_1', String(now / 1000), body)), body, secret, { now })).toBe(true);
    expect(verifyResendWebhook({ get: (n: string) => (hdrs() as any)[n] ?? null }, body, secret, { now })).toBe(true);
  });
  it('rejects wrong secret, tampered body, old or future timestamp, missing headers', () => {
    const other = 'whsec_' + Buffer.from('another-key').toString('base64');
    expect(verifyResendWebhook(hdrs(), body, other, { now })).toBe(false);
    expect(verifyResendWebhook(hdrs(), body + ' ', secret, { now })).toBe(false);
    const old = String(now / 1000 - 301);
    expect(verifyResendWebhook(hdrs(old), body, secret, { now })).toBe(false);
    const future = String(now / 1000 + 301);
    expect(verifyResendWebhook(hdrs(future), body, secret, { now })).toBe(false);
    expect(verifyResendWebhook(hdrs(String(now / 1000 - 299)), body, secret, { now })).toBe(true);
    expect(verifyResendWebhook({ 'svix-id': 'msg_1' }, body, secret, { now })).toBe(false);
  });
  it('replaying a valid signature under a different id fails', () => {
    expect(verifyResendWebhook({ ...hdrs(), 'svix-id': 'msg_2' }, body, secret, { now })).toBe(false);
  });
  it('parses events', () => {
    expect(parseResendEvent(body)).toEqual({ providerMessageId: 'em_1', type: 'bounced', to: 'office@example.org', detail: 'mailbox full' });
    expect(parseResendEvent({ type: 'email.complained', data: { email_id: 'e2', to: ['a@example.org'] } })?.type).toBe('complained');
    expect(parseResendEvent({ type: 'email.something_new', data: { email_id: 'e3', to: [] } })?.type).toBe('other');
    expect(parseResendEvent({ type: 'domain.created', data: {} })).toBeNull();
    expect(parseResendEvent('garbage')).toBeNull();
  });
});

describe('env factories', () => {
  it('default to mock', () => {
    expect(createMessagingFromEnv({})).toBeInstanceOf(MockMessagingProvider);
    expect(createMessagingFromEnv({ MESSAGING_MODE: 'mock' })).toBeInstanceOf(MockMessagingProvider);
    expect(createEmailFromEnv({})).toBeInstanceOf(MockEmailProvider);
  });
  it('live with config gives the real adapters', async () => {
    const { f, calls } = fakeFetch([okRows(['254700000001'])]);
    const sms = createMessagingFromEnv({ MESSAGING_MODE: 'live', ONFON_API_KEY: 'test-key', ONFON_CLIENT_ID: 'c', ONFON_ACCESS_KEY: 'a', ONFON_SENDER_ID: 'CHURCH', ONFON_BASE_URL: 'https://sandbox.example.org/sms' }, f);
    expect(sms).toBeInstanceOf(OnfonSms);
    await sms.send('sms', [{ to: '0700000001', body: 'hi' }]);
    expect(calls[0].url).toBe('https://sandbox.example.org/sms/SendBulkSMS');
    const e = createEmailFromEnv({ EMAIL_MODE: 'live', RESEND_API_KEY: 'test-key', RESEND_FROM: 'A <a@example.org>' });
    expect(e).toBeInstanceOf(ResendEmail);
  });
  it('live without config fails clearly, naming variables but no values', () => {
    expect(() => createMessagingFromEnv({ MESSAGING_MODE: 'live', ONFON_API_KEY: 'test-key' })).toThrow(/ONFON_CLIENT_ID.*ONFON_ACCESS_KEY.*ONFON_SENDER_ID/);
    expect(() => createMessagingFromEnv({ MESSAGING_MODE: 'live', ONFON_API_KEY: 'test-key' })).not.toThrow(/test-key/);
    expect(() => createEmailFromEnv({ EMAIL_MODE: 'live' })).toThrow(/RESEND_API_KEY, RESEND_FROM/);
    expect(() => createEmailFromEnv({ EMAIL_MODE: 'lvie' })).toThrow(/must be/);
  });
});
