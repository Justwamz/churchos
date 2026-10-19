import { MockEmailProvider, MockMessagingProvider, type EmailProvider, type MessagingProvider } from './index';
import type { FetchLike } from './http';
import { OnfonSms } from './onfon';
import { ResendEmail } from './resend';

export type Env = Record<string, string | undefined>;

function modeOf(env: Env, name: string): 'mock' | 'live' {
  const v = (env[name] ?? '').trim().toLowerCase();
  if (v === '' || v === 'mock') return 'mock';
  if (v === 'live') return 'live';
  throw new Error(`${name} must be "mock" or "live" (got "${v}")`);
}
function need(env: Env, modeName: string, names: string[]) {
  const missing = names.filter((n) => !(env[n] ?? '').trim());
  if (missing.length) throw new Error(`${modeName}=live but missing: ${missing.join(', ')}`);
}
const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);

/** SMS and WhatsApp provider. Mock unless MESSAGING_MODE=live; live needs the Onfon settings or this throws at startup. */
export function createMessagingFromEnv(env: Env, fetchImpl?: FetchLike): MessagingProvider {
  if (modeOf(env, 'MESSAGING_MODE') === 'mock') return new MockMessagingProvider();
  need(env, 'MESSAGING_MODE', ['ONFON_API_KEY', 'ONFON_CLIENT_ID', 'ONFON_ACCESS_KEY', 'ONFON_SENDER_ID']);
  const approved = (env.ONFON_APPROVED_SENDER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return new OnfonSms(
    {
      apiKey: env.ONFON_API_KEY!.trim(),
      clientId: env.ONFON_CLIENT_ID!.trim(),
      accessKey: env.ONFON_ACCESS_KEY!.trim(),
      defaultSenderId: env.ONFON_SENDER_ID!.trim(),
      baseUrl: env.ONFON_BASE_URL?.trim() || undefined,
      sendPath: env.ONFON_SEND_PATH?.trim() || undefined,
      accessKeyHeader: env.ONFON_ACCESS_KEY_HEADER?.trim() || undefined,
      batchSize: num(env.ONFON_BATCH_SIZE),
      timeoutMs: num(env.ONFON_TIMEOUT_MS),
      approvedSenderIds: approved.length ? approved : undefined,
    },
    fetchImpl,
  );
}

/** Email provider. Mock unless EMAIL_MODE=live; live needs RESEND_API_KEY and RESEND_FROM or this throws at startup. */
export function createEmailFromEnv(env: Env, fetchImpl?: FetchLike): EmailProvider {
  if (modeOf(env, 'EMAIL_MODE') === 'mock') return new MockEmailProvider();
  need(env, 'EMAIL_MODE', ['RESEND_API_KEY', 'RESEND_FROM']);
  return new ResendEmail(
    { apiKey: env.RESEND_API_KEY!.trim(), from: env.RESEND_FROM!.trim(), replyTo: env.RESEND_REPLY_TO?.trim() || undefined, baseUrl: env.RESEND_BASE_URL?.trim() || undefined, timeoutMs: num(env.RESEND_TIMEOUT_MS) },
    fetchImpl,
  );
}
