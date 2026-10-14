import type { Ctx } from './ctx';

/** Per-message price, set by the platform (L87). KES 1.00. */
export const SMS_RATE_CENTS = 100;
/** Below this many messages' worth, admins see a low-balance warning (L59). */
export const LOW_BALANCE_MESSAGES = 20;

export type SmsKind = 'receipt' | 'reminder' | 'announcement';

/**
 * Sends a message. Every message creates an in-app notification when the recipient has an account (L56).
 * SMS goes out only if the organisation's wallet can pay for it. An empty wallet never fails the caller (L59).
 */
export async function notify(
  ctx: Ctx,
  a: { orgId: string; phone: string; kind: SmsKind; title: string; body: string; idemKey: string; sms?: boolean },
): Promise<{ sms: 'sent' | 'skipped_no_balance' | 'not_requested'; inApp: boolean }> {
  const now = ctx.clock.now().toISOString();
  const user = (await ctx.db.query<any>(`SELECT id FROM users WHERE phone=$1`, [a.phone]))[0];
  if (user) {
    await ctx.db.query(`INSERT INTO notifications (id, org_id, user_id, kind, title, body, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
      ctx.newId('ntf'), a.orgId, user.id, a.kind, a.title, a.body, now,
    ]);
  }
  if (a.sms === false) return { sms: 'not_requested', inApp: !!user };
  let paid = false;
  try {
    paid = await ctx.ledger.chargeSms(a.orgId, SMS_RATE_CENTS, a.idemKey);
  } catch {
    paid = false;
  }
  await ctx.db.query(`INSERT INTO sms_messages (id, org_id, to_phone, kind, body, cost, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
    ctx.newId('sms'), a.orgId, a.phone, a.kind, a.body, paid ? SMS_RATE_CENTS : 0, paid ? 'sent' : 'skipped_no_balance', now,
  ]);
  return { sms: paid ? 'sent' : 'skipped_no_balance', inApp: !!user };
}
