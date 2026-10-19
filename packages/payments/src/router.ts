import { createHash } from 'node:crypto';
import type { Cents, PaymentMethod } from '@churchos/shared';
import { AirtelMoney, airtelConfigFromEnv } from './airtel';
import { PspError, type Fetch } from './http';
import { MockProvider } from './mock';
import { MpesaDaraja, mpesaConfigFromEnv } from './mpesa';
import { Paystack, paystackConfigFromEnv } from './paystack';
import type { CardCheckoutResult, InboundPayment, PayoutDestination, Provider } from './provider';

export type PspName = 'mpesa' | 'airtel' | 'paystack';

/** Outcome of an asynchronous payout or refund, reported later by a PSP. */
export interface Outcome {
  kind: 'payout' | 'refund';
  id: string;
  ok: boolean;
}

/** Headers the webhook routes set before calling handleWebhook. The adapter never sees the real network address of a caller otherwise. */
export const PSP_HEADER = 'x-psp';
export const PSP_TOKEN_HEADER = 'x-psp-token';
export const PSP_IP_HEADER = 'x-psp-ip';

/** Deterministic id for a refund sent through B2C, so a retry is recognised by Daraja instead of paying twice. */
export const refundId = (providerTxId: string) => `rf_${createHash('sha256').update(providerTxId).digest('hex').slice(0, 24)}`;

const off = (what: string) => new PspError('not_configured', `${what} are not switched on yet`, undefined);

/** Routes each operation to the PSP that owns it. A PSP without configuration fails with a friendly typed error, never a crash. */
export class RoutedProvider implements Provider {
  readonly kind = 'live' as const;
  constructor(public adapters: { mpesa?: MpesaDaraja; airtel?: AirtelMoney; paystack?: Paystack }) {}

  async initiateStkPush(req: { phone: string; amount: Cents; reference: string; method: PaymentMethod }): Promise<{ providerTxId: string }> {
    if (req.method === 'mpesa') {
      if (!this.adapters.mpesa) throw off('M-Pesa payments');
      return this.adapters.mpesa.initiateStkPush(req);
    }
    if (req.method === 'airtel') {
      if (!this.adapters.airtel) throw off('Airtel Money payments');
      return this.adapters.airtel.initiateStkPush(req);
    }
    throw new PspError('unsupported', `${req.method === 'tkash' ? 'T-Kash' : req.method} payments are not available yet`);
  }

  async initiateCardCheckout(req: { amount: Cents; reference: string; phone?: string; email?: string }): Promise<CardCheckoutResult> {
    if (!this.adapters.paystack) throw off('Card payments');
    return this.adapters.paystack.initiateCardCheckout(req);
  }

  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): boolean {
    const psp = headers[PSP_HEADER] as PspName | undefined;
    const q = { token: headers[PSP_TOKEN_HEADER], ip: headers[PSP_IP_HEADER] };
    if (psp === 'mpesa') return !!this.adapters.mpesa?.verify(headers, rawBody, q);
    if (psp === 'airtel') return !!this.adapters.airtel?.verify(headers, rawBody, q);
    if (psp === 'paystack') return !!this.adapters.paystack?.verify(headers, rawBody, q);
    return false;
  }

  /** null for events that are not a received payment (failed prompts, transfer events, results). */
  parseWebhook(rawBody: string, headers: Record<string, string | undefined> = {}): InboundPayment | null {
    const psp = headers[PSP_HEADER];
    if (psp === 'mpesa') return this.adapters.mpesa?.parse(rawBody) ?? null;
    if (psp === 'airtel') return this.adapters.airtel?.parse(rawBody) ?? null;
    if (psp === 'paystack') return this.adapters.paystack?.parse(rawBody) ?? null;
    return null;
  }

  /** Extra check on a callback that carries no amount: ask the PSP itself whether the payment really happened. */
  async confirmInbound(headers: Record<string, string | undefined>, p: InboundPayment): Promise<boolean> {
    const psp = headers[PSP_HEADER];
    if (psp === 'airtel' && this.adapters.airtel) return (await this.adapters.airtel.status(p.providerTxId)).code === 'TS';
    if (psp === 'paystack' && this.adapters.paystack) {
      const v = await this.adapters.paystack.verifyTransaction(p.providerTxId);
      return v.paid && v.amount === p.amount;
    }
    return true;
  }

  /** Asynchronous payout, reversal and refund results from M-Pesa and Paystack. */
  parseOutcome(headers: Record<string, string | undefined>, rawBody: string): Outcome | null {
    const psp = headers[PSP_HEADER];
    if (psp === 'mpesa') {
      const r = this.adapters.mpesa?.parseResult(rawBody);
      return r ? { kind: r.id.startsWith('rf_') ? 'refund' : 'payout', id: r.id, ok: r.ok } : null;
    }
    if (psp === 'paystack') {
      const r = this.adapters.paystack?.parseOutcome(rawBody);
      return r ? { kind: r.kind === 'transfer' ? 'payout' : 'refund', id: r.id, ok: r.ok } : null;
    }
    return null;
  }

  async payout(req: { payoutId: string; destination: PayoutDestination; amount: Cents }): Promise<{ status: 'confirmed' | 'failed' | 'pending' }> {
    const d = req.destination;
    if (d.type === 'mobile') {
      if (!this.adapters.mpesa?.canInitiate) throw off('M-Pesa payouts');
      const r = await this.adapters.mpesa.b2c({ id: req.payoutId, phone: d.phone ?? '', amount: req.amount, remarks: 'Church settlement' });
      return { status: r.status === 'accepted' ? 'pending' : 'failed' };
    }
    if (!this.adapters.paystack) throw off('Bank payouts');
    return this.adapters.paystack.transfer(req);
  }

  /**
   * Refunds go back the way the money came. Card: Paystack refund (partial allowed). M-Pesa: a B2C payment of the refund amount to the payer's
   * phone (Daraja's reversal API can only reverse a whole transaction and needs the receipt number). Airtel: the refund API (whole amount).
   * 'confirmed' means the PSP accepted the request; a later failure is reported through parseOutcome.
   */
  async refund(req: { providerTxId: string; amount: Cents; method?: PaymentMethod; phone?: string }): Promise<{ status: 'confirmed' | 'failed' }> {
    if (req.method === 'card') {
      if (!this.adapters.paystack) throw off('Card refunds');
      return this.adapters.paystack.refund(req.providerTxId, req.amount);
    }
    if (req.method === 'airtel') {
      if (!this.adapters.airtel) throw off('Airtel Money refunds');
      return this.adapters.airtel.refund(req.providerTxId);
    }
    if (req.method === 'mpesa') {
      if (!this.adapters.mpesa?.canInitiate) throw off('M-Pesa refunds');
      if (!req.phone) return { status: 'failed' }; // anonymous gifts keep no number to send the money back to
      const r = await this.adapters.mpesa.b2c({ id: refundId(req.providerTxId), phone: req.phone, amount: req.amount, remarks: 'Refund' });
      return { status: r.status === 'accepted' ? 'confirmed' : 'failed' };
    }
    throw new PspError('unsupported', 'That payment cannot be refunded automatically');
  }

  /**
   * Sum of what ChurchOS can read: Paystack balance (live), Airtel collection balance (live) and M-Pesa working plus utility accounts as last
   * reported to the result callback. Daraja's balance query is asynchronous, so this call asks for a refresh and returns the previous
   * answer; reconciliation can be off by whatever happened since. Bank accounts and cash are not included.
   */
  async walletBalance(): Promise<Cents> {
    const { mpesa, airtel, paystack } = this.adapters;
    let total = 0;
    if (mpesa) {
      void mpesa.requestBalance().catch(() => undefined);
      total += mpesa.lastBalance?.cents ?? 0;
    }
    if (airtel) total += await airtel.balance();
    if (paystack) total += await paystack.balance();
    return total;
  }
}

/** A friendly message for the API to show a person, from any provider error. */
export function friendlyPspMessage(e: unknown): string | null {
  if (!(e instanceof PspError)) return null;
  if (e.kind === 'not_configured' || e.kind === 'unsupported' || e.kind === 'rejected') return e.message;
  return 'The payment service is not answering right now. Please try again in a moment.';
}

/**
 * MockProvider unless PSP_MODE=live. A live mode with no PSP configured at all is a startup error, so a production server never
 * quietly runs on the simulator.
 */
export function createProviderFromEnv(env: Record<string, string | undefined>, fetchFn: Fetch = (...a) => fetch(...a), now?: () => Date): Provider {
  if (env.PSP_MODE !== 'live') return new MockProvider();
  const mc = mpesaConfigFromEnv(env), ac = airtelConfigFromEnv(env), pc = paystackConfigFromEnv(env);
  if (!mc && !ac && !pc) throw new PspError('not_configured', 'PSP_MODE=live but no payment provider is configured (see docs/going-live-payments.md)');
  return new RoutedProvider({
    mpesa: mc ? new MpesaDaraja(mc, fetchFn, now) : undefined,
    airtel: ac ? new AirtelMoney(ac, fetchFn, now) : undefined,
    paystack: pc ? new Paystack(pc, fetchFn, now) : undefined,
  });
}

export const isMock = (p: Provider): p is MockProvider => p.kind === 'mock';
