/** A tiny injectable fetch helper: timeout, typed errors, nothing secret in messages. */

export type FetchLike = (input: string, init?: any) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export class HttpTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`request timed out after ${timeoutMs} ms`);
    this.name = 'HttpTimeoutError';
  }
}
export class HttpNetworkError extends Error {
  constructor(detail: string) {
    super(`network error: ${detail}`);
    this.name = 'HttpNetworkError';
  }
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  text: string;
  json: any;
  header(name: string): string | null;
}

/** Removes things that must not reach logs or stored errors: long digit runs (phone numbers), email addresses, bearer tokens. */
export function redact(s: string): string {
  return String(s)
    .replace(/[^\s@"'<>]+@[^\s@"'<>]+/g, '[email]')
    .replace(/\+?\d[\d\s-]{7,}\d/g, '[number]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [key]')
    .slice(0, 300);
}

/** One request. Throws HttpTimeoutError or HttpNetworkError only; HTTP error statuses are returned, not thrown. */
export async function httpRequest(
  fetchImpl: FetchLike,
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<HttpResponse> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeoutMs);
  try {
    const res = await fetchImpl(url, { method: opts.method ?? 'POST', headers: opts.headers, body: opts.body, signal: ctl.signal });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, text, json, header: (n) => res.headers.get(n) };
  } catch (e: any) {
    if (timedOut || e?.name === 'AbortError') throw new HttpTimeoutError(timeoutMs);
    throw new HttpNetworkError(redact(e?.message ?? 'unknown'));
  } finally {
    clearTimeout(timer);
  }
}
