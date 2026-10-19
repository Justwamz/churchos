/** A tiny injectable HTTP layer. Adapters never call global fetch directly, so tests can pass a fake. */
export type Fetch = typeof fetch;

/** What went wrong, in terms an operator can act on. Messages never contain secrets or phone numbers. */
export type PspErrorKind = 'not_configured' | 'unsupported' | 'network' | 'timeout' | 'auth' | 'rejected' | 'bad_response';

export class PspError extends Error {
  constructor(public kind: PspErrorKind, message: string, public psp?: string, public status?: number) {
    super(message);
    this.name = 'PspError';
  }
}

export interface JsonRequest {
  method?: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Used only in error messages, e.g. 'M-Pesa'. */
  psp: string;
  /** Short action name for error messages, e.g. 'STK push'. Never put personal data here. */
  what: string;
}

/**
 * Sends JSON and returns { status, json }. Network failures and timeouts become PspError. A non-2xx status is NOT thrown here, because
 * several PSPs put the useful reason in the body: the caller decides. The body is never logged.
 */
export async function jsonRequest(fetchFn: Fetch, r: JsonRequest): Promise<{ status: number; json: any }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), r.timeoutMs ?? 20_000);
  try {
    const res = await fetchFn(r.url, {
      method: r.method ?? (r.body === undefined ? 'GET' : 'POST'),
      headers: { accept: 'application/json', ...(r.body === undefined ? {} : { 'content-type': 'application/json' }), ...r.headers },
      body: r.body === undefined ? undefined : JSON.stringify(r.body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json: any = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, json };
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new PspError('timeout', `${r.psp} did not answer in time (${r.what})`, r.psp);
    throw new PspError('network', `Could not reach ${r.psp} (${r.what})`, r.psp);
  } finally {
    clearTimeout(timer);
  }
}

export const basicAuth = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

/** 2547XXXXXXXX from 07.., 7.., +254.., 254..; null when it is not a Kenyan mobile number. */
export function msisdn254(raw: string): string | null {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (/^254[17]\d{8}$/.test(d)) return d;
  if (/^0[17]\d{8}$/.test(d)) return `254${d.slice(1)}`;
  if (/^[17]\d{8}$/.test(d)) return `254${d}`;
  return null;
}

/** Cents to a shillings amount for APIs that take whole or decimal KES. */
export const toKes = (cents: number) => (cents % 100 === 0 ? cents / 100 : Number((cents / 100).toFixed(2)));

export const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** A token cache shared by the OAuth-style adapters: refreshes a minute before expiry and shares one in-flight request. */
export class TokenCache {
  private tok?: { value: string; exp: number };
  private inflight?: Promise<string>;
  constructor(private now: () => number = Date.now) {}
  async get(fetchNew: () => Promise<{ token: string; expiresInSec: number }>): Promise<string> {
    if (this.tok && this.tok.exp > this.now()) return this.tok.value;
    this.inflight ??= fetchNew()
      .then((t) => {
        this.tok = { value: t.token, exp: this.now() + Math.max(0, t.expiresInSec - 60) * 1000 };
        return t.token;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }
  clear() {
    this.tok = undefined;
  }
}
