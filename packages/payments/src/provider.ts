import type { Cents, PaymentMethod } from '@churchos/shared';

export interface PayoutDestination {
  type: 'bank' | 'mobile';
  bank?: string;
  accountNumber?: string;
  accountName?: string;
  phone?: string;
}

/** Normalised inbound payment notification, the same shape for every PSP adapter. */
export interface InboundPayment {
  providerTxId: string;
  method: PaymentMethod;
  amount: Cents;
  reference: string;
  phone: string;
  occurredAt: string;
}

/** The only surface the rest of ChurchOS knows about a PSP (L78). */
export interface PaymentProvider {
  initiateStkPush(req: { phone: string; amount: Cents; reference: string; method: PaymentMethod }): Promise<{ providerTxId: string }>;
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): boolean;
  /** null means the event is not a received payment (a failed prompt, a transfer result) and is ignored. */
  parseWebhook(rawBody: string, headers?: Record<string, string | undefined>): InboundPayment | null;
  /**
   * 'pending' means the PSP accepted the request and will report the outcome later (M-Pesa B2C, bank transfers). The ledger then keeps the
   * funds reserved in transit until Ledger.settlePayout is called from the PSP's result callback.
   */
  payout(req: { payoutId: string; destination: PayoutDestination; amount: Cents }): Promise<{ status: 'confirmed' | 'failed' | 'pending' }>;
  /** method and phone of the original payment let a live router pick the right PSP; the mock ignores them. 'confirmed' means accepted by the PSP. */
  refund(req: { providerTxId: string; amount: Cents; method?: PaymentMethod; phone?: string }): Promise<{ status: 'confirmed' | 'failed' }>;
  /** Wallet balance as the PSP sees it, for daily reconciliation. */
  walletBalance(): Promise<Cents>;
}

export interface CardCheckoutResult {
  providerTxId: string;
  /** Hosted page to send the payer to. Absent for the simulated provider, where ChurchOS serves its own test page. */
  checkoutUrl?: string;
}

/** What the API holds in ctx.provider: the PSP surface plus hosted card checkout, and whether it is simulated or live. */
export interface Provider extends PaymentProvider {
  readonly kind: 'mock' | 'live';
  initiateCardCheckout(req: { amount: Cents; reference: string; phone?: string; email?: string }): Promise<CardCheckoutResult>;
  /** Live only: asks the PSP whether an inbound payment really happened (for callbacks that are unsigned or carry no amount). */
  confirmInbound?(headers: Record<string, string | undefined>, p: InboundPayment): Promise<boolean>;
  /** Live only: result of an asynchronous payout or refund. Mock never has one. */
  parseOutcome?(headers: Record<string, string | undefined>, rawBody: string): { kind: 'payout' | 'refund'; id: string; ok: boolean } | null;
}
