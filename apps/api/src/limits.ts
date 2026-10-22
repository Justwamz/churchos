import { toCents } from '@churchos/shared';
import { HttpError } from './ctx';

/**
 * One place for every ceiling an outside value is held to (IN-01, IN-02, IN-09, IN-10, IN-13, LG-19).
 * Money limits are in whole shillings (KES); the parsers return cents.
 */
export const LIMITS = {
  /** One gift, payment or order. */
  PAYMENT_KES: 1_000_000,
  /** The older cap on a public gift or order, kept because the payment providers' per-transaction cap is lower. */
  ORDER_KES: 150_000,
  /** Prices of tickets, shop items, bookings, adverts, certificates. */
  PRICE_KES: 1_000_000,
  /** Project targets, pledges, budgets. */
  TARGET_KES: 1_000_000_000,
  /** One cash count. */
  CASH_COUNT_KES: 10_000_000,
  /** Fees, tariffs, settlement inputs. */
  FEE_KES: 1_000_000,
  QTY_MAX: 1000,
} as const;

/** Text caps (characters). */
export const TEXT = { name: 80, title: 120, note: 500, message: 2000, body: 5000, code: 40, url: 500 } as const;

const kes = (n: number) => `KES ${n.toLocaleString('en-KE')}`;

/**
 * Strict amount parser for every request amount. `value` is a number or a plain decimal string with at most 2 decimals
 * ("1500", "1500.50"). Returns cents or throws HttpError 400 'bad_amount' with a message that names the limit.
 * `min` and `max` are in shillings; `min` defaults to 0 (so zero is allowed) and `max` to the largest target.
 */
export function parseKes(value: unknown, opts: { min?: number; max?: number; label?: string } = {}): number {
  const min = opts.min ?? 0;
  const max = opts.max ?? LIMITS.TARGET_KES;
  const label = opts.label ?? 'the amount';
  let c: number;
  try { c = toCents(value); } catch {
    if (typeof value === 'string' && /[,\s]/.test(value.trim()) && /\d/.test(value)) throw new HttpError(400, `Enter ${label} as plain shillings with no commas or spaces, for example 1500 or 1500.50`, 'bad_amount');
    throw new HttpError(400, `Enter ${label} in shillings, with at most 2 decimals (for example 1500 or 1500.50)`, 'bad_amount');
  }
  if (c < Math.round(min * 100) || c > Math.round(max * 100)) {
    throw new HttpError(400, `${label[0].toUpperCase()}${label.slice(1)} must be between ${kes(min)} and ${kes(max)}`, 'bad_amount');
  }
  return c;
}

/** A string field that must really be a string (arrays, objects, numbers are refused), trimmed, with a length cap. */
export function str(v: unknown, opts: { max?: number; label?: string; required?: boolean; allowNumber?: boolean } = {}): string {
  const label = opts.label ?? 'A field';
  if (v === undefined || v === null) {
    if (opts.required) throw new HttpError(400, `${label} is required`, 'bad_input');
    return '';
  }
  if (typeof v === 'number' && opts.allowNumber) v = String(v);
  if (typeof v !== 'string') throw new HttpError(400, `${label} must be text`, 'bad_input');
  const s = v.replace(/\u0000/g, '').trim();
  if (opts.required && !s) throw new HttpError(400, `${label} is required`, 'bad_input');
  if (opts.max !== undefined && s.length > opts.max) throw new HttpError(400, `${label} is too long (at most ${opts.max} characters)`, 'too_long');
  return s;
}

/** Caps an optional free-text field. Rejects non-text and anything over `max`. Empty returns ''. */
export const text = (v: unknown, max: number, label = 'That text') => str(v, { max, label });

/** A whole number (number or digit string). Arrays, objects, fractions and out-of-range values give 400. */
export function int(v: unknown, opts: { min?: number; max?: number; label?: string; def?: number } = {}): number {
  const label = opts.label ?? 'A number';
  if ((v === undefined || v === null || v === '') && opts.def !== undefined) return opts.def;
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^-?\d{1,15}$/.test(v.trim())) n = Number(v);
  else throw new HttpError(400, `${label} must be a whole number`, 'bad_number');
  const min = opts.min ?? 0;
  const max = opts.max ?? LIMITS.QTY_MAX;
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label} must be a whole number from ${min} to ${max}`, 'bad_number');
  return n;
}

/** A list parameter such as limit, offset, year or month. Bad values fall back to the default; out-of-range values are clamped. */
export function intParam(v: unknown, opts: { min: number; max: number; def: number }): number {
  if (typeof v !== 'string' && typeof v !== 'number') return opts.def;
  const s = String(v).trim();
  if (!/^-?\d{1,12}$/.test(s)) return opts.def;
  return Math.min(opts.max, Math.max(opts.min, Number(s)));
}

/** A YYYY-MM-DD query parameter, or undefined when missing or not a real date. */
export function dateParam(v: unknown): string | undefined {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? undefined : v;
}

/** Escapes % _ and \ so a typed search matches literally. Use with `ILIKE $n ESCAPE '\'`. */
export const likeEscape = (s: unknown): string => String(s ?? '').replace(/[\\%_]/g, (c) => `\\${c}`);
