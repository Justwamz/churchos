import type { FastifyInstance } from 'fastify';
import { toCents } from '@churchos/shared';
import { normalizePhone } from '../auth';
import { HttpError, requireAdmin, requireSession, staffScope, type Ctx } from '../ctx';
import { LOW_BALANCE_MESSAGES, notify, SMS_RATE_CENTS } from '../sms';

export function smsRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };
  const adm = { preHandler: requireAdmin };

  async function walletOf(orgId: string) {
    const org = (await ctx.db.query<any>(`SELECT id, name, sms_code FROM organisations WHERE id=$1`, [orgId]))[0];
    const balance = await ctx.ledger.smsBalance(orgId);
    const messagesLeft = Math.floor(balance / SMS_RATE_CENTS);
    return {
      org: { id: org.id, name: org.name },
      balance,
      rate: SMS_RATE_CENTS,
      messagesLeft,
      low: messagesLeft < LOW_BALANCE_MESSAGES,
      empty: messagesLeft === 0,
      lowThreshold: LOW_BALANCE_MESSAGES,
      paybillReference: org.sms_code ? `SMS#${org.sms_code}` : null,
    };
  }

  app.get('/sms/wallet', auth, async (req) => {
    const scope = await staffScope(ctx, req, 'sms.manage');
    const messages = await ctx.db.query<any>(`SELECT id, to_phone, kind, body, cost, status, created_at FROM sms_messages WHERE org_id=$1 ORDER BY created_at DESC LIMIT 100`, [scope.orgId]);
    const topups = await ctx.db.query<any>(`SELECT id, amount, status, created_at FROM sms_topups WHERE org_id=$1 ORDER BY created_at DESC LIMIT 20`, [scope.orgId]);
    return { ...(await walletOf(scope.orgId)), messages, topups };
  });

  /** Tops up by STK push. The payment lands in the shared paybill with a SMS# reference and is credited to the wallet, never to collections (L58). */
  app.post('/sms/topup', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const scope = await staffScope(ctx, req, 'sms.manage');
    const phone = normalizePhone(b.phone);
    if (!phone) throw new HttpError(400, 'Enter a valid Kenyan phone number', 'bad_phone');
    let amount: number;
    try { amount = toCents(b.amount); } catch { throw new HttpError(400, 'Enter an amount', 'bad_amount'); }
    if (amount < 10000) throw new HttpError(400, 'The minimum top-up is KES 100', 'amount_too_small');
    if (amount > 5_000_000) throw new HttpError(400, 'The maximum top-up is KES 50,000', 'amount_too_large');
    const org = (await ctx.db.query<any>(`SELECT sms_code FROM organisations WHERE id=$1`, [scope.orgId]))[0];
    if (!org?.sms_code) throw new HttpError(409, 'This church has no SMS wallet code yet', 'no_wallet');
    const { providerTxId } = await ctx.provider.initiateStkPush({ phone, amount, reference: `SMS#${org.sms_code}`, method: 'mpesa' });
    const id = ctx.newId('top');
    await ctx.db.query(`INSERT INTO sms_topups (id, provider_tx_id, org_id, amount, phone, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [id, providerTxId, scope.orgId, amount, phone, ctx.clock.now().toISOString()]);
    return { id, status: 'initiated', message: `Check ${phone.replace(/^254/, '0')} and enter your PIN to complete the top-up.` };
  });

  app.get('/sms/topup/:id', auth, async (req) => {
    const scope = await staffScope(ctx, req, 'sms.manage');
    const t = (await ctx.db.query<any>(`SELECT id, status, amount FROM sms_topups WHERE id=$1 AND org_id=$2`, [(req.params as any).id, scope.orgId]))[0];
    if (!t) throw new HttpError(404, 'top-up not found', 'not_found');
    return t;
  });

  /** Sends reminders to members whose pledge is not fully paid (L41, L56). */
  app.post('/projects/:id/remind', auth, async (req) => {
    const scope = await staffScope(ctx, req, 'projects.manage');
    const p = (await ctx.db.query<any>(`SELECT p.*, b.name AS branch_name FROM projects p JOIN branches b ON b.id=p.branch_id WHERE p.id=$1`, [(req.params as any).id]))[0];
    if (!p || !scope.branchIds.includes(p.branch_id)) throw new HttpError(404, 'project not found', 'not_found');
    const rows = await ctx.db.query<any>(
      `SELECT pl.id, pl.amount, m.phone, m.full_name,
              COALESCE((SELECT SUM(net) FROM payments WHERE project_id=pl.project_id AND member_id=pl.membership_id AND stage IN ('pending','available','paid_out')),0) AS paid
         FROM pledges pl JOIN memberships m ON m.id=pl.membership_id WHERE pl.project_id=$1 AND m.phone IS NOT NULL`,
      [p.id],
    );
    const code = (await ctx.db.query<any>(`SELECT code FROM branches WHERE id=$1`, [p.branch_id]))[0].code;
    let sent = 0, skipped = 0, none = 0;
    for (const r of rows) {
      const left = Number(r.amount) - Number(r.paid);
      if (left <= 0) { none++; continue; }
      const body = `Hello ${String(r.full_name).split(' ')[0]}, your pledge to ${p.name} has KES ${(left / 100).toLocaleString('en-KE')} remaining. Give at churchos.app/${code}. Thank you.`;
      const res = await notify(ctx, { orgId: p.org_id, phone: r.phone, kind: 'reminder', title: `Pledge reminder: ${p.name}`, body, idemKey: `reminder:${r.id}:${ctx.clock.now().toISOString().slice(0, 13)}` });
      if (res.sms === 'sent') sent++; else skipped++;
    }
    return { pledges: rows.length, smsSent: sent, smsSkippedNoBalance: skipped, alreadyPaid: none };
  });

  // ---------- member notifications (in-app) ----------

  app.get('/me/notifications', auth, async (req) => {
    const rows = await ctx.db.query<any>(`SELECT id, kind, title, body, read, created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.session!.uid]);
    return { unread: rows.filter((r) => !r.read).length, rows };
  });

  app.post('/me/notifications/read', auth, async (req) => {
    await ctx.db.query(`UPDATE notifications SET read=true WHERE user_id=$1`, [req.session!.uid]);
    return { ok: true };
  });

  // ---------- platform view ----------

  app.get('/admin/sms', adm, async () => {
    const orgs = await ctx.db.query<any>(`SELECT id FROM organisations ORDER BY name`);
    const wallets = [];
    for (const o of orgs) {
      const w = await walletOf(o.id);
      const c = (await ctx.db.query<any>(`SELECT COUNT(*) FILTER (WHERE status='sent') AS sent, COUNT(*) FILTER (WHERE status='skipped_no_balance') AS skipped FROM sms_messages WHERE org_id=$1`, [o.id]))[0];
      wallets.push({ ...w, sent: Number(c.sent), skipped: Number(c.skipped) });
    }
    return { rate: SMS_RATE_CENTS, revenue: await ctx.ledger.balance('sms_revenue'), wallets };
  });
}
