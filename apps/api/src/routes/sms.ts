import type { FastifyInstance } from 'fastify';
import { HttpError, requireSession, staffScope, type Ctx } from '../ctx';
import { notify } from '../sms';

/** Pledge reminders and a member's own notification inbox. Wallets, top-ups and messages live in wallets.ts and messages.ts. */
export function smsRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };

  /** Sends reminders to members whose pledge is not fully paid (L41, L56). Each goes in-app, and by SMS when the wallet can pay. */
  app.post('/projects/:id/remind', auth, async (req) => {
    const scope = await staffScope(ctx, req, 'projects.manage');
    const p = (await ctx.db.query<any>(`SELECT p.*, b.code AS branch_code FROM projects p JOIN branches b ON b.id=p.branch_id WHERE p.id=$1`, [(req.params as any).id]))[0];
    if (!p || !scope.branchIds.includes(p.branch_id)) throw new HttpError(404, 'project not found', 'not_found');
    const rows = await ctx.db.query<any>(
      `SELECT pl.id, pl.amount, m.phone, m.full_name,
              COALESCE((SELECT SUM(net) FROM payments WHERE project_id=pl.project_id AND member_id=pl.membership_id AND stage IN ('pending','available','paid_out')),0) AS paid
         FROM pledges pl JOIN memberships m ON m.id=pl.membership_id WHERE pl.project_id=$1 AND m.phone IS NOT NULL`,
      [p.id],
    );
    let sent = 0, skipped = 0, none = 0;
    for (const r of rows) {
      const left = Number(r.amount) - Number(r.paid);
      if (left <= 0) { none++; continue; }
      const body = `Hello ${String(r.full_name).split(' ')[0]}, your pledge to ${p.name} has KES ${(left / 100).toLocaleString('en-KE')} remaining. Give at churchos.app/${p.branch_code}. Thank you.`;
      const res = await notify(ctx, { orgId: p.org_id, branchId: p.branch_id, phone: r.phone, kind: 'reminder', title: `Pledge reminder: ${p.name}`, body, idemKey: `reminder:${r.id}:${ctx.clock.now().toISOString().slice(0, 13)}` });
      if (res.sms === 'sent') sent++; else skipped++;
    }
    return { pledges: rows.length, smsSent: sent, smsSkippedNoBalance: skipped, alreadyPaid: none };
  });

  // ---------- member notifications (in-app inbox, L56, L121) ----------

  app.get('/me/notifications', auth, async (req) => {
    const rows = await ctx.db.query<any>(`SELECT id, kind, title, body, message_id, read, created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.session!.uid]);
    return { unread: rows.filter((r) => !r.read).length, rows };
  });

  app.post('/me/notifications/read', auth, async (req) => {
    await ctx.db.query(`UPDATE notifications SET read=true WHERE user_id=$1`, [req.session!.uid]);
    return { ok: true };
  });
}
