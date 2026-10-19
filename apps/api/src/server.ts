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
  const app = Fastify({ trustProxy: process.env.TRUST_PROXY === '1', logger: opts.logger ?? false, bodyLimit: 6 * 1024 * 1024, maxParamLength: 600 });
  // Every event written while handling a request carries where it came from (L104).
  app.addHook('onRequest', (req, _reply, done) => {
    const app = req.headers['x-churchos-app'];
    als.run({ ip: req.ip ?? null, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200) || null, app: typeof app === 'string' ? app.slice(0, 20) : null, requestId: String(req.id) }, done);
  });
  await app.register(cors, { origin: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] });

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

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof PspError) return reply.status(err.kind === 'rejected' || err.kind === 'unsupported' ? 400 : 503).send({ error: friendlyPspMessage(err), code: `psp_${err.kind}` });
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, code: err.code });
    if (err?.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message, code: err.code ?? 'bad_request' });
    app.log.error(err);
    return reply.status(500).send({ error: 'Something went wrong on our side. Please try again.', code: 'internal' });
  });

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
