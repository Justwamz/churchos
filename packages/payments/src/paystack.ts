import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Cents } from '@churchos/shared';
import { jsonRequest, PspError, trimSlash, type Fetch } from './http';
import type { InboundPayment, PayoutDestination } from './provider';

export interface PaystackConfig {
  secretKey: string;
  /** Where Paystack sends the payer after paying (optional). */
  returnUrl?: string;
  /** Domain for the placeholder email when the payer's email is unknown (Paystack requires an email). */
  fallbackEmailDomain: string;
  currency: string;
  /** Optional IP allowlist for webhooks (Paystack publishes its sending IPs). */
  allowedIps?: string[];
  /** Transfer recipient type for bank payouts. Kenya: 'kepss' (bank). */
  bankRecipientType: string;
  baseUrl: string;
}

export function paystackConfigFromEnv(env: Record<string, string | undefined>): PaystackConfig | null {
  if (!env.PAYSTACK_SECRET_KEY) return null;
  return {
    secretKey: env.PAYSTACK_SECRET_KEY,
    returnUrl: env.PAYSTACK_RETURN_URL,
    // Paystack validates email syntax, and example.com is a reserved domain that passes it. Set your own domain in production.
    fallbackEmailDomain: env.PAYSTACK_FALLBACK_EMAIL_DOMAIN ?? 'example.com',
    currency: env.PAYSTACK_CURRENCY ?? 'KES',
    allowedIps: (env.PAYSTACK_ALLOWED_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    bankRecipientType: env.PAYSTACK_BANK_RECIPIENT_TYPE ?? 'kepss',
    baseUrl: trimSlash(env.PAYSTACK_BASE_URL ?? 'https://api.paystack.co'),
  };
}

const TRANSFER_PREFIX = 'churchos-';

/** Paystack card payments (hosted checkout), refunds, bank transfers and balance. Amounts are in the smallest unit, which is cents for KES. */
export class Paystack {
  constructor(public cfg: PaystackConfig, private fetchFn: Fetch, private now: () => Date = () => new Date()) {}

  private async call(method: 'GET' | 'POST', path: string, body: unknown, what: string) {
    const r = await jsonRequest(this.fetchFn, {
      method, url: `${this.cfg.baseUrl}${path}`, body, psp: 'Paystack', what,
      headers: { authorization: `Bearer ${this.cfg.secretKey}` },
    });
    if (r.status === 401) throw new PspError('auth', 'Paystack refused the secret key', 'Paystack', 401);
    return r;
  }

  emailFor(phone?: string, email?: string): string {
    if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return email;
    const digits = String(phone ?? '').replace(/\D/g, '') || 'giver';
    return `${digits}@${this.cfg.fallbackEmailDomain}`;
  }

  /** Starts hosted checkout. The reference we choose is the providerTxId; the church reference travels in metadata. */
  async initiateCardCheckout(req: { amount: Cents; reference: string; phone?: string; email?: string }): Promise<{ providerTxId: string; checkoutUrl: string }> {
    const ref = `CARD${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
    const r = await this.call('POST', '/transaction/initialize', {
      email: this.emailFor(req.phone, req.email),
      amount: req.amount,
      currency: this.cfg.currency,
      reference: ref,
      channels: ['card'],
      ...(this.cfg.returnUrl ? { callback_url: this.cfg.returnUrl } : {}),
      metadata: { reference: req.reference, phone: req.phone ?? '' },
    }, 'start card payment');
    const url = r.json?.data?.authorization_url;
    if (r.json?.status !== true || !url) throw new PspError('rejected', `Paystack did not start the card payment${r.json?.message ? `: ${String(r.json.message).slice(0, 120)}` : ''}`, 'Paystack', r.status);
    return { providerTxId: String(r.json.data.reference ?? ref), checkoutUrl: String(url) };
  }

  /** Asks Paystack whether a reference was really paid, and for how much. Used to re-check a webhook before trusting it. */
  async verifyTransaction(reference: string): Promise<{ paid: boolean; amount: Cents }> {
    const r = await this.call('GET', `/transaction/verify/${encodeURIComponent(reference)}`, undefined, 'verify payment');
    const d = r.json?.data;
    return { paid: r.json?.status === true && d?.status === 'success', amount: Number(d?.amount) || 0 };
  }

  /** Refund of a card payment, whole or partial. Paystack processes it later; acceptance is reported as confirmed. */
  async refund(providerTxId: string, amount: Cents): Promise<{ status: 'confirmed' | 'failed' }> {
    const r = await this.call('POST', '/refund', { transaction: providerTxId, amount, currency: this.cfg.currency }, 'refund');
    return { status: r.json?.status === true ? 'confirmed' : 'failed' };
  }

  /** Available balance in cents for the configured currency. */
  async balance(): Promise<Cents> {
    const r = await this.call('GET', '/balance', undefined, 'balance');
    const row = (r.json?.data as any[] | undefined)?.find((b) => b?.currency === this.cfg.currency);
    if (r.json?.status !== true) throw new PspError('bad_response', 'Paystack gave no balance', 'Paystack', r.status);
    return Number(row?.balance) || 0;
  }

  /** Bank transfer via a transfer recipient. 'pending' until transfer.success or transfer.failed arrives. */
  async transfer(req: { payoutId: string; destination: PayoutDestination; amount: Cents }): Promise<{ status: 'confirmed' | 'failed' | 'pending' }> {
    const d = req.destination;
    if (d.type !== 'bank' || !d.accountNumber || !d.bank) throw new PspError('rejected', 'The bank details are incomplete', 'Paystack');
    const rec = await this.call('POST', '/transferrecipient', {
      type: this.cfg.bankRecipientType, name: d.accountName ?? 'Church account', account_number: d.accountNumber, bank_code: d.bank, currency: this.cfg.currency,
    }, 'add transfer recipient');
    const code = rec.json?.data?.recipient_code;
    if (rec.json?.status !== true || !code) return { status: 'failed' };
    const t = await this.call('POST', '/transfer', {
      source: 'balance', amount: req.amount, currency: this.cfg.currency, recipient: code,
      reference: `${TRANSFER_PREFIX}${req.payoutId}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-'), reason: 'Church settlement',
    }, 'transfer');
    if (t.json?.status !== true) return { status: 'failed' };
    const s = t.json?.data?.status;
    if (s === 'success') return { status: 'confirmed' };
    // 'otp' means the account still requires an OTP to approve transfers: nothing moved, switch that off in the Paystack dashboard.
    return s === 'pending' || s === 'received' || s === 'processing' ? { status: 'pending' } : { status: 'failed' };
  }

  /** x-paystack-signature is the HMAC-SHA512 of the raw body keyed with the secret key, compared in constant time. */
  verify(headers: Record<string, string | undefined>, rawBody: string, query?: { ip?: string }): boolean {
    const sig = headers['x-paystack-signature'];
    if (!sig) return false;
    const allow = this.cfg.allowedIps ?? [];
    if (allow.length > 0 && (!query?.ip || !allow.includes(query.ip))) return false;
    const expected = Buffer.from(createHmac('sha512', this.cfg.secretKey).update(rawBody).digest('hex'));
    const got = Buffer.from(sig);
    return expected.length === got.length && timingSafeEqual(expected, got);
  }

  /** charge.success to a payment; every other event (including failures) is null. */
  parse(rawBody: string): InboundPayment | null {
    let b: any;
    try {
      b = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (b?.event !== 'charge.success') return null;
    const d = b.data;
    if (!d?.reference || d.status !== 'success' || !Number.isFinite(Number(d.amount)) || Number(d.amount) <= 0) return null;
    if (d.currency && d.currency !== this.cfg.currency) return null;
    return {
      providerTxId: String(d.reference),
      method: 'card',
      amount: Number(d.amount),
      reference: String(d.metadata?.reference ?? ''),
      phone: String(d.metadata?.phone ?? ''),
      occurredAt: d.paid_at ? new Date(d.paid_at).toISOString() : this.now().toISOString(),
    };
  }

  /** transfer.success, transfer.failed and transfer.reversed, keyed by our payout id; refund failures keyed by the transaction reference. */
  parseOutcome(rawBody: string): { kind: 'transfer' | 'refund'; id: string; ok: boolean } | null {
    let b: any;
    try {
      b = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const d = b?.data;
    if (typeof b?.event !== 'string' || !d) return null;
    if (/^transfer\.(success|failed|reversed)$/.test(b.event) && typeof d.reference === 'string') {
      const id = d.reference.startsWith(TRANSFER_PREFIX) ? d.reference.slice(TRANSFER_PREFIX.length) : d.reference;
      return { kind: 'transfer', id, ok: b.event === 'transfer.success' };
    }
    if (/^refund\.(processed|failed)$/.test(b.event)) {
      const id = String(d.transaction_reference ?? d.transaction?.reference ?? '');
      return id ? { kind: 'refund', id, ok: b.event === 'refund.processed' } : null;
    }
    return null;
  }
}
