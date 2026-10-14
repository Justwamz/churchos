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

  async walletBalance() {
    return this.wallet;
  }
}
