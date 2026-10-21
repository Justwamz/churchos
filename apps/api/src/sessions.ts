import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { ADMIN_SESSION_TTL_MS, readToken, SESSION_TTL_MS, signData, signToken, verifyData, type Session } from './auth';
import type { Ctx } from './ctx';

/** Sessions run on real time (the demo clock tool moves the platform clock for money and reminders, not sign-ins). */
/** Positive lookups are remembered for a few seconds so a busy screen does not hit the database for every call. Revoking clears them at once. */
const CACHE_MS = 15_000;
const caches = new WeakMap<Ctx, Map<string, { checked: number; expires: number }>>();
function cacheOf(ctx: Ctx) {
  let c = caches.get(ctx);
  if (!c) { c = new Map(); caches.set(ctx, c); }
  return c;
}

const asMs = (v: unknown) => (v instanceof Date ? v.getTime() : Date.parse(String(v)));

export interface UserRow {
  id: string;
  phone: string;
  name: string;
  is_platform_admin: boolean;
}

/** Starts a server-side session for a user and returns the token that names it. Platform admins get 4 hours, everyone else 12. */
export async function createSession(ctx: Ctx, user: UserRow, req: FastifyRequest): Promise<{ token: string; sid: string; expiresAt: number }> {
  const now = new Date();
  const ttl = user.is_platform_admin ? ADMIN_SESSION_TTL_MS : SESSION_TTL_MS;
  const expiresAt = now.getTime() + ttl;
  const sid = `ses_${randomUUID().replace(/-/g, '')}`;
  await ctx.db.query(`INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, ip, user_agent) VALUES ($1,$2,$3,$4,$3,$5,$6)`, [
    sid, user.id, now.toISOString(), new Date(expiresAt).toISOString(), req.ip ? String(req.ip) : null, String(req.headers['user-agent'] ?? '').slice(0, 200) || null,
  ]);
  return { token: signToken({ uid: user.id, sid, expiresAt }), sid, expiresAt };
}

/** Is this session row there, not revoked and not expired? */
async function sessionLive(ctx: Ctx, sid: string, uid: string): Promise<boolean> {
  const now = Date.now();
  const c = cacheOf(ctx);
  const hit = c.get(sid);
  if (hit && hit.checked + CACHE_MS > now && hit.expires > now) return true;
  const row = (await ctx.db.query<any>(`SELECT user_id, expires_at, revoked_at FROM sessions WHERE id=$1`, [sid]))[0];
  if (!row || row.user_id !== uid || row.revoked_at || asMs(row.expires_at) <= now) { c.delete(sid); return false; }
  if (c.size > 2000) for (const [k, v] of c) if (v.checked + CACHE_MS <= now) c.delete(k);
  c.set(sid, { checked: now, expires: asMs(row.expires_at) });
  // Last-seen is written when the lookup misses the cache, so at most once every 15 seconds per session.
  await ctx.db.query(`UPDATE sessions SET last_seen_at=$2 WHERE id=$1`, [sid, new Date(now).toISOString()]);
  return true;
}

/** The person for a live session. Name and admin flag come from the users table on every request, so a demoted admin loses access at once. */
async function sessionUser(ctx: Ctx, sid: string, uid: string): Promise<Session | null> {
  if (!(await sessionLive(ctx, sid, uid))) return null;
  const u = (await ctx.db.query<any>(`SELECT id, phone, name, is_platform_admin FROM users WHERE id=$1`, [uid]))[0];
  if (!u) return null;
  return { uid: u.id, phone: u.phone, name: u.name, isAdmin: !!u.is_platform_admin, sid };
}

export function bearerOf(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

export const pathOf = (req: FastifyRequest) => String(req.url).split('?')[0];

/** A download ticket in `?t=`: only on GET, never on /auth, only for the exact path it was made for. */
async function ticketSession(ctx: Ctx, req: FastifyRequest): Promise<Session | null> {
  const t = (req.query as any)?.t;
  if (typeof t !== 'string' || req.method !== 'GET') return null;
  const path = pathOf(req);
  if (path === '/auth' || path.startsWith('/auth/')) return null;
  const p = verifyData(t, 'download', ctx.clock.now().getTime());
  if (!p || p.method !== 'GET' || p.path !== path || typeof p.uid !== 'string' || typeof p.sid !== 'string') return null;
  return sessionUser(ctx, p.sid, p.uid);
}

/** The signed-in person for this request, or null. Header token first; a download ticket only when no header is sent. */
export async function getSession(ctx: Ctx, req: FastifyRequest): Promise<Session | null> {
  const token = bearerOf(req);
  if (token) {
    const c = readToken(token);
    if (!c || c.e <= Date.now()) return null;
    return sessionUser(ctx, c.sid, c.uid);
  }
  return ticketSession(ctx, req);
}

/** Like getSession but accepts only the header token. Used by the routes that issue tickets and manage sessions. */
export async function getHeaderSession(ctx: Ctx, req: FastifyRequest): Promise<Session | null> {
  const c = readToken(bearerOf(req));
  if (!c || c.e <= Date.now()) return null;
  return sessionUser(ctx, c.sid, c.uid);
}

export async function revokeSession(ctx: Ctx, sid: string, uid: string): Promise<boolean> {
  cacheOf(ctx).delete(sid);
  const r = await ctx.db.query<any>(`UPDATE sessions SET revoked_at=$3 WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id`, [sid, uid, new Date().toISOString()]);
  return r.length > 0;
}

export async function revokeAllSessions(ctx: Ctx, uid: string): Promise<number> {
  const rows = await ctx.db.query<any>(`UPDATE sessions SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL RETURNING id`, [uid, new Date().toISOString()]);
  const c = cacheOf(ctx);
  for (const r of rows) c.delete(r.id);
  return rows.length;
}

export const DOWNLOAD_TICKET_MS = 60_000;

export function makeDownloadTicket(ctx: Ctx, s: Session, pathname: string): string {
  return signData({ uid: s.uid, sid: s.sid, path: pathname, method: 'GET', e: ctx.clock.now().getTime() + DOWNLOAD_TICKET_MS }, 'download');
}

/** Is the session still live right now (not revoked, not expired)? For long-lived connections such as the live collections stream. */
export async function stillSignedIn(ctx: Ctx, s: Session): Promise<boolean> {
  if (!s.sid) return false;
  return (await sessionUser(ctx, s.sid, s.uid)) !== null;
}
