import type { FastifyInstance } from 'fastify';
import { normalizePhone, signToken } from '../auth';
import { HttpError, type Ctx } from '../ctx';

const DEV_OTP = '123456';
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60_000;
const attempts = new Map<string, { n: number; until: number }>();

/** Called for every inbound PSP notification: verify, post to the ledger, link to member and project, notify live dashboards. */
export async function handleWebhook(ctx: Ctx, rawBody: string, headers: Record<string, string | undefined>) {
  if (!ctx.provider.verifyWebhook(headers, rawBody)) throw new HttpError(401, 'invalid signature', 'bad_signature');
  const parsed = ctx.provider.parseWebhook(rawBody);
  const inb = { ...parsed, phone: normalizePhone(parsed.phone) ?? parsed.phone };
  const intent = (await ctx.db.query<any>(`SELECT * FROM give_intents WHERE provider_tx_id = $1`, [inb.providerTxId]))[0];
  const result = await ctx.ledger.receivePayment(inb, intent?.fee);
  if (result.status === 'duplicate') return result;

  if (result.status === 'matched') {
    const p = (await ctx.db.query<any>(`SELECT org_id, purpose FROM payments WHERE id = $1`, [result.paymentId]))[0];
    const m = (
      await ctx.db.query<any>(`SELECT id FROM memberships WHERE org_id = $1 AND phone = $2 AND status = 'active' LIMIT 1`, [p.org_id, inb.phone])
    )[0];
    let projectId: string | null = intent?.project_id ?? null;
    if (!projectId && p.purpose?.startsWith('PROJ-')) {
      const proj = (await ctx.db.query<any>(`SELECT id FROM projects WHERE branch_id = $1 AND code = $2`, [result.branchId, p.purpose.slice(5)]))[0];
      projectId = proj?.id ?? null;
    }
    await ctx.db.query(`UPDATE payments SET member_id = $2, project_id = $3 WHERE id = $1`, [result.paymentId, m?.id ?? null, projectId]);
  }
  if (intent) {
    await ctx.db.query(`UPDATE give_intents SET status = $2, payment_id = $3 WHERE id = $1`, [
      intent.id,
      result.status === 'matched' ? 'completed' : 'failed',
      result.paymentId,
    ]);
  }
  ctx.events.emit('payment', { paymentId: result.paymentId, status: result.status, branchId: result.status === 'matched' ? result.branchId : null });
  return result;
}

export function coreRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/health', async () => ({ ok: true, time: ctx.clock.now().toISOString(), clockOffsetHours: ctx.clock.offsetHours }));

  app.post('/auth/otp/request', async (req) => {
    const phone = normalizePhone((req.body as any)?.phone);
    if (!phone) throw new HttpError(400, 'Enter a valid Kenyan phone number', 'bad_phone');
    const user = (await ctx.db.query<any>(`SELECT id FROM users WHERE phone = $1`, [phone]))[0];
    // The response is identical whether or not the number is registered, so numbers cannot be probed.
    return { sent: true, ...(process.env.NODE_ENV === 'production' ? {} : { devCode: DEV_OTP, known: !!user }) };
  });

  app.post('/auth/otp/verify', async (req) => {
    const body = (req.body ?? {}) as any;
    const phone = normalizePhone(body.phone);
    if (!phone) throw new HttpError(400, 'Enter a valid Kenyan phone number', 'bad_phone');
    const lock = attempts.get(phone);
    if (lock && lock.until > Date.now() && lock.n >= MAX_ATTEMPTS) throw new HttpError(429, 'Too many attempts, try again in 15 minutes', 'rate_limited');
    const user = (await ctx.db.query<any>(`SELECT * FROM users WHERE phone = $1`, [phone]))[0];
    if (String(body.code) !== DEV_OTP || !user) {
      const cur = lock && lock.until > Date.now() ? lock : { n: 0, until: Date.now() + LOCK_MS };
      attempts.set(phone, { n: cur.n + 1, until: cur.until });
      throw new HttpError(401, 'That code is not correct', 'bad_code');
    }
    attempts.delete(phone);
    const token = signToken({ uid: user.id, phone, name: user.name, isAdmin: user.is_platform_admin });
    return { token, user: { id: user.id, name: user.name, phone, isAdmin: user.is_platform_admin } };
  });

  // Raw body is needed to verify the PSP signature.
  app.post('/psp/webhook', { config: { rawBody: true } }, async (req, reply) => {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const result = await handleWebhook(ctx, (req as any).rawBody ?? raw, req.headers as any);
    return reply.send({ ok: true, status: result.status });
  });
}
