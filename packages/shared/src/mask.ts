/** Masking helpers for personal data (L109). Masked values keep enough to recognise a record, never enough to use it. */

export type MaskKind = 'phone' | 'dob' | 'account' | 'email' | 'id' | 'text';

/** 254711000001 becomes 254711•••001. Short or odd values are hidden entirely. */
export function maskPhone(p: string | null | undefined): string | null {
  if (p === null || p === undefined || p === '') return null;
  const s = String(p).replace(/\s+/g, '');
  if (s.length < 9) return '••••';
  return `${s.slice(0, 6)}•••${s.slice(-3)}`;
}

/** 1985-06-14 becomes 1985-••-••. Only the year stays. */
export function maskDob(d: string | null | undefined): string | null {
  if (!d) return null;
  const m = /^(\d{4})-\d{2}-\d{2}$/.exec(String(d));
  return m ? `${m[1]}-••-••` : '••••';
}

/** 1100234567 becomes ••••4567. */
export function maskAccount(a: string | null | undefined): string | null {
  if (a === null || a === undefined || a === '') return null;
  const s = String(a);
  return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
}

/** jane@example.com becomes j•••@example.com. */
export function maskEmail(e: string | null | undefined): string | null {
  if (!e) return null;
  const [u, d] = String(e).split('@');
  return d ? `${u.slice(0, 1)}•••@${d}` : '••••';
}

/** An identifier such as a certificate or ID number: only the last three characters stay. */
export function maskId(v: string | null | undefined): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  return s.length <= 3 ? '•••' : `•••${s.slice(-3)}`;
}

export function maskValue(kind: MaskKind, v: unknown): unknown {
  if (v === null || v === undefined) return v;
  switch (kind) {
    case 'phone': return maskPhone(String(v));
    case 'dob': return maskDob(String(v));
    case 'account': return maskAccount(String(v));
    case 'email': return maskEmail(String(v));
    case 'id': return maskId(String(v));
    default: return '••••';
  }
}

/** True when the value already looks masked, so it is never masked twice or mistaken for a real number. */
export const isMasked = (v: unknown) => typeof v === 'string' && v.includes('•');
