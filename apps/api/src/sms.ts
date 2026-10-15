import type { Ctx } from './ctx';
import { activeBands, costOf, recordUnits, unitsUsed } from './pricing';
import { checkLowBalance, integrationSettings, RATES, walletFor } from './wallets';

/** Kept for callers that still think in terms of the SMS price. The price is set per channel in wallets.ts (L112). */
export const SMS_RATE_CENTS = RATES.sms; // the default list price, the real price comes from the tariff

export type SmsKind = 'receipt' | 'reminder' | 'announcement';

/**
 * A single message about the person's own giving or membership: a receipt, a pledge reminder, a graduation notice. Every one
 * becomes an in-app notification when the person has an account (L56). SMS goes out only if the wallet that pays for that branch
 * can cover it, and an empty wallet never fails the caller (L59).
 */
export async function notify(
  ctx: Ctx,
  a: { orgId: string; branchId?: string | null; phone: string; kind: SmsKind; title: string; body: string; idemKey: string; sms?: boolean },
): Promise<{ sms: 'sent' | 'skipped_no_balance' | 'not_requested'; inApp: boolean }> {
  const now = ctx.clock.now().toISOString();
  const user = (await ctx.db.query<any>(`SELECT id FROM users WHERE phone=$1`, [a.phone]))[0];
  if (user) {
    await ctx.db.query(`INSERT INTO notifications (id, org_id, user_id, kind, title, body, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
      ctx.newId('ntf'), a.orgId, user.id, a.kind, a.title, a.body, now,
    ]);
  }
  if (a.sms === false) return { sms: 'not_requested', inApp: !!user };

  let sent = false;
  let walletId: string | null = null;
  let priced = 0;
  try {
    const w = await walletFor(ctx, a.orgId, a.branchId ?? null, 'sms');
    if (w) {
      const cost = costOf(await activeBands(ctx, a.orgId, 'sms'), await unitsUsed(ctx, a.orgId, 'sms'), 1);
      if (await ctx.ledger.chargeWallet(w.id, cost, a.idemKey, 'sms')) {
        walletId = w.id;
        priced = cost;
        const settings = await integrationSettings(ctx.db, a.orgId);
        const [res] = await ctx.messaging.send('sms', [{ to: a.phone, body: a.body, from: settings.smsSenderId }]);
        sent = res?.status === 'sent';
        if (sent) await recordUnits(ctx, a.orgId, 'sms', 1);
        else await ctx.ledger.refundWallet(w.id, cost, a.idemKey, 'sms');
      }
    }
    if (w) await checkLowBalance(ctx, w.id);
  } catch {
    sent = false;
  }
  await ctx.db.query(`INSERT INTO sms_messages (id, org_id, to_phone, kind, body, cost, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
    ctx.newId('sms'), a.orgId, a.phone, a.kind, a.body, sent ? priced : 0, sent ? 'sent' : 'skipped_no_balance', now,
  ]);
  void walletId;
  return { sms: sent ? 'sent' : 'skipped_no_balance', inApp: !!user };
}
