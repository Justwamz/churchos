import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Cents } from '@churchos/shared';
import { jsonRequest, msisdn254, PspError, toKes, TokenCache, trimSlash, type Fetch } from './http';
import type { InboundPayment } from './provider';

export interface AirtelConfig {
  env: 'sandbox' | 'production';
  clientId: string;
  clientSecret: string;
  country: string;
  currency: string;
  callbackBase: string;
  /** Unguessable string in the callback URL path. */
  callbackToken: string;
  /** Optional key for Airtel's callback `hash` (HMAC-SHA256, base64). Without it the path token and a status re-check protect the callback. */
  webhookKey?: string;
  allowedIps?: string[];
}

const HOSTS = { sandbox: 'https://openapiuat.airtel.africa', production: 'https://openapi.airtel.africa' };

export function airtelConfigFromEnv(env: Record<string, string | undefined>): AirtelConfig | null {
  const need = ['AIRTEL_CLIENT_ID', 'AIRTEL_CLIENT_SECRET', 'AIRTEL_CALLBACK_BASE', 'AIRTEL_CALLBACK_TOKEN'];
  if (need.some((k) => !env[k])) return null;
  return {
    env: env.AIRTEL_ENV === 'production' ? 'production' : 'sandbox',
    clientId: env.AIRTEL_CLIENT_ID!,
    clientSecret: env.AIRTEL_CLIENT_SECRET!,
    country: env.AIRTEL_COUNTRY ?? 'KE',
    currency: env.AIRTEL_CURRENCY ?? 'KES',
    callbackBase: trimSlash(env.AIRTEL_CALLBACK_BASE!),
    callbackToken: env.AIRTEL_CALLBACK_TOKEN!,
    webhookKey: env.AIRTEL_WEBHOOK_KEY,
    allowedIps: (env.AIRTEL_ALLOWED_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

const eqStr = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Airtel Money (Kenya): USSD push collection, transaction status, refund, balance. Disbursement is not implemented. */
export class AirtelMoney {
  private tokens: TokenCache;
  constructor(public cfg: AirtelConfig, private fetchFn: Fetch, private now: () => Date = () => new Date()) {
    this.tokens = new TokenCache(() => this.now().getTime());
  }

  private get host() {
    return HOSTS[this.cfg.env];
  }
  /** The callback URL to register on the Airtel developer portal. */
  callbackUrl() {
    return `${this.cfg.callbackBase}/webhooks/airtel/${this.cfg.callbackToken}`;
  }

  private async token(): Promise<string> {
    return this.tokens.get(async () => {
      const r = await jsonRequest(this.fetchFn, {
        url: `${this.host}/auth/oauth2/token`,
        body: { client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, grant_type: 'client_credentials' },
        psp: 'Airtel Money', what: 'sign in',
      });
      if (r.status !== 200 || !r.json?.access_token) throw new PspError('auth', 'Airtel Money refused the client id and secret', 'Airtel Money', r.status);
      return { token: String(r.json.access_token), expiresInSec: Number(r.json.expires_in) || 3600 };
    });
  }

  private async call(method: 'GET' | 'POST', path: string, body: unknown, what: string) {
    const go = async () =>
      jsonRequest(this.fetchFn, {
        method, url: `${this.host}${path}`, body, psp: 'Airtel Money', what,
        headers: { authorization: `Bearer ${await this.token()}`, 'X-Country': this.cfg.country, 'X-Currency': this.cfg.currency },
      });
    let r = await go();
    if (r.status === 401) {
      this.tokens.clear();
      r = await go();
    }
    return r;
  }

  /** Sends the USSD push. The transaction id is ours (it is the providerTxId the callback repeats). */
  async initiateStkPush(req: { phone: string; amount: Cents; reference: string }): Promise<{ providerTxId: string }> {
    const phone = msisdn254(req.phone);
    if (!phone) throw new PspError('rejected', 'That is not a valid Airtel number', 'Airtel Money');
    const id = `ATL${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
    const { country, currency } = this.cfg;
    const r = await this.call('POST', '/merchant/v2/payments/', {
      reference: req.reference.slice(0, 64),
      subscriber: { country, currency, msisdn: phone.slice(3) }, // Airtel wants the number without the country code
      transaction: { amount: toKes(req.amount), country, currency, id },
    }, 'USSD push');
    if (r.json?.status?.success !== true) throw new PspError('rejected', 'Airtel Money did not send the prompt', 'Airtel Money', r.status);
    return { providerTxId: id };
  }

  /** Transaction status: 'TS' success, 'TF' failed, 'TA' ambiguous, and Airtel's own id (needed for refunds). */
  async status(id: string): Promise<{ code: string; airtelMoneyId?: string }> {
    const r = await this.call('GET', `/standard/v1/payments/${encodeURIComponent(id)}`, undefined, 'status');
    const t = r.json?.data?.transaction;
    if (!t) throw new PspError('bad_response', 'Airtel Money gave no status', 'Airtel Money', r.status);
    return { code: String(t.status ?? ''), airtelMoneyId: t.airtel_money_id ? String(t.airtel_money_id) : undefined };
  }

  /** Refund of the whole transaction (Airtel's refund API takes no amount). */
  async refund(providerTxId: string): Promise<{ status: 'confirmed' | 'failed' }> {
    const s = await this.status(providerTxId);
    if (!s.airtelMoneyId) return { status: 'failed' };
    const r = await this.call('POST', '/standard/v1/payments/refund', { transaction: { airtel_money_id: s.airtelMoneyId } }, 'refund');
    return { status: r.json?.status?.success === true ? 'confirmed' : 'failed' };
  }

  /** Collection account balance in cents (KES). */
  async balance(): Promise<Cents> {
    const r = await this.call('GET', '/standard/v1/users/balance', undefined, 'balance');
    const n = Number(r.json?.data?.balance);
    if (!Number.isFinite(n)) throw new PspError('bad_response', 'Airtel Money gave no balance', 'Airtel Money', r.status);
    return Math.round(n * 100);
  }

  /** Path token (constant time), optional IP allowlist, and Airtel's `hash` when a webhook key is configured. */
  verify(_headers: Record<string, string | undefined>, rawBody: string, query?: { token?: string; ip?: string }): boolean {
    if (!query?.token || !eqStr(query.token, this.cfg.callbackToken)) return false;
    const allow = this.cfg.allowedIps ?? [];
    if (allow.length > 0 && (!query.ip || !allow.includes(query.ip))) return false;
    if (!this.cfg.webhookKey) return true;
    try {
      const b = JSON.parse(rawBody);
      const t = b?.transaction;
      if (!t || typeof b.hash !== 'string') return false;
      // The documented input is the transaction object (id, message, status_code). Confirm the exact serialisation in the sandbox.
      const expected = createHmac('sha256', this.cfg.webhookKey).update(JSON.stringify({ transaction: { id: t.id, message: t.message, status_code: t.status_code } })).digest('base64');
      return eqStr(expected, b.hash);
    } catch {
      return false;
    }
  }

  /**
   * Airtel's callback carries no amount or phone, only the transaction id and a status. A successful one returns amount 0 and an empty
   * phone, and the API fills both from the gift intent it saved at initiation. Failed, ambiguous and unknown callbacks return null.
   */
  parse(rawBody: string): InboundPayment | null {
    let b: any;
    try {
      b = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const t = b?.transaction;
    if (!t?.id || String(t.status_code) !== 'TS') return null;
    return { providerTxId: String(t.id), method: 'airtel', amount: 0, reference: '', phone: '', occurredAt: this.now().toISOString() };
  }
}
