import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { maskPhone } from '@churchos/shared';
import { HttpError, type Ctx } from './ctx';
import { clientIp, limiterFor, rateLimit, tooMany } from './ratelimit';

export type AuthMode = 'demo' | 'sms';

/** The fixed sign-in code of the public demo. */
export const DEV_CODE = '123456';

/**
 * How people sign in. An explicit AUTH_MODE (demo or sms) wins. Otherwise: demo when NODE_ENV is not production or ALLOW_DEV_OTP=1
 * (the fixed code works for every registered number), real SMS codes everywhere else.
 */
export function authMode(): AuthMode {
  const explicit = String(process.env.AUTH_MODE ?? '').trim().toLowerCase();
  if (explicit === 'sms' || explicit === 'demo') return explicit;
  if (process.env.NODE_ENV !== 'production' || process.env.ALLOW_DEV_OTP === '1') return 'demo';
  return 'sms';
}

let warned = false;
/** One clear line at startup when the public demo sign-in is on in production. */
export function warnIfDemoInProduction() {
  if (warned) return;
  if (process.env.NODE_ENV === 'production' && authMode() === 'demo') {
    warned = true;
    console.warn('DEMO SIGN-IN IS ON: the fixed code works for every registered number');
  }
}

const CODE_TTL_MS = 5 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;
const GENERIC_BAD = 'That code is not correct or has expired. Ask for a new code.';

const hashCode = (salt: string, code: string) => createHash('sha256').update(`${salt}:${code}`).digest('hex');
const asMs = (v: unknown) => (v instanceof Date ? v.getTime() : Date.parse(String(v)));

export const dailyCap = () => {
  const n = Number.parseInt(String(process.env.OTP_DAILY_CAP ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 500;
};

/**
 * Sends a sign-in code to a registered number. Callers always answer {sent:true}: for an unknown number the same limits apply and the
 * same work is done (a code is generated and hashed, the same tables are queried) but nothing is stored and no SMS goes out.
 */
export async function requestSmsCode(ctx: Ctx, req: FastifyRequest, phone: string): Promise<void> {
  const ip = clientIp(req);
  const lim = (key: string, max: number, windowMs: number) => rateLimit(ctx, key, { max, windowMs });
  const ipRes = lim(`otp:req:ip:${ip}`, 20, 3600_000);
  if (!ipRes.ok) tooMany('Too many code requests from this device. Please try again later.', ipRes.retryAfterSec);
  const gap = lim(`otp:req:gap:${phone}`, 1, 30_000);
  if (!gap.ok) tooMany(`Please wait ${gap.retryAfterSec} seconds before asking for another code.`, gap.retryAfterSec);
  const hr = lim(`otp:req:phone:${phone}`, 5, 3600_000);
  if (!hr.ok) tooMany('Too many codes for this number. Please try again in an hour.', hr.retryAfterSec);
  // Platform-wide daily ceiling on SMS spend.
  const store = limiterFor(ctx);
  if (store.peek('otp:daily').count >= dailyCap()) {
    if (rateLimit(ctx, 'otp:daily-audit', { max: 1, windowMs: 24 * 3600_000 }).ok) {
      await ctx.ledger.audit({ action: 'security.otp_cap', category: 'security', actorType: 'system', summary: 'The daily limit of sign-in codes was reached. Sign-in codes are paused until it resets.', meta: { cap: dailyCap() } });
    }
    throw new HttpError(503, 'Sign-in codes are paused, try again later', 'otp_paused');
  }

  const now = ctx.clock.now();
  const user = (await ctx.db.query<any>(`SELECT id FROM users WHERE phone = $1`, [phone]))[0];
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const salt = randomBytes(16).toString('hex');
  const hash = hashCode(salt, code);
  if (!user) {
    // Same amount of database work as the real path.
    await ctx.db.query(`SELECT id FROM otp_codes WHERE phone=$1 AND used_at IS NULL`, [phone]);
    await ctx.db.query(`SELECT id FROM otp_codes WHERE phone=$1 AND created_at > $2`, [phone, now.toISOString()]);
    return;
  }
  await ctx.db.query(`UPDATE otp_codes SET used_at=$2 WHERE phone=$1 AND used_at IS NULL`, [phone, now.toISOString()]);
  await ctx.db.query(`INSERT INTO otp_codes (id, phone, code_hash, salt, expires_at, attempts, created_at, ip) VALUES ($1,$2,$3,$4,$5,0,$6,$7)`, [
    ctx.newId('otp'), phone, hash, salt, new Date(now.getTime() + CODE_TTL_MS).toISOString(), now.toISOString(), ip,
  ]);
  store.hit('otp:daily', { max: Number.MAX_SAFE_INTEGER, windowMs: 24 * 3600_000 });
  // Sent in the background so the answer takes the same time for every number. Neither the code nor the number is ever logged.
  const from = process.env.OTP_SENDER_ID?.trim() || undefined;
  void ctx.messaging
    .send('sms', [{ to: phone, body: `Your ChurchOS code is ${code}. It expires in 5 minutes. Never share it.`, from }])
    .then((r) => { if (r[0]?.status !== 'sent') console.error('sign-in code could not be sent'); })
    .catch(() => console.error('sign-in code could not be sent'));
}

/** Checks a code. Returns the user row when it is right, null for every kind of wrong (unknown number, wrong, expired, used, locked). */
export async function checkSmsCode(ctx: Ctx, req: FastifyRequest, phone: string, code: unknown): Promise<any | null> {
  const ipRes = rateLimit(ctx, `otp:ver:ip:${clientIp(req)}`, { max: 30, windowMs: 10 * 60_000 });
  if (!ipRes.ok) tooMany('Too many attempts from this device. Please try again in a few minutes.', ipRes.retryAfterSec);
  const now = ctx.clock.now();
  const given = String(code ?? '').trim();
  const row = (await ctx.db.query<any>(`SELECT * FROM otp_codes WHERE phone=$1 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`, [phone]))[0];
  let ok = false;
  if (row && asMs(row.expires_at) > now.getTime() && row.attempts < MAX_CODE_ATTEMPTS) {
    // Counting the try first means a code can never be guessed more than 5 times, even with parallel requests.
    const counted = await ctx.db.query<any>(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id=$1 AND used_at IS NULL AND attempts < $2 RETURNING attempts`, [row.id, MAX_CODE_ATTEMPTS]);
    if (counted.length > 0) {
      const a = Buffer.from(hashCode(row.salt, given));
      const b = Buffer.from(String(row.code_hash));
      ok = /^\d{6}$/.test(given) && a.length === b.length && timingSafeEqual(a, b);
      if (ok) {
        const used = await ctx.db.query<any>(`UPDATE otp_codes SET used_at=$2 WHERE id=$1 AND used_at IS NULL RETURNING id`, [row.id, now.toISOString()]);
        ok = used.length > 0;
      }
    }
  } else {
    // Same hashing work when there is nothing to compare with.
    hashCode('0'.repeat(32), given);
  }
  const user = ok ? (await ctx.db.query<any>(`SELECT * FROM users WHERE phone=$1`, [phone]))[0] : null;
  if (ok && user) return user;
  // One audit row per number per hour, not one per wrong guess.
  if (rateLimit(ctx, `otp:failaudit:${phone}`, { max: 1, windowMs: 3600_000 }).ok) {
    await ctx.ledger.audit({ action: 'security.login_failed', category: 'security', actorType: 'system', summary: 'Wrong or expired sign-in code', meta: { phone: maskPhone(phone) } });
  }
  return null;
}

export const badCodeError = () => new HttpError(401, GENERIC_BAD, 'bad_code');
