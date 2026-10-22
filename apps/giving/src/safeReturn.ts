/**
 * Where the card test page may send the person afterwards (IN-04). Only http(s) addresses on this page's own origin,
 * on an origin listed in VITE_RETURN_ORIGINS (comma separated), or, when running locally, on the same host with any port.
 * The result is rebuilt from the parsed address, never the raw text, so no `javascript:` or `data:` value can come out.
 * Anything else gives '/'.
 */
export function safeReturn(
  raw: string | null | undefined,
  here: { href: string; origin: string; hostname: string },
  opts: { allowedOrigins?: string[]; dev?: boolean } = {},
): string {
  try {
    if (!raw || raw.length > 2000) return '/';
    const u = new URL(raw, here.href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '/';
    if (u.username || u.password) return '/';
    const allowed = new Set([here.origin, ...(opts.allowedOrigins ?? []).map((o) => { try { return new URL(o).origin; } catch { return ''; } }).filter(Boolean)]);
    const local = !!opts.dev && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && u.hostname === here.hostname;
    if (!allowed.has(u.origin) && !local) return '/';
    return u.origin === here.origin ? `${u.pathname}${u.search}${u.hash}` : `${u.origin}${u.pathname}${u.search}${u.hash}`;
  } catch { return '/'; }
}
