import { computeFee, type PaymentMethod } from '@churchos/shared';
import type { Ctx } from './ctx';
import { addNotification } from './notifications';
import { staffWith } from './scope';

/**
 * LG-01: a payment must satisfy the order before it fulfils it. One place knows what each kind of order costs.
 *
 * Design for a payment that is too small: the money is still received and credited to the church honestly (nothing is lost or
 * hidden), but the order is NOT fulfilled. It stays awaiting payment, the payment is recorded in `held_payments` (kind 'underpaid'),
 * an audit event is written and the church staff are told. Payments for the same order add up, so the payer can send the difference
 * and the order completes; otherwise staff reverse the payment through the normal reversal request. A payment that is too large
 * fulfils the order and the excess is recorded (kind 'overpaid') for refund handling.
 */

export interface Expected {
  kind: 'ticket' | 'shop' | 'booking' | 'advert' | 'certificate';
  /** What the payer must have paid in total, in cents, including any fee they carry. */
  expected: number;
  orgId: string;
  /** Short name used in audit and messages, for example "ticket order 7K2M". */
  label: string;
}

const ACTION_PREFIX: Record<Expected['kind'], string> = { ticket: 'ticket', shop: 'shop', booking: 'booking', advert: 'advert', certificate: 'record' };

async function feeCarried(ctx: Ctx, orgId: string, method: PaymentMethod, base: number): Promise<number> {
  const org = (await ctx.db.query<any>(`SELECT fee_bearer, fee_schedule FROM organisations WHERE id=$1`, [orgId]))[0];
  if (!org || base <= 0) return base;
  return computeFee(org.fee_schedule, method, base, org.fee_bearer).amountPaid;
}

/** The amount an order for this reference (`TKT-x`, `SHOP-x`, `BK-x`, `AD-x`, `CERT-x`) needs, or null when the reference is not an order. */
export async function expectedFor(ctx: Ctx, purpose: string, method: PaymentMethod = 'mpesa'): Promise<Expected | null> {
  const p = String(purpose ?? '');
  const sep = p.indexOf('-');
  if (sep < 0) return null;
  const tag = p.slice(0, sep).toUpperCase();
  const code = p.slice(sep + 1);
  if (tag === 'TKT') {
    const o = (await ctx.db.query<any>(`SELECT org_id, code, total FROM ticket_orders WHERE code=$1`, [code]))[0];
    return o ? { kind: 'ticket', expected: Number(o.total), orgId: o.org_id, label: `ticket order ${o.code}` } : null;
  }
  if (tag === 'SHOP') {
    const s = (await ctx.db.query<any>(`SELECT org_id, receipt_no, total FROM shop_sales WHERE code=$1`, [code]))[0];
    // The shop's fee is carried by the church (computeFee 'church'), so this is the sale total unless the schedule says otherwise.
    return s ? { kind: 'shop', expected: s.total > 0 ? computeFee((await ctx.db.query<any>(`SELECT fee_schedule FROM organisations WHERE id=$1`, [s.org_id]))[0].fee_schedule, method, Number(s.total), 'church').amountPaid : 0, orgId: s.org_id, label: `shop sale ${s.receipt_no}` } : null;
  }
  if (tag === 'BK') {
    const b = (await ctx.db.query<any>(`SELECT org_id, title, price FROM bookings WHERE code=$1`, [code]))[0];
    return b ? { kind: 'booking', expected: await feeCarried(ctx, b.org_id, method, Number(b.price ?? 0)), orgId: b.org_id, label: `booking "${b.title}"` } : null;
  }
  if (tag === 'AD') {
    const a = (await ctx.db.query<any>(`SELECT org_id, title, price FROM adverts WHERE code=$1`, [code]))[0];
    return a ? { kind: 'advert', expected: await feeCarried(ctx, a.org_id, method, Number(a.price ?? 0)), orgId: a.org_id, label: `advert "${a.title}"` } : null;
  }
  if (tag === 'CERT') {
    const rec = (await ctx.db.query<any>(`SELECT id, org_id, subject_name FROM sacramental_records WHERE serial=$1`, [code]))[0];
    const issue = rec ? (await ctx.db.query<any>(`SELECT fee FROM record_issues WHERE record_id=$1 AND status='awaiting_payment' ORDER BY created_at DESC LIMIT 1`, [rec.id]))[0] : null;
    return rec && issue ? { kind: 'certificate', expected: await feeCarried(ctx, rec.org_id, method, Number(issue.fee)), orgId: rec.org_id, label: `certificate copy for ${rec.subject_name}` } : null;
  }
  return null;
}

export interface PaymentCheck {
  /** True when the order may be fulfilled now. */
  fulfil: boolean;
  expected?: Expected;
  paid?: number;
}

const kes = (c: number) => `KES ${(c / 100).toLocaleString('en-KE')}`;

/**
 * Compares everything paid so far for this order's reference with what the order costs. Called with a payment that has just been
 * received and credited. Records and announces a shortfall or an excess; returns whether the order may be fulfilled.
 */
export async function checkPayment(ctx: Ctx, paymentId: string): Promise<PaymentCheck> {
  const p = (await ctx.db.query<any>(`SELECT id, org_id, branch_id, purpose, method, amount_paid FROM payments WHERE id=$1`, [paymentId]))[0];
  if (!p) return { fulfil: false };
  const exp = await expectedFor(ctx, String(p.purpose ?? ''), p.method);
  if (!exp) return { fulfil: true };
  // Payments for the same order add up, so a payer can top up the difference. Reversed or refunded money does not count.
  const paid = Number((await ctx.db.query<any>(`SELECT COALESCE(SUM(amount_paid),0) AS s FROM payments WHERE purpose=$1 AND org_id=$2 AND stage NOT IN ('reversed','refunded','suspense')`, [p.purpose, exp.orgId]))[0].s);
  const prefix = ACTION_PREFIX[exp.kind];
  const record = async (kind: 'underpaid' | 'overpaid', expected: number, shown: number, summary: string) => {
    const heldId = ctx.newId('hld');
    await ctx.db.query(`INSERT INTO held_payments (id, payment_id, purpose, expected, paid, kind, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [heldId, p.id, p.purpose, expected, shown, kind, ctx.clock.now().toISOString()]);
    await ctx.ledger.audit({ orgId: p.org_id ?? exp.orgId, branchId: p.branch_id ?? null, actorType: 'psp', action: `${prefix}.${kind}`, category: 'money', entity: 'payment', entityId: p.id, summary, links: { paymentId: p.id }, meta: { purpose: p.purpose, expected, paid: shown } });
    if (p.branch_id) {
      for (const u of await staffWith(ctx, p.org_id, p.branch_id, 'collections.view')) {
        await addNotification(ctx, { orgId: p.org_id, userId: u.id, kind: 'announcement', title: kind === 'underpaid' ? 'A payment is too small for its order' : 'A payment is more than its order', body: summary, link: `staff:held-payments?id=${heldId}`, audience: 'staff' });
      }
    }
  };
  if (exp.orgId !== p.org_id) {
    // Paid to one church's reference for another church's order: never fulfilled, the money stays where it landed.
    await record('underpaid', exp.expected, Number(p.amount_paid), `A payment of ${kes(Number(p.amount_paid))} quoted a reference for another church's ${exp.label}. The order was not fulfilled.`);
    return { fulfil: false, expected: exp, paid };
  }
  if (paid < exp.expected) {
    await record('underpaid', exp.expected, paid, `A payment of ${kes(Number(p.amount_paid))} arrived for the ${exp.label}, which costs ${kes(exp.expected)} (${kes(paid)} paid so far). The order was not fulfilled. The payer can send the difference, or the payment can be reversed.`);
    return { fulfil: false, expected: exp, paid };
  }
  if (paid > exp.expected) await record('overpaid', exp.expected, paid, `${kes(paid)} was paid for the ${exp.label}, which costs ${kes(exp.expected)}. The order was fulfilled; ${kes(paid - exp.expected)} is extra and may need to be refunded.`);
  return { fulfil: true, expected: exp, paid };
}
