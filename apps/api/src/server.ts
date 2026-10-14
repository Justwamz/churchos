import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { Clock, createDb, Ledger, type Db } from '@churchos/ledger';
import { MockProvider } from '@churchos/payments';
import { HttpError, type Ctx } from './ctx';
import { adminRoutes } from './routes/admin';
import { coreRoutes, handleWebhook } from './routes/core';
import { memberRoutes } from './routes/member';
import { publicRoutes } from './routes/public';
import { staffRoutes } from './routes/staff';
import { APP_SCHEMA } from './schema';

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

  const ctx: Ctx = { db, ledger, provider, clock, events: new EventEmitter(), newId: (p) => `${p}_${randomUUID().slice(0, 12)}` };
  ctx.events.setMaxListeners(0);
  provider.setDeliver(async (raw, headers) => {
    try {
      await handleWebhook(ctx, raw, headers);
    } catch (e) {
      console.error('webhook failed', e);
    }
  });

  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cors, { origin: true, methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] });

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

  coreRoutes(app, ctx);
  publicRoutes(app, ctx);
  staffRoutes(app, ctx);
  memberRoutes(app, ctx);
  adminRoutes(app, ctx);

  return { app, ctx };
}
