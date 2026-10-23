import { runSystem } from '@churchos/ledger';
import { HttpError, inList, type Ctx } from '../ctx';
import { phoneSince } from '../dataprotection';
import { maskPhoneSql } from './helpers';
import { appendReversal } from './giving-ledger';

/** Reversals above this amount need two different approvers (D1, KES 50,000). */
export const SECOND_APPROVER_ABOVE = 5_000_000;

/**
 * Rule-based intake for pasted payment confirmation messages (L11, L12). It finds a transaction code in the text and
 * looks it up in our records. The text itself is never trusted: only the payment we find in our own ledger is acted on.
 */
export async function findPaymentFromMessage(ctx: Ctx, message: string): Promise<any | null> {
  const tokens = [...new Set(String(message ?? '').toUpperCase().match(/\b[A-Z0-9]{8,14}\b/g) ?? [])];
  for (const t of tokens) {
    const p = (await ctx.db.query<any>(`SELECT * FROM payments WHERE provider_tx_id = $1`, [t]))[0];
    if (p) return p;
  }
  return null;
}

export async function createReversalRequest(
  ctx: Ctx,
  a: {
    requestedBy: string;
    source: 'member' | 'staff';
    message?: string;
    paymentId?: string;
    reason?: string;
    orgId?: string;
    branchIds?: string[];
    payerPhone?: string;
    userId?: string;
    /** Ticket refunds are agreed with the church well after the usual reversal window (L193). */
    force?: boolean;
  },
) {
  let payment: any | null = null;
  // The payment is found in any church (the payer may have paid the wrong one); who may act on it is decided just below.
  if (a.paymentId) payment = (await runSystem(() => ctx.db.query<any>(`SELECT * FROM payments WHERE id=$1`, [a.paymentId])))[0] ?? null;
  else if (a.message) payment = await runSystem(() => findPaymentFromMessage(ctx, a.message!));
  if (!payment) throw new HttpError(404, 'We could not find that payment. Paste the full confirmation message, including the transaction code.', 'payment_not_found');

  // Verify the requester is entitled to ask: members only for payments from their own phone, staff only inside their scope.
  const anonOwner = payment.anonymous ? (await ctx.db.query<any>(`SELECT user_id FROM anonymous_gifts WHERE payment_id=$1`, [payment.id]))[0]?.user_id : null;
  if (a.source === 'member' && (payment.anonymous ? !anonOwner || anonOwner !== a.userId : payment.payer_phone !== a.payerPhone || new Date(payment.received_at).toISOString() < (await phoneSince(ctx, a.payerPhone ?? '')))) {
    throw new HttpError(403, 'That payment was not made from your phone number', 'not_your_payment');
  }
  if (a.source === 'staff' && payment.stage !== 'suspense' && !(a.branchIds ?? []).includes(payment.branch_id)) {
    throw new HttpError(403, 'That payment is outside the branches you manage', 'forbidden');
  }
  // Unclaimed (suspense) money belongs to no church yet: church staff cannot ask for it back (AZ-05). Platform admins and the payer can.
  if (a.source === 'staff' && payment.stage === 'suspense') {
    const who = (await ctx.db.query<any>(`SELECT is_platform_admin FROM users WHERE id=$1`, [a.requestedBy]))[0];
    if (!who?.is_platform_admin) throw new HttpError(403, 'That payment has not been claimed by any church. Ask ChurchOS support.', 'forbidden');
  }
  if (payment.stage === 'reversed' || payment.stage === 'refunded') throw new HttpError(409, 'That payment has already been reversed', 'already_reversed');
  const open = (await ctx.db.query<any>(`SELECT id FROM reversal_requests WHERE payment_id=$1 AND status IN ('pending','awaiting_second')`, [payment.id]))[0];
  if (open) throw new HttpError(409, 'A reversal request for this payment is already open', 'duplicate_request');

  const id = ctx.newId('rev');
  await ctx.db.query(
    `INSERT INTO reversal_requests (id, payment_id, requested_by, source, message, reason, created_at, force) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, payment.id, a.requestedBy, a.source, a.message ?? null, a.reason?.trim() || 'Requested by user', ctx.clock.now().toISOString(), !!a.force],
  );
  await ctx.ledger.audit({ orgId: payment.org_id, branchId: payment.branch_id, actor: a.requestedBy, action: 'reversal.request', entity: 'payment', entityId: payment.id, summary: `Asked for a reversal of payment ${payment.provider_tx_id}`, reason: a.reason?.trim() || null, links: { paymentId: payment.id, reversalRequestId: id } });
  return {
    id,
    status: 'pending',
    found: { transactionCode: payment.provider_tx_id, amount: payment.amount_paid, where: payment.stage === 'suspense' ? 'held safely, not yet credited to a church' : 'credited to a church' },
  };
}

/**
 * Admin decision. Above the threshold the first approval parks the request and a different admin must approve it (maker-checker, L35).
 */
export async function decideReversal(ctx: Ctx, requestId: string, adminId: string, approve: boolean, reason?: string) {
  const r = (await ctx.db.query<any>(`SELECT * FROM reversal_requests WHERE id=$1`, [requestId]))[0];
  if (!r) throw new HttpError(404, 'request not found', 'not_found');
  if (r.status !== 'pending' && r.status !== 'awaiting_second') throw new HttpError(409, 'This request was already decided', 'already_decided');
  const payment = (await ctx.db.query<any>(`SELECT * FROM payments WHERE id=$1`, [r.payment_id]))[0];

  // The person who asked can never approve (AUTH-08): not the requester, and not the admin whose own phone or anonymous gift made the payment.
  if (approve) {
    const me = (await ctx.db.query<any>(`SELECT phone FROM users WHERE id=$1`, [adminId]))[0];
    const anonOwner = payment.anonymous ? (await ctx.db.query<any>(`SELECT user_id FROM anonymous_gifts WHERE payment_id=$1`, [payment.id]))[0]?.user_id : null;
    if (r.requested_by === adminId || (me?.phone && payment.payer_phone && me.phone === payment.payer_phone) || (anonOwner && anonOwner === adminId)) {
      throw new HttpError(403, 'You asked for this reversal or paid this money yourself, so a different admin must decide it', 'same_person');
    }
  }
  // Claim the request in one atomic step: only one caller can go on to the provider (LG-03).
  const claimed = await ctx.db.query<any>(
    `UPDATE reversal_requests SET claim_token=$2 WHERE id=$1 AND status IN ('pending','awaiting_second') AND claim_token IS NULL RETURNING id, status, first_approver`,
    [requestId, ctx.newId('clm')],
  );
  if (!claimed[0]) throw new HttpError(409, 'This request is already being decided', 'already_decided');
  const release = () => ctx.db.query(`UPDATE reversal_requests SET claim_token=NULL WHERE id=$1 AND status IN ('pending','awaiting_second')`, [requestId]);
  r.status = claimed[0].status;
  r.first_approver = claimed[0].first_approver;
  try {
    return await decideClaimed(ctx, r, payment, requestId, adminId, approve, reason);
  } finally {
    await release();
  }
}

async function decideClaimed(ctx: Ctx, r: any, payment: any, requestId: string, adminId: string, approve: boolean, reason?: string) {

  if (!approve) {
    await ctx.db.query(`UPDATE reversal_requests SET status='rejected', first_approver=COALESCE(first_approver,$2) WHERE id=$1`, [requestId, adminId]);
    await ctx.ledger.audit({ orgId: payment.org_id, branchId: payment.branch_id, actor: adminId, action: 'reversal.reject', entity: 'reversal_request', entityId: requestId, summary: `Rejected the reversal of payment ${payment.provider_tx_id}`, reason: reason?.trim() || null, links: { paymentId: payment.id, reversalRequestId: requestId } });
    return { id: requestId, status: 'rejected' };
  }
  const needsTwo = payment.amount_paid > SECOND_APPROVER_ABOVE;
  if (needsTwo && r.status === 'pending') {
    await ctx.db.query(`UPDATE reversal_requests SET status='awaiting_second', first_approver=$2 WHERE id=$1`, [requestId, adminId]);
    await ctx.ledger.audit({ orgId: payment.org_id, branchId: payment.branch_id, actor: adminId, action: 'reversal.first_approval', entity: 'reversal_request', entityId: requestId, summary: `First approval of the reversal of payment ${payment.provider_tx_id}, a second admin must approve`, links: { paymentId: payment.id, reversalRequestId: requestId } });
    return { id: requestId, status: 'awaiting_second' };
  }
  if (needsTwo && r.first_approver === adminId) throw new HttpError(403, 'A different admin must give the second approval', 'same_person');

  try {
    await ctx.ledger.reverse(payment.id, { reason: r.reason, actor: adminId, force: !!r.force });
    await appendReversal(ctx, payment.id, r.reason);
  } catch (e: any) {
    await ctx.db.query(`UPDATE reversal_requests SET status='failed', failure=$2 WHERE id=$1`, [requestId, e.message]);
    throw new HttpError(409, e.message, e.code ?? 'reversal_failed');
  }
  await ctx.db.query(`UPDATE reversal_requests SET status='approved', second_approver=$2 WHERE id=$1`, [requestId, needsTwo ? adminId : null]);
  await ctx.ledger.audit({ orgId: payment.org_id, branchId: payment.branch_id, actor: adminId, action: 'reversal.approve', entity: 'reversal_request', entityId: requestId, summary: `Approved the reversal of payment ${payment.provider_tx_id}${needsTwo ? ' (second approval)' : ''}`, reason: reason?.trim() || null, links: { paymentId: payment.id, reversalRequestId: requestId, ledgerEntry: `reverse:${payment.id}` }, meta: { amount: payment.amount_paid } });
  if (!needsTwo) await ctx.db.query(`UPDATE reversal_requests SET first_approver=$2 WHERE id=$1`, [requestId, adminId]);
  return { id: requestId, status: 'approved' };
}

export async function listReversalRequests(ctx: Ctx, status?: string) {
  const rows = await ctx.db.query<any>(
    `SELECT r.*, p.amount_paid, p.provider_tx_id, p.stage AS payment_stage, p.anonymous, p.reference, ${maskPhoneSql('p.payer_phone')} AS payer_phone, b.name AS branch_name, u.name AS requested_by_name
       FROM reversal_requests r JOIN payments p ON p.id=r.payment_id LEFT JOIN branches b ON b.id=p.branch_id LEFT JOIN users u ON u.id=r.requested_by
      ${status ? `WHERE r.status IN (${inList(1, status.split(',').length)})` : ''} ORDER BY r.created_at DESC LIMIT 200`,
    status ? status.split(',') : [],
  );
  // The two-admin rule, per request: how many approvals it needs and how many it has (approved: all it needed).
  return rows.map((r) => {
    const approvalsRequired = r.amount_paid > SECOND_APPROVER_ABOVE ? 2 : 1;
    const approvalsDone = r.status === 'approved' ? approvalsRequired : r.status === 'awaiting_second' ? 1 : 0;
    return { ...r, approvalsRequired, approvalsDone, secondApproverAbove: SECOND_APPROVER_ABOVE };
  });
}
