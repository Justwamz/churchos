import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { canonical, type AuditChange } from '@churchos/ledger';
import { maskValue, type MaskKind } from '@churchos/shared';
import type { Ctx } from './ctx';
import type { Session } from './auth';

// ---------- request context: who and where, attached to every event automatically (L104) ----------

export interface RequestAudit {
  ip: string | null;
  userAgent: string | null;
  app: string | null;
  requestId: string | null;
  actorId?: string;
  actorName?: string;
  actorType?: 'user' | 'admin' | 'member';
}

export const als = new AsyncLocalStorage<RequestAudit>();

/** Read by the ledger each time it writes an audit event. */
export const auditContext = () => als.getStore();

/** Called once the signed-in user is known, so later events carry their name and capacity. */
export function setActor(s: Session) {
  const st = als.getStore();
  if (!st) return;
  st.actorId = s.uid;
  st.actorName = s.name;
  st.actorType = s.isAdmin ? 'admin' : 'user';
}

// ---------- field changes (L104) ----------

export interface FieldSpec {
  field: string;
  label: string;
  /** Sensitive values are stored masked in the log (L109). */
  mask?: MaskKind;
}

const same = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);

/** Returns only the fields that changed, with sensitive values masked before they are ever stored. */
export function diff(specs: FieldSpec[], before: Record<string, any> | null, after: Record<string, any>): AuditChange[] {
  const out: AuditChange[] = [];
  for (const s of specs) {
    const b = before ? before[s.field] : undefined;
    const a = after[s.field];
    if (before && same(b, a)) continue;
    if (!before && (a === undefined || a === null || a === '')) continue;
    out.push({
      field: s.field,
      label: s.label,
      before: before ? (s.mask ? maskValue(s.mask, b) : b ?? null) : null,
      after: s.mask ? maskValue(s.mask, a) : a ?? null,
      ...(s.mask ? { masked: true } : {}),
    });
  }
  return out;
}

export const sha = (s: string | null | undefined) => (s ? createHash('sha256').update(s).digest('hex').slice(0, 16) : null);

// ---------- what each kind of thing records ----------

export const MEMBER_SPECS: FieldSpec[] = [
  { field: 'full_name', label: 'Name' },
  { field: 'category', label: 'Adult or child' },
  { field: 'sex', label: 'Sex' },
  { field: 'dob', label: 'Date of birth', mask: 'dob' },
  { field: 'phone', label: 'Phone', mask: 'phone' },
  { field: 'branch_id', label: 'Branch' },
  { field: 'household_id', label: 'Household' },
  { field: 'is_primary_contact', label: 'Primary contact' },
  { field: 'guardians', label: 'Guardians' },
];

export const RECORD_SPECS: FieldSpec[] = [
  { field: 'subject_name', label: 'Name' },
  { field: 'event_date', label: 'Date' },
  { field: 'place', label: 'Place' },
  { field: 'officiant', label: 'Officiant' },
  { field: 'register_number', label: 'Register number' },
  { field: 'dob', label: 'Date of birth', mask: 'dob' },
  { field: 'birthplace', label: 'Birthplace' },
  { field: 'father', label: 'Father' },
  { field: 'mother', label: 'Mother' },
  { field: 'sponsors', label: 'Sponsors' },
  { field: 'parties', label: 'Parties' },
  { field: 'certificateNumber', label: 'Marriage certificate number', mask: 'id' },
  { field: 'issuingAuthority', label: 'Issuing authority' },
  { field: 'witnesses', label: 'Witnesses' },
  { field: 'file', label: 'Scan' },
];

export const TEMPLATE_SPECS: FieldSpec[] = [
  { field: 'churchName', label: 'Church name' },
  { field: 'tagline', label: 'Tagline' },
  { field: 'baptismTitle', label: 'Certificate title' },
  { field: 'baptismBody', label: 'Wording' },
  { field: 'signatories', label: 'Signatories' },
  { field: 'accent', label: 'Accent colour' },
  { field: 'footer', label: 'Footer note' },
  { field: 'showQr', label: 'Show QR code' },
  { field: 'copyPriceCents', label: 'Price of a copy (cents)' },
  { field: 'logo', label: 'Logo' },
];

export const BRANCH_PROFILE_SPECS: FieldSpec[] = [
  { field: 'address', label: 'Address' },
  { field: 'town', label: 'Town' },
  { field: 'phone', label: 'Phone', mask: 'phone' },
  { field: 'email', label: 'Email', mask: 'email' },
];

export const FEE_SPECS: FieldSpec[] = [
  { field: 'feeBearer', label: 'Who pays the fee' },
  { field: 'platform', label: 'Platform fee' },
  { field: 'psp.mpesa', label: 'M-Pesa cost' },
  { field: 'psp.airtel', label: 'Airtel Money cost' },
  { field: 'psp.tkash', label: 'T-Kash cost' },
  { field: 'psp.card', label: 'Card cost' },
  { field: 'psp.cash', label: 'Cash cost' },
];

export const PROJECT_SPECS: FieldSpec[] = [
  { field: 'name', label: 'Name' },
  { field: 'code', label: 'Code' },
  { field: 'description', label: 'Description' },
  { field: 'target', label: 'Target (cents)' },
  { field: 'deadline', label: 'Deadline' },
  { field: 'restricted', label: 'Restricted fund' },
  { field: 'status', label: 'Status' },
];

export const NUMBER_FORMAT_SPECS: FieldSpec[] = [
  { field: 'pattern', label: 'Member number format' },
  { field: 'next', label: 'Next number' },
];

/** Flattens a record row (details and file included) so one set of field specs covers it. */
export function flattenRecord(r: any): Record<string, any> {
  const d = r.details ?? {};
  return {
    subject_name: r.subject_name,
    event_date: r.event_date,
    place: r.place,
    officiant: r.officiant,
    register_number: r.register_number,
    dob: d.dob ?? null,
    birthplace: d.birthplace ?? null,
    father: d.father ?? null,
    mother: d.mother ?? null,
    sponsors: d.sponsors ?? null,
    parties: Array.isArray(d.parties) ? d.parties.map((p: any) => p.name) : null,
    certificateNumber: d.certificateNumber ?? null,
    issuingAuthority: d.issuingAuthority ?? null,
    witnesses: d.witnesses ?? null,
    file: r.file_name ? `${r.file_name} (${sha(r.file_data) ?? 'no data'})` : null,
  };
}

export function flattenFees(bearer: string, schedule: any): Record<string, any> {
  return { feeBearer: bearer, platform: schedule.platform, 'psp.mpesa': schedule.psp?.mpesa, 'psp.airtel': schedule.psp?.airtel, 'psp.tkash': schedule.psp?.tkash, 'psp.card': schedule.psp?.card, 'psp.cash': schedule.psp?.cash };
}

// ---------- version history (L105) ----------

/**
 * Keeps a full copy of the thing as it stood after a change. Versions are append-only like the log itself. Snapshots hold the
 * real values (they are the record), so they are readable only by people allowed to audit that church.
 */
export async function recordVersion(
  ctx: Ctx,
  v: { orgId: string; branchId?: string | null; entity: string; entityId: string; snapshot: unknown; summary: string; eventId?: string | null },
): Promise<number> {
  const who = auditContext();
  return ctx.db.tx(async (q) => {
    const n = Number((await q.query<any>(`SELECT COALESCE(MAX(version),0) AS n FROM entity_versions WHERE entity=$1 AND entity_id=$2`, [v.entity, v.entityId]))[0].n) + 1;
    await q.query(
      `INSERT INTO entity_versions (id, org_id, branch_id, entity, entity_id, version, snapshot, summary, changed_by, changed_by_name, changed_at, event_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [ctx.newId('ver'), v.orgId, v.branchId ?? null, v.entity, v.entityId, n, JSON.stringify(v.snapshot), v.summary, who?.actorId ?? null, who?.actorName ?? null, ctx.clock.now().toISOString(), v.eventId ?? null],
    );
    return n;
  });
}

/**
 * A version snapshot keeps sensitive values masked, like the audit events do (L109). The live record is the source of truth for
 * the real value, history only needs to show that it changed.
 */
export function maskedSnapshot(specs: FieldSpec[], flat: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of specs) {
    const v = flat[s.field];
    if (v === undefined) continue;
    out[s.field] = s.mask ? maskValue(s.mask, v) : v;
  }
  return out;
}

/**
 * Logs that someone viewed sensitive data (L109). A busy list screen reloads often, so the same person viewing the same kind of
 * data again within a minute is not logged twice.
 */
export async function logAccess(ctx: Ctx, e: { orgId: string; what: string; count: number }): Promise<void> {
  if (e.count <= 0) return;
  const who = auditContext();
  if (!who?.actorId) return;
  const since = new Date(ctx.clock.now().getTime() - 60_000).toISOString();
  const recent = await ctx.db.query<any>(`SELECT 1 FROM audit_events WHERE chain=$1 AND actor_id=$2 AND action='access.sensitive_view' AND summary=$3 AND at >= $4 LIMIT 1`, [e.orgId, who.actorId, `Viewed ${e.what}`, since]);
  if (recent.length) return;
  await ctx.ledger.audit({ orgId: e.orgId, action: 'access.sensitive_view', category: 'access', summary: `Viewed ${e.what}`, meta: { records: e.count } });
}
