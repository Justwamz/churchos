import { createHash, randomUUID } from 'node:crypto';
import type { Db } from './db';

export type ActorType = 'user' | 'admin' | 'member' | 'system' | 'psp';
export type AuditCategory = 'money' | 'member' | 'record' | 'access' | 'config' | 'security' | 'messaging' | 'system';

/** One changed field. Sensitive values are stored already masked, never in the clear (L109). */
export interface AuditChange {
  field: string;
  label?: string;
  before: unknown;
  after: unknown;
  masked?: boolean;
}

export interface AuditInput {
  orgId?: string | null;
  branchId?: string | null;
  actorId?: string | null;
  actorName?: string | null;
  actorType?: ActorType;
  action: string;
  category?: AuditCategory;
  entity?: string;
  entityId?: string;
  summary?: string;
  changes?: AuditChange[];
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  app?: string | null;
  requestId?: string | null;
  /** Pointers to related records, for example the payment or ledger entry a reversal relates to (L106). */
  links?: Record<string, string>;
  meta?: unknown;
}

const CATEGORY_BY_PREFIX: Record<string, AuditCategory> = {
  payment: 'money', payout: 'money', cash: 'money', reversal: 'money', suspense: 'money', settlement: 'money', fees: 'money', sms: 'money',
  member: 'member', members: 'member', transfer: 'member', household: 'member',
  record: 'record', template: 'record', kyc: 'record', project: 'config', payout_destination: 'config',
  access: 'access', security: 'security', message: 'messaging', broadcast: 'messaging', advert: 'config', notice: 'config', resource: 'config', booking: 'config', team: 'security', role: 'security', shop: 'money', ticket: 'money', kids: 'member', giving: 'money', attendance: 'member', giving_ledger: 'access', prayer: 'member', suggestion: 'config', expense: 'money', credit: 'money', statement: 'access', church: 'config', lectionary: 'config', event: 'config', wall: 'member',
};

export function categoryFor(action: string): AuditCategory {
  return CATEGORY_BY_PREFIX[action.split('.')[0]] ?? 'system';
}

/**
 * Stable JSON: object keys sorted, so the same event always hashes the same way. Values JSON cannot hold are treated exactly as
 * JSON.stringify treats them (an undefined property is dropped, an undefined array item becomes null), so an event hashes the same when it
 * is written and when it is read back from the database (LG-07).
 */
export function canonical(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined && typeof o[k] !== 'function').sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

/** What the database will hand back for a JSON value: the JSON round trip. */
const roundTrip = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(JSON.stringify(v)));

const HASHED = ['id', 'chain', 'at', 'org_id', 'branch_id', 'actor_id', 'actor_name', 'actor_type', 'action', 'category', 'entity', 'entity_id', 'summary', 'changes', 'reason', 'ip', 'user_agent', 'app', 'request_id', 'links', 'meta'] as const;

export function hashEvent(prevHash: string | null, row: Record<string, unknown>): string {
  const body: Record<string, unknown> = {};
  for (const k of HASHED) body[k] = row[k] ?? null;
  return createHash('sha256').update(`${prevHash ?? ''}|${canonical(body)}`).digest('hex');
}

/**
 * Appends one event to its chain. The chain is per organisation, with a shared 'platform' chain for events that belong to no
 * organisation. Each hash covers the previous one, so a changed or removed event is detectable (L107).
 */
export async function writeAudit(db: Db, at: string, e: AuditInput): Promise<string> {
  return db.tx(async (q) => {
    const chain = e.orgId ?? 'platform';
    const prev = (await q.query<{ hash: string }>(`SELECT hash FROM audit_events WHERE chain=$1 ORDER BY seq DESC LIMIT 1`, [chain]))[0];
    const row = {
      id: `evt_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      chain,
      at,
      org_id: e.orgId ?? null,
      branch_id: e.branchId ?? null,
      actor_id: e.actorId ?? null,
      actor_name: e.actorName ?? null,
      actor_type: e.actorType ?? (e.actorId ? 'user' : 'system'),
      action: e.action,
      category: e.category ?? categoryFor(e.action),
      entity: e.entity ?? null,
      entity_id: e.entityId ?? null,
      summary: e.summary ?? e.action.replace(/[._]/g, ' '),
      changes: e.changes && e.changes.length ? roundTrip(e.changes) : null,
      reason: e.reason ?? null,
      ip: e.ip ?? null,
      user_agent: e.userAgent ? String(e.userAgent).slice(0, 200) : null,
      app: e.app ?? null,
      request_id: e.requestId ?? null,
      links: roundTrip(e.links),
      meta: roundTrip(e.meta),
    };
    const hash = hashEvent(prev?.hash ?? null, row);
    await q.query(
      `INSERT INTO audit_events (id, chain, at, org_id, branch_id, actor_id, actor_name, actor_type, action, category, entity, entity_id, summary, changes, reason, ip, user_agent, app, request_id, links, meta, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [row.id, chain, at, row.org_id, row.branch_id, row.actor_id, row.actor_name, row.actor_type, row.action, row.category, row.entity, row.entity_id, row.summary,
       row.changes ? JSON.stringify(row.changes) : null, row.reason, row.ip, row.user_agent, row.app, row.request_id, row.links ? JSON.stringify(row.links) : null,
       row.meta === null || row.meta === undefined ? null : JSON.stringify(row.meta), prev?.hash ?? null, hash],
    );
    return row.id;
  });
}

export interface ChainReport {
  chain: string;
  events: number;
  ok: boolean;
  /** Sequence number of the first event that does not match, when the chain is broken. */
  brokenAtSeq?: number;
  reason?: string;
  /** Every event that does not match, not only the first (LG-07). Empty when the chain is intact. */
  breaks?: { seq: number; reason: string }[];
}

/**
 * Recomputes every hash and checks each event points at the one before it. It does not stop at the first problem: every event that does
 * not match is listed in `breaks`, and brokenAtSeq / reason still name the first one.
 *
 * Note on old data: events written before the LG-07 fix whose meta held an `undefined` value (the kids.* events) were hashed with that
 * value as null, but the database keeps no such key, so they can no longer be re-verified and report 'changed'. They are listed by seq
 * with the others; a chain whose only breaks are kids.* events from before the fix is a known artefact, not tampering. New events hash
 * identically on write and read.
 */
export async function verifyChains(db: Db, chain?: string): Promise<ChainReport[]> {
  const chains = chain
    ? [chain]
    : (await db.query<{ chain: string }>(`SELECT DISTINCT chain FROM audit_events ORDER BY chain`)).map((r) => r.chain);
  const out: ChainReport[] = [];
  for (const c of chains) {
    const rows = await db.query<any>(`SELECT * FROM audit_events WHERE chain=$1 ORDER BY seq`, [c]);
    let prev: string | null = null;
    const breaks: { seq: number; reason: string }[] = [];
    for (const r of rows) {
      if ((r.prev_hash ?? null) !== prev) breaks.push({ seq: Number(r.seq), reason: 'an earlier event was removed or reordered' });
      if (hashEvent(r.prev_hash ?? null, r) !== r.hash) breaks.push({ seq: Number(r.seq), reason: 'this event was changed after it was written' });
      prev = r.hash; // carry on from what is stored, so one bad event does not hide later ones
    }
    out.push(breaks.length === 0 ? { chain: c, events: rows.length, ok: true } : { chain: c, events: rows.length, ok: false, brokenAtSeq: breaks[0].seq, reason: breaks[0].reason, breaks });
  }
  return out;
}
