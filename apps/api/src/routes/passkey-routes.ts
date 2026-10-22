import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { maskPhone } from '@churchos/shared';
import { signData, verifyData } from '../auth';
import { HttpError, requireSession, type Ctx } from '../ctx';
import { str } from '../limits';
import { authMode } from '../otp';
import { clientIp, rateLimit, tooMany } from '../ratelimit';
import { createSession, getHeaderSession } from '../sessions';
import { rpId, rpName, verifyAssertion, verifyRegistration, WebAuthnError } from '../webauthn';

/**
 * Passkeys (WebAuthn). Sign in without a code, and the second factor for platform admins (AUTH-03).
 * Challenges are signed (purpose "passkey"), live 5 minutes and work once. Policy lives in secondFactorGate().
 */

const CHALLENGE_MS = 5 * 60_000;
const PENDING_MS = 5 * 60_000;
const MAX_PASSKEYS = 10;

/** REQUIRE_ADMIN_PASSKEY=1: in sms mode a platform admin without a passkey gets no session until one is added. Off by default (demo); ON for a real launch. */
export const passkeyRequiredForAdmins = () => process.env.REQUIRE_ADMIN_PASSKEY === '1';

const asMs = (v: unknown) => (v instanceof Date ? v.getTime() : Date.parse(String(v)));
const bad = () => new HttpError(401, 'That passkey could not be used. Try again, or sign in with a code.', 'bad_passkey');

async function passkeyCount(ctx: Ctx, uid: string): Promise<number> {
  return Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM passkeys WHERE user_id=$1`, [uid]))[0].n);
}

/** Makes one challenge and the signed state the browser sends back with the answer. */
function newChallenge(ctx: Ctx, kind: 'register' | 'login' | 'second', extra: Record<string, unknown> = {}) {
  const challenge = randomBytes(32).toString('base64url');
  const state = signData({ ch: challenge, kind, jti: randomUUID(), e: ctx.clock.now().getTime() + CHALLENGE_MS, ...extra }, 'passkey');
  return { challenge, state };
}

/** Uses up a challenge or pending token (single use). False when it was used before. */
async function consume(ctx: Ctx, jti: string, expiresMs: number): Promise<boolean> {
  const now = ctx.clock.now();
  await ctx.db.query(`DELETE FROM passkey_used WHERE expires_at < $1`, [new Date(now.getTime() - 60_000).toISOString()]);
  const r = await ctx.db.query<any>(`INSERT INTO passkey_used (jti, expires_at) VALUES ($1,$2) ON CONFLICT (jti) DO NOTHING RETURNING jti`, [jti, new Date(expiresMs).toISOString()]);
  return r.length > 0;
}

async function readState(ctx: Ctx, state: unknown, kind: string): Promise<Record<string, any>> {
  const p = verifyData(String(state ?? ''), 'passkey', ctx.clock.now().getTime());
  if (!p || p.kind !== kind || typeof p.ch !== 'string' || typeof p.jti !== 'string') throw new HttpError(400, 'This passkey request has expired. Please start again.', 'challenge_expired');
  return p;
}

function makePending(ctx: Ctx, uid: string, kind: 'second' | 'enrol') {
  return signData({ uid, kind, jti: randomUUID(), e: ctx.clock.now().getTime() + PENDING_MS }, 'passkey_pending');
}
function readPending(ctx: Ctx, token: unknown, kind: 'second' | 'enrol') {
  const p = verifyData(String(token ?? ''), 'passkey_pending', ctx.clock.now().getTime());
  if (!p || p.kind !== kind || typeof p.uid !== 'string' || typeof p.jti !== 'string') throw new HttpError(401, 'Your sign-in has expired. Please sign in again.', 'pending_expired');
  return p;
}

/**
 * Called after the SMS code is right. In demo mode never anything. In sms mode:
 * a platform admin with a passkey must present it ({needsPasskey, pending}); without one, REQUIRE_ADMIN_PASSKEY=1 sends them to add one first
 * ({needsEnrolment, pending}); otherwise they are let in (the admin app shows a banner).
 */
export async function secondFactorGate(ctx: Ctx, user: any): Promise<null | { needsPasskey: true; pending: string } | { needsEnrolment: true; pending: string }> {
  if (authMode() !== 'sms' || !user.is_platform_admin) return null;
  if ((await passkeyCount(ctx, user.id)) > 0) return { needsPasskey: true, pending: makePending(ctx, user.id, 'second') };
  if (passkeyRequiredForAdmins()) return { needsEnrolment: true, pending: makePending(ctx, user.id, 'enrol') };
  return null;
}

async function finishSignIn(ctx: Ctx, req: FastifyRequest, user: any, how: string) {
  await ctx.ledger.audit({ action: 'security.login', category: 'security', actorId: user.id, actorName: user.name, actorType: user.is_platform_admin ? 'admin' : 'user', summary: `${user.name} signed in${how}`, meta: { phone: maskPhone(user.phone), method: how.trim() || 'code' } });
  const { token } = await createSession(ctx, user, req);
  return { token, user: { id: user.id, name: user.name, phone: user.phone, isAdmin: user.is_platform_admin } };
}

export function passkeyRoutes(app: FastifyInstance, ctx: Ctx) {
  const limit = (req: FastifyRequest) => {
    const r = rateLimit(ctx, `passkey:ip:${clientIp(req)}`, { max: 100, windowMs: 10 * 60_000 });
    if (!r.ok) tooMany('Too many attempts. Please wait a few minutes and try again.', r.retryAfterSec);
  };
  const userRow = async (uid: string) => (await ctx.db.query<any>(`SELECT * FROM users WHERE id=$1`, [uid]))[0];
  const credentialOf = (b: any) => {
    if (!b?.credential || typeof b.credential !== 'object' || typeof b.credential.id !== 'string' || b.credential.id.length > 1400) throw new HttpError(400, 'Missing passkey response', 'bad_request');
    return b.credential;
  };

  // ---------- add a passkey (signed in, or in the enrolment step of a required sign-in) ----------

  /** Who is adding a passkey: a signed-in person, or someone holding an enrolment token from sign-in. */
  async function registrant(req: FastifyRequest): Promise<{ uid: string; pending?: Record<string, any> }> {
    const s = await getHeaderSession(ctx, req);
    if (s) return { uid: s.uid };
    const pending = readPending(ctx, (req.body as any)?.pending, 'enrol');
    return { uid: pending.uid, pending };
  }

  app.post('/auth/passkeys/register/options', async (req) => {
    limit(req);
    const who = await registrant(req);
    const u = await userRow(who.uid);
    if (!u) throw new HttpError(401, 'sign in required', 'unauthenticated');
    if ((await passkeyCount(ctx, u.id)) >= MAX_PASSKEYS) throw new HttpError(409, `You can keep up to ${MAX_PASSKEYS} passkeys. Remove one first.`, 'too_many_passkeys');
    const existing = await ctx.db.query<any>(`SELECT credential_id, transports FROM passkeys WHERE user_id=$1`, [u.id]);
    const { challenge, state } = newChallenge(ctx, 'register', { uid: u.id });
    return {
      state,
      options: {
        rp: { name: rpName(), id: rpId() },
        user: { id: Buffer.from(u.id).toString('base64url'), name: maskPhone(u.phone), displayName: u.name },
        challenge,
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        timeout: 120_000,
        attestation: 'none',
        excludeCredentials: existing.map((e) => ({ type: 'public-key', id: e.credential_id, transports: e.transports ?? undefined })),
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' },
      },
    };
  });

  app.post('/auth/passkeys/register/verify', async (req) => {
    limit(req);
    const who = await registrant(req);
    const b = (req.body ?? {}) as any;
    const st = await readState(ctx, b.state, 'register');
    if (st.uid !== who.uid) throw new HttpError(400, 'This passkey request does not belong to you. Please start again.', 'challenge_expired');
    if (!(await consume(ctx, st.jti, st.e))) throw new HttpError(400, 'This passkey request was already used. Please start again.', 'challenge_expired');
    let reg;
    try { reg = verifyRegistration({ credential: credentialOf(b), expectedChallenge: st.ch, rpId: rpId() }); }
    catch (e) {
      if (e instanceof WebAuthnError) throw new HttpError(400, 'That passkey could not be added. Please try again.', 'bad_passkey');
      throw e;
    }
    // The enrolment step of a required sign-in works once; it is used up before anything is stored.
    if (who.pending && !(await consume(ctx, who.pending.jti, who.pending.e))) throw new HttpError(401, 'Your sign-in has expired. Please sign in again.', 'pending_expired');
    const name = str(b.name ?? 'My passkey', { max: 60, label: 'The passkey name', allowNumber: false }) || 'My passkey';
    const now = ctx.clock.now().toISOString();
    const id = ctx.newId('pk');
    const ins = await ctx.db.query<any>(
      `INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, name, created_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT (credential_id) DO NOTHING RETURNING id`,
      [id, who.uid, reg.credentialId, reg.publicKey, reg.counter, JSON.stringify(reg.transports), name, now],
    );
    if (!ins.length) throw new HttpError(409, 'This passkey is already registered.', 'duplicate');
    const u = await userRow(who.uid);
    await ctx.ledger.audit({ action: 'security.passkey_added', category: 'security', actorId: u.id, actorName: u.name, actorType: u.is_platform_admin ? 'admin' : 'user', summary: `${u.name} added a passkey`, meta: { name } });
    if (who.pending) {
      // The new passkey completes the required sign-in.
      return { id, name, ...(await finishSignIn(ctx, req, u, ' with a new passkey')) };
    }
    return { id, name };
  });

  // ---------- list and remove ----------

  app.get('/auth/passkeys', { preHandler: requireSession }, async (req) => {
    const rows = await ctx.db.query<any>(`SELECT id, name, created_at, last_used_at, transports FROM passkeys WHERE user_id=$1 ORDER BY created_at`, [req.session!.uid]);
    return {
      mode: authMode(),
      isAdmin: req.session!.isAdmin,
      passkeyRequiredForAdmins: passkeyRequiredForAdmins(),
      passkeys: rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at, transports: r.transports ?? [] })),
    };
  });

  app.delete('/auth/passkeys/:id', { preHandler: requireSession }, async (req) => {
    const s = req.session!;
    const id = String((req.params as any).id);
    const n = await passkeyCount(ctx, s.uid);
    if (s.isAdmin && passkeyRequiredForAdmins() && authMode() === 'sms' && n <= 1) throw new HttpError(409, 'Platform admins must keep at least one passkey.', 'last_passkey');
    const r = await ctx.db.query<any>(`DELETE FROM passkeys WHERE id=$1 AND user_id=$2 RETURNING name`, [id, s.uid]);
    if (!r.length) throw new HttpError(404, 'Passkey not found', 'not_found');
    await ctx.ledger.audit({ action: 'security.passkey_removed', category: 'security', actorId: s.uid, actorName: s.name, actorType: s.isAdmin ? 'admin' : 'user', summary: `${s.name} removed a passkey`, meta: { name: r[0].name } });
    return { ok: true };
  });

  // ---------- sign in with a passkey (no code, no phone number) ----------

  app.post('/auth/passkeys/login/options', async (req) => {
    limit(req);
    const { challenge, state } = newChallenge(ctx, 'login');
    return { state, options: { challenge, rpId: rpId(), timeout: 120_000, userVerification: 'required', allowCredentials: [] } };
  });

  app.post('/auth/passkeys/login/verify', async (req) => {
    limit(req);
    const b = (req.body ?? {}) as any;
    const st = await readState(ctx, b.state, 'login');
    if (!(await consume(ctx, st.jti, st.e))) throw new HttpError(400, 'This passkey request was already used. Please start again.', 'challenge_expired');
    const cred = credentialOf(b);
    const row = (await ctx.db.query<any>(`SELECT * FROM passkeys WHERE credential_id=$1`, [cred.id]))[0];
    if (!row) throw bad();
    const user = await userRow(row.user_id);
    if (!user) throw bad();
    try {
      const out = verifyAssertion({ credential: cred, expectedChallenge: st.ch, rpId: rpId(), publicKey: row.public_key, counter: Number(row.counter), requireUv: true });
      await useCounter(row, out.counter);
    } catch (e) {
      if (e instanceof WebAuthnError) return fail(user, e.message);
      throw e;
    }
    return finishSignIn(ctx, req, user, ' with a passkey');
  });

  async function fail(user: any, why: string): Promise<never> {
    if (rateLimit(ctx, `passkey:failaudit:${user.id}`, { max: 1, windowMs: 3600_000 }).ok) {
      await ctx.ledger.audit({ action: 'security.login_failed', category: 'security', actorType: 'system', summary: 'A passkey was refused', meta: { phone: maskPhone(user.phone), reason: why.slice(0, 80) } });
    }
    throw bad();
  }
  /** Moves the counter forward only if nobody else did meanwhile, so one assertion cannot be used twice in parallel. */
  async function useCounter(row: any, counter: number) {
    const r = await ctx.db.query<any>(`UPDATE passkeys SET counter=$2, last_used_at=$4 WHERE id=$1 AND counter=$3 RETURNING id`, [row.id, counter, Number(row.counter), ctx.clock.now().toISOString()]);
    if (!r.length) throw new WebAuthnError('Counter changed');
  }

  // ---------- second factor after the SMS code (platform admins) ----------

  app.post('/auth/passkeys/second/options', async (req) => {
    limit(req);
    const p = readPending(ctx, (req.body as any)?.pending, 'second');
    const keys = await ctx.db.query<any>(`SELECT credential_id, transports FROM passkeys WHERE user_id=$1`, [p.uid]);
    const { challenge, state } = newChallenge(ctx, 'second', { uid: p.uid, pj: p.jti });
    return { state, options: { challenge, rpId: rpId(), timeout: 120_000, userVerification: 'preferred', allowCredentials: keys.map((k) => ({ type: 'public-key', id: k.credential_id, transports: k.transports ?? undefined })) } };
  });

  app.post('/auth/passkeys/verify-second', async (req) => {
    limit(req);
    const b = (req.body ?? {}) as any;
    const p = readPending(ctx, b.pending, 'second');
    const st = await readState(ctx, b.state, 'second');
    if (st.uid !== p.uid || st.pj !== p.jti) throw new HttpError(400, 'This passkey request does not match your sign-in. Please start again.', 'challenge_expired');
    if (!(await consume(ctx, st.jti, st.e))) throw new HttpError(400, 'This passkey request was already used. Please start again.', 'challenge_expired');
    const cred = credentialOf(b);
    const row = (await ctx.db.query<any>(`SELECT * FROM passkeys WHERE credential_id=$1 AND user_id=$2`, [cred.id, p.uid]))[0];
    const user = await userRow(p.uid);
    if (!row || !user) throw bad();
    try {
      const out = verifyAssertion({ credential: cred, expectedChallenge: st.ch, rpId: rpId(), publicKey: row.public_key, counter: Number(row.counter) });
      await useCounter(row, out.counter);
    } catch (e) {
      if (e instanceof WebAuthnError) return fail(user, e.message);
      throw e;
    }
    // The pending sign-in works once: a wrong passkey above leaves it open for another try until it expires (5 minutes).
    if (!(await consume(ctx, p.jti, p.e))) throw new HttpError(401, 'Your sign-in has expired. Please sign in again.', 'pending_expired');
    return finishSignIn(ctx, req, user, ' with a code and a passkey');
  });
}
