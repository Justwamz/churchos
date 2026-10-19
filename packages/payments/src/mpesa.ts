import { constants, publicEncrypt, timingSafeEqual, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Cents } from '@churchos/shared';
import { basicAuth, jsonRequest, msisdn254, PspError, toKes, TokenCache, trimSlash, type Fetch } from './http';
import type { InboundPayment } from './provider';

export interface MpesaConfig {
  env: 'sandbox' | 'production';
  consumerKey: string;
  consumerSecret: string;
  /** Paybill or till number the money is collected on (BusinessShortCode / PartyB for STK). */
  shortcode: string;
  passkey: string;
  /** Public https base of this API, no trailing slash. Callback URLs are built from it. */
  callbackBase: string;
  /** Unguessable string placed in the callback URL path, because Daraja callbacks carry no signature. */
  callbackToken: string;
  /** Optional source IP allowlist for callbacks (Safaricom's published ranges). Empty means no IP check. */
  allowedIps?: string[];
  /** STK transaction type: CustomerPayBillOnline (paybill, default) or CustomerBuyGoodsOnline (till). */
  stkTransactionType?: 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline';
  /** B2C, reversal and balance (optional; without them payouts and refunds by M-Pesa are 'not switched on'). */
  initiatorName?: string;
  /** Plain initiator password, encrypted per request with the certificate. Not needed when securityCredential is given. */
  initiatorPassword?: string;
  /** Pre-encrypted SecurityCredential, if you prefer to encrypt it outside ChurchOS. */
  securityCredential?: string;
  /** PEM text of Safaricom's public certificate (sandbox or production). */
  certificatePem?: string;
  /** Shortcode that sends B2C money, when different from the collection shortcode. */
  b2cShortcode?: string;
}

const HOSTS = { sandbox: 'https://sandbox.safaricom.co.ke', production: 'https://api.safaricom.co.ke' };

/** Daraja timestamp, yyyyMMddHHmmss in Nairobi time (UTC+3). */
export function darajaTimestamp(d: Date): string {
  const e = new Date(d.getTime() + 3 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${e.getUTCFullYear()}${p(e.getUTCMonth() + 1)}${p(e.getUTCDate())}${p(e.getUTCHours())}${p(e.getUTCMinutes())}${p(e.getUTCSeconds())}`;
}

/** TransactionDate / TransTime (yyyyMMddHHmmss, Nairobi time) to an ISO string. */
export function darajaTimeToIso(t: unknown, fallback: Date): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(t ?? ''));
  if (!m) return fallback.toISOString();
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 3 * 3600_000).toISOString();
}

/** RSA PKCS#1 v1.5 encrypt of the initiator password with Safaricom's certificate, base64: the SecurityCredential. */
export function encryptCredential(password: string, certPem: string): string {
  const key = new X509Certificate(certPem).publicKey;
  return publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(password)).toString('base64');
}

export function mpesaConfigFromEnv(env: Record<string, string | undefined>): MpesaConfig | null {
  const need = ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY', 'MPESA_CALLBACK_BASE', 'MPESA_CALLBACK_TOKEN'];
  if (need.some((k) => !env[k])) return null;
  let certificatePem = env.MPESA_CERT_PEM;
  if (!certificatePem && env.MPESA_CERT_PATH) {
    try {
      certificatePem = readFileSync(env.MPESA_CERT_PATH, 'utf8');
    } catch {
      throw new PspError('not_configured', 'MPESA_CERT_PATH could not be read', 'M-Pesa');
    }
  }
  return {
    env: env.MPESA_ENV === 'production' ? 'production' : 'sandbox',
    consumerKey: env.MPESA_CONSUMER_KEY!,
    consumerSecret: env.MPESA_CONSUMER_SECRET!,
    shortcode: env.MPESA_SHORTCODE!,
    passkey: env.MPESA_PASSKEY!,
    callbackBase: trimSlash(env.MPESA_CALLBACK_BASE!),
    callbackToken: env.MPESA_CALLBACK_TOKEN!,
    allowedIps: (env.MPESA_ALLOWED_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    stkTransactionType: env.MPESA_STK_TYPE === 'till' ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
    initiatorName: env.MPESA_INITIATOR_NAME,
    initiatorPassword: env.MPESA_INITIATOR_PASSWORD,
    securityCredential: env.MPESA_SECURITY_CREDENTIAL,
    certificatePem,
    b2cShortcode: env.MPESA_B2C_SHORTCODE,
  };
}

const eqStr = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Safaricom Daraja: STK push (Lipa na M-Pesa Online), C2B paybill, B2C, reversal, account balance. */
export class MpesaDaraja {
  private tokens: TokenCache;
  /** Last balance Daraja reported to the result callback, in cents. Daraja's balance query is asynchronous, so this can be stale. */
  lastBalance: { cents: Cents; at: string } | null = null;

  constructor(public cfg: MpesaConfig, private fetchFn: Fetch, private now: () => Date = () => new Date()) {
    this.tokens = new TokenCache(() => this.now().getTime());
  }

  private get host() {
    return HOSTS[this.cfg.env];
  }

  /** URL for a callback type, with the secret token in the path. Timeouts share the result URL. */
  callbackUrl(kind: 'stk' | 'c2b' | 'c2b-validate' | 'result') {
    // The path says daraja, not mpesa: Daraja refuses to register callback URLs that contain words like mpesa or safaricom.
    return `${this.cfg.callbackBase}/webhooks/daraja/${this.cfg.callbackToken}/${kind}`;
  }

  private async token(): Promise<string> {
    return this.tokens.get(async () => {
      const r = await jsonRequest(this.fetchFn, {
        url: `${this.host}/oauth/v1/generate?grant_type=client_credentials`,
        headers: { authorization: basicAuth(this.cfg.consumerKey, this.cfg.consumerSecret) },
        psp: 'M-Pesa', what: 'sign in',
      });
      if (r.status !== 200 || !r.json?.access_token) throw new PspError('auth', 'M-Pesa refused the consumer key and secret', 'M-Pesa', r.status);
      return { token: String(r.json.access_token), expiresInSec: Number(r.json.expires_in) || 3599 };
    });
  }

  private async call(path: string, body: unknown, what: string) {
    const doCall = async () =>
      jsonRequest(this.fetchFn, { url: `${this.host}${path}`, headers: { authorization: `Bearer ${await this.token()}` }, body, psp: 'M-Pesa', what });
    let r = await doCall();
    if (r.status === 401) {
      this.tokens.clear();
      r = await doCall();
    }
    return r;
  }

  /** Sends the phone prompt. Returns CheckoutRequestID, which is the providerTxId the callback repeats. */
  async initiateStkPush(req: { phone: string; amount: Cents; reference: string }): Promise<{ providerTxId: string }> {
    const phone = msisdn254(req.phone);
    if (!phone) throw new PspError('rejected', 'That is not a valid Safaricom number', 'M-Pesa');
    if (req.amount % 100 !== 0) throw new PspError('rejected', 'M-Pesa prompts take whole shillings only', 'M-Pesa');
    const timestamp = darajaTimestamp(this.now());
    const password = Buffer.from(`${this.cfg.shortcode}${this.cfg.passkey}${timestamp}`).toString('base64');
    const r = await this.call('/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode: this.cfg.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: this.cfg.stkTransactionType ?? 'CustomerPayBillOnline',
      Amount: req.amount / 100,
      PartyA: phone,
      PartyB: this.cfg.shortcode,
      PhoneNumber: phone,
      CallBackURL: this.callbackUrl('stk'),
      AccountReference: req.reference.slice(0, 12), // Daraja allows 12 characters
      TransactionDesc: 'Church giving',
    }, 'STK push');
    if (String(r.json?.ResponseCode) !== '0' || !r.json?.CheckoutRequestID) {
      throw new PspError('rejected', `M-Pesa did not send the prompt${r.json?.errorMessage ? `: ${String(r.json.errorMessage).slice(0, 120)}` : ''}`, 'M-Pesa', r.status);
    }
    return { providerTxId: String(r.json.CheckoutRequestID) };
  }

  /** Registers the C2B confirmation and validation URLs for the paybill (an operator step, run once per shortcode). */
  async registerC2bUrls() {
    const r = await this.call('/mpesa/c2b/v2/registerurl', {
      ShortCode: this.cfg.shortcode,
      ResponseType: 'Completed', // accept payments even when validation is unreachable
      ConfirmationURL: this.callbackUrl('c2b'),
      ValidationURL: this.callbackUrl('c2b-validate'),
    }, 'register C2B URLs');
    if (String(r.json?.ResponseCode) !== '0' && !/success/i.test(String(r.json?.ResponseDescription ?? ''))) {
      throw new PspError('rejected', 'M-Pesa did not register the paybill URLs', 'M-Pesa', r.status);
    }
  }

  private credential(): string {
    if (this.cfg.securityCredential) return this.cfg.securityCredential;
    if (!this.cfg.initiatorPassword || !this.cfg.certificatePem) throw new PspError('not_configured', 'M-Pesa payouts are not switched on yet', 'M-Pesa');
    return encryptCredential(this.cfg.initiatorPassword, this.cfg.certificatePem);
  }

  get canInitiate(): boolean {
    return !!(this.cfg.initiatorName && (this.cfg.securityCredential || (this.cfg.initiatorPassword && this.cfg.certificatePem)));
  }

  /**
   * B2C: sends money to a phone. Asynchronous: 'accepted' only means Daraja queued it. The outcome arrives at the result URL, keyed by
   * OriginatorConversationID, which we set to the ChurchOS payout id so it is also the idempotency key.
   */
  async b2c(req: { id: string; phone: string; amount: Cents; remarks: string }): Promise<{ status: 'accepted' | 'failed' }> {
    if (!this.canInitiate) throw new PspError('not_configured', 'M-Pesa payouts are not switched on yet', 'M-Pesa');
    const phone = msisdn254(req.phone);
    if (!phone) throw new PspError('rejected', 'That is not a valid Safaricom number', 'M-Pesa');
    const r = await this.call('/mpesa/b2c/v3/paymentrequest', {
      OriginatorConversationID: req.id,
      InitiatorName: this.cfg.initiatorName,
      SecurityCredential: this.credential(),
      CommandID: 'BusinessPayment',
      Amount: toKes(req.amount),
      PartyA: this.cfg.b2cShortcode ?? this.cfg.shortcode,
      PartyB: phone,
      Remarks: req.remarks.slice(0, 100),
      QueueTimeOutURL: this.callbackUrl('result'),
      ResultURL: this.callbackUrl('result'),
      Occassion: req.id.slice(0, 100), // Daraja spells it this way
    }, 'B2C');
    return { status: String(r.json?.ResponseCode) === '0' ? 'accepted' : 'failed' };
  }

  /** Reverses a whole C2B transaction by its M-Pesa receipt number. Daraja reverses the full amount only. Result arrives at the result URL. */
  async reverse(req: { receipt: string; amount: Cents; id: string }): Promise<{ status: 'accepted' | 'failed' }> {
    if (!this.canInitiate) throw new PspError('not_configured', 'M-Pesa reversals are not switched on yet', 'M-Pesa');
    const r = await this.call('/mpesa/reversal/v1/request', {
      Initiator: this.cfg.initiatorName,
      SecurityCredential: this.credential(),
      CommandID: 'TransactionReversal',
      TransactionID: req.receipt,
      Amount: toKes(req.amount),
      ReceiverParty: this.cfg.shortcode,
      RecieverIdentifierType: '11', // Daraja spells it this way
      ResultURL: this.callbackUrl('result'),
      QueueTimeOutURL: this.callbackUrl('result'),
      Remarks: 'Reversal',
      Occasion: req.id.slice(0, 100),
    }, 'reversal');
    return { status: String(r.json?.ResponseCode) === '0' ? 'accepted' : 'failed' };
  }

  /** Asks Daraja for the account balance. The answer comes later to the result URL and is kept in lastBalance. */
  async requestBalance(): Promise<void> {
    if (!this.canInitiate) return;
    await this.call('/mpesa/accountbalance/v1/query', {
      Initiator: this.cfg.initiatorName,
      SecurityCredential: this.credential(),
      CommandID: 'AccountBalance',
      PartyA: this.cfg.shortcode,
      IdentifierType: '4',
      Remarks: 'Balance',
      QueueTimeOutURL: this.callbackUrl('result'),
      ResultURL: this.callbackUrl('result'),
    }, 'balance');
  }

  /**
   * Daraja callbacks are unsigned. The path token is compared in constant time, and when an allowlist is configured the caller's IP must be
   * on it. `token` comes from the route path; `ip` from the request.
   */
  verify(_headers: Record<string, string | undefined>, _rawBody: string, query?: { token?: string; ip?: string }): boolean {
    if (!query?.token || !eqStr(query.token, this.cfg.callbackToken)) return false;
    const allow = this.cfg.allowedIps ?? [];
    return allow.length === 0 || (!!query.ip && allow.includes(query.ip));
  }

  /** STK callback and C2B confirmation to a payment. Failed or cancelled prompts return null: they never become payments. */
  parse(rawBody: string): InboundPayment | null {
    let b: any;
    try {
      b = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const stk = b?.Body?.stkCallback;
    if (stk) {
      if (Number(stk.ResultCode) !== 0) return null;
      const items: any[] = stk.CallbackMetadata?.Item ?? [];
      const get = (n: string) => items.find((i) => i?.Name === n)?.Value;
      const amount = Number(get('Amount'));
      if (!stk.CheckoutRequestID || !Number.isFinite(amount) || amount <= 0) return null;
      return {
        providerTxId: String(stk.CheckoutRequestID),
        method: 'mpesa',
        amount: Math.round(amount * 100),
        reference: '', // Daraja does not echo the account reference; the API rebuilds it from the gift intent
        phone: String(get('PhoneNumber') ?? ''),
        occurredAt: darajaTimeToIso(get('TransactionDate'), this.now()),
      };
    }
    if (b?.TransID && b?.TransAmount !== undefined) {
      const amount = Number(b.TransAmount);
      if (!Number.isFinite(amount) || amount <= 0) return null;
      return {
        providerTxId: String(b.TransID),
        method: 'mpesa',
        amount: Math.round(amount * 100),
        reference: String(b.BillRefNumber ?? ''),
        phone: String(b.MSISDN ?? ''), // C2B v2 sends this as a SHA-256 hash, so it will not match a member
        occurredAt: darajaTimeToIso(b.TransTime, this.now()),
      };
    }
    return null;
  }

  /**
   * B2C, reversal and balance results (and timeouts). A balance report is kept in lastBalance as a side effect.
   * Returns a payout or refund outcome keyed by the id we sent, or null when there is nothing to act on.
   */
  parseResult(rawBody: string): { id: string; ok: boolean; receipt?: string } | null {
    let b: any;
    try {
      b = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const r = b?.Result;
    if (!r) return null;
    const params: any[] = r.ResultParameters?.ResultParameter ?? [];
    const bal = params.find((p) => p?.Key === 'AccountBalance')?.Value;
    if (typeof bal === 'string') {
      // "Working Account|KES|700000.00|700000.00|0.00|0.00&Utility Account|KES|..." name|currency|available|current|reserved|uncleared
      let total = 0;
      for (const part of bal.split('&')) {
        const f = part.split('|');
        if (/^(Working|Utility) Account$/i.test(f[0] ?? '') && f[1] === 'KES') total += Math.round(Number(f[3]) * 100) || 0;
      }
      this.lastBalance = { cents: total, at: this.now().toISOString() };
      return null;
    }
    if (!r.OriginatorConversationID) return null;
    return { id: String(r.OriginatorConversationID), ok: Number(r.ResultCode) === 0, receipt: r.TransactionID ? String(r.TransactionID) : undefined };
  }
}
