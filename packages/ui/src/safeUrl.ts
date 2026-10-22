/**
 * A link that came from the API (stream, meeting or payment page) is opened only when it is a real http(s) address.
 * `httpsOnly` is for links a church typed in (live streams, meetings): they must start with https://.
 * Returns the cleaned address, or null when it is not safe to open.
 */
export function safeHttpUrl(raw: unknown, opts: { httpsOnly?: boolean } = {}): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && !opts.httpsOnly)) return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch { return null; }
}

/** Opens a link in a new tab with no access back to this page. Returns false when the link is unsafe or the browser blocked it. */
export function openExternal(raw: unknown, opts: { httpsOnly?: boolean } = {}): boolean {
  const url = safeHttpUrl(raw, opts);
  if (!url) return false;
  return !!window.open(url, '_blank', 'noopener,noreferrer');
}
