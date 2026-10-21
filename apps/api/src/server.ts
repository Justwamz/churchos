import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { Clock, createDb, Ledger, type Db } from '@churchos/ledger';
import { createProviderFromEnv, friendlyPspMessage, isMock, PspError, type Provider } from '@churchos/payments';
import { MockEmailProvider, MockMessagingProvider, createEmailFromEnv, createMessagingFromEnv, type Channel, type EmailProvider, type MessagingProvider, type OutboundEmail, type OutboundMessage } from '@churchos/messaging';
import { HttpError, type Ctx } from './ctx';
import { loadHelp } from './help';
import { adminRoutes } from './routes/admin';
import { auditRoutes } from './routes/audit';
import { helpRoutes } from './routes/help';
import { kycRoutes } from './routes/kyc';
import { smsRoutes } from './routes/sms';
import { messageRoutes } from './routes/messages';
import { walletRoutes } from './routes/wallets';
import { tariffRoutes } from './routes/tariffs';
import { providerRoutes } from './routes/providers';
import { advertRoutes } from './routes/adverts';
import { communityRoutes } from './routes/community';
import { bookingRoutes } from './routes/bookings';
import { teamRoutes } from './routes/team';
import { shopRoutes } from './routes/shop';
import { ticketRoutes } from './routes/tickets';
import { kidsRoutes } from './routes/kids';
import { ticketRefundRoutes } from './routes/ticket-refunds';
import { eventCreditRoutes } from './routes/event-credit';
import { statementRoutes } from './routes/statements';
import { lectionaryRoutes } from './routes/lectionary';
import { staffTodayRoutes } from './routes/staff-today';
import { wordsRoutes } from './routes/words';
import { brandingRoutes } from './routes/branding';
import { creditExtraRoutes } from './routes/credit-extras';
import { joinRoutes } from './routes/join';
import { givingPlanRoutes } from './routes/giving-plans';
import { attendanceRoutes } from './routes/attendance';
import { givingLedgerRoutes } from './routes/giving-ledger';
import { prayerRoutes } from './routes/prayer';
import { suggestionRoutes } from './routes/suggestions';
import { expenseRoutes } from './routes/expenses';
import { coreRoutes, handleWebhook } from './routes/core';
import { pspWebhookRoutes, withInitiationLog } from './routes/psp-webhooks';
import { memberRoutes } from './routes/member';
import { memberRoutes2 } from './routes/members';
import { publicRoutes } from './routes/public';
import { memberRecordRoutes, publicRecordRoutes, recordRoutes } from './routes/records';
import { staffRoutes } from './routes/staff';
import { APP_SCHEMA } from './schema';
import { als, auditContext } from './audit';
import { CORS_HEADERS, CORS_METHODS, corsAllows, isProduction } from './cors';
import { trustProxyHops } from './guards';

export const DEFAULT_BODY_LIMIT = 64 * 1024;
const MB = 1024 * 1024;
/** Routes that take pictures or scans as base64 in JSON. Largest legitimate payload: 3 receipts of 1.2 MB each (about 4.9 MB in base64). */
const UPLOAD_LIMITS: { methods: string[]; url: RegExp; limit: number }[] = [
  { methods: ['POST'], url: /^\/(expenses|me\/claims)$/, limit: 6 * MB },
  { methods: ['POST'], url: /^\/expenses\/:id\/files$/, limit: 6 * MB },
  { methods: ['POST'], url: /^\/kyc\/documents$/, limit: 6 * MB }, // files up to 3 MB
  { methods: ['POST'], url: /^\/records$/, limit: 6 * MB },
  { methods: ['PUT'], url: /^\/records\/:id$/, limit: 6 * MB },
  { methods: ['POST'], url: /^\/records\/:id\/file$/, limit: 6 * MB },
  { methods: ['PUT'], url: /^\/certificates\/template$/, limit: 2 * MB },
  { methods: ['PUT'], url: /^\/church\/branding$/, limit: 4 * MB }, // six icons, up to 2.6 MB before base64
  { methods: ['POST'], url: /^\/events\/:id\/poster$/, limit: 2 * MB },
  { methods: ['POST', 'PUT'], url: /^\/adverts(\/:id)?$/, limit: 2 * MB },
  { methods: ['POST'], url: /^\/shop\/items\/:id\/image$/, limit: 1 * MB },
  { methods: ['POST'], url: /^\/lectionary\/import$/, limit: 1 * MB },
];
export const uploadLimit = (methods: string[], url: string): number | undefined => UPLOAD_LIMITS.find((u) => u.url.test(url) && methods.some((m) => u.methods.includes(m)))?.limit;

/** PostgreSQL SQLSTATEs that mean "the value you sent is not valid". */
const BAD_INPUT_SQLSTATES = new Set(['22021', '22P02', '22007', '22008', '22003', '22001', '22P05', '22004']);

/** One short line, never a body, header, token, query string or phone number. */
function logError(req: any, err: any) {
  const msg = String(err?.message ?? '').replace(/\s+/g, ' ').slice(0, 200);
  console.error(`error ${req?.method} ${String(req?.url ?? '').split('?')[0]} id=${req?.id} ${err?.constructor?.name ?? 'Error'}${err?.code ? ` [${err.code}]` : ''}: ${msg}`);
}

export interface BuildOptions {
  db?: Db;
  stkDelayMs?: number;
  logger?: boolean;
  /** Inject a payment provider (tests build a live router over a fake fetch). Otherwise PSP_MODE decides: simulated unless PSP_MODE=live. */
  provider?: Provider;
}

/**
 * The real SMS and email providers when MESSAGING_MODE / EMAIL_MODE is live (Slice 23), the simulated ones otherwise. The rest of the API only
 * knows the simulated shape, so a live provider is wrapped to keep a count of what was sent (without keeping any message text or number).
 */
class CountingSms extends MockMessagingProvider {
  constructor(private real: MessagingProvider) { super(); }
  async send(channel: Channel, batch: OutboundMessage[]) {
    const res = await this.real.send(channel, batch);
    res.forEach((r, i) => { if (r.status === 'sent') { this.sent.push({ channel, to: '', body: '', id: r.providerMessageId ?? 'LIVE', from: batch[i]?.from }); if (this.sent.length > 5000) this.sent.shift(); } });
    return res;
  }
}
class CountingEmail extends MockEmailProvider {
  constructor(private real: EmailProvider) { super(); }
  async send(mail: OutboundEmail) {
    const r = await this.real.send(mail);
    if (r.status === 'sent') { this.sent.push({ to: '', subject: '', body: '', id: r.providerMessageId ?? 'LIVE' }); if (this.sent.length > 5000) this.sent.shift(); }
    return r;
  }
}
const messagingFromEnv = (): MockMessagingProvider => { const p = createMessagingFromEnv(process.env); return p instanceof MockMessagingProvider ? p : new CountingSms(p); };
const emailFromEnv = (): MockEmailProvider => { const p = createEmailFromEnv(process.env); return p instanceof MockEmailProvider ? p : new CountingEmail(p); };

export async function buildApp(opts: BuildOptions = {}) {
  const db = opts.db ?? (await createDb());
  const clock = new Clock();
  const base = opts.provider ?? createProviderFromEnv(process.env);
  if (isMock(base) && opts.stkDelayMs !== undefined) base.setStkDelay(opts.stkDelayMs);
  const provider = withInitiationLog(base, db, () => clock.now().toISOString());
  const ledger = new Ledger(db, clock, provider);
  await ledger.migrate();
  await db.exec(APP_SCHEMA);

  const ctx: Ctx = { db, ledger, provider, messaging: messagingFromEnv(), email: emailFromEnv(), givingUrl: process.env.GIVING_URL ?? 'http://localhost:3001', clock, events: new EventEmitter(), newId: (p) => `${p}_${randomUUID().slice(0, 12)}` };
  ctx.events.setMaxListeners(0);
  if (isMock(provider)) {
    provider.setDeliver(async (raw, headers) => {
      try {
        await handleWebhook(ctx, raw, headers);
      } catch (e) {
        console.error('webhook failed', e);
      }
    });
  }

  ledger.auditContext = auditContext;
  const hops = trustProxyHops();
  const app = Fastify({
    // A hop count, never `true`: with `true` a caller can write their own address into X-Forwarded-For and be believed (WEB-03).
    // A plain number is NOT usable here: Fastify 5.12 treats a numeric trustProxy as "trust nobody". The function form trusts the first `hops` hops.
    trustProxy: hops > 0 ? (_address: string, hop: number) => hop < hops : false,
    logger: opts.logger ?? false,
    bodyLimit: DEFAULT_BODY_LIMIT,
    maxParamLength: 600,
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
    keepAliveTimeout: 5_000,
  });
  // Routes that legitimately carry pictures or scans (base64 inside JSON) get a larger, explicit limit. Everything else is 64 KB.
  app.addHook('onRoute', (route) => {
    const methods = ([] as string[]).concat(route.method as any);
    const limit = uploadLimit(methods, route.url);
    if (limit) route.bodyLimit = limit;
  });
  // Security headers on every response (WEB-05, WEB-08). Routes that set their own Cache-Control, CSP or CORP keep theirs.
  app.addHook('onSend', async (_req, reply, payload) => {
    const type = String(reply.getHeader('content-type') ?? '');
    const image = type.startsWith('image/');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('permissions-policy', 'geolocation=(), camera=(), microphone=()');
    // The web apps live on other sites (onrender.com is a public suffix) and load pictures with <img>, so images must be cross-origin readable.
    if (!reply.hasHeader('cross-origin-resource-policy')) reply.header('cross-origin-resource-policy', image ? 'cross-origin' : 'same-site');
    if (!reply.hasHeader('content-security-policy')) {
      reply.header('content-security-policy', image ? "sandbox; default-src 'none'; img-src 'self' data:" : type.startsWith('application/pdf') ? "frame-ancestors 'none'" : "default-src 'none'; frame-ancestors 'none'");
    }
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    if (isProduction()) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    return payload;
  });
  // Every event written while handling a request carries where it came from (L104).
  app.addHook('onRequest', (req, _reply, done) => {
    const app = req.headers['x-churchos-app'];
    als.run({ ip: req.ip ?? null, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200) || null, app: typeof app === 'string' ? app.slice(0, 20) : null, requestId: String(req.id) }, done);
  });
  // CORS fails closed in production (no CORS_ORIGINS = no browser origin allowed; start-up also refuses, see guards.ts). Bearer tokens, no cookies: credentials stay off.
  await app.register(cors, {
    origin: (origin, cb) => cb(null, corsAllows(origin)),
    methods: CORS_METHODS,
    allowedHeaders: CORS_HEADERS,
    exposedHeaders: ['content-disposition'],
    maxAge: 600,
  });

  // Keep the raw body, the PSP signature is computed over the exact bytes.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as any).rawBody = body;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new HttpError(400, 'invalid JSON', 'bad_json'), undefined);
    }
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof PspError) return reply.status(err.kind === 'rejected' || err.kind === 'unsupported' ? 400 : 503).send({ error: friendlyPspMessage(err), code: `psp_${err.kind}` });
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, code: err.code });
    const fst = typeof err?.code === 'string' && err.code.startsWith('FST_');
    if (fst) {
      if (err.statusCode === 413) return reply.status(413).send({ error: 'That is too large to send', code: 'too_large' });
      if (err.statusCode === 415) return reply.status(415).send({ error: 'That kind of content is not accepted', code: 'unsupported_type' });
      if (err.statusCode && err.statusCode < 500) return reply.status(400).send({ error: 'That request could not be read', code: 'bad_request' });
    }
    // Bad values that reach the database (NUL bytes, malformed text, dates, numbers out of range) are the caller's mistake, not ours.
    if (BAD_INPUT_SQLSTATES.has(String(err?.code)) || err instanceof RangeError) return reply.status(400).send({ error: 'That value is not valid', code: 'bad_request' });
    if (!fst && err?.statusCode && err.statusCode >= 400 && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message, code: err.code ?? 'bad_request' });
    logError(req, err);
    return reply.status(500).send({ error: 'Something went wrong', code: 'internal' });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'Not found', code: 'not_found' }));

  await loadHelp(db);

  coreRoutes(app, ctx);
  pspWebhookRoutes(app, ctx);
  helpRoutes(app, ctx);
  kycRoutes(app, ctx);
  smsRoutes(app, ctx);
  walletRoutes(app, ctx);
  tariffRoutes(app, ctx);
  providerRoutes(app, ctx);
  advertRoutes(app, ctx);
  communityRoutes(app, ctx);
  bookingRoutes(app, ctx);
  teamRoutes(app, ctx);
  shopRoutes(app, ctx);
  ticketRoutes(app, ctx);
  kidsRoutes(app, ctx);
  ticketRefundRoutes(app, ctx);
  eventCreditRoutes(app, ctx);
  statementRoutes(app, ctx);
  lectionaryRoutes(app, ctx);
  staffTodayRoutes(app, ctx);
  wordsRoutes(app, ctx);
  brandingRoutes(app, ctx);
  creditExtraRoutes(app, ctx);
  joinRoutes(app, ctx);
  givingPlanRoutes(app, ctx);
  attendanceRoutes(app, ctx);
  givingLedgerRoutes(app, ctx);
  prayerRoutes(app, ctx);
  suggestionRoutes(app, ctx);
  expenseRoutes(app, ctx);
  messageRoutes(app, ctx);
  publicRoutes(app, ctx);
  staffRoutes(app, ctx);
  memberRoutes(app, ctx);
  memberRoutes2(app, ctx);
  recordRoutes(app, ctx);
  publicRecordRoutes(app, ctx);
  memberRecordRoutes(app, ctx);
  adminRoutes(app, ctx);
  auditRoutes(app, ctx);

  return { app, ctx };
}
