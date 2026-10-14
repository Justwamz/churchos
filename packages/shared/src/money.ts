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

export function toCents(kes: number | string): Cents {
  const n = typeof kes === 'string' ? parseFloat(kes) : kes;
  if (!Number.isFinite(n)) throw new Error('invalid amount');
  return Math.round(n * 100);
}
