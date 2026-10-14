export interface ParsedReference {
  code: string;
  purpose: string;
}

/** Parses a paybill account reference such as "GRC001#TITHE". Returns null when no church code is present. */
export function parseReference(ref: string | null | undefined): ParsedReference | null {
  if (!ref) return null;
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const idx = trimmed.indexOf('#');
  const codePart = (idx === -1 ? trimmed : trimmed.slice(0, idx)).trim().toUpperCase();
  const purposePart = idx === -1 ? '' : trimmed.slice(idx + 1).trim().toUpperCase();
  if (!codePart) return null;
  return { code: codePart, purpose: purposePart || 'OFFERING' };
}

export function buildReference(code: string, purpose: string): string {
  return `${code.toUpperCase()}#${purpose.toUpperCase()}`;
}
