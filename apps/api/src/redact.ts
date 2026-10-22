/**
 * Log redaction (LG-23). Logs on a hosted service are not private, so nothing personal goes into them: no names, emails, tokens,
 * codes, or whole phone numbers. Use these helpers for any console line that could touch a person's data.
 */

/** The last 3 digits of a phone number and nothing else: `•••001`. Empty or missing numbers give `•••`. */
export function maskPhone3(phone: unknown): string {
  const d = String(phone ?? '').replace(/\D/g, '');
  return d.length >= 3 ? `•••${d.slice(-3)}` : '•••';
}

/** Strips what looks personal from free text: emails, long digit runs (phones, references, amounts with references), long token-like strings. */
export function scrub(text: unknown): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')
    .replace(/\+?\d[\d ()-]{6,}\d/g, (m) => maskPhone3(m))
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[token]')
    .slice(0, 200);
}

/** One short, safe line for an error: its name, code and a scrubbed, truncated message. Never the stack, request body or query string. */
export function errLine(e: unknown): string {
  const x = e as any;
  return `${x?.constructor?.name ?? typeof e}${x?.code ? ` [${x.code}]` : ''}: ${scrub(x?.message ?? e)}`;
}

/** `GET /path id=abc ErrorName`: method, path without the query, request id, error name. */
export function requestErrorLine(req: { method?: string; url?: string; id?: unknown } | null | undefined, e: unknown): string {
  const x = e as any;
  return `error ${req?.method} ${String(req?.url ?? '').split('?')[0]} id=${req?.id} ${x?.constructor?.name ?? 'Error'}${x?.code ? ` [${x.code}]` : ''}`;
}
