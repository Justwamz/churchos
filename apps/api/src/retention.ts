import type { Ctx } from './ctx';
import { rateLimit } from './ratelimit';

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

// ---------- personal data purges (visitors, attendance, children's logs) ----------

/**
 * How long personal details are kept. Defaults follow docs/data-protection.md (all to confirm with counsel) and can be changed
 * with environment variables (the same for every church; there is no per-church override).
 */
export function personalRetention(env: NodeJS.ProcessEnv = process.env) {
  const n = (name: string, dflt: number) => { const v = Number.parseInt(String(env[name] ?? ''), 10); return Number.isFinite(v) && v > 0 ? v : dflt; };
  return {
    visitorMonths: n('RETENTION_VISITOR_MONTHS', 12),
    attendanceYears: n('RETENTION_ATTENDANCE_YEARS', 3),
    kidsLogYears: n('RETENTION_KIDS_LOG_YEARS', 7),
    dryRun: env.RETENTION_DRY_RUN === '1',
  };
}

export interface PersonalPurgeResult {
  dryRun: boolean;
  visitors: number;
  attendance: number;
  kidsCheckins: number;
  kidsLog: number;
  kidsCodes: number;
}

const minus = (from: Date, y: number, m: number) => { const d = new Date(from.getTime()); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCMonth(d.getUTCMonth() - m); return d.toISOString(); };

/**
 * Removes personal details from old rows and keeps the rows, so counts and reports still add up. Never touches financial tables or the audit log.
 * - Visitors with no membership, last seen before the limit: name, phone and notes replaced; visits, status and dates kept.
 * - Attendance older than the limit: name and the link to the person replaced with a per-row placeholder (distinct counts per service stay right).
 * - Children's check-ins, log lines and pick-up codes older than the limit: names and ids replaced; times, classes, tags and results kept for safeguarding.
 * Idempotent (a second run finds nothing to change). With RETENTION_DRY_RUN=1 nothing changes and the counts are audited (once a day).
 */
export async function runPersonalPurges(ctx: Ctx): Promise<PersonalPurgeResult> {
  const cfg = personalRetention();
  const now = ctx.clock.now();
  const visitorCut = minus(now, 0, cfg.visitorMonths);
  const attCut = minus(now, cfg.attendanceYears, 0);
  const kidsCut = minus(now, cfg.kidsLogYears, 0);
  const res: PersonalPurgeResult = { dryRun: cfg.dryRun, visitors: 0, attendance: 0, kidsCheckins: 0, kidsLog: 0, kidsCodes: 0 };
  const count = async (sql: string, p: unknown[]) => Number((await ctx.db.query<any>(sql, p))[0].n);

  const visitorWhere = `membership_id IS NULL AND status <> 'member' AND last_seen_at < $1 AND name <> 'Former visitor'`;
  const attWhere = `at < $1 AND name <> 'Anonymised'`;
  if (cfg.dryRun) {
    res.visitors = await count(`SELECT count(*)::int AS n FROM visitors WHERE ${visitorWhere}`, [visitorCut]);
    res.attendance = await count(`SELECT count(*)::int AS n FROM attendance WHERE ${attWhere}`, [attCut]);
    res.kidsCheckins = await count(`SELECT count(*)::int AS n FROM kids_checkins WHERE in_at < $1 AND child_name <> 'Anonymised' AND status='out'`, [kidsCut]);
    res.kidsLog = await count(`SELECT count(*)::int AS n FROM kids_log WHERE at < $1 AND (subject_name IS DISTINCT FROM 'Anonymised' AND (subject_name IS NOT NULL OR children IS NOT NULL OR detail IS NOT NULL OR subject_id IS NOT NULL))`, [kidsCut]);
    res.kidsCodes = await count(`SELECT count(*)::int AS n FROM kids_codes WHERE created_at < $1 AND to_name <> 'Anonymised'`, [kidsCut]);
  } else {
    // Visitors first, so the attendance rows of an anonymised visitor lose their name too.
    const v = await ctx.db.query<any>(`UPDATE visitors SET name='Former visitor', phone='anon-' || id, note=NULL, contacted_by=NULL, contacted_by_name=NULL WHERE ${visitorWhere} RETURNING id`, [visitorCut]);
    res.visitors = v.length;
    if (v.length) await ctx.db.query(`UPDATE attendance SET name='Former visitor' WHERE visitor_id = ANY($1::text[]) AND name <> 'Anonymised'`, [v.map((x) => x.id)]);
    res.attendance = (await ctx.db.query<any>(
      `UPDATE attendance SET name='Anonymised', membership_id=CASE WHEN membership_id IS NULL THEN NULL ELSE 'anon_' || id END, visitor_id=CASE WHEN visitor_id IS NULL THEN NULL ELSE 'anon_' || id END, location=NULL, by_user=NULL, by_name=NULL WHERE ${attWhere} RETURNING id`, [attCut])).length;
    res.kidsCheckins = (await ctx.db.query<any>(
      `UPDATE kids_checkins SET child_name='Anonymised', child_id='anon_' || id, dropper_name='Anonymised', dropper_id='anon_' || id, collector_name=CASE WHEN collector_name IS NULL THEN NULL ELSE 'Anonymised' END, collector_id=CASE WHEN collector_id IS NULL THEN NULL ELSE 'anon_' || id END WHERE in_at < $1 AND child_name <> 'Anonymised' AND status='out' RETURNING id`, [kidsCut])).length;
    res.kidsLog = (await ctx.db.query<any>(
      `UPDATE kids_log SET subject_name=CASE WHEN subject_name IS NULL THEN NULL ELSE 'Anonymised' END, subject_id=CASE WHEN subject_id IS NULL THEN NULL ELSE 'anon_' || id END, children=NULL, detail=NULL WHERE at < $1 AND (subject_name IS DISTINCT FROM 'Anonymised' AND (subject_name IS NOT NULL OR children IS NOT NULL OR detail IS NOT NULL OR subject_id IS NOT NULL)) RETURNING id`, [kidsCut])).length;
    res.kidsCodes = (await ctx.db.query<any>(`UPDATE kids_codes SET to_name='Anonymised', to_phone='' , subject_id='anon_' || id WHERE created_at < $1 AND to_name <> 'Anonymised' RETURNING id`, [kidsCut])).length;
  }
  const total = res.visitors + res.attendance + res.kidsCheckins + res.kidsLog + res.kidsCodes;
  if (total > 0 && (!cfg.dryRun || rateLimit(ctx, 'retention:dryrun-audit', { max: 1, windowMs: 24 * 3600_000 }).ok)) {
    await ctx.ledger.audit({
      action: cfg.dryRun ? 'retention.purge_personal_dry_run' : 'retention.purge_personal', category: 'system', actorType: 'system',
      summary: `${cfg.dryRun ? 'Would anonymise' : 'Anonymised'} old personal details: ${res.visitors} visitors, ${res.attendance} attendance rows, ${res.kidsCheckins} children's check-ins, ${res.kidsLog} children's log lines, ${res.kidsCodes} pick-up codes`,
      meta: { ...res, visitorMonths: cfg.visitorMonths, attendanceYears: cfg.attendanceYears, kidsLogYears: cfg.kidsLogYears },
    });
  }
  return res;
}
