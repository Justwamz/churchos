import type { Ctx } from './ctx';

/**
 * Automatic clean-up of short-lived data (LG-16). The schedule is written up in docs/data-protection.md.
 * Only data with no legal retention duty is touched here: sign-in codes, old sessions and old in-app notifications.
 * Financial records (ledger, payments, postings, giving ledger), the audit log and held payments are never deleted by any job.
 */
export const RETENTION = {
  otpAfterExpiryMs: 24 * 3600_000,
  sessionAfterEndMs: 30 * 86_400_000,
  notificationMs: 90 * 86_400_000,
} as const;

export interface PurgeResult {
  otpCodes: number;
  sessions: number;
  notifications: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Safe to run as often as you like: each run deletes only what is past its limit, so a second run finds nothing. */
export async function runRetentionJobs(ctx: Ctx): Promise<PurgeResult> {
  const clockNow = ctx.clock.now().getTime();
  // Sessions run on real time (see sessions.ts), so a development clock moved into the future must never delete a live session.
  const sessionNow = Math.min(clockNow, Date.now());
  const otp = await ctx.db.query<any>(`DELETE FROM otp_codes WHERE expires_at < $1 RETURNING id`, [iso(clockNow - RETENTION.otpAfterExpiryMs)]);
  const sessCut = iso(sessionNow - RETENTION.sessionAfterEndMs);
  const ses = await ctx.db.query<any>(`DELETE FROM sessions WHERE expires_at < $1 OR (revoked_at IS NOT NULL AND revoked_at < $1) RETURNING id`, [sessCut]);
  const ntf = await ctx.db.query<any>(`DELETE FROM notifications WHERE created_at < $1 RETURNING id`, [iso(clockNow - RETENTION.notificationMs)]);
  const res = { otpCodes: otp.length, sessions: ses.length, notifications: ntf.length };
  if (res.otpCodes + res.sessions + res.notifications > 0) {
    await ctx.ledger.audit({ action: 'retention.purge', category: 'system', actorType: 'system', summary: `Removed expired data: ${res.otpCodes} sign-in codes, ${res.sessions} old sessions, ${res.notifications} old notifications`, meta: res });
  }
  return res;
}
