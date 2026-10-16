import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { Clock, createDb, Ledger, type Db } from '@churchos/ledger';
import { MockProvider } from '@churchos/payments';
import { MockEmailProvider, MockMessagingProvider } from '@churchos/messaging';
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
import { givingPlanRoutes } from './routes/giving-plans';
import { attendanceRoutes } from './routes/attendance';
import { coreRoutes, handleWebhook } from './routes/core';
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
}

export async function buildApp(opts: BuildOptions = {}) {
  const db = opts.db ?? (await createDb());
  const clock = new Clock();
  const provider = new MockProvider({ stkDelayMs: opts.stkDelayMs ?? 3000 });
  const ledger = new Ledger(db, clock, provider);
  await ledger.migrate();
  await db.exec(APP_SCHEMA);

  const ctx: Ctx = { db, ledger, provider, messaging: new MockMessagingProvider(), email: new MockEmailProvider(), givingUrl: process.env.GIVING_URL ?? 'http://localhost:3001', clock, events: new EventEmitter(), newId: (p) => `${p}_${randomUUID().slice(0, 12)}` };
  ctx.events.setMaxListeners(0);
  provider.setDeliver(async (raw, headers) => {
    try {
      await handleWebhook(ctx, raw, headers);
    } catch (e) {
      console.error('webhook failed', e);
    }
  });

  ledger.auditContext = auditContext;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 6 * 1024 * 1024, maxParamLength: 600 });
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
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, code: err.code });
    if (err?.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message, code: err.code ?? 'bad_request' });
    app.log.error(err);
    return reply.status(500).send({ error: 'Something went wrong on our side. Please try again.', code: 'internal' });
  });

  await loadHelp(db);

  coreRoutes(app, ctx);
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
  givingPlanRoutes(app, ctx);
  attendanceRoutes(app, ctx);
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
