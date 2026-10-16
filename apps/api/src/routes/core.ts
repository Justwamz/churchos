import { planRunPaid } from './giving-plans';
import { advertPaid } from './adverts';
import { bookingPaid } from './bookings';
import { shopPaid } from './shop';
import { ticketsPaid } from './tickets';
import type { FastifyInstance } from 'fastify';
import { maskPhone } from '@churchos/shared';
import { normalizePhone, signToken } from '../auth';
import { HttpError, type Ctx } from '../ctx';
import { notify } from '../sms';
import { checkLowBalance } from '../wallets';

const DEV_OTP = '123456';
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60_000;
const attempts = new Map<string, { n: number; until: number }>();

/** Called for every inbound PSP notification: verify, post to the ledger, link to member and project, notify live dashboards. */
export async function handleWebhook(ctx: Ctx, rawBody: string, headers: Record<string, string | undefined>) {
  if (!ctx.provider.verifyWebhook(headers, rawBody)) throw new HttpError(401, 'invalid signature', 'bad_signature');
  const parsed = ctx.provider.parseWebhook(rawBody);
  const inb = { ...parsed, phone: normalizePhone(parsed.phone) ?? parsed.phone };
  // A reference starting with SMS# or WA# is a messaging wallet top-up, never a church collection (L58, L116).
  const ref = inb.reference.trim().toUpperCase();
  const walletRef = /^(SMS|WA)#(.+)$/.exec(ref);
  if (walletRef) {
    const channel = walletRef[1] === 'SMS' ? 'sms' : 'whatsapp';
    const wallet = (await ctx.db.query<any>(`SELECT id, org_id FROM wallets WHERE channel=$1 AND code=$2`, [channel, walletRef[2].trim()]))[0];
    if (wallet) {
      const r = await ctx.ledger.receiveWalletTopup(wallet.id, wallet.org_id, inb);
      if (r === 'credited') {
        await ctx.db.query(`UPDATE wallet_topups SET status='completed' WHERE provider_tx_id=$1`, [inb.providerTxId]);
        await checkLowBalance(ctx, wallet.id); // a top-up above the warning level re-arms the alert
        await ctx.ledger.audit({ orgId: wallet.org_id, actorType: 'psp', action: 'wallet.topup', category: 'money', entity: 'wallet', entityId: wallet.id, summary: `Wallet top-up of KES ${(inb.amount / 100).toLocaleString('en-KE')} received by ${inb.method === 'card' ? 'card' : 'M-Pesa'}`, links: { walletId: wallet.id, ledgerEntry: `wallettopup:${inb.providerTxId}` }, meta: { amount: inb.amount, method: inb.method } });
      }
      ctx.events.emit('wallet_topup', { walletId: wallet.id });
      return { status: r === 'credited' ? ('wallet_topup' as const) : ('duplicate' as const), paymentId: inb.providerTxId };
    }
    // Unknown wallet code: falls through and is held in suspense like any unmatched payment.
  }
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
    // A regular gift counts for the member who set it up, even when they pay from a different number.
    const planMember = intent?.plan_run_id ? (await ctx.db.query<any>(`SELECT p.membership_id FROM giving_plan_runs r JOIN giving_plans p ON p.id=r.plan_id WHERE r.id=$1`, [intent.plan_run_id]))[0]?.membership_id : null;
    await ctx.db.query(`UPDATE payments SET member_id = $2, project_id = $3 WHERE id = $1`, [result.paymentId, planMember ?? m?.id ?? null, projectId]);
    if (String(p.purpose ?? '').startsWith('CERT-')) {
      const rec = (await ctx.db.query<any>(`SELECT id, subject_name FROM sacramental_records WHERE serial=$1`, [String(p.purpose).slice(5)]))[0];
      const issue = rec ? (await ctx.db.query<any>(`SELECT id, requested_by FROM record_issues WHERE record_id=$1 AND status='awaiting_payment' ORDER BY created_at DESC LIMIT 1`, [rec.id]))[0] : null;
      if (issue) {
        await ctx.db.query(`UPDATE record_issues SET status='issued', payment_id=$2 WHERE id=$1`, [issue.id, result.paymentId]);
        await ctx.db.query(`INSERT INTO notifications (id, org_id, user_id, kind, title, body, created_at) VALUES ($1,$2,$3,'announcement','Your certificate copy is ready',$4,$5)`, [
          ctx.newId('ntf'), p.org_id, issue.requested_by, `Payment received. The copy of the certificate for ${rec.subject_name} is ready to print.`, ctx.clock.now().toISOString(),
        ]);
      }
    }
    if (String(p.purpose ?? '').startsWith('TKT-')) await ticketsPaid(ctx, String(p.purpose).slice(4), result.paymentId);
    if (String(p.purpose ?? '').startsWith('SHOP-')) await shopPaid(ctx, String(p.purpose).slice(5), result.paymentId);
    if (String(p.purpose ?? '').startsWith('BK-')) await bookingPaid(ctx, String(p.purpose).slice(3), result.paymentId);
    if (String(p.purpose ?? '').startsWith('AD-')) await advertPaid(ctx, String(p.purpose).slice(3), result.paymentId);
    // Receipt by in-app notification, and by SMS when the church's wallet can pay for it (L56, L59).
    const info = (await ctx.db.query<any>(`SELECT b.name AS church, p.amount_paid, p.provider_tx_id FROM payments p JOIN branches b ON b.id=p.branch_id WHERE p.id=$1`, [result.paymentId]))[0];
    try {
      await notify(ctx, {
        orgId: p.org_id, branchId: result.branchId, phone: inb.phone, kind: 'receipt', idemKey: `receipt:${inb.providerTxId}`,
        title: 'Gift received',
        body: `Received KES ${(Number(info.amount_paid) / 100).toLocaleString('en-KE')} for ${String(p.purpose ?? 'OFFERING').toLowerCase().replace('proj-', 'project ')} at ${info.church}. Ref ${info.provider_tx_id}. God bless you.`,
      });
    } catch (e) {
      console.error('receipt notification failed', e);
    }
  }
  if (intent) {
    await ctx.db.query(`UPDATE give_intents SET status = $2, payment_id = $3 WHERE id = $1`, [
      intent.id,
      result.status === 'matched' ? 'completed' : 'failed',
      result.paymentId,
    ]);
    if (intent.plan_run_id && result.status === 'matched') await planRunPaid(ctx, intent.plan_run_id, result.paymentId);
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
    if (lock && lock.until > Date.now() && lock.n >= MAX_ATTEMPTS) {
      await ctx.ledger.audit({ action: 'security.login_locked', category: 'security', summary: 'Too many wrong codes, sign-in locked for 15 minutes', meta: { phone: maskPhone(phone) } });
      throw new HttpError(429, 'Too many attempts, try again in 15 minutes', 'rate_limited');
    }
    const user = (await ctx.db.query<any>(`SELECT * FROM users WHERE phone = $1`, [phone]))[0];
    if (String(body.code) !== DEV_OTP || !user) {
      const cur = lock && lock.until > Date.now() ? lock : { n: 0, until: Date.now() + LOCK_MS };
      attempts.set(phone, { n: cur.n + 1, until: cur.until });
      await ctx.ledger.audit({ action: 'security.login_failed', category: 'security', summary: user ? 'Wrong sign-in code' : 'Sign-in with an unknown number', actorType: 'system', meta: { phone: maskPhone(phone), attempt: cur.n + 1, knownNumber: !!user } });
      throw new HttpError(401, 'That code is not correct', 'bad_code');
    }
    attempts.delete(phone);
    await ctx.ledger.audit({ action: 'security.login', category: 'security', actorId: user.id, actorName: user.name, actorType: user.is_platform_admin ? 'admin' : 'user', summary: `${user.name} signed in`, meta: { phone: maskPhone(phone) } });
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
