import type { FastifyInstance } from 'fastify';
import { maskPhone } from '@churchos/shared';
import { diff, type FieldSpec } from '../audit';
import { HttpError, requireAdmin, type Ctx } from '../ctx';
import { addNotification } from '../notifications';

const SPECS: Record<string, FieldSpec> = {
  sms_sender: { field: 'smsSenderId', label: 'SMS sender name' },
  whatsapp_display: { field: 'whatsappDisplayName', label: 'WhatsApp display name' },
  whatsapp_number: { field: 'whatsappNumber', label: 'WhatsApp number', mask: 'phone' },
};

/**
 * Platform-side messaging: who the providers are, and approval of the sender names and numbers churches ask for (L128).
 * Provider names and credentials appear only here, never in a church-facing response.
 */
export function providerRoutes(app: FastifyInstance, ctx: Ctx) {
  const adm = { preHandler: requireAdmin };

  app.get('/admin/providers', adm, async () => {
    const sentSms = ctx.messaging.count('sms');
    const sentWa = ctx.messaging.count('whatsapp');
    return [
      { channel: 'sms', name: process.env.MESSAGING_MODE === 'live' ? 'Onfon Mobile' : 'Simulated SMS aggregator', status: 'connected', mode: process.env.MESSAGING_MODE === 'live' ? 'live' : 'development', credentials: { apiKey: 'sk_sim_••••••3f9a', senderPool: 'shared short code' }, sentSinceStart: sentSms },
      { channel: 'whatsapp', name: 'Simulated WhatsApp Business provider', status: 'connected', mode: 'development', credentials: { apiKey: 'wa_sim_••••••71c2', template: 'church_notice (approved)' }, sentSinceStart: sentWa },
      { channel: 'email', name: process.env.EMAIL_MODE === 'live' ? 'Resend' : 'Simulated email provider', status: 'connected', mode: process.env.EMAIL_MODE === 'live' ? 'live' : 'development', credentials: { apiKey: 'em_sim_••••••90bd' }, sentSinceStart: ctx.email.sent.length },
    ];
  });

  app.get('/admin/sender-requests', adm, async (req) => {
    const status = (req.query as any).status ? String((req.query as any).status).split(',') : null;
    const rows = await ctx.db.query<any>(
      `SELECT r.*, o.name AS org_name, b.name AS branch_name, u.name AS requested_by_name FROM sender_requests r JOIN organisations o ON o.id=r.org_id LEFT JOIN branches b ON b.id=r.branch_id LEFT JOIN users u ON u.id=r.requested_by
        ${status ? 'WHERE r.status = ANY($1::text[])' : ''} ORDER BY r.created_at DESC LIMIT 200`,
      status ? [status] : [],
    );
    return rows.map((r) => ({ ...r, value: r.kind === 'whatsapp_number' ? maskPhone(r.value) : r.value }));
  });

  app.post('/admin/sender-requests/:id/decide', adm, async (req) => {
    const b = (req.body ?? {}) as any;
    const r = (await ctx.db.query<any>(`SELECT * FROM sender_requests WHERE id=$1`, [(req.params as any).id]))[0];
    if (!r) throw new HttpError(404, 'request not found', 'not_found');
    if (r.status !== 'pending') throw new HttpError(409, 'This request was already decided', 'already_decided');
    const approve = b.approve !== false;
    const reason = String(b.reason ?? '').trim();
    if (!approve && !reason) throw new HttpError(400, 'Give a reason so the church knows what to change', 'reason_required');
    const now = ctx.clock.now().toISOString();
    await ctx.db.query(`UPDATE sender_requests SET status=$2, reason=$3, decided_by=$4, decided_at=$5 WHERE id=$1`, [r.id, approve ? 'approved' : 'rejected', approve ? null : reason, req.session!.uid, now]);
    const spec = SPECS[r.kind];
    let changes: any[] = [];
    if (approve) {
      if (r.branch_id) {
        const cur = (await ctx.db.query<any>(`SELECT sms_sender_id, whatsapp_number FROM branch_integrations WHERE branch_id=$1`, [r.branch_id]))[0] ?? {};
        const col = r.kind === 'sms_sender' ? 'sms_sender_id' : 'whatsapp_number';
        await ctx.db.query(`INSERT INTO branch_integrations (branch_id, org_id, ${col}) VALUES ($1,$2,$3) ON CONFLICT (branch_id) DO UPDATE SET ${col}=$3`, [r.branch_id, r.org_id, r.value]);
        changes = diff([spec], { [spec.field]: cur[col] ?? null }, { [spec.field]: r.value });
      } else {
        const col = r.kind === 'sms_sender' ? 'sms_sender_id' : r.kind === 'whatsapp_display' ? 'whatsapp_display_name' : 'whatsapp_number';
        const cur = (await ctx.db.query<any>(`SELECT ${col} AS v FROM integration_settings WHERE org_id=$1`, [r.org_id]))[0];
        await ctx.db.query(`UPDATE integration_settings SET ${col}=$2 WHERE org_id=$1`, [r.org_id, r.value]);
        changes = diff([spec], { [spec.field]: cur?.v ?? null }, { [spec.field]: r.value });
      }
    }
    await ctx.ledger.audit({ orgId: r.org_id, branchId: r.branch_id, actor: req.session!.uid, action: approve ? 'integration.sender_approved' : 'integration.sender_rejected', category: 'config', entity: 'sender_request', entityId: r.id, summary: `${approve ? 'Approved' : 'Rejected'} a ${spec.label.toLowerCase()}`, reason: approve ? null : reason, changes });
    // Tell the person who asked.
    await addNotification(ctx, {
      orgId: r.org_id, userId: r.requested_by, kind: 'announcement', title: approve ? `Your ${spec.label.toLowerCase()} was approved` : `Your ${spec.label.toLowerCase()} was not approved`,
      body: approve ? `ChurchOS approved ${r.kind === 'whatsapp_number' ? 'the WhatsApp number' : '"' + r.value + '"'}. It is now in use.` : `ChurchOS could not approve it: ${reason}`, link: 'staff:integrations', audience: 'staff',
    });
    return { id: r.id, status: approve ? 'approved' : 'rejected' };
  });
}
