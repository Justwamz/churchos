import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Clock, Db, Ledger } from '@churchos/ledger';
import { isMock, type MockProvider, type Provider } from '@churchos/payments';
import type { MockEmailProvider, MockMessagingProvider } from '@churchos/messaging';
import { branchesFor, type Permission, type Session } from './auth';
import { bearerOf, getSession } from './sessions';
import { setActor } from './audit';
import { enterSessionScope } from './dbscope';
import { runSystem } from '@churchos/ledger';
import { LEGAL_VERSION } from '@churchos/shared';
import { randomBytes } from 'node:crypto';

/** Known only to this process: the demo seeding calls the API as demo users before they could have accepted the Terms, so those calls carry it. */
export const INTERNAL_SEED_KEY = randomBytes(16).toString('hex');

export interface Ctx {
  db: Db;
  ledger: Ledger;
  provider: Provider;
  messaging: MockMessagingProvider;
  email: MockEmailProvider;
  /** Where the public giving and card checkout pages live, for links in responses. */
  givingUrl: string;
  clock: Clock;
  events: EventEmitter;
  newId: (prefix: string) => string;
}

declare module 'fastify' {
  interface FastifyRequest {
    session?: Session;
    /** The app context, set by an onRequest hook so session checks can reach the database. */
    churchCtx?: Ctx;
  }
}

/** Where to send a payer for a card payment: the provider's hosted page when live, ChurchOS's own test page when simulated. */
export function checkoutLink(ctx: Ctx, r: { providerTxId: string; checkoutUrl?: string }, suffix = ''): string {
  return r.checkoutUrl ?? `${ctx.givingUrl}/checkout/${r.providerTxId}${suffix}`;
}

/** The simulator's development helpers. A live provider has none, so these routes answer 404 there. */
export function mockOnly(ctx: Ctx): MockProvider {
  if (!isMock(ctx.provider)) throw new HttpError(404, 'Only available with the simulated payment provider', 'not_found');
  return ctx.provider;
}

export { isMock };

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

/** The token from the Authorization header. A token in the query string is no longer accepted (use a download ticket, see sessions.ts). */
export function bearer(req: FastifyRequest): string | undefined {
  return bearerOf(req);
}

export async function requireSession(req: FastifyRequest, _reply: FastifyReply) {
  const c = req.churchCtx;
  const s = c ? await getSession(c, req) : null;
  if (!s) throw new HttpError(401, 'sign in required', 'unauthenticated');
  req.session = s;
  setActor(s);
  await enterSessionScope(c!, s);
  await enforceLegalAcceptance(c!, req, s);
}

// ENFORCE_LEGAL_ACCEPTANCE=1 (a launch switch, default off): a signed-in person who has not accepted the current Terms of Use and Privacy Notice gets 403 legal_acceptance_required
// on everything except sign-in and sign-out, the legal routes, their basic profile, their own data export and the erasure routes.
const LEGAL_EXEMPT = [/^\/auth\//, /^\/legal\//, /^\/public\//, /^\/me$/, /^\/me\/export$/, /^\/me\/erasure-(preview|request)$/];
async function enforceLegalAcceptance(c: Ctx, req: FastifyRequest, s: Session) {
  if (process.env.ENFORCE_LEGAL_ACCEPTANCE !== '1') return;
  if (req.headers['x-churchos-internal-seed'] === INTERNAL_SEED_KEY) return;
  const path = String(req.url).split('?')[0];
  if (LEGAL_EXEMPT.some((r) => r.test(path))) return;
  const ok = await runSystem(() => c.db.query<any>(`SELECT 1 FROM legal_acceptances WHERE user_id=$1 AND doc='terms_privacy' AND version=$2 LIMIT 1`, [s.uid, LEGAL_VERSION]));
  if (!ok[0]) throw new HttpError(403, 'Please read and accept the Terms of Use and the Privacy Notice to continue.', 'legal_acceptance_required');
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  await requireSession(req, reply);
  if (!req.session!.isAdmin) throw new HttpError(403, 'platform admin only', 'forbidden');
}

export interface StaffScope {
  orgId: string;
  branchIds: string[];
}

/**
 * Where the signed-in user holds `permission`. A user with grants in several organisations picks one with ?org=.
 * Asking for a branch outside the grant is a 403, never an empty result that could hide a leak.
 */
export async function staffScope(ctx: Ctx, req: FastifyRequest, permission: Permission, branchParam?: string): Promise<StaffScope> {
  const rows = await branchesFor(ctx.db, req.session!.uid, permission);
  if (rows.length === 0) throw new HttpError(403, `missing permission ${permission}`, 'forbidden');
  const wantedOrg = (req.query as any)?.org as string | undefined;
  const orgId = wantedOrg && rows.some((r) => r.orgId === wantedOrg) ? wantedOrg : rows[0].orgId;
  const branchIds = rows.filter((r) => r.orgId === orgId).map((r) => r.branchId);
  if (branchParam) {
    if (!branchIds.includes(branchParam)) throw new HttpError(403, 'no access to that branch', 'forbidden');
    return { orgId, branchIds: [branchParam] };
  }
  return { orgId, branchIds };
}

export function inList(start: number, n: number): string {
  return Array.from({ length: n }, (_, i) => `$${start + i}`).join(',');
}

/** Start of the current day in EAT (UTC+3) as an ISO string, relative to the (possibly advanced) platform clock. */
export function startOfDayEat(now: Date): string {
  const eat = new Date(now.getTime() + 3 * 3600_000);
  eat.setUTCHours(0, 0, 0, 0);
  return new Date(eat.getTime() - 3 * 3600_000).toISOString();
}
