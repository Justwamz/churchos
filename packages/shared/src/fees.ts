import { bpsOf } from './money';
import type { Cents, FeeBearer, FeeResult, FeeSchedule, PaymentMethod, PlatformFeeRule } from './types';

export const DEFAULT_FEE_SCHEDULE: FeeSchedule = {
  platform: { type: 'flat', bps: 150 },
  psp: {
    mpesa: { bps: 100, fixed: 0 },
    airtel: { bps: 120, fixed: 0 },
    tkash: { bps: 120, fixed: 0 },
    card: { bps: 290, fixed: 0 },
    cash: { bps: 0, fixed: 0 },
  },
};

function platformBps(rule: PlatformFeeRule, amount: Cents): number {
  if (rule.type === 'flat') return rule.bps;
  for (const t of rule.tiers) {
    if (t.upTo === null || amount <= t.upTo) return t.bps;
  }
  return rule.tiers[rule.tiers.length - 1]?.bps ?? 0;
}

function feeOn(schedule: FeeSchedule, method: PaymentMethod, amount: Cents) {
  const platformFee = bpsOf(amount, platformBps(schedule.platform, amount));
  const psp = schedule.psp[method];
  const pspCost = bpsOf(amount, psp.bps) + psp.fixed;
  return { platformFee, pspCost, totalFee: platformFee + pspCost };
}

/**
 * Church bears the fee: the member pays `base`, the church receives base minus fee.
 * Member bears the fee: the member pays base plus fee, and the church receives exactly `base`.
 * Invariant for both: amountPaid - totalFee === netToChurch, and platformFee + pspCost === totalFee.
 */
export function computeFee(
  schedule: FeeSchedule,
  method: PaymentMethod,
  base: Cents,
  bearer: FeeBearer,
): FeeResult {
  if (!Number.isInteger(base) || base <= 0) throw new Error('amount must be a positive whole number of cents');
  if (bearer === 'church') {
    const f = feeOn(schedule, method, base);
    return { ...f, amountPaid: base, netToChurch: base - f.totalFee };
  }
  // Member bears: find gross such that gross - fee(gross) === base.
  let gross = base + feeOn(schedule, method, base).totalFee;
  for (let i = 0; i < 50; i++) {
    const f = feeOn(schedule, method, gross);
    const net = gross - f.totalFee;
    if (net === base) return { ...f, amountPaid: gross, netToChurch: base };
    gross += base - net;
  }
  // Rounding can make an exact solution impossible. Settle on the last gross and
  // fold any leftover cents into the platform fee so net is exactly base.
  const f = feeOn(schedule, method, gross);
  const leftover = gross - f.totalFee - base;
  return {
    ...f,
    platformFee: f.platformFee + leftover,
    totalFee: f.totalFee + leftover,
    amountPaid: gross,
    netToChurch: base,
  };
}
