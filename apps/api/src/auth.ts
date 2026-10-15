import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from '@churchos/ledger';

export const PERMISSIONS = [
  'collections.view',
  'settlements.view',
  'reports.view',
  'members.view',
  'members.edit',
  'members.sensitive',
  'members.settings',
  'records.view',
  'records.edit',
  'records.approve',
  'templates.manage',
  'audit.view',
  'audit.export',
  'members.reveal',
  'transfers.approve',
  'cash.count',
  'cash.approve',
  'projects.manage',
  'payouts.view',
  'payouts.manage',
  'kyc.manage',
  'messages.send',
  'messages.view',
  'wallets.view',
  'wallets.topup',
  'wallets.manage',
  'integrations.manage',
  'groups.manage',
  'reversals.request',
  'adverts.view',
  'adverts.manage',
  'adverts.approve',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Default role templates (L34). Organisations can build their own from the same permissions (L32). */
export const ROLE_TEMPLATES: Record<string, Permission[]> = {
  'Organisation Owner': [...PERMISSIONS],
  // Only the organisation owner sees or changes payout destinations (L35).
  'Branch Admin': PERMISSIONS.filter((p) => p !== 'payouts.view' && p !== 'payouts.manage' && p !== 'members.settings' && p !== 'audit.export' && p !== 'integrations.manage'),
  Treasurer: ['collections.view', 'settlements.view', 'reports.view', 'cash.count', 'cash.approve', 'projects.manage', 'reversals.request', 'wallets.view', 'wallets.topup'],
  Pastor: ['collections.view', 'reports.view', 'members.view', 'members.sensitive', 'members.reveal', 'transfers.approve', 'records.view', 'records.approve', 'messages.send', 'messages.view', 'groups.manage', 'adverts.view', 'adverts.approve'],
  // A read-only role an owner can give to an external or internal auditor (L108).
  Auditor: ['audit.view', 'audit.export', 'collections.view', 'settlements.view', 'reports.view', 'members.view', 'records.view'],
  Secretary: ['members.view', 'members.edit', 'members.sensitive', 'members.reveal', 'transfers.approve', 'records.view', 'records.edit', 'messages.view', 'groups.manage', 'adverts.view', 'adverts.manage'],
};

export interface Session {
  uid: string;
  phone: string;
  name: string;
  isAdmin: boolean;
}

const SECRET = process.env.CHURCHOS_AUTH_SECRET ?? 'dev-only-secret-change-me';
const TTL_MS = 12 * 3600_000;

export function signToken(s: Session): string {
  const payload = Buffer.from(JSON.stringify({ ...s, exp: Date.now() + TTL_MS })).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyToken(token: string | undefined): Session | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof p.exp !== 'number' || p.exp < Date.now()) return null;
    return { uid: p.uid, phone: p.phone, name: p.name, isAdmin: !!p.isAdmin };
  } catch {
    return null;
  }
}

export function normalizePhone(raw: string): string | null {
  const digits = String(raw ?? '').replace(/[^\d]/g, '');
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  if (/^[17]\d{8}$/.test(digits)) return `254${digits}`;
  return null;
}

export interface Grant {
  orgId: string;
  permissions: Set<string>;
  branchIds: string[];
}

/** Resolves what a user may do and where. Org scope = all the org's branches, region scope = branches in that region (L33). */
export async function loadGrants(db: Db, uid: string): Promise<Grant[]> {
  const rows = await db.query<any>(
    `SELECT ra.org_id, ra.scope_type, ra.scope_id, r.permissions FROM role_assignments ra JOIN roles r ON r.id = ra.role_id WHERE ra.user_id = $1`,
    [uid],
  );
  const byOrg = new Map<string, Grant>();
  for (const row of rows) {
    let branchIds: string[] = [];
    if (row.scope_type === 'org') {
      branchIds = (await db.query<any>(`SELECT id FROM branches WHERE org_id = $1`, [row.org_id])).map((b) => b.id);
    } else if (row.scope_type === 'region') {
      branchIds = (await db.query<any>(`SELECT id FROM branches WHERE org_id = $1 AND region = $2`, [row.org_id, row.scope_id])).map((b) => b.id);
    } else {
      branchIds = [row.scope_id];
    }
    const g = byOrg.get(row.org_id) ?? { orgId: row.org_id, permissions: new Set<string>(), branchIds: [] };
    for (const p of row.permissions as string[]) g.permissions.add(p);
    g.branchIds = [...new Set([...g.branchIds, ...branchIds])];
    byOrg.set(row.org_id, g);
  }
  return [...byOrg.values()];
}

/**
 * Branch ids where this user holds `permission`, per organisation.
 * Different roles can grant different permissions in different places, so this is evaluated per permission.
 */
export async function branchesFor(db: Db, uid: string, permission: Permission): Promise<{ orgId: string; branchId: string }[]> {
  const rows = await db.query<any>(
    `SELECT ra.org_id, ra.scope_type, ra.scope_id, r.permissions FROM role_assignments ra JOIN roles r ON r.id = ra.role_id WHERE ra.user_id = $1`,
    [uid],
  );
  const out = new Map<string, { orgId: string; branchId: string }>();
  for (const row of rows) {
    if (!(row.permissions as string[]).includes(permission)) continue;
    let ids: string[];
    if (row.scope_type === 'org') ids = (await db.query<any>(`SELECT id FROM branches WHERE org_id=$1`, [row.org_id])).map((b) => b.id);
    else if (row.scope_type === 'region') ids = (await db.query<any>(`SELECT id FROM branches WHERE org_id=$1 AND region=$2`, [row.org_id, row.scope_id])).map((b) => b.id);
    else ids = [row.scope_id];
    for (const id of ids) out.set(id, { orgId: row.org_id, branchId: id });
  }
  return [...out.values()];
}
