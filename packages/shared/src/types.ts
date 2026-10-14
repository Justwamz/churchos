export type Cents = number;
export type PaymentMethod = 'mpesa' | 'airtel' | 'card' | 'tkash' | 'cash';
export type FeeBearer = 'church' | 'member';

export type PlatformFeeRule =
  | { type: 'flat'; bps: number }
  | { type: 'tiered'; tiers: { upTo: Cents | null; bps: number }[] };

export interface FeeSchedule {
  platform: PlatformFeeRule;
  psp: Record<PaymentMethod, { bps: number; fixed: Cents }>;
}

export interface FeeResult {
  platformFee: Cents;
  pspCost: Cents;
  totalFee: Cents;
  amountPaid: Cents;
  netToChurch: Cents;
}
