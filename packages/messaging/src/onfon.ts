import { timingSafeEqual } from 'node:crypto';
import type { Channel, MessagingProvider, OutboundMessage, SendResult } from './index';
import { httpRequest, redact, type FetchLike } from './http';

/**
 * Onfon Media (Onfon Mobile) bulk SMS, Kenya. Request shape (POST {baseUrl}/SendBulkSMS, header AccessKey, JSON body with
 * SenderId, MessageParameters[{Number, Text}], ApiKey, ClientId) follows Onfon's public integration samples. The response
 * shape and the callback shape are read tolerantly because Onfon issues the full reference only with an account.
 */

export interface OnfonConfig {
  apiKey: string;
  clientId: string;
  accessKey: string;
  defaultSenderId: string;
  baseUrl?: string;
  /** Path appended to baseUrl, default /SendBulkSMS. */
  sendPath?: string;
  /** Messages per HTTP request. Default 100 (conservative, confirm Onfon's limit for your account). */
  batchSize?: number;
  timeoutMs?: number;
  /** When set, only these sender ids may be used (the ones Onfon approved for your account). */
  approvedSenderIds?: string[];
  /** Name of the header carrying the access key. Default AccessKey. */
  accessKeyHeader?: string;
}

export const ONFON_DEFAULT_BASE_URL = 'https://api.onfonmedia.co.ke/v1/sms';

/** Kenyan mobile number to 2547XXXXXXXX / 2541XXXXXXXX. Other international numbers (10 to 15 digits) pass through. Null when invalid. */
export function normalizePhone(raw: string): string | null {
  let d = String(raw ?? '').replace(/[\s\-().]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  if (!/^\d+$/.test(d)) return null;
  if (/^0[17]\d{8}$/.test(d)) return '254' + d.slice(1);
  if (/^[17]\d{8}$/.test(d)) return '254' + d;
  if (d.startsWith('254')) return /^254[17]\d{8}$/.test(d) ? d : null;
  if (/^[1-9]\d{9,14}$/.test(d)) return d;
  return null;
}

/** Alphanumeric, no spaces, 1 to 11 characters. */
export function isValidSenderId(s: string): boolean {
  return /^[A-Za-z0-9]{1,11}$/.test(s);
}

const GSM7 = new Set(
  Array.from("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"),
);
const GSM7_EXT = new Set(Array.from('^{}\\[~]|€'));

/** Encoding and segment count, for billing. GSM-7: 160 single, 153 per part. UCS-2 (any other character): 70 single, 67 per part. */
export function smsSegments(text: string): { encoding: 'GSM-7' | 'UCS-2'; length: number; segments: number } {
  let units = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM7.has(ch)) units += 1;
    else if (GSM7_EXT.has(ch)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return { encoding: 'GSM-7', length: units, segments: units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153) };
  const len = text.length; // UTF-16 code units
  return { encoding: 'UCS-2', length: len, segments: len <= 70 ? 1 : Math.ceil(len / 67) };
}

export class OnfonSms implements MessagingProvider {
  private readonly cfg: Required<Pick<OnfonConfig, 'baseUrl' | 'sendPath' | 'batchSize' | 'timeoutMs' | 'accessKeyHeader'>> & OnfonConfig;
  constructor(cfg: OnfonConfig, private readonly fetchImpl: FetchLike = (globalThis.fetch as unknown) as FetchLike) {
    this.cfg = {
      ...cfg,
      baseUrl: (cfg.baseUrl ?? ONFON_DEFAULT_BASE_URL).replace(/\/+$/, ''),
      sendPath: cfg.sendPath ?? '/SendBulkSMS',
      batchSize: Math.max(1, cfg.batchSize ?? 100),
      timeoutMs: cfg.timeoutMs ?? 20000,
      accessKeyHeader: cfg.accessKeyHeader ?? 'AccessKey',
    };
  }

  async send(channel: Channel, batch: OutboundMessage[]): Promise<SendResult[]> {
    if (channel !== 'sms') return batch.map(() => ({ status: 'failed' as const, error: 'WhatsApp is not provided by this adapter' }));
    const results: SendResult[] = new Array(batch.length);
    const ready: { idx: number; number: string; text: string; sender: string }[] = [];
    batch.forEach((m, idx) => {
      const number = normalizePhone(m.to);
      if (!number) return void (results[idx] = { status: 'failed', error: 'invalid phone number' });
      if (!m.body || !m.body.trim()) return void (results[idx] = { status: 'failed', error: 'empty message' });
      const sender = (m.from ?? '').trim() || this.cfg.defaultSenderId;
      if (!isValidSenderId(sender)) return void (results[idx] = { status: 'failed', error: 'invalid sender id (letters and digits only, 11 characters at most)' });
      if (this.cfg.approvedSenderIds?.length && !this.cfg.approvedSenderIds.includes(sender)) {
        return void (results[idx] = { status: 'failed', error: 'sender id is not approved for this account' });
      }
      ready.push({ idx, number, text: m.body, sender });
    });
    // One request per sender id and per batch-size chunk, keeping the original positions.
    const bySender = new Map<string, typeof ready>();
    for (const r of ready) bySender.set(r.sender, [...(bySender.get(r.sender) ?? []), r]);
    for (const [sender, list] of bySender) {
      for (let i = 0; i < list.length; i += this.cfg.batchSize) {
        const chunk = list.slice(i, i + this.cfg.batchSize);
        const out = await this.sendChunk(sender, chunk);
        chunk.forEach((c, k) => (results[c.idx] = out[k]));
      }
    }
    return results;
  }

  private async sendChunk(sender: string, chunk: { number: string; text: string }[]): Promise<SendResult[]> {
    const fail = (error: string) => chunk.map(() => ({ status: 'failed' as const, error }));
    try {
      const res = await httpRequest(this.fetchImpl, this.cfg.baseUrl + this.cfg.sendPath, {
        method: 'POST',
        timeoutMs: this.cfg.timeoutMs,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', [this.cfg.accessKeyHeader]: this.cfg.accessKey },
        body: JSON.stringify({
          SenderId: sender,
          MessageParameters: chunk.map((c) => ({ Number: c.number, Text: c.text })),
          ApiKey: this.cfg.apiKey,
          ClientId: this.cfg.clientId,
        }),
      });
      if (!res.ok) return fail(`SMS provider returned HTTP ${res.status}${res.json?.ErrorDescription ? ': ' + redact(res.json.ErrorDescription) : ''}`);
      const j = res.json;
      if (!j || typeof j !== 'object') return fail('SMS provider returned an unreadable response');
      if (Number(j.ErrorCode ?? 0) !== 0) return fail(redact(`SMS provider error ${j.ErrorCode}: ${j.ErrorDescription ?? 'unknown'}`));
      const data: any[] = Array.isArray(j.Data) ? j.Data : [];
      return chunk.map((c, k) => {
        // Onfon returns one entry per message in order; fall back to matching by number if the counts differ.
        const row = data.length === chunk.length ? data[k] : data.find((d) => normalizePhone(String(d?.MobileNumber ?? '')) === c.number);
        if (!row) return { status: 'failed' as const, error: 'SMS provider gave no result for this message' };
        const code = Number(row.MessageErrorCode ?? 0);
        if (code !== 0) return { status: 'failed' as const, error: redact(`SMS rejected (${code}): ${row.MessageErrorDescription ?? 'unknown'}`) };
        return { status: 'sent' as const, providerMessageId: row.MessageId != null ? String(row.MessageId) : undefined };
      });
    } catch (e: any) {
      return fail(redact(e?.message ?? 'send failed'));
    }
  }
}

export interface OnfonDlr {
  providerMessageId: string;
  status: 'delivered' | 'failed' | 'sent';
  error?: string;
}

const pick = (o: any, names: string[]): string | undefined => {
  for (const k of Object.keys(o)) if (names.includes(k.toLowerCase().replace(/[_\s-]/g, ''))) return o[k] == null ? undefined : String(o[k]);
  return undefined;
};

/** Delivery report from Onfon: a JSON object, a JSON string or a form-encoded string. Null when it has no message id. */
export function parseOnfonDlr(body: unknown): OnfonDlr | null {
  let o: any = body;
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o);
    } catch {
      o = Object.fromEntries(new URLSearchParams(o));
    }
  }
  if (Array.isArray(o)) o = o[0];
  if (!o || typeof o !== 'object') return null;
  const id = pick(o, ['messageid', 'msgid', 'id']);
  if (!id) return null;
  const raw = (pick(o, ['status', 'deliverystatus', 'messagestatus', 'dlrstatus']) ?? '').toUpperCase();
  const errCode = pick(o, ['errorcode', 'messageerrorcode']);
  const errText = pick(o, ['errordescription', 'messageerrordescription', 'error', 'reason']);
  let status: OnfonDlr['status'];
  if (/^(DELIVRD|DELIVERED|DELIVERED_TO_HANDSET|SUCCESS)$/.test(raw)) status = 'delivered';
  else if (/^(ACCEPTD|ACCEPTED|ENROUTE|QUEUED|SENT|SUBMITTED|BUFFERED|PENDING)$/.test(raw)) status = 'sent';
  else if (raw) status = 'failed';
  else status = errCode && errCode !== '0' ? 'failed' : 'sent';
  const out: OnfonDlr = { providerMessageId: id, status };
  if (status === 'failed') out.error = redact(errText ?? (raw ? `delivery status ${raw}` : `error ${errCode}`));
  return out;
}

/** Constant-time check of a shared secret that the church puts in the callback URL or a header. */
export function verifyOnfonCallbackSecret(provided: string | null | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
