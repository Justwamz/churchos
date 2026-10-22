import type { Cents } from './types';

/** Basis points of an amount, rounded half up to a whole cent. */
export function bpsOf(amount: Cents, bps: number): Cents {
  return Math.floor((amount * bps + 5000) / 10000);
}

export function formatKes(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString('en-KE');
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}KES ${whole}.${frac}`;
}

const STRICT_KES = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * Strict parser for an amount typed or sent as shillings. Accepts a finite non-negative JS number with at most
 * 2 decimals, or a plain decimal string ("1500", "1500.5", "1500.50"). Rejects thousands separators, exponents,
 * hex, signs, trailing text and sub-cent amounts (never rounds). Callers apply their own min and max.
 * Returns whole cents. Throws Error('invalid amount') for anything else.
 */
export function toCents(kes: unknown): Cents {
  if (typeof kes === 'number') {
    if (!Number.isFinite(kes) || kes < 0 || kes >= 1e12) throw new Error('invalid amount');
    const c = Math.round(kes * 100);
    if (Math.abs(kes * 100 - c) > 1e-6) throw new Error('invalid amount');
    return c;
  }
  if (typeof kes === 'string') {
    const t = kes.trim();
    if (!STRICT_KES.test(t)) throw new Error('invalid amount');
    const [w, f = ''] = t.split('.');
    return Number(w) * 100 + Number(f.padEnd(2, '0'));
  }
  throw new Error('invalid amount');
}
