import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PSP_HEADER, PSP_IP_HEADER, PSP_TOKEN_HEADER, isMock, type PspName, type Provider } from '@churchos/payments';
import type { Db } from '@churchos/ledger';
import { HttpError, type Ctx } from '../ctx';
import { handleWebhook } from './core';

/**
 * Wraps a live provider so every prompt or checkout it starts is remembered (reference and amount, by the provider's transaction id).
 * Callbacks from M-Pesa STK and Airtel do not repeat the church reference, so handleWebhook reads it back from here.
 */
export function withInitiationLog(p: Provider, db: Db, now: () => string): Provider {
  if (isMock(p)) return p;
  const save = (providerTxId: string, reference: string, amount: number, method: string) =>
    db.query(`INSERT INTO psp_refs (provider_tx_id, reference, amount, method, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (provider_tx_id) DO NOTHING`, [providerTxId, reference, amount, method, now()]);
  return new Proxy(p, {
    get(target, prop, recv) {
      if (prop === 'initiateStkPush') {
        return async (req: any) => {
          const r = await target.initiateStkPush(req);
          await save(r.providerTxId, req.reference, req.amount, req.method);
          return r;
        };
      }
      if (prop === 'initiateCardCheckout') {
        return async (req: any) => {
          const r = await target.initiateCardCheckout(req);
          await save(r.providerTxId, req.reference, req.amount, 'card');
          return r;
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

const raw = (req: FastifyRequest) => String((req as any).rawBody ?? JSON.stringify(req.body ?? {}));

function pspHeaders(req: FastifyRequest, psp: PspName, token?: string): Record<string, string | undefined> {
  const h: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) h[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  // Set last, so a caller can never supply these itself.
  h[PSP_HEADER] = psp;
  h[PSP_TOKEN_HEADER] = token;
  h[PSP_IP_HEADER] = req.ip;
  return h;
}

const DARAJA_OK = { ResultCode: 0, ResultDesc: 'Accepted' };

/** Settles a payout the PSP reported on, or flags a refund that failed after being accepted. Idempotent. */
async function applyOutcome(ctx: Ctx, headers: Record<string, string | undefined>, body: string) {
  const o = ctx.provider.parseOutcome?.(headers, body);
  if (!o) return false;
  if (o.kind === 'payout') {
    await ctx.ledger.settlePayout(o.id, o.ok);
  } else if (!o.ok) {
    // The refund was accepted earlier and the books already show it as reversed, so the money still has to reach the person by hand.
    await ctx.ledger.audit({ actorType: 'psp', action: 'refund.failed_later', category: 'money', entity: 'refund', entityId: o.id, summary: 'A refund the payment provider had accepted failed afterwards. The person has not been paid back and it needs to be sent by hand.', meta: { ref: o.id } });
  }
  return true;
}

export function pspWebhookRoutes(app: FastifyInstance, ctx: Ctx) {
  const fail = (e: unknown): never => {
    if (e instanceof HttpError) throw e;
    // Never echo details to the caller or log the body (it holds phone numbers).
    console.error('psp webhook failed', (e as Error)?.message);
    throw new HttpError(500, 'could not process', 'webhook_failed');
  };

  // Daraja: no signature exists, so the secret token in the path (and an optional IP allowlist) is the check.
  // The path says daraja, not mpesa, because Daraja refuses to register URLs containing words such as mpesa or safaricom.
  for (const kind of ['stk', 'c2b'] as const) {
    app.post(`/webhooks/daraja/:token/${kind}`, async (req) => {
      try {
        await handleWebhook(ctx, raw(req), pspHeaders(req, 'mpesa', (req.params as any).token));
      } catch (e) {
        fail(e);
      }
      return DARAJA_OK;
    });
  }
  // C2B validation happens before the money moves and nothing is recorded: just say yes (a wrong token still gets a 401).
  app.post('/webhooks/daraja/:token/c2b-validate', async (req) => {
    if (!ctx.provider.verifyWebhook(pspHeaders(req, 'mpesa', (req.params as any).token), raw(req))) throw new HttpError(401, 'invalid token', 'bad_signature');
    return DARAJA_OK;
  });
  app.post('/webhooks/daraja/:token/result', async (req) => {
    const h = pspHeaders(req, 'mpesa', (req.params as any).token);
    if (!ctx.provider.verifyWebhook(h, raw(req))) throw new HttpError(401, 'invalid token', 'bad_signature');
    try {
      await applyOutcome(ctx, h, raw(req));
    } catch (e) {
      fail(e);
    }
    return DARAJA_OK;
  });

  app.post('/webhooks/airtel/:token', async (req) => {
    try {
      await handleWebhook(ctx, raw(req), pspHeaders(req, 'airtel', (req.params as any).token));
    } catch (e) {
      fail(e);
    }
    return { ok: true };
  });

  app.post('/webhooks/paystack', async (req) => {
    const h = pspHeaders(req, 'paystack');
    try {
      if (!ctx.provider.verifyWebhook(h, raw(req))) throw new HttpError(401, 'invalid signature', 'bad_signature');
      if (!(await applyOutcome(ctx, h, raw(req)))) await handleWebhook(ctx, raw(req), h);
    } catch (e) {
      fail(e);
    }
    return { ok: true };
  });
}
