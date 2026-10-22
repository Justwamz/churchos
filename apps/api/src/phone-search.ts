import type { FastifyRequest } from 'fastify';
import { branchesFor } from './auth';
import type { Ctx } from './ctx';
import { rateLimit, tooMany } from './ratelimit';
import { inStaffScope } from './scope';

/** At least three digits in a row: the search could be matching a phone number. */
const PHONE_LIKE = /\d{3,}/;

/**
 * Whether a staff search may also match the REAL phone number (AZ-08). Only people who hold `members.reveal` over everything the
 * search covers can, so the phone mask cannot be defeated by guessing digits. Everyone else matches on name and member number only.
 * When the phone is used for matching, the search is rate limited per person (60 a minute) and one `member.phone_search` event is
 * written (the typed digits are not stored).
 *
 * `branchIds` is the branches the search covers; leave it out when the search covers the whole church.
 */
export async function phoneSearchAllowed(ctx: Ctx, req: FastifyRequest, orgId: string, q: string, branchIds?: string[]): Promise<boolean> {
  if (!PHONE_LIKE.test(q)) return false; // nothing phone-like was typed: names and numbers only, no limit needed
  let ok: boolean;
  if (branchIds) {
    const held = new Set((await branchesFor(ctx.db, req.session!.uid, 'members.reveal')).filter((r) => r.orgId === orgId).map((r) => r.branchId));
    ok = branchIds.length > 0 && branchIds.every((b) => held.has(b));
  } else ok = await inStaffScope(ctx, req, 'members.reveal', orgId, null);
  if (!ok) return false;
  const r = rateLimit(ctx, `phonesearch:${req.session!.uid}`, { max: 60, windowMs: 60_000 });
  if (!r.ok) tooMany('You are searching by phone number very quickly. Please wait a moment.', r.retryAfterSec);
  await ctx.ledger.audit({ orgId, actor: req.session!.uid, action: 'member.phone_search', category: 'access', entity: 'organisation', entityId: orgId, summary: 'Searched people by phone number' });
  return true;
}
