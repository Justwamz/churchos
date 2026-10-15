import type { FastifyInstance } from 'fastify';
import { DEFAULT_FEE_SCHEDULE, toCents, type FeeSchedule } from '@churchos/shared';
import { HttpError, requireAdmin, type Ctx } from '../ctx';
import { decideReversal, listReversalRequests } from './reversals';
import { handleWebhook } from './core';
import { maskPhoneSql } from './helpers';
import { applyDuePayoutChanges } from './kyc';
import { diff, FEE_SPECS, flattenFees, maskedSnapshot, recordVersion } from '../audit';
import { runMemberHousekeeping } from '../members';
import { runScheduledMessages } from '../messages';
import { runCommunityJobs } from './community';
import { runBookingJobs } from './bookings';
import { runShopJobs } from './shop';
import { runTicketJobs } from './tickets';
import { runKidsJobs } from './kids';

function validSchedule(s: any): s is FeeSchedule {
  const rule = s?.platform;
  const okRule =
    (rule?.type === 'flat' && Number.isFinite(rule.bps) && rule.bps >= 0 && rule.bps <= 2000) ||
    (rule?.type === 'tiered' && Array.isArray(rule.tiers) && rule.tiers.length > 0 && rule.tiers.every((t: any) => Number.isFinite(t.bps) && t.bps >= 0 && t.bps <= 2000));
  if (!okRule) return false;
  for (const m of Object.keys(DEFAULT_FEE_SCHEDULE.psp)) {
    const p = s?.psp?.[m];
    if (!p || !Number.isFinite(p.bps) || !Number.isFinite(p.fixed) || p.bps < 0 || p.fixed < 0) return false;
  }
  return true;
}

export function adminRoutes(app: FastifyInstance, ctx: Ctx) {
  const adm = { preHandler: requireAdmin };
  // Testing tools exist only outside production.
  const devOnly = async () => {
    if (process.env.NODE_ENV === 'production') throw new HttpError(404, 'not found', 'not_found');
  };
  const devAdm = { preHandler: [requireAdmin, devOnly] };

  app.get('/admin/tenants', adm, async () => {
    const orgs = await ctx.db.query<any>(`SELECT * FROM organisations ORDER BY name`);
    const out = [];
    for (const o of orgs) {
      const branches = await ctx.db.query<any>(`SELECT id, code, name, region, payout_paused FROM branches WHERE org_id=$1 ORDER BY name`, [o.id]);
      const withBalances = [];
      for (const b of branches) {
        withBalances.push({
          ...b,
          pending: await ctx.ledger.balance('pending', b.id),
          available: await ctx.ledger.balance('available', b.id),
          receivable: await ctx.ledger.balance('receivable', b.id),
        });
      }
      // The messaging plan: the standard (default) tariff, or a specific one such as a volume-tiered plan (L124).
      const own = (await ctx.db.query<any>(`SELECT tariff_id FROM org_tariffs WHERE org_id=$1`, [o.id]))[0];
      const tid = own?.tariff_id ?? (await ctx.db.query<any>(`SELECT id FROM tariffs WHERE is_default LIMIT 1`))[0]?.id;
      const tr = (await ctx.db.query<any>(`SELECT t.name, t.is_default, (SELECT bands FROM tariff_versions v WHERE v.tariff_id=t.id AND v.effective_from <= $2 ORDER BY v.effective_from DESC, v.version DESC LIMIT 1) AS bands FROM tariffs t WHERE t.id=$1`, [tid, ctx.clock.now().toISOString()]))[0];
      const tiered = !!tr?.bands && (tr.bands.sms.length > 1 || tr.bands.whatsapp.length > 1);
      out.push({ id: o.id, name: o.name, feeBearer: o.fee_bearer, feeSchedule: o.fee_schedule, messagingPlan: { tariffId: tid, name: tr?.name ?? null, assigned: !!own, isDefault: !!tr?.is_default, tiered }, branches: withBalances });
    }
    return out;
  });

  app.put('/admin/tenants/:id/fees', adm, async (req) => {
    const b = (req.body ?? {}) as any;
    if (b.feeBearer !== 'church' && b.feeBearer !== 'member') throw new HttpError(400, 'Fee bearer must be church or member', 'bad_bearer');
    if (!validSchedule(b.feeSchedule)) throw new HttpError(400, 'The fee schedule is not valid', 'bad_schedule');
    const id = (req.params as any).id;
    const beforeOrg = (await ctx.db.query<any>('SELECT fee_bearer, fee_schedule FROM organisations WHERE id=$1', [id]))[0];
    const r = await ctx.db.query(`UPDATE organisations SET fee_bearer=$2, fee_schedule=$3 WHERE id=$1 RETURNING id`, [id, b.feeBearer, JSON.stringify(b.feeSchedule)]);
    if (r.length === 0) throw new HttpError(404, 'tenant not found', 'not_found');
    const afterFees = flattenFees(b.feeBearer, b.feeSchedule);
    const changes = diff(FEE_SPECS, beforeOrg ? flattenFees(beforeOrg.fee_bearer, beforeOrg.fee_schedule) : null, afterFees);
    const evt = await ctx.ledger.audit({ orgId: id, actor: req.session!.uid, action: 'fees.update', entity: 'fee_schedule', entityId: id, summary: 'Changed the fee settings', changes, reason: b.reason ? String(b.reason).slice(0, 200) : null });
    await recordVersion(ctx, { orgId: id, entity: 'fee_schedule', entityId: id, snapshot: maskedSnapshot(FEE_SPECS, afterFees), summary: changes.map((c) => c.label).join(', ') || 'Saved without changes', eventId: evt });
    return { ok: true };
  });

  // The split between platform fee and PSP cost is visible here only (L21).
  app.get('/admin/payments', adm, async (req) => {
    const q = req.query as any;
    const stage = q.stage ? String(q.stage) : null;
    return ctx.db.query<any>(
      `SELECT p.id, p.provider_tx_id, p.received_at, p.method, p.reference, p.purpose, ${maskPhoneSql('p.payer_phone')} AS payer_phone, p.amount_paid, p.net, p.platform_fee, p.psp_cost, p.stage,
              b.name AS branch_name, b.code AS branch_code
         FROM payments p LEFT JOIN branches b ON b.id=p.branch_id ${stage ? 'WHERE p.stage=$1' : ''} ORDER BY p.received_at DESC LIMIT 200`,
      stage ? [stage] : [],
    );
  });

  /** Shows the real payer number of one payment to a platform admin. Always logged (L109). */
  app.post('/admin/payments/:id/reveal', adm, async (req) => {
    const p = (await ctx.db.query<any>('SELECT id, org_id, branch_id, payer_phone, provider_tx_id FROM payments WHERE id=$1', [(req.params as any).id]))[0];
    if (!p) throw new HttpError(404, 'payment not found', 'not_found');
    await ctx.ledger.audit({ orgId: p.org_id, branchId: p.branch_id, actor: req.session!.uid, action: 'access.reveal', category: 'access', entity: 'payment', entityId: p.id, summary: `Revealed the payer phone of payment ${p.provider_tx_id}`, reason: (req.body as any)?.reason ? String((req.body as any).reason).slice(0, 200) : null, meta: { fields: ['payer_phone'] } });
    return { payer_phone: p.payer_phone };
  });

  app.get('/admin/suspense', adm, async () => {
    const rows = await ctx.db.query<any>(
      `SELECT id, provider_tx_id, received_at, method, reference, ${maskPhoneSql('payer_phone')} AS payer_phone, amount_paid, psp_cost FROM payments WHERE stage='suspense' ORDER BY received_at`,
    );
    const expiresMs = ctx.ledger.opts.suspenseHours * 3600_000;
    return rows.map((r) => ({ ...r, expiresAt: new Date(new Date(r.received_at).getTime() + expiresMs).toISOString() }));
  });

  app.post('/admin/suspense/:id/claim', adm, async (req) => {
    const branchId = (req.body as any)?.branchId;
    if (!branchId) throw new HttpError(400, 'Choose a branch', 'bad_branch');
    try {
      await ctx.ledger.claimSuspense((req.params as any).id, branchId, req.session!.uid);
    } catch (e: any) {
      throw new HttpError(409, e.message, e.code);
    }
    return { ok: true };
  });

  app.get('/admin/reversal-requests', adm, async (req) => listReversalRequests(ctx, (req.query as any).status));
  app.post('/admin/reversal-requests/:id/decide', adm, async (req) =>
    decideReversal(ctx, (req.params as any).id, req.session!.uid, (req.body as any)?.approve !== false, (req.body as any)?.reason),
  );

  app.post('/admin/settlement/run', adm, async (req) => {
    await applyDuePayoutChanges(ctx);
    const expired = await ctx.ledger.expireSuspense();
    const results = await ctx.ledger.runSettlement();
    await ctx.ledger.audit({ actor: req.session!.uid, action: 'settlement.run', meta: { expired, results: results.length } });
    return { expiredSuspense: expired, results };
  });

  app.post('/admin/branches/:id/resume', adm, async (req) => {
    await ctx.ledger.resumeBranch((req.params as any).id);
    await ctx.ledger.audit({ actor: req.session!.uid, action: 'payout.resume', entity: 'branch', entityId: (req.params as any).id });
    return { ok: true };
  });

  app.get('/admin/reconcile', adm, async () => ctx.ledger.reconcile());

  app.get('/admin/payouts', adm, async () =>
    ctx.db.query<any>(`SELECT po.*, b.name AS branch_name FROM payouts po JOIN branches b ON b.id=po.branch_id ORDER BY po.created_at DESC LIMIT 100`),
  );


  app.get('/admin/revenue', adm, async () => {
    const r = (
      await ctx.db.query<any>(`SELECT COALESCE(SUM(platform_fee),0) AS platform_fee, COALESCE(SUM(psp_cost),0) AS psp_cost, COUNT(*) AS n FROM payments WHERE stage IN ('pending','available','paid_out')`)
    )[0];
    return { ...r, feeRevenueBalance: await ctx.ledger.balance('fee_revenue'), pspCostPayable: await ctx.ledger.balance('psp_cost_payable'), clockOffsetHours: ctx.clock.offsetHours, now: ctx.clock.now().toISOString() };
  });

  // ---------- testing tools (development only) ----------

  app.post('/admin/simulate/paybill', devAdm, async (req) => {
    const b = (req.body ?? {}) as any;
    let amount: number;
    try { amount = toCents(b.amount); } catch { throw new HttpError(400, 'Enter an amount', 'bad_amount'); }
    const out = await ctx.provider.simulatePaybill({ phone: String(b.phone ?? '254700000000'), amount, reference: String(b.reference ?? ''), method: b.method ?? 'mpesa', duplicate: !!b.duplicate });
    return { ok: true, ...out };
  });

  app.post('/admin/clock/advance', devAdm, async (req) => {
    const hours = Number((req.body as any)?.hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) throw new HttpError(400, 'Enter hours between 1 and 720', 'bad_hours');
    ctx.clock.advanceHours(hours);
    const released = await ctx.ledger.releasePending();
    const housekeeping = await runMemberHousekeeping(ctx);
    const messagesSent = await runScheduledMessages(ctx);
    const community = await runCommunityJobs(ctx);
    const bookings = await runBookingJobs(ctx);
    const shop = await runShopJobs(ctx);
    const tickets = await runTicketJobs(ctx);
    const kids = await runKidsJobs(ctx);
    return { community, bookings, shop, tickets, kids, now: ctx.clock.now().toISOString(), offsetHours: ctx.clock.offsetHours, released, messagesSent, ...housekeeping };
  });

  app.post('/admin/provider/fail-next-payout', devAdm, async () => {
    ctx.provider.failNextPayout();
    return { ok: true };
  });

  app.post('/admin/webhook-replay', devAdm, async (req) => {
    const b = (req.body ?? {}) as any;
    const raw = JSON.stringify(b);
    return handleWebhook(ctx, raw, { 'x-psp-signature': ctx.provider.sign(raw) });
  });
}
