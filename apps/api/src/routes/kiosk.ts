import { dbScope, runSystem } from '@churchos/ledger';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { branchesFor, normalizePhone, verifyData, type Permission } from '../auth';
import { HttpError, requireSession, type Ctx } from '../ctx';
import { bearerOf } from '../sessions';
import { clientIp, limitRoute } from '../ratelimit';
import { brandingInfo } from './branding';
import { wordsFor } from './words';

/**
 * Kiosk mode (Slice 39): a self check-in terminal at the church entrance.
 *
 * A staff member with attendance permission makes a short-lived pairing code; the tablet exchanges it for a revocable device token that is
 * scoped to ONE branch (and so one church) and works on the /kiosk endpoints below and nowhere else (it is not a session, so every other
 * route answers 401). The token is never stored, only its hash. The kiosk shows no personal data: a check-in answers with the first name the
 * person typed (never one read from the database, apart from a signed member-app QR which proves who is holding the phone) and a welcome.
 * A known and an unknown phone number get exactly the same answer, and nothing on the kiosk can list or search people.
 *
 * Kids: check-in of children is done by a teacher with a guardian proof and a location check (routes/kids.ts); there is no guardian-started
 * check-in to reuse, so the kiosk does not offer it (config.kids is false).
 */

const MIN = 60_000;
const PAIR_TTL_MS = 10 * MIN;
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const TOKEN_PREFIX = 'kd_';
const PERMS: Permission[] = ['attendance.checkin', 'attendance.manage'];

export const KIOSK_SCHEMA = `
CREATE TABLE IF NOT EXISTS kiosk_devices (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  branch_id text NOT NULL,
  name text NOT NULL,
  token_hash text,
  created_by text NOT NULL,
  created_at text NOT NULL,
  revoked_at text,
  last_seen_at text,
  pair_code_hash text,
  pair_expires_at text,
  paired_at text
);
CREATE UNIQUE INDEX IF NOT EXISTS kiosk_devices_token ON kiosk_devices(token_hash) WHERE token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS kiosk_devices_code ON kiosk_devices(pair_code_hash) WHERE pair_code_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS kiosk_devices_org ON kiosk_devices(org_id, branch_id);
GRANT SELECT, INSERT, UPDATE ON kiosk_devices TO app_user;
ALTER TABLE kiosk_devices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON kiosk_devices;
CREATE POLICY tenant_isolation ON kiosk_devices USING (org_id = current_setting('app.org_id', true));
`;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const cap = (v: unknown, n: number) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, n);

/** The first word of what was typed, letters, hyphen and apostrophe only, 2 to 24 characters. Null when nothing usable is left. */
export function kioskFirstName(raw: unknown): string | null {
  const words = String(raw ?? '').normalize('NFKC').split(/\s+/);
  for (const w of words) {
    if (!w || /[:/\\@.]|\d|www|https?/i.test(w)) continue;
    const clean = w.replace(/[^\p{L}'-]/gu, '').replace(/^[-']+|[-']+$/g, '').slice(0, 24);
    if ((clean.match(/\p{L}/gu) ?? []).length >= 2) return clean.charAt(0).toUpperCase() + clean.slice(1);
  }
  return null;
}

interface KioskDevice { id: string; org_id: string; branch_id: string; name: string }
const deviceOf = (req: FastifyRequest): KioskDevice => (req as any).kiosk as KioskDevice;

export function kioskRoutes(app: FastifyInstance, ctx: Ctx, att: { identify: (s: any, p: any) => Promise<any>; record: (s: any, a: any) => Promise<boolean>; state: (s: any) => string; serviceRow: (id: string) => Promise<any> }) {
  const staff = { preHandler: requireSession };
  const nowIso = () => ctx.clock.now().toISOString();
  const nowMs = () => ctx.clock.now().getTime();

  async function staffBranches(req: FastifyRequest) {
    const rows = (await Promise.all(PERMS.map((p) => branchesFor(ctx.db, req.session!.uid, p)))).flat();
    if (!rows.length) throw new HttpError(403, `missing permission ${PERMS[0]}`, 'forbidden');
    const wanted = (req.query as any)?.org as string | undefined;
    const orgId = wanted && rows.some((r) => r.orgId === wanted) ? wanted : rows[0].orgId;
    return { orgId, branchIds: [...new Set(rows.filter((r) => r.orgId === orgId).map((r) => r.branchId))] };
  }

  // ======================= staff: pair, list, revoke =======================

  app.post('/kiosk/devices', staff, async (req) => {
    const sc = await staffBranches(req);
    const b = (req.body ?? {}) as any;
    const branchId = String(b.branchId ?? (sc.branchIds.length === 1 ? sc.branchIds[0] : ''));
    if (!sc.branchIds.includes(branchId)) throw new HttpError(sc.branchIds.length > 1 && !b.branchId ? 400 : 404, sc.branchIds.length > 1 && !b.branchId ? 'Choose the branch this kiosk is for' : 'not found', sc.branchIds.length > 1 && !b.branchId ? 'bad_branch' : 'not_found');
    const name = cap(b.name, 40) || 'Entrance kiosk';
    let code = '';
    for (let i = 0; i < 20 && !code; i++) {
      const c = [...Array(8)].map(() => CODE_ALPHABET[randomInt(32)]).join('');
      if (!(await ctx.db.query<any>(`SELECT 1 FROM kiosk_devices WHERE pair_code_hash=$1`, [sha(c)])).length) code = c;
    }
    if (!code) throw new HttpError(500, 'Could not make a code', 'internal');
    const id = ctx.newId('kdv');
    const expires = new Date(nowMs() + PAIR_TTL_MS).toISOString();
    await ctx.db.query(`INSERT INTO kiosk_devices (id, org_id, branch_id, name, created_by, created_at, pair_code_hash, pair_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, sc.orgId, branchId, name, req.session!.uid, nowIso(), sha(code), expires]);
    await ctx.ledger.audit({ orgId: sc.orgId, branchId, actor: req.session!.uid, action: 'kiosk.pairing_started', entity: 'kiosk_device', entityId: id, summary: `Made a pairing code for the kiosk "${name}"`, meta: { source: 'kiosk' } });
    const display = `${code.slice(0, 4)}-${code.slice(4)}`;
    return { id, code: display, expiresAt: expires, path: `/kiosk?code=${code}`, minutes: PAIR_TTL_MS / MIN };
  });

  app.get('/kiosk/devices', staff, async (req) => {
    const sc = await staffBranches(req);
    const rows = await ctx.db.query<any>(
      `SELECT d.id, d.name, d.branch_id, b.name AS branch, d.created_at, d.revoked_at, d.last_seen_at, d.paired_at, d.pair_expires_at, d.token_hash IS NOT NULL AS has_token
         FROM kiosk_devices d JOIN branches b ON b.id=d.branch_id WHERE d.org_id=$1 AND d.branch_id = ANY($2::text[]) ORDER BY d.created_at DESC LIMIT 100`,
      [sc.orgId, sc.branchIds],
    );
    const t = nowMs();
    return {
      devices: rows.map((r) => ({
        id: r.id, name: r.name, branchId: r.branch_id, branch: r.branch, createdAt: r.created_at, lastSeenAt: r.last_seen_at, pairedAt: r.paired_at, revokedAt: r.revoked_at,
        status: r.revoked_at ? 'revoked' : r.has_token ? 'active' : Date.parse(r.pair_expires_at) > t ? 'waiting' : 'expired',
      })),
    };
  });

  app.post('/kiosk/devices/:id/revoke', staff, async (req) => {
    const sc = await staffBranches(req);
    const d = (await ctx.db.query<any>(`SELECT * FROM kiosk_devices WHERE id=$1`, [String((req.params as any).id)]))[0];
    if (!d || d.org_id !== sc.orgId || !sc.branchIds.includes(d.branch_id)) throw new HttpError(404, 'not found', 'not_found');
    if (!d.revoked_at) {
      await ctx.db.query(`UPDATE kiosk_devices SET revoked_at=$2, pair_code_hash=NULL WHERE id=$1`, [d.id, nowIso()]);
      await ctx.ledger.audit({ orgId: d.org_id, branchId: d.branch_id, actor: req.session!.uid, action: 'kiosk.revoked', entity: 'kiosk_device', entityId: d.id, summary: `Revoked the kiosk "${d.name}"`, meta: { source: 'kiosk' } });
    }
    return { ok: true };
  });

  // ======================= the kiosk itself =======================

  const byIp = (name: string, max: number, windowMs: number) => limitRoute(app, ctx, { name: `kiosk-${name}-ip`, max, windowMs, key: (req) => clientIp(req) });
  const byDevice = (name: string, max: number, windowMs: number) => limitRoute(app, ctx, { name: `kiosk-${name}-dev`, max, windowMs, key: (req) => sha(bearerOf(req) ?? '').slice(0, 20) });

  /** Only a live kiosk token passes. A person's session token is not one, and a kiosk token is not a session anywhere else. */
  async function kioskAuth(req: FastifyRequest) {
    const t = bearerOf(req);
    if (!t || !t.startsWith(TOKEN_PREFIX) || t.length > 100) throw new HttpError(401, 'This kiosk is not paired', 'unauthenticated');
    // The church is not known until the token is: look the device up with every row visible, then scope the rest of the request to its church.
    const d = (await runSystem(() => ctx.db.query<any>(`SELECT id, org_id, branch_id, name FROM kiosk_devices WHERE token_hash=$1 AND revoked_at IS NULL`, [sha(t)])))[0];
    if (!d) throw new HttpError(401, 'This kiosk is not paired', 'unauthenticated');
    (req as any).kiosk = d;
    const sc = dbScope.getStore();
    if (sc) { sc.bypass = false; sc.orgIds = [d.org_id]; }
    await ctx.db.query(`UPDATE kiosk_devices SET last_seen_at=$2 WHERE id=$1`, [d.id, nowIso()]);
  }

  app.post('/kiosk/pair', { preHandler: [byIp('pair', 15, 10 * MIN)] }, async (req) => {
    const b = (req.body ?? {}) as any;
    const code = String(b.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    const bad = () => new HttpError(400, 'That code did not work. Ask for a new one.', 'bad_code');
    if (code.length !== 8) throw bad();
    const d = (await ctx.db.query<any>(`SELECT * FROM kiosk_devices WHERE pair_code_hash=$1 AND token_hash IS NULL AND revoked_at IS NULL`, [sha(code)]))[0];
    if (!d || Date.parse(d.pair_expires_at) <= nowMs()) throw bad();
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const name = cap(b.name, 40) || d.name;
    // One use: the update only succeeds while the code is still unused.
    const r = await ctx.db.query<any>(`UPDATE kiosk_devices SET token_hash=$2, name=$3, paired_at=$4, last_seen_at=$4, pair_code_hash=NULL WHERE id=$1 AND token_hash IS NULL RETURNING id`, [d.id, sha(token), name, nowIso()]);
    if (!r[0]) throw bad();
    await ctx.ledger.audit({ orgId: d.org_id, branchId: d.branch_id, actor: null, actorType: 'system', action: 'kiosk.paired', entity: 'kiosk_device', entityId: d.id, summary: `The kiosk "${name}" was paired`, meta: { source: 'kiosk' } });
    return { token, name };
  });

  /** The service people are arriving for: open now, the one starting soonest. */
  async function currentService(d: KioskDevice) {
    const rows = await ctx.db.query<any>(`SELECT id FROM services WHERE org_id=$1 AND branch_id=$2 AND status='scheduled' AND opens_at <= $3 AND closes_at >= $3 ORDER BY starts_at LIMIT 1`, [d.org_id, d.branch_id, nowIso()]);
    return rows[0] ? att.serviceRow(rows[0].id) : null;
  }

  app.get('/kiosk/config', { preHandler: [byIp('config', 120, MIN), kioskAuth, byDevice('config', 60, MIN)] }, async (req) => {
    const d = deviceOf(req);
    const org = (await ctx.db.query<any>(`SELECT name FROM organisations WHERE id=$1`, [d.org_id]))[0];
    const branch = (await ctx.db.query<any>(`SELECT name FROM branches WHERE id=$1`, [d.branch_id]))[0];
    const s = await currentService(d);
    const w = await wordsFor(ctx, d.org_id);
    return {
      church: org?.name ?? '', branch: branch?.name ?? '', device: d.name, words: w, branding: await brandingInfo(ctx, d.org_id),
      service: s ? { name: s.name, startsAt: s.starts_at } : null, kids: false,
    };
  });

  app.post('/kiosk/checkin', { preHandler: [byIp('checkin', 200, 10 * MIN), kioskAuth, byDevice('checkin', 30, MIN)] }, async (req) => {
    const d = deviceOf(req);
    const b = (req.body ?? {}) as any;
    const s = await currentService(d);
    if (!s) throw new HttpError(409, 'Check-in is not open right now. Please see a greeter.', 'not_open');
    const bad = () => new HttpError(400, 'Please see a greeter.', 'bad_request');
    const ways = [b.phone, b.memberNumber, b.qrToken].filter((v) => v !== undefined && v !== null && v !== '');
    if (ways.length !== 1) throw bad();
    const done = async (kind: 'member' | 'visitor' | 'none', first: string) => {
      await ctx.ledger.audit({ orgId: d.org_id, branchId: d.branch_id, actor: null, actorType: 'system', action: 'kiosk.checkin', entity: 'service', entityId: s.id, summary: `Kiosk check-in at "${s.name}" (${kind})`, meta: { source: 'kiosk', deviceId: d.id, kind } });
      return { ok: true, firstName: first, message: `Welcome, ${first}!` };
    };
    const ask = { ok: true, firstName: '', message: 'Welcome! Please tell us your first name.', needName: true };

    // A member-app QR proves who holds the phone, so it is the only way the kiosk greets by a stored name.
    if (b.qrToken) {
      const raw = String(b.qrToken).trim().slice(0, 600);
      const p = raw.startsWith('A1.') ? verifyData(raw.slice(3), 'qr', nowMs(), { allowExpired: true }) : null;
      if (!p || p.k !== 'a' || Number(p.e) < nowMs()) throw bad();
      const m = (await ctx.db.query<any>(`SELECT id, full_name, org_id FROM memberships WHERE id=$1 AND status='active'`, [String(p.m)]))[0];
      if (!m || m.org_id !== s.org_id) throw bad();
      await att.record(s, { kind: 'member', membershipId: m.id, name: m.full_name, mode: 'in_person', via: 'kiosk', byName: d.name });
      return done('member', kioskFirstName(m.full_name) ?? 'friend');
    }

    // A phone number or member number is not proof, and member numbers run in sequence: the greeting is always the first name typed on the kiosk.
    const typed = kioskFirstName(b.firstName);
    if (!typed) {
      if (b.firstName !== undefined && String(b.firstName).trim()) throw bad();
      return ask;
    }
    if (b.memberNumber) {
      const num = cap(b.memberNumber, 20).toUpperCase();
      if (!/^[A-Z0-9-]{2,20}$/.test(num)) throw bad();
      const m = (await ctx.db.query<any>(`SELECT id, full_name FROM memberships WHERE org_id=$1 AND upper(member_number)=$2 AND status='active' AND category='adult'`, [s.org_id, num]))[0];
      if (m) {
        await att.record(s, { kind: 'member', membershipId: m.id, name: m.full_name, mode: 'in_person', via: 'kiosk', byName: d.name });
        return done('member', typed);
      }
      return done('none', typed); // nothing is recorded and nothing tells the caller the number is unknown
    }
    const phone = normalizePhone(String(b.phone ?? '').slice(0, 20));
    if (!phone) throw bad();
    const r = await att.identify(s, { name: typed, phone, mode: 'in_person', via: 'kiosk', byName: d.name, from: { ip: clientIp(req), token: `kiosk:${d.id}` } });
    return done(r.kind, typed);
  });

  /** Anything else under /kiosk is not found, never a hint about what exists. */
  app.get('/kiosk/*', async () => { throw new HttpError(404, 'Not found', 'not_found'); });
}
