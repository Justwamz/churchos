import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { EmailProvider, OutboundEmail, SendResult } from './index';
import { httpRequest, redact, type FetchLike } from './http';

export interface ResendConfig {
  apiKey: string;
  /** For example 'ChurchOS <no-reply@mail.example.org>'. The domain must be verified in Resend. */
  from: string;
  replyTo?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Test hook: how to wait between the first try and the retry. */
  sleep?: (ms: number) => Promise<void>;
}

/** Stable for the same message, so a retry cannot double-send. Resend remembers a key for 24 hours and allows 256 characters. */
export function idempotencyKey(mail: OutboundEmail): string {
  const h = createHash('sha256').update(JSON.stringify([mail.to.trim().toLowerCase(), mail.subject, mail.body, mail.html ?? ''])).digest('hex');
  return `churchos-${h.slice(0, 48)}`;
}

export class ResendEmail implements EmailProvider {
  private readonly baseUrl: string;
  constructor(private readonly cfg: ResendConfig, private readonly fetchImpl: FetchLike = (globalThis.fetch as unknown) as FetchLike) {
    this.baseUrl = (cfg.baseUrl ?? 'https://api.resend.com').replace(/\/+$/, '');
  }

  async send(mail: OutboundEmail): Promise<SendResult> {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail.to)) return { status: 'failed', error: 'invalid address' };
    const payload: Record<string, unknown> = { from: this.cfg.from, to: [mail.to], subject: mail.subject, text: mail.body };
    if (mail.html) payload.html = mail.html;
    if (this.cfg.replyTo) payload.reply_to = this.cfg.replyTo;
    const body = JSON.stringify(payload);
    const headers = { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey(mail) };
    const sleep = this.cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let lastError = 'email send failed';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await httpRequest(this.fetchImpl, `${this.baseUrl}/emails`, { method: 'POST', headers, body, timeoutMs: this.cfg.timeoutMs ?? 15000 });
        if (res.ok && res.json?.id) return { status: 'sent', providerMessageId: String(res.json.id) };
        if (res.ok) return { status: 'failed', error: 'email provider returned no message id' };
        const detail = res.json ? `${res.json.name ?? 'error'}: ${res.json.message ?? ''}` : `HTTP ${res.status}`;
        lastError = redact(`email provider HTTP ${res.status} ${detail}`);
        const retryable = res.status === 429 || res.status >= 500;
        // Quota errors do not clear in seconds; do not retry them.
        const quota = /quota_exceeded/.test(String(res.json?.name ?? ''));
        if (!retryable || quota || attempt === 1) return { status: 'failed', error: lastError };
        const ra = Number(res.header('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : 1000);
      } catch (e: any) {
        lastError = redact(e?.message ?? 'email send failed');
        if (attempt === 1) return { status: 'failed', error: lastError };
        await sleep(1000); // same idempotency key, so a timeout that actually went through is not sent twice
      }
    }
    return { status: 'failed', error: lastError };
  }
}

type HeaderBag = Record<string, string | string[] | undefined> | { get(name: string): string | null };
function header(h: HeaderBag, name: string): string | undefined {
  if (typeof (h as any).get === 'function') return (h as any).get(name) ?? undefined;
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === name) {
      const v = (h as any)[k];
      return Array.isArray(v) ? v.join(' ') : v;
    }
  }
  return undefined;
}

/** Svix scheme used by Resend webhooks: HMAC-SHA256 over `${id}.${timestamp}.${rawBody}` with the base64 part of the whsec_ secret. */
export function verifyResendWebhook(headers: HeaderBag, rawBody: string, secret: string, opts: { now?: number; toleranceSeconds?: number } = {}): boolean {
  const id = header(headers, 'svix-id');
  const ts = header(headers, 'svix-timestamp');
  const sigs = header(headers, 'svix-signature');
  if (!id || !ts || !sigs || !secret) return false;
  const t = Number(ts);
  if (!Number.isFinite(t)) return false;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? 300)) return false;
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest();
  for (const part of sigs.split(' ')) {
    const [ver, sig] = part.split(',');
    if (ver !== 'v1' || !sig) continue;
    const got = Buffer.from(sig, 'base64');
    if (got.length === expected.length && timingSafeEqual(got, expected)) return true;
  }
  return false;
}

export interface ResendEvent {
  providerMessageId: string;
  type: 'sent' | 'delivered' | 'delivery_delayed' | 'bounced' | 'complained' | 'failed' | 'suppressed' | 'opened' | 'clicked' | 'other';
  to: string;
  detail?: string;
}

const KNOWN = ['sent', 'delivered', 'delivery_delayed', 'bounced', 'complained', 'failed', 'suppressed', 'opened', 'clicked'];

/** Reads a Resend webhook body (after verification). Null when it is not an email event with an id. */
export function parseResendEvent(body: unknown): ResendEvent | null {
  let o: any = body;
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o);
    } catch {
      return null;
    }
  }
  if (!o || typeof o.type !== 'string' || !o.type.startsWith('email.') || !o.data?.email_id) return null;
  const t = o.type.slice(6);
  const to = Array.isArray(o.data.to) ? String(o.data.to[0] ?? '') : String(o.data.to ?? '');
  const detail = o.data.bounce?.message ?? o.data.failed?.reason ?? undefined;
  return { providerMessageId: String(o.data.email_id), type: (KNOWN.includes(t) ? t : 'other') as ResendEvent['type'], to, detail: detail ? redact(detail) : undefined };
}
