import type { FastifyInstance } from 'fastify';
import { HttpError, inList, requireSession, staffScope, type Ctx } from '../ctx';
import { expectedFor } from '../payment-check';

/**
 * Payments that did not match their order (too small, or more than the price), kept for staff to look at (see payment-check.ts).
 * Permission: `collections.view`, the same right as the Collections and Overview screens and the one the "payment is too small" alert is sent to.
 * Resolving is a record only: it says what was done about it, who did it and when. No money moves here; refunds go through the normal reversal request.
 */
const ACTIONS: Record<string, string> = { refunded_outside: 'Refunded outside ChurchOS', kept_as_gift: 'Kept as a gift', order_completed: 'Order completed another way', other: 'Other' };
const KIND_LABEL: Record<string, string> = { TKT: 'Event tickets', SHOP: 'Shop sale', BK: 'Booking', AD: 'Advert', CERT: 'Certificate copy' };

export function heldPaymentRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };

  app.get('/payments/held', auth, async (req) => {
    const scope = await staffScope(ctx, req, 'collections.view', (req.query as any).branch);
    const status = (req.query as any).status === 'resolved' ? 'resolved' : (req.query as any).status === 'all' ? 'all' : 'open';
    if (!scope.branchIds.length) return { rows: [], openCount: 0 };
    const ids = scope.branchIds;
    const rows = await ctx.db.query<any>(
      `SELECT h.id, h.kind, h.purpose, h.expected, h.paid, h.status, h.created_at, h.resolution, h.resolution_note, h.resolved_at, h.payment_id,
              p.provider_tx_id, p.method, p.amount_paid, b.name AS branch_name, u.name AS resolved_by_name
         FROM held_payments h JOIN payments p ON p.id=h.payment_id JOIN branches b ON b.id=p.branch_id LEFT JOIN users u ON u.id=h.resolved_by
        WHERE p.org_id=$1 AND p.branch_id IN (${inList(2, ids.length)}) ${status === 'all' ? '' : `AND h.status='${status === 'open' ? 'open' : 'resolved'}'`}
        ORDER BY h.created_at DESC LIMIT 200`,
      [scope.orgId, ...ids],
    );
    const openCount = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM held_payments h JOIN payments p ON p.id=h.payment_id WHERE h.status='open' AND p.org_id=$1 AND p.branch_id IN (${inList(2, ids.length)})`, [scope.orgId, ...ids]))[0].n);
    const out = [];
    for (const r of rows) {
      const tag = String(r.purpose ?? '').split('-')[0].toUpperCase();
      // The order's own name, when it still exists; the order of another church is never described to this one.
      const exp = await expectedFor(ctx, r.purpose, r.method).catch(() => null);
      out.push({
        id: r.id, kind: r.kind, reference: r.purpose, transactionCode: r.provider_tx_id, branch: r.branch_name,
        orderType: KIND_LABEL[tag] ?? 'Payment', what: exp && exp.orgId === scope.orgId ? exp.label : KIND_LABEL[tag] ?? 'An order',
        expected: Number(r.expected), received: Number(r.paid), difference: Number(r.paid) - Number(r.expected),
        at: r.created_at, status: r.status, resolution: r.resolution, resolutionLabel: r.resolution ? ACTIONS[r.resolution] : null, note: r.resolution_note, resolvedBy: r.resolved_by_name, resolvedAt: r.resolved_at,
      });
    }
    return { rows: out, openCount };
  });

  app.post('/payments/held/:id/resolve', auth, async (req) => {
    const scope = await staffScope(ctx, req, 'collections.view');
    const b = (req.body ?? {}) as any;
    const action = String(b.action ?? '');
    if (!ACTIONS[action]) throw new HttpError(400, 'Choose what was done about this payment', 'bad_action');
    const note = String(b.note ?? '').trim().replace(/\s+/g, ' ');
    if (note.length > 500) throw new HttpError(400, 'The note can be at most 500 characters', 'bad_content');
    if (action === 'other' && !note) throw new HttpError(400, 'Add a short note about what was done', 'bad_content');
    const id = String((req.params as any).id);
    const h = (await ctx.db.query<any>(
      `SELECT h.*, p.org_id, p.branch_id, p.provider_tx_id FROM held_payments h JOIN payments p ON p.id=h.payment_id WHERE h.id=$1`, [id]))[0];
    // Out of scope reads as missing, never forbidden.
    if (!h || h.org_id !== scope.orgId || !scope.branchIds.includes(h.branch_id)) throw new HttpError(404, 'That payment was not found', 'not_found');
    if (h.status !== 'open') throw new HttpError(409, 'This payment was already marked as dealt with', 'already_resolved');
    const claimed = await ctx.db.query<any>(
      `UPDATE held_payments SET status='resolved', resolution=$2, resolution_note=$3, resolved_by=$4, resolved_at=$5 WHERE id=$1 AND status='open' RETURNING id`,
      [id, action, note || null, req.session!.uid, ctx.clock.now().toISOString()],
    );
    if (!claimed.length) throw new HttpError(409, 'This payment was already marked as dealt with', 'already_resolved');
    await ctx.ledger.audit({
      orgId: h.org_id, branchId: h.branch_id, actor: req.session!.uid, action: 'payment.held_resolved', category: 'money', entity: 'payment', entityId: h.payment_id,
      summary: `Marked a ${h.kind} payment (${h.provider_tx_id}, ${h.purpose}) as dealt with: ${ACTIONS[action]}`, reason: note || null, links: { paymentId: h.payment_id }, meta: { heldId: id, action },
    });
    // Clear the alert for everyone it was sent to.
    await ctx.db.query(`UPDATE notifications SET deleted_at=$2, read=true WHERE link=$1 AND deleted_at IS NULL`, [`staff:held-payments?id=${id}`, ctx.clock.now().toISOString()]);
    return { ok: true };
  });
}
