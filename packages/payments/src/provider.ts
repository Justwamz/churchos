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
  parseWebhook(rawBody: string): InboundPayment;
  payout(req: { payoutId: string; destination: PayoutDestination; amount: Cents }): Promise<{ status: 'confirmed' | 'failed' }>;
  refund(req: { providerTxId: string; amount: Cents }): Promise<{ status: 'confirmed' | 'failed' }>;
  /** Wallet balance as the PSP sees it, for daily reconciliation. */
  walletBalance(): Promise<Cents>;
}
