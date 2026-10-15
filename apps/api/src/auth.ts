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
  'notices.view',
  'notices.manage',
  'events.view',
  'events.manage',
  'resources.manage',
  'bookings.view',
  'bookings.manage',
  'team.view',
  'team.manage',
  'shop.view',
  'shop.sell',
  'shop.manage',
  'events.checkin',
  'kids.checkin',
  'kids.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Plain words and a group for every permission, for the screen where roles are built (L32). Every permission must appear here. */
export const PERMISSION_INFO: Record<Permission, { label: string; group: string; hint?: string }> = {
  'collections.view': { group: 'Money', label: 'See collections and the dashboard', hint: 'Giving as it arrives, by method and purpose.' },
  'settlements.view': { group: 'Money', label: 'See settlements', hint: 'What is held, ready to pay out and paid out.' },
  'reports.view': { group: 'Money', label: 'See reports' },
  'cash.count': { group: 'Money', label: 'Count and record cash' },
  'cash.approve': { group: 'Money', label: 'Approve counted cash', hint: 'A second person signs off recorded cash.' },
  'projects.manage': { group: 'Money', label: 'Create and manage projects' },
  'reversals.request': { group: 'Money', label: 'Ask for a payment to be reversed' },
  'payouts.view': { group: 'Money', label: 'See the payout account' },
  'payouts.manage': { group: 'Money', label: 'Change the payout account', hint: 'Changes are checked by ChurchOS.' },
  'members.view': { group: 'Members', label: 'See members and households' },
  'members.edit': { group: 'Members', label: 'Add and change members' },
  'members.sensitive': { group: 'Members', label: 'See sensitive member details', hint: 'Date of birth and similar.' },
  'members.reveal': { group: 'Members', label: 'Show full phone numbers', hint: 'Each reveal is written to the audit log.' },
  'members.settings': { group: 'Members', label: 'Change member settings', hint: 'For example the member number format.' },
  'transfers.approve': { group: 'Members', label: 'Approve member transfers' },
  'records.view': { group: 'Baptism and marriage records', label: 'See records' },
  'records.edit': { group: 'Baptism and marriage records', label: 'Prepare records' },
  'records.approve': { group: 'Baptism and marriage records', label: 'Approve records', hint: 'A second person checks what was entered.' },
  'templates.manage': { group: 'Baptism and marriage records', label: 'Design the certificate' },
  'messages.send': { group: 'Messaging', label: 'Send messages to members', hint: 'In-app, SMS and WhatsApp, charged to the wallet.' },
  'messages.view': { group: 'Messaging', label: 'See sent messages' },
  'groups.manage': { group: 'Messaging', label: 'Create and manage groups' },
  'wallets.view': { group: 'Messaging', label: 'See messaging wallets', hint: 'Also receives low balance alerts, so an email address is needed.' },
  'wallets.topup': { group: 'Messaging', label: 'Top up messaging wallets' },
  'wallets.manage': { group: 'Messaging', label: 'Move credit between wallets' },
  'integrations.manage': { group: 'Messaging', label: 'Change messaging settings' },
  'notices.view': { group: 'Community', label: 'See notices' },
  'notices.manage': { group: 'Community', label: 'Publish notices' },
  'events.view': { group: 'Community', label: 'See events' },
  'events.checkin': { group: 'Community', label: 'Check people in at the door', hint: 'Scan tickets. Does not show anything else.' },
  'kids.checkin': { group: 'Community', label: 'Check children in and out', hint: 'Sunday school teachers. Scan guardians and hand children over.' },
  'kids.manage': { group: 'Community', label: "Manage children's classes", hint: 'Set up classes and teachers, see the check-in log and late pick-ups.' },
  'events.manage': { group: 'Community', label: 'Create and manage events' },
  'adverts.view': { group: 'Community', label: 'See adverts' },
  'adverts.manage': { group: 'Community', label: 'Create and manage adverts' },
  'adverts.approve': { group: 'Community', label: 'Approve adverts', hint: 'Someone other than the creator.' },
  'resources.manage': { group: 'Bookings', label: 'Set up what can be booked' },
  'bookings.view': { group: 'Bookings', label: 'See bookings and the calendar' },
  'bookings.manage': { group: 'Bookings', label: 'Answer and cancel bookings' },
  'audit.view': { group: 'Security and team', label: 'See the audit log' },
  'audit.export': { group: 'Security and team', label: 'Export the audit log' },
  'kyc.manage': { group: 'Security and team', label: 'Manage church verification' },
  'shop.view': { group: 'Church shop', label: 'See shop items, stock and sales' },
  'shop.sell': { group: 'Church shop', label: 'Sell at the till and close the till', hint: 'Takes cash and mobile money, and counts the cash at the end of the day.' },
  'shop.manage': { group: 'Church shop', label: 'Manage the shop', hint: 'Items, prices, stock, voiding sales, cost and margin.' },
  'team.view': { group: 'Security and team', label: 'See the team and their access' },
  'team.manage': { group: 'Security and team', label: 'Add team members and change their access', hint: 'You can only give access that you have yourself.' },
};

/** Default role templates (L34). Organisations can build their own from the same permissions (L32). */
export const ROLE_TEMPLATES: Record<string, Permission[]> = {
  'Organisation Owner': [...PERMISSIONS],
  // Only the organisation owner sees or changes payout destinations (L35).
  'Branch Admin': PERMISSIONS.filter((p) => p !== 'payouts.view' && p !== 'payouts.manage' && p !== 'members.settings' && p !== 'audit.export' && p !== 'integrations.manage'),
  Treasurer: ['collections.view', 'settlements.view', 'reports.view', 'cash.count', 'cash.approve', 'projects.manage', 'reversals.request', 'wallets.view', 'wallets.topup', 'shop.view', 'shop.sell'],
  Pastor: ['collections.view', 'reports.view', 'members.view', 'members.sensitive', 'members.reveal', 'transfers.approve', 'records.view', 'records.approve', 'messages.send', 'messages.view', 'groups.manage', 'adverts.view', 'adverts.approve', 'notices.view', 'notices.manage', 'events.view', 'events.manage', 'events.checkin', 'kids.checkin', 'kids.manage', 'bookings.view'],
  // A read-only role an owner can give to an external or internal auditor (L108).
  "Children's Teacher": ['kids.checkin'],
  Auditor: ['audit.view', 'audit.export', 'collections.view', 'settlements.view', 'reports.view', 'members.view', 'records.view'],
  Secretary: ['members.view', 'members.edit', 'members.sensitive', 'members.reveal', 'transfers.approve', 'records.view', 'records.edit', 'messages.view', 'groups.manage', 'adverts.view', 'adverts.manage', 'notices.view', 'notices.manage', 'events.view', 'events.manage', 'bookings.view', 'bookings.manage', 'resources.manage', 'events.checkin', 'kids.checkin', 'kids.manage'],
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

/** Signs any small object so it cannot be changed on the way: the guardian's rotating QR code and the scan proof the teacher holds. */
export function signData(obj: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
}

export function verifyData(token: string): Record<string, any> | null {
  const [payload, sig] = String(token ?? '').split('.');
  if (!payload || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(createHmac('sha256', SECRET).update(payload).digest('base64url'));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
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
