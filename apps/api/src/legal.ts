import type { FastifyInstance, FastifyRequest } from 'fastify';
import { runSystem } from '@churchos/ledger';
import { ACCEPT_DOCS, DOC_SLUGS, LEGAL_EFFECTIVE, LEGAL_UPDATED, LEGAL_VERSION, OPERATOR, type AcceptDoc } from '@churchos/shared';
import { branchesFor, keyedHash } from './auth';
import { HttpError, requireSession, type Ctx } from './ctx';
import { isProduction } from './cors';

/**
 * Legal acceptances (Terms of Use and Privacy Notice, the church's Data Processing Agreement, a guardian's agreement for a child).
 * One row per person, document, version and church (and child, for the guardian agreement). Never deleted by a retention job and kept
 * after an erasure as legal evidence: the row points at the closed account, which no longer carries a name or phone number.
 * The network address is stored only as a keyed hash (HMAC with a server secret).
 */
export const LEGAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS legal_acceptances (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  org_id text,
  doc text NOT NULL CHECK (doc IN ('terms_privacy','dpa','kids_guardian')),
  version text NOT NULL,
  accepted_at timestamptz NOT NULL,
  app text,
  ip_hash text,
  user_agent text,
  subject_id text
);
CREATE INDEX IF NOT EXISTS legal_acceptances_user_idx ON legal_acceptances (user_id, doc);
CREATE INDEX IF NOT EXISTS legal_acceptances_org_idx ON legal_acceptances (org_id, doc);
CREATE UNIQUE INDEX IF NOT EXISTS legal_acceptances_once ON legal_acceptances (user_id, doc, version, COALESCE(org_id, ''), COALESCE(subject_id, ''));
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS consent_notice_version text;
-- A payer who continued past "By continuing you agree to the Terms of Use and Privacy Notice" on the giving page: the version they were shown, with the payment or order.
ALTER TABLE give_intents ADD COLUMN IF NOT EXISTS legal_version text;
ALTER TABLE give_intents ADD COLUMN IF NOT EXISTS legal_accepted_at timestamptz;
ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS legal_version text;
ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS legal_accepted_at timestamptz;
`;

const KNOWN_APPS = new Set(['staff', 'member', 'giving', 'admin']);
const clampApp = (v: unknown): string | null => (typeof v !== 'string' ? null : KNOWN_APPS.has(v) ? v : 'unknown');
/** The version a client says it showed (giving page). Stored as sent when it looks like a version date, otherwise ignored. */
export const legalVersionOf = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const isAcceptDoc = (d: unknown): d is AcceptDoc => (ACCEPT_DOCS as readonly string[]).includes(String(d));

/** The public details of the operator. */
export const operatorPublic = () => ({ name: OPERATOR.name, email: OPERATOR.email, address: OPERATOR.address, postalAddress: OPERATOR.postalAddress, odpcStatus: OPERATOR.odpcStatus, odpcNumber: OPERATOR.odpcNumber });

/**
 * Whether a church must have accepted the Data Processing Agreement before it sends bulk messages. ENFORCE_DPA_BULK=1 or 0 decides.
 * Unset: on for a real launch (production with demo data off), off for development, tests and the demo deployment.
 */
export function dpaRequiredForBulk(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ENFORCE_DPA_BULK === '1') return true;
  if (env.ENFORCE_DPA_BULK === '0') return false;
  return isProduction(env) && env.SEED_DEMO === '0';
}

export async function dpaAccepted(ctx: Ctx, orgId: string): Promise<{ at: string; by: string } | null> {
  const r = (await runSystem(() => ctx.db.query<any>(`SELECT accepted_at, user_id FROM legal_acceptances WHERE org_id=$1 AND doc='dpa' AND version=$2 ORDER BY accepted_at LIMIT 1`, [orgId, LEGAL_VERSION])))[0];
  return r ? { at: new Date(r.accepted_at).toISOString(), by: r.user_id } : null;
}

/** Refuses a bulk message from a church whose Organisation Owner has not accepted the Data Processing Agreement. */
export async function requireDpaForBulk(ctx: Ctx, orgId: string) {
  if (!dpaRequiredForBulk()) return;
  if (await dpaAccepted(ctx, orgId)) return;
  throw new HttpError(409, 'Before your church sends messages to many people, its Organisation Owner needs to accept the Data Processing Agreement. Ask the owner to open Today in the staff app and accept it. It takes a minute.', 'dpa_required');
}

export interface AcceptInput { userId: string; orgId: string | null; doc: AcceptDoc; version: string; app: string | null; subjectId?: string | null }

/** Records one acceptance. Safe to repeat: the same person, document, version and church is recorded once. Returns whether a row was created. */
export async function recordAcceptance(ctx: Ctx, a: AcceptInput, req?: FastifyRequest): Promise<{ created: boolean; at: string }> {
  const now = ctx.clock.now().toISOString();
  const ip = req?.ip ?? null;
  const ua = String(req?.headers['user-agent'] ?? '').slice(0, 120) || null;
  const rows = await ctx.db.query<any>(
    `INSERT INTO legal_acceptances (id, user_id, org_id, doc, version, accepted_at, app, ip_hash, user_agent, subject_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT DO NOTHING RETURNING id`,
    [ctx.newId('lga'), a.userId, a.orgId, a.doc, a.version, now, a.app, ip ? keyedHash(ip, 'legal_ip') : null, ua, a.subjectId ?? null],
  );
  if (rows.length > 0) {
    await ctx.ledger.audit({ orgId: a.orgId, actor: a.userId, action: 'legal.accepted', category: 'member', entity: 'legal_acceptance', entityId: rows[0].id, summary: `Accepted ${a.doc === 'terms_privacy' ? 'the Terms of Use and Privacy Notice' : a.doc === 'dpa' ? 'the Data Processing Agreement' : "a guardian's agreement for a child"} (version ${a.version})`, meta: { doc: a.doc, version: a.version, app: a.app } });
    return { created: true, at: now };
  }
  const earlier = (await ctx.db.query<any>(`SELECT accepted_at FROM legal_acceptances WHERE user_id=$1 AND doc=$2 AND version=$3 AND COALESCE(org_id,'')=COALESCE($4,'') AND COALESCE(subject_id,'')=COALESCE($5,'') LIMIT 1`, [a.userId, a.doc, a.version, a.orgId, a.subjectId ?? null]))[0];
  return { created: false, at: earlier ? new Date(earlier.accepted_at).toISOString() : now };
}

export function legalRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };

  /** What the legal pages need: the current version, the dates and who runs the service. Nothing personal. */
  app.get('/public/legal', async () => ({ version: LEGAL_VERSION, effective: LEGAL_EFFECTIVE, updated: LEGAL_UPDATED, documents: DOC_SLUGS, operator: operatorPublic() }));

  /** What the signed-in person must accept, and whether they have. For a church owner it also lists the Data Processing Agreement of each church they own. */
  app.get('/legal/status', auth, async (req) => {
    const uid = req.session!.uid;
    const tp = (await ctx.db.query<any>(`SELECT accepted_at FROM legal_acceptances WHERE user_id=$1 AND doc='terms_privacy' AND version=$2 LIMIT 1`, [uid, LEGAL_VERSION]))[0];
    const required: { doc: AcceptDoc; version: string; accepted: boolean; acceptedAt: string | null; orgId?: string; church?: string }[] = [
      { doc: 'terms_privacy', version: LEGAL_VERSION, accepted: !!tp, acceptedAt: tp ? new Date(tp.accepted_at).toISOString() : null },
    ];
    const orgIds = [...new Set((await branchesFor(ctx.db, uid, 'members.settings')).map((r) => r.orgId))];
    for (const orgId of orgIds) {
      const org = (await runSystem(() => ctx.db.query<any>(`SELECT name FROM organisations WHERE id=$1`, [orgId])))[0];
      const d = await dpaAccepted(ctx, orgId);
      required.push({ doc: 'dpa', version: LEGAL_VERSION, accepted: !!d, acceptedAt: d?.at ?? null, orgId, church: org?.name });
    }
    return { version: LEGAL_VERSION, effective: LEGAL_EFFECTIVE, required, enforced: process.env.ENFORCE_LEGAL_ACCEPTANCE === '1', operator: operatorPublic() };
  });

  /** Records an acceptance of the CURRENT version only. An older or invented version is refused so a stale screen cannot record the wrong thing. */
  app.post('/legal/accept', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const s = req.session!;
    if (!isAcceptDoc(b.doc)) throw new HttpError(400, 'Unknown document', 'bad_doc');
    if (String(b.version ?? '') !== LEGAL_VERSION) throw new HttpError(409, 'These documents have been updated. Please reload the page and read the latest version.', 'legal_version_mismatch');
    let orgId: string | null = null;
    if (b.doc !== 'terms_privacy') {
      orgId = String(b.orgId ?? '');
      const perm = b.doc === 'dpa' ? 'members.settings' : 'members.edit';
      if (!orgId || !(await branchesFor(ctx.db, s.uid, perm)).some((r) => r.orgId === orgId)) {
        throw new HttpError(403, b.doc === 'dpa' ? "Only the church's Organisation Owner can accept the Data Processing Agreement" : 'You cannot record this for that church', 'forbidden');
      }
    }
    const r = await recordAcceptance(ctx, { userId: s.uid, orgId, doc: b.doc, version: LEGAL_VERSION, app: clampApp(b.app ?? req.headers['x-churchos-app']), subjectId: null }, req);
    return { ok: true, doc: b.doc, version: LEGAL_VERSION, acceptedAt: r.at, alreadyAccepted: !r.created };
  });
}
