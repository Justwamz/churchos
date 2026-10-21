import { planRunPaid } from './giving-plans';
import { appendGift } from './giving-ledger';
import { advertPaid } from './adverts';
import { bookingPaid } from './bookings';
import { shopPaid } from './shop';
import { ticketsPaid } from './tickets';
import type { FastifyInstance } from 'fastify';
import { buildReference } from '@churchos/shared';
import { normalizePhone } from '../auth';
import { authRoutes } from './auth-routes';
import { HttpError, type Ctx } from '../ctx';
import { addNotification } from '../notifications';
import { notify } from '../sms';
import { checkLowBalance } from '../wallets';
import { checkPayment } from '../payment-check';
import { isMock } from '@churchos/payments';

/** Called for every inbound PSP notification: verify, post to the ledger, link to member and project, notify live dashboards. */
export async function handleWebhook(ctx: Ctx, rawBody: string, headers: Record<string, string | undefined>) {
  if (!ctx.provider.verifyWebhook(headers, rawBody)) throw new HttpError(401, 'invalid signature', 'bad_signature');
  const parsed = ctx.provider.parseWebhook(rawBody, headers);
  // A live provider sends events that are not a received payment (failed prompts, transfer results): acknowledged and ignored.
  if (!parsed) return { status: 'ignored' as const };
  const intent = (await ctx.db.query<any>(`SELECT * FROM give_intents WHERE provider_tx_id = $1`, [parsed.providerTxId]))[0];
  // M-Pesa STK and Airtel callbacks carry no church reference (Airtel no amount or phone either), so they are matched back to what we
  // asked for when the prompt was sent, the same way a simulated payment arrives with its reference.
  if (!parsed.reference || parsed.amount <= 0) {
    const asked = (await ctx.db.query<any>(`SELECT reference, amount FROM psp_refs WHERE provider_tx_id = $1`, [parsed.providerTxId]))[0];
    if (!parsed.reference) {
      if (asked) parsed.reference = asked.reference;
      else if (intent) {
        const br = (await ctx.db.query<any>(`SELECT code FROM branches WHERE id = $1`, [intent.branch_id]))[0];
        if (br) parsed.reference = buildReference(br.code, intent.purpose);
      }
    }
    if (parsed.amount <= 0) {
      const amt = asked ? Number(asked.amount) : intent ? Number(intent.amount_paid) : 0;
      if (amt <= 0) return { status: 'ignored' as const }; // a success callback we never asked for
      parsed.amount = amt;
    }
    if (!parsed.phone && intent?.phone) parsed.phone = intent.phone;
  }
  // Callbacks that cannot be signed (Airtel) or carry no amount are checked with the provider itself before any money is posted.
  if (ctx.provider.confirmInbound && !(await ctx.provider.confirmInbound(headers, parsed))) return { status: 'ignored' as const };
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
    const anon = !!intent?.anonymous;
    const planMember = !anon && intent?.plan_run_id ? (await ctx.db.query<any>(`SELECT p.membership_id FROM giving_plan_runs r JOIN giving_plans p ON p.id=r.plan_id WHERE r.id=$1`, [intent.plan_run_id]))[0]?.membership_id : null;
    await ctx.db.query(`UPDATE payments SET member_id = $2, project_id = $3 WHERE id = $1`, [result.paymentId, anon ? null : planMember ?? m?.id ?? null, projectId]);
    if (anon) {
      // The church never sees who gave: the number is removed from the payment and kept only in anonymous_gifts.
      await ctx.db.query(`UPDATE payments SET anonymous=true, payer_phone=NULL WHERE id=$1`, [result.paymentId]);
      await ctx.db.query(`UPDATE anonymous_gifts SET payment_id=$2 WHERE intent_id=$1`, [intent.id, result.paymentId]);
    } else {
      await appendGift(ctx, result.paymentId);
    }
    // LG-01: an order is fulfilled only when what was paid covers it. A short payment stays on the books, is recorded and announced, and the
    // order keeps waiting (see payment-check.ts).
    const gate = await checkPayment(ctx, result.paymentId);
    if (gate.fulfil && String(p.purpose ?? '').startsWith('CERT-')) {
      const rec = (await ctx.db.query<any>(`SELECT id, subject_name FROM sacramental_records WHERE serial=$1`, [String(p.purpose).slice(5)]))[0];
      const issue = rec ? (await ctx.db.query<any>(`SELECT id, requested_by FROM record_issues WHERE record_id=$1 AND status='awaiting_payment' ORDER BY created_at DESC LIMIT 1`, [rec.id]))[0] : null;
      if (issue) {
        await ctx.db.query(`UPDATE record_issues SET status='issued', payment_id=$2 WHERE id=$1`, [issue.id, result.paymentId]);
        await addNotification(ctx, { orgId: p.org_id, userId: issue.requested_by, kind: 'announcement', title: 'Your certificate copy is ready', body: `Payment received. The copy of the certificate for ${rec.subject_name} is ready to print.` });
      }
    }
    if (gate.fulfil && String(p.purpose ?? '').startsWith('TKT-')) await ticketsPaid(ctx, String(p.purpose).slice(4), result.paymentId);
    if (gate.fulfil && String(p.purpose ?? '').startsWith('SHOP-')) await shopPaid(ctx, String(p.purpose).slice(5), result.paymentId);
    if (gate.fulfil && String(p.purpose ?? '').startsWith('BK-')) await bookingPaid(ctx, String(p.purpose).slice(3), result.paymentId);
    if (gate.fulfil && String(p.purpose ?? '').startsWith('AD-')) await advertPaid(ctx, String(p.purpose).slice(3), result.paymentId);
    // Receipt by in-app notification, and by SMS when the church's wallet can pay for it (L56, L59).
    const info = (await ctx.db.query<any>(`SELECT b.name AS church, p.amount_paid, p.provider_tx_id FROM payments p JOIN branches b ON b.id=p.branch_id WHERE p.id=$1`, [result.paymentId]))[0];
    try {
      await notify(ctx, {
        orgId: p.org_id, branchId: result.branchId, phone: inb.phone, kind: 'receipt', idemKey: `receipt:${inb.providerTxId}`,
        title: 'Gift received',
        body: `Received KES ${(Number(info.amount_paid) / 100).toLocaleString('en-KE')} for ${String(p.purpose ?? 'OFFERING').toLowerCase().replace('proj-', 'project ')} at ${info.church}. Ref ${info.provider_tx_id}. God bless you.`,
        link: 'member:give?sub=history',
        sms: !anon, // an anonymous gift: the in-app receipt stays, but no SMS row or reference carries the giver's number (LG-09)
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
  app.get('/health', async () => (process.env.NODE_ENV === 'production' ? { ok: true } : { ok: true, time: ctx.clock.now().toISOString() }));

  // Sign-in, sessions and download tickets live in auth-routes.ts.
  authRoutes(app, ctx);

  // Raw body is needed to verify the PSP signature.
  // The simulator's own endpoint: it exists only while the provider is the simulator. With a live provider this route is gone (404), and the
  // caller can never choose which provider checks the request: x-psp, x-psp-token and x-psp-ip are only set by the /webhooks/* routes.
  app.post('/psp/webhook', { config: { rawBody: true } }, async (req, reply) => {
    if (!isMock(ctx.provider)) throw new HttpError(404, 'Not found', 'not_found');
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const headers: Record<string, string | undefined> = { ...(req.headers as any) };
    for (const h of ['x-psp', 'x-psp-token', 'x-psp-ip']) delete headers[h];
    const result = await handleWebhook(ctx, (req as any).rawBody ?? raw, headers);
    return reply.send({ ok: true, status: result.status });
  });
}
