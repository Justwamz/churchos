import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Cents, PaymentMethod } from '@churchos/shared';
import type { InboundPayment, PaymentProvider, PayoutDestination } from './provider';

export type Deliver = (rawBody: string, headers: Record<string, string>) => Promise<void>;

export interface MockOptions {
  secret?: string;
  /** How long an STK push takes to "complete" on the member's phone. */
  stkDelayMs?: number;
  deliver?: Deliver;
}

/**
 * Simulated PSP for local development and tests. It keeps its own wallet balance, so the
 * ledger's reconciliation check compares two genuinely independent numbers.
 */
export class MockProvider implements PaymentProvider {
  private wallet: Cents = 0;
  private secret: string;
  private stkDelayMs: number;
  private deliver?: Deliver;
  private failPayouts = 0;
  private failRefunds = 0;
  private failStks = 0;
  readonly payoutsSent: { payoutId: string; amount: Cents; destination: PayoutDestination }[] = [];

  constructor(opts: MockOptions = {}) {
    this.secret = opts.secret ?? 'dev-psp-secret';
    this.stkDelayMs = opts.stkDelayMs ?? 3000;
    this.deliver = opts.deliver;
  }

  setDeliver(d: Deliver) {
    this.deliver = d;
  }
  failNextPayout(n = 1) {
    this.failPayouts = n;
  }
  failNextRefund(n = 1) {
    this.failRefunds = n;
  }
  failNextStk(n = 1) {
    this.failStks = n;
  }

  sign(rawBody: string): string {
    return createHmac('sha256', this.secret).update(rawBody).digest('hex');
  }

  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): boolean {
    const sig = headers['x-psp-signature'];
    if (!sig) return false;
    const expected = Buffer.from(this.sign(rawBody));
    const got = Buffer.from(sig);
    return expected.length === got.length && timingSafeEqual(expected, got);
  }

  parseWebhook(rawBody: string): InboundPayment {
    const b = JSON.parse(rawBody);
    return {
      providerTxId: String(b.providerTxId),
      method: b.method,
      amount: Number(b.amount),
      reference: String(b.reference ?? ''),
      phone: String(b.phone ?? ''),
      occurredAt: b.occurredAt ?? new Date().toISOString(),
    };
  }

  async initiateStkPush(req: { phone: string; amount: Cents; reference: string; method: PaymentMethod }) {
    const providerTxId = `STK${randomUUID().slice(0, 8).toUpperCase()}`;
    if (this.failStks > 0) {
      this.failStks--;
      return { providerTxId };
    }
    setTimeout(() => {
      void this.emitPayment({ providerTxId, method: req.method, amount: req.amount, reference: req.reference, phone: req.phone });
    }, this.stkDelayMs);
    return { providerTxId };
  }

  /** Simulates a member paying to the shared paybill with a typed account reference. */
  async simulatePaybill(p: {
    phone: string;
    amount: Cents;
    reference: string;
    method?: PaymentMethod;
    providerTxId?: string;
    duplicate?: boolean;
  }) {
    const providerTxId = p.providerTxId ?? `PB${randomUUID().slice(0, 8).toUpperCase()}`;
    const payment = { providerTxId, method: p.method ?? 'mpesa', amount: p.amount, reference: p.reference, phone: p.phone };
    await this.emitPayment(payment);
    if (p.duplicate) await this.emitPayment(payment, false);
    return { providerTxId };
  }

  private async emitPayment(
    p: { providerTxId: string; method: PaymentMethod; amount: Cents; reference: string; phone: string },
    creditWallet = true,
  ) {
    if (creditWallet) this.wallet += p.amount;
    const rawBody = JSON.stringify({ ...p, occurredAt: new Date().toISOString() });
    await this.deliver?.(rawBody, { 'x-psp-signature': this.sign(rawBody), 'content-type': 'application/json' });
  }

  async payout(req: { payoutId: string; destination: PayoutDestination; amount: Cents }) {
    if (this.failPayouts > 0) {
      this.failPayouts--;
      return { status: 'failed' as const };
    }
    if (req.amount > this.wallet) return { status: 'failed' as const };
    this.wallet -= req.amount;
    this.payoutsSent.push(req);
    return { status: 'confirmed' as const };
  }

  async refund(req: { providerTxId: string; amount: Cents }) {
    if (this.failRefunds > 0) {
      this.failRefunds--;
      return { status: 'failed' as const };
    }
    if (req.amount > this.wallet) return { status: 'failed' as const };
    this.wallet -= req.amount;
    return { status: 'confirmed' as const };
  }

  // ---------- hosted card checkout (L116) ----------
  // A real PSP hosts the card page, so card numbers never reach ChurchOS. This simulates that page: ChurchOS gets a checkout id and a
  // URL to send the person to, and the hosted page reports back with the result.
  private checkouts = new Map<string, { amount: Cents; reference: string; phone: string; done: boolean }>();

  /** Starts a card payment. Returns an id for the hosted checkout page. */
  async initiateCardCheckout(req: { amount: Cents; reference: string; phone?: string }) {
    const providerTxId = `CARD${randomUUID().slice(0, 8).toUpperCase()}`;
    this.checkouts.set(providerTxId, { amount: req.amount, reference: req.reference, phone: req.phone ?? '', done: false });
    return { providerTxId };
  }

  /** What the hosted page shows before the person pays: the amount, never the church's internal details. */
  checkoutInfo(providerTxId: string) {
    const c = this.checkouts.get(providerTxId);
    return c && !c.done ? { amount: c.amount } : null;
  }

  /**
   * The hosted checkout page submits the card here. Test cards: 4242 4242 4242 4242 succeeds, 4000 0000 0000 0002 is declined,
   * anything else is invalid. A success is reported to ChurchOS as a signed webhook, like every other payment.
   */
  async completeCardCheckout(providerTxId: string, card: { number: string; expiry: string; cvc: string }) {
    const c = this.checkouts.get(providerTxId);
    if (!c || c.done) return { status: 'unknown' as const };
    const n = String(card.number ?? '').replace(/\s+/g, '');
    if (!/^\d{12,19}$/.test(n) || !/^\d{2}\/\d{2}$/.test(String(card.expiry ?? '')) || !/^\d{3,4}$/.test(String(card.cvc ?? ''))) return { status: 'invalid' as const };
    if (n === '4000000000000002') return { status: 'declined' as const };
    if (n !== '4242424242424242') return { status: 'invalid' as const };
    c.done = true;
    await this.emitPayment({ providerTxId, method: 'card', amount: c.amount, reference: c.reference, phone: c.phone });
    return { status: 'paid' as const };
  }

  async walletBalance() {
    return this.wallet;
  }
}
