import type { FastifyInstance } from 'fastify';
import { maskPhone } from '@churchos/shared';
import { normalizePhone } from '../auth';
import { HttpError, requireSession, type Ctx } from '../ctx';
import { str } from '../limits';
import { authMode, badCodeError, checkSmsCode, DEV_CODE, requestSmsCode, warnIfDemoInProduction } from '../otp';
import { clientIp, limiterFor, rateLimit, tooMany } from '../ratelimit';
import { createSession, getHeaderSession, makeDownloadTicket, revokeAllSessions, revokeSession } from '../sessions';

const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60_000;

/** Sign-in (demo code or real SMS codes), sessions, sign-out and short-lived download tickets. */
export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  // Session checks need the app context; this is how requireSession reaches it.
  app.addHook('onRequest', (req, _reply, done) => {
    req.churchCtx = ctx;
    done();
  });
  warnIfDemoInProduction();

  /** Lets the apps show the right wording: a fixed demo code, or "we sent you a code". */
  app.get('/auth/mode', async () => ({ mode: authMode() }));

  app.post('/auth/otp/request', async (req) => {
    const phone = normalizePhone(str((req.body as any)?.phone, { max: 20, label: 'The phone number', allowNumber: true }));
    if (!phone) throw new HttpError(400, 'Enter a valid Kenyan phone number', 'bad_phone');
    if (authMode() === 'demo') {
      const user = (await ctx.db.query<any>(`SELECT id FROM users WHERE phone = $1`, [phone]))[0];
      // The response is identical whether or not the number is registered in production, so numbers cannot be probed.
      return { sent: true, ...(process.env.NODE_ENV === 'production' ? {} : { devCode: DEV_CODE, known: !!user }) };
    }
    await requestSmsCode(ctx, req, phone);
    return { sent: true };
  });

  app.post('/auth/otp/verify', async (req) => {
    const body = (req.body ?? {}) as any;
    body.code = str(body.code, { max: 12, label: 'The code', allowNumber: true });
    const phone = normalizePhone(str(body.phone, { max: 20, label: 'The phone number', allowNumber: true }));
    if (!phone) throw new HttpError(400, 'Enter a valid Kenyan phone number', 'bad_phone');
    let user: any | null;
    if (authMode() === 'sms') {
      user = await checkSmsCode(ctx, req, phone, body.code);
      if (!user) throw badCodeError();
    } else {
      // Demo: the fixed code. Wrong tries are counted per number AND address, so a stranger cannot lock the real person out.
      const key = `demo:lock:${phone}:${clientIp(req)}`;
      const limiter = limiterFor(ctx);
      const lock = limiter.peek(key);
      if (lock.count >= MAX_ATTEMPTS) {
        if (rateLimit(ctx, `demo:lockaudit:${key}`, { max: 1, windowMs: 3600_000 }).ok) {
          await ctx.ledger.audit({ action: 'security.login_locked', category: 'security', summary: 'Too many wrong codes, sign-in locked for 15 minutes', meta: { phone: maskPhone(phone) } });
        }
        tooMany('Too many attempts, try again in 15 minutes', lock.retryAfterSec);
      }
      user = (await ctx.db.query<any>(`SELECT * FROM users WHERE phone = $1`, [phone]))[0];
      if (String(body.code) !== DEV_CODE || !user) {
        const r = limiter.hit(key, { max: MAX_ATTEMPTS, windowMs: LOCK_MS });
        await ctx.ledger.audit({ action: 'security.login_failed', category: 'security', summary: user ? 'Wrong sign-in code' : 'Sign-in with an unknown number', actorType: 'system', meta: { phone: maskPhone(phone), attempt: r.count, knownNumber: !!user } });
        throw new HttpError(401, 'That code is not correct', 'bad_code');
      }
      limiter.reset(key);
    }
    await ctx.ledger.audit({ action: 'security.login', category: 'security', actorId: user.id, actorName: user.name, actorType: user.is_platform_admin ? 'admin' : 'user', summary: `${user.name} signed in`, meta: { phone: maskPhone(phone) } });
    const { token } = await createSession(ctx, user, req);
    return { token, user: { id: user.id, name: user.name, phone, isAdmin: user.is_platform_admin } };
  });

  // ---------- sessions ----------

  app.post('/auth/logout', { preHandler: requireSession }, async (req) => {
    await revokeSession(ctx, req.session!.sid!, req.session!.uid);
    return { ok: true };
  });

  app.post('/auth/logout-all', { preHandler: requireSession }, async (req) => {
    const n = await revokeAllSessions(ctx, req.session!.uid);
    return { ok: true, revoked: n };
  });

  app.get('/auth/sessions', { preHandler: requireSession }, async (req) => {
    const rows = await ctx.db.query<any>(
      `SELECT id, created_at, last_seen_at, user_agent, expires_at FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > $2 ORDER BY created_at DESC LIMIT 50`,
      [req.session!.uid, new Date().toISOString()],
    );
    return { sessions: rows.map((r) => ({ id: r.id, createdAt: r.created_at, lastSeenAt: r.last_seen_at, device: r.user_agent ?? 'Unknown device', current: r.id === req.session!.sid })) };
  });

  app.post('/auth/sessions/:id/revoke', { preHandler: requireSession }, async (req) => {
    const ok = await revokeSession(ctx, String((req.params as any).id), req.session!.uid);
    if (!ok) throw new HttpError(404, 'Session not found', 'not_found');
    return { ok: true };
  });

  // ---------- download tickets (replace ?token=) ----------

  /** A one-minute ticket for one GET path, for images, files and the live stream that cannot send an Authorization header. */
  app.post('/auth/download-ticket', async (req) => {
    const s = await getHeaderSession(ctx, req);
    if (!s) throw new HttpError(401, 'sign in required', 'unauthenticated');
    if (!rateLimit(ctx, `ticket:${s.uid}`, { max: 240, windowMs: 60_000 }).ok) throw new HttpError(429, 'Too many requests. Please wait a moment.', 'rate_limited');
    const raw = (req.body as any)?.path;
    if (typeof raw !== 'string' || raw.length > 1500 || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || raw.includes('#')) throw new HttpError(400, 'Not a valid path', 'bad_path');
    const [pathname, ...q] = raw.split('?');
    const query = q.join('?');
    if (pathname === '/auth' || pathname.startsWith('/auth/') || pathname.includes('..')) throw new HttpError(400, 'Not a valid path', 'bad_path');
    const t = makeDownloadTicket(ctx, s, pathname);
    return { url: `${pathname}?${query ? `${query}&` : ''}t=${t}` };
  });
}
