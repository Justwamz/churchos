import type { PaymentMethod } from '@churchos/shared';
export { buildReference, computeFee, toCents, parseReference, formatKes } from '@churchos/shared';
import { HttpError } from '../ctx';

const METHODS: PaymentMethod[] = ['mpesa', 'airtel', 'card', 'tkash'];

export function normalizeMethod(m: unknown): PaymentMethod {
  const v = String(m ?? 'mpesa').toLowerCase() as PaymentMethod;
  if (!METHODS.includes(v)) throw new HttpError(400, 'Unsupported payment method', 'bad_method');
  return v;
}

export function csv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

/** SQL for a masked phone column, for example 254711•••001. Used so full numbers are never even selected for staff screens (L109). */
export const maskPhoneSql = (col: string) =>
  `(CASE WHEN ${col} IS NULL THEN NULL WHEN length(${col}) < 9 THEN '••••' ELSE left(${col}, 6) || '•••' || right(${col}, 3) END)`;
