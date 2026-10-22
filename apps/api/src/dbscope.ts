import { dbScope, runSystem, type DbScope } from '@churchos/ledger';
import type { Ctx } from './ctx';
import type { Session } from './auth';

/**
 * Which tenant scope a request runs in (AZ-20). The database layer reads the scope from AsyncLocalStorage (see `dbScope` in
 * packages/ledger/src/db.ts), so handlers need no change.
 *
 * Modes, and why:
 * - BYPASS (owner connection, every row): routes that are public or keyed by a code or secret, where there is no signed-in church
 *   (`/public/*`, `/auth/*`, `/webhooks/*`, `/psp/*`, `/help/*`, `/health`, `/permissions`, `/stream/*`); the platform admin (`requireAdmin`);
 *   scheduled jobs, start-up and seeds (no scope at all); webhook delivery from the simulator and audit chain writes (`runSystem`).
 * - ORG SCOPE (`churchos_app`, row-level security on): every other request, after sign-in, limited to the churches the person
 *   is connected to: a role, a membership, a join request or a link offer. A request that never signs in gets an empty scope and
 *   sees nothing (fail closed).
 */
const BYPASS_PREFIXES = ['/public/', '/auth/', '/webhooks/', '/psp/', '/help/', '/stream/', '/me/link/'];
// /me/reversal-request finds a payment by the code in an SMS, in any church. Kiosk pairing is keyed by a one-time code; the other kiosk routes start closed and kioskAuth scopes them to the device church.
const BYPASS_EXACT = new Set(['/health', '/permissions', '/me/reversal-request', '/kiosk/pair']);

// A transfer between churches is decided by the receiving church and moves a membership across the boundary on purpose.
const BYPASS_PATTERNS = [/^POST \/transfers\/[^/]+\/decide$/];

export function initialScope(url: string, method = 'GET'): DbScope {
  const path = String(url).split('?')[0];
  const open = BYPASS_EXACT.has(path) || BYPASS_PATTERNS.some((r) => r.test(`${method} ${path}`)) || BYPASS_PREFIXES.some((p) => path.startsWith(p));
  return { bypass: open, orgIds: [] };
}

/** Churches a person is connected to. Read with every row visible: this is how the scope is decided. */
export async function orgsOfUser(ctx: Ctx, uid: string): Promise<string[]> {
  const rows = await runSystem(() =>
    ctx.db.query<{ org_id: string }>(
      `SELECT org_id FROM role_assignments WHERE user_id=$1
       UNION SELECT org_id FROM memberships WHERE user_id=$1
       UNION SELECT org_id FROM join_requests WHERE user_id=$1
       UNION SELECT org_id FROM link_offers WHERE user_id=$1
       UNION SELECT org_id FROM event_credits WHERE user_id=$1
       UNION SELECT org_id FROM ticket_orders WHERE buyer_user_id=$1
       UNION SELECT org_id FROM giving_plans WHERE user_id=$1`,
      [uid],
    ),
  );
  return rows.map((r) => r.org_id).filter(Boolean);
}

/** Called by requireSession once the person is known: narrows the request from "nothing" to their churches (admin: everything). */
export async function enterSessionScope(ctx: Ctx, s: Session): Promise<void> {
  const st = dbScope.getStore();
  if (!st) return;
  if (st.bypass && s.isAdmin) return;
  if (s.isAdmin) { st.bypass = true; return; }
  if (st.bypass) return; // an open route that also signs the person in (help, stream) keeps its own rules
  st.orgIds = await orgsOfUser(ctx, s.uid);
}
