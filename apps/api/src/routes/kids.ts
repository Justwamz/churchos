import { createHash, randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { branchesFor, normalizePhone, signData, verifyData } from '../auth';
import { HttpError, requireSession, type Ctx } from '../ctx';
import { activeBands, costOf, recordUnits, unitsUsed } from '../pricing';
import { grantsFor, inStaffScope, staffWith } from '../scope';
import { notify } from '../sms';
import { checkLowBalance, integrationSettings, sendEmail, walletFor } from '../wallets';
import { csv } from './helpers';
import { qrSvg } from './tickets';

/** Children's check-in and pick-up (L179 to L190). */

const QR_TTL_MS = 45_000;
const PROOF_TTL_MS = 5 * 60_000;
const CODE_HOURS = 12;
const MAX_BAD_CODES = 8;

const hm = (iso: string) => new Date(iso).toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit' });
const dayText = (iso: string) => new Date(iso).toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi', weekday: 'short', day: 'numeric', month: 'short' });
const maskPhone = (p: string | null) => (p && p.length >= 10 ? `0${p.slice(3, 6)} *** ${p.slice(-3)}` : '');
const localPhone = (p: string | null) => (p && p.startsWith('254') ? `0${p.slice(3)}` : p ?? '');
const hashCode = (sessionId: string, code: string) => createHash('sha256').update(`${sessionId}:${code}`).digest('hex');
const cap = (v: unknown, n: number) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, n);

function agoYears(ctx: Ctx, dob: string | null): number | null {
  if (!dob) return null;
  const d = new Date(`${dob}T00:00:00Z`);
  const n = ctx.clock.now();
  let y = n.getUTCFullYear() - d.getUTCFullYear();
  if (n.getUTCMonth() < d.getUTCMonth() || (n.getUTCMonth() === d.getUTCMonth() && n.getUTCDate() < d.getUTCDate())) y--;
  return y;
}

/** "Android, Chrome" from a browser's own description, so the log says which kind of device scanned. */
function uaShort(ua: unknown): string {
  const s = String(ua ?? '');
  const os = /Android/i.test(s) ? 'Android' : /iPhone|iPad|iOS/i.test(s) ? 'iOS' : /Windows/i.test(s) ? 'Windows' : /Mac OS/i.test(s) ? 'Mac' : /Linux/i.test(s) ? 'Linux' : 'Unknown device';
  const br = /Edg\//.test(s) ? 'Edge' : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : 'browser';
  return `${os}, ${br}`;
}

/** The device a request came from: the name the app gave it, and what the browser says it is. */
const deviceOf = (req: FastifyRequest, given: unknown) => {
  const g = cap(given, 60);
  const u = uaShort(req.headers['user-agent']);
  return g ? `${g} (${u})` : u;
};

export interface Geo { lat: number; lng: number; acc: number }

/** A place reading from a phone, or nothing if it is missing or nonsense. */
export function parseGeo(v: unknown): Geo | null {
  let o: any = v;
  if (typeof v === 'string') { const [lat, lng, acc] = v.split(',').map(Number); o = { lat, lng, acc }; }
  if (!o || typeof o !== 'object') return null;
  const lat = Number(o.lat), lng = Number(o.lng), acc = o.acc === undefined || o.acc === null ? 0 : Number(o.acc);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(acc) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || acc < 0) return null;
  return { lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5, acc: Math.round(acc) };
}

export const metresBetween = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const R = 6371000, rad = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/** A reading less exact than this is treated as no reading (L188). */
export const MAX_ACCURACY_M = 1000;

export interface LocCheck { status: 'ok' | 'away' | 'unknown' | 'unchecked'; source: 'teacher' | 'guardian' | null; distanceM: number | null; radiusM: number | null; branch: string; teacher: Geo | null; guardian: Geo | null }

/**
 * Is the check happening at the branch? The teacher's device decides. If it gave no usable reading, the guardian's phone is used.
 * A branch with no location set is not checked (L188, L189).
 */
export async function checkLocation(ctx: Ctx, branchId: string, teacher: Geo | null, guardian: Geo | null): Promise<LocCheck> {
  const b = (await ctx.db.query<any>(`SELECT name, geo_lat, geo_lng, geo_radius_m FROM branches WHERE id=$1`, [branchId]))[0];
  const base = { branch: b?.name ?? '', teacher, guardian, radiusM: b?.geo_radius_m ?? null };
  if (!b || b.geo_lat === null || b.geo_lat === undefined) return { ...base, status: 'unchecked', source: null, distanceM: null };
  const usable = (g: Geo | null) => (g && g.acc <= MAX_ACCURACY_M ? g : null);
  const t = usable(teacher);
  const use = t ?? usable(guardian);
  if (!use) return { ...base, status: 'unknown', source: null, distanceM: null };
  const d = Math.round(metresBetween(use, { lat: Number(b.geo_lat), lng: Number(b.geo_lng) }));
  return { ...base, status: d - Math.min(use.acc, 100) > Number(b.geo_radius_m) ? 'away' : 'ok', source: t ? 'teacher' : 'guardian', distanceM: d };
}

const distText = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);

/** What the teacher's screen says about the location, in plain words, without any coordinates. */
export function publicLoc(l: LocCheck) {
  const message =
    l.status === 'away' ? `You are about ${distText(l.distanceM!)} from ${l.branch}. Children can only be checked in at the branch.`
    : l.status === 'unknown' ? "We can't tell where you are. Allow location for this page, or ask the guardian to allow location in their app, then scan again."
    : l.status === 'ok' ? `At ${l.branch}${l.source === 'guardian' ? " (from the guardian's phone)" : ''}`
    : '';
  return { status: l.status, source: l.source, distanceM: l.distanceM, radiusM: l.radiusM, branch: l.branch, message };
}

const geoText = (g: Geo | null) => (g ? `${g.lat}, ${g.lng} (within ${g.acc} m)` : null);

const LOCATED = new Set(['scan', 'check_in', 'check_out', 'lookup', 'code_sent', 'escalated', 'contacts_shown']);

export interface KidsLog {
  orgId: string;
  branchId: string;
  action: string;
  result: string;
  sessionId?: string | null;
  className?: string | null;
  staffId?: string | null;
  staffName?: string | null;
  staffDevice?: string | null;
  subjectId?: string | null;
  subjectName?: string | null;
  subjectDevice?: string | null;
  method?: string | null;
  children?: string | null;
  detail?: string | null;
  /** Where the teacher's device said it was, and where the guardian's phone said it was when it made the code. */
  geo?: Geo | null;
  guardianGeo?: Geo | null;
}

/** One line in the children's log, and the same event in the audit trail. */
export async function kidsLog(ctx: Ctx, e: KidsLog) {
  const at = ctx.clock.now().toISOString();
  const loc = LOCATED.has(e.action) ? await checkLocation(ctx, e.branchId, e.geo ?? null, e.guardianGeo ?? null) : null;
  await ctx.db.query(
    `INSERT INTO kids_log (id, org_id, branch_id, at, action, result, session_id, class_name, staff_id, staff_name, staff_device, subject_id, subject_name, subject_device, method, children, detail, location)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [ctx.newId('kl'), e.orgId, e.branchId, at, e.action, e.result, e.sessionId ?? null, e.className ?? null, e.staffId ?? null, e.staffName ?? null, e.staffDevice ?? null, e.subjectId ?? null, e.subjectName ?? null, e.subjectDevice ?? null, e.method ?? null, e.children ?? null, e.detail ?? null,
      loc ? JSON.stringify({ status: loc.status, source: loc.source, distanceM: loc.distanceM, radiusM: loc.radiusM, teacher: loc.teacher, guardian: loc.guardian }) : null],
  );
  await ctx.ledger.audit({
    orgId: e.orgId, branchId: e.branchId, actorId: e.staffId ?? null, actorType: e.staffId ? 'user' : 'system', action: `kids.${e.action}`, entity: 'kids_session', entityId: e.sessionId ?? e.orgId,
    summary: `${e.action.replace(/_/g, ' ')}${e.children ? `: ${e.children}` : ''}${e.subjectName ? ` (${e.subjectName})` : ''}${e.result !== 'ok' ? `, ${e.result}` : ''}`,
    meta: { result: e.result, method: e.method, staffDevice: e.staffDevice, guardianDevice: e.subjectDevice, session: e.sessionId, detail: e.detail, ...(loc ? { location: loc.status, distanceM: loc.distanceM, locationSource: loc.source } : {}) },
  }).catch(() => undefined);
}

/** One WhatsApp message paid for by the church's WhatsApp wallet. Never fails the caller. */
async function sendWhatsapp(ctx: Ctx, a: { orgId: string; branchId: string; phone: string; body: string; idemKey: string }): Promise<'sent' | 'skipped'> {
  try {
    const pref = (await ctx.db.query<any>(`SELECT whatsapp_opt_in FROM contact_prefs WHERE phone=$1`, [a.phone]))[0];
    if (!pref?.whatsapp_opt_in) return 'skipped';
    const w = await walletFor(ctx, a.orgId, a.branchId, 'whatsapp');
    if (!w) return 'skipped';
    const cost = costOf(await activeBands(ctx, a.orgId, 'whatsapp'), await unitsUsed(ctx, a.orgId, 'whatsapp'), 1);
    if (!(await ctx.ledger.chargeWallet(w.id, cost, a.idemKey, 'whatsapp'))) return 'skipped';
    const settings = await integrationSettings(ctx.db, a.orgId);
    const [res] = await ctx.messaging.send('whatsapp', [{ to: a.phone, body: a.body, from: settings.whatsappNumber }]);
    const ok = res?.status === 'sent';
    if (ok) await recordUnits(ctx, a.orgId, 'whatsapp', 1);
    else await ctx.ledger.refundWallet(w.id, cost, a.idemKey, 'whatsapp');
    await checkLowBalance(ctx, w.id);
    return ok ? 'sent' : 'skipped';
  } catch {
    return 'skipped';
  }
}

/** The registered guardians of a child, with whether they have the app. */
async function guardiansOf(ctx: Ctx, childId: string) {
  return ctx.db.query<any>(
    `SELECT g.guardian_id AS id, m.full_name AS name, m.phone, m.user_id, m.branch_id, u.email, u.email_verified
       FROM guardians g JOIN memberships m ON m.id=g.guardian_id LEFT JOIN users u ON u.id=m.user_id WHERE g.child_id=$1 AND m.status='active'`,
    [childId],
  );
}

async function guardianCanCollect(ctx: Ctx, childId: string, guardianId: string): Promise<boolean> {
  return (await ctx.db.query<any>(`SELECT 1 FROM guardians WHERE child_id=$1 AND guardian_id=$2`, [childId, guardianId])).length > 0;
}

/** Alerts for a child who has not been collected. Shared by the routes and the scheduler. */
function kidsInternals(ctx: Ctx) {
  const nowIso = () => ctx.clock.now().toISOString();
  async function alertGuardians(s: any, r: any, who: 'late' | 'escalated') {
    const room = (await ctx.db.query<any>(`SELECT room FROM kids_classes WHERE id=$1`, [s.class_id]))[0]?.room;
    const church = (await ctx.db.query<any>(`SELECT name FROM organisations WHERE id=$1`, [s.org_id]))[0]?.name ?? 'church';
    const body = `${r.child_name} has not been collected from ${s.class_name} at ${church}. Please come to ${room ?? s.class_name} now. If you cannot, call the church office.`;
    const seen = new Set<string>();
    for (const g of await guardiansOf(ctx, r.child_id)) {
      if (!g.phone || seen.has(g.phone)) continue;
      seen.add(g.phone);
      const res = await notify(ctx, { orgId: s.org_id, branchId: s.branch_id, phone: g.phone, kind: 'announcement', title: `${r.child_name} is waiting to be collected`, body, idemKey: `kids:late:${r.id}:${g.id}`, sms: true, link: 'member:kids' });
      const wa = await sendWhatsapp(ctx, { orgId: s.org_id, branchId: s.branch_id, phone: g.phone, body, idemKey: `kids:late:wa:${r.id}:${g.id}` });
      let mail = 'none';
      if (g.email && g.email_verified) mail = (await sendEmail(ctx, s.org_id, g.email, `${r.child_name} is waiting to be collected`, `Hello ${String(g.name).split(' ')[0]},\n\n${body}\n`)) ? 'sent' : 'failed';
      const parts = [`SMS ${res.sms === 'sent' ? 'sent' : 'not sent'}`, `WhatsApp ${wa === 'sent' ? 'sent' : 'not sent'}`, `email ${mail === 'sent' ? 'sent' : mail === 'none' ? 'no address' : 'failed'}`, res.inApp ? 'in-app sent' : 'no app'];
      await kidsLog(ctx, { orgId: s.org_id, branchId: s.branch_id, sessionId: s.id, className: s.class_name, action: 'alert_sent', result: 'ok', method: who, subjectId: g.id, subjectName: g.name, children: r.child_name, detail: parts.join(', ') });
    }
  }

  async function alertStaff(s: any, r: any, kind: 'auto' | 'manual', by: string | null) {
    const people = await staffWith(ctx, s.org_id, s.branch_id, 'kids.manage');
    const body = `${r.child_name} (tag ${r.tag}) has not been collected from ${s.class_name}. ${kind === 'manual' ? `${by ?? 'The teacher'} asked for help.` : 'The guardians were told and have not come.'} Open Children in the staff app to see who to call.`;
    for (const u of people) {
      const res = await notify(ctx, { orgId: s.org_id, branchId: s.branch_id, phone: u.phone, kind: 'announcement', title: `Child not collected: ${r.child_name}`, body, idemKey: `kids:esc:${r.id}:${u.id}`, sms: true, link: 'staff:children', audience: 'staff' });
      await kidsLog(ctx, { orgId: s.org_id, branchId: s.branch_id, sessionId: s.id, className: s.class_name, action: 'alert_sent', result: 'ok', method: 'staff', subjectId: u.id, subjectName: u.name, children: r.child_name, detail: `Staff alert: SMS ${res.sms === 'sent' ? 'sent' : 'not sent'}${res.inApp ? ', in-app sent' : ''}` });
    }
  }

  async function escalate(s: any, r: any, kind: 'auto' | 'manual', byId: string | null, byName: string | null, note: string | null, device: string | null) {
    const upd = await ctx.db.query<any>(`UPDATE kids_checkins SET escalated_at=$2, escalated_by=$3, escalation_kind=$4, escalation_note=$5, alerted_at=COALESCE(alerted_at,$2) WHERE id=$1 AND status='in' AND escalated_at IS NULL RETURNING *, (alerted_at IS NULL) AS x`, [r.id, nowIso(), byId, kind, note]);
    if (!upd[0]) return false;
    await kidsLog(ctx, { orgId: s.org_id, branchId: s.branch_id, sessionId: s.id, className: s.class_name, staffId: byId, staffName: byName, staffDevice: device, action: 'escalated', result: 'ok', method: kind, children: r.child_name, detail: note });
    if (!r.alerted_at) await alertGuardians(s, r, 'escalated');
    await alertStaff(s, r, kind, byName);
    return true;
  }


  return { alertGuardians, alertStaff, escalate };
}

export function kidsRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };
  const nowIso = () => ctx.clock.now().toISOString();
  const nowMs = () => ctx.clock.now().getTime();
  /** Where the teacher's device says it is, sent with each action (L188). */
  const tg = (req: FastifyRequest): Geo | null => parseGeo((req.body as any)?.geo ?? (req.query as any)?.geo);

  // ======================= the guardian's side =======================

  async function myFamilies(uid: string) {
    const ms = await ctx.db.query<any>(
      `SELECT m.id, m.full_name, m.org_id, m.branch_id, o.name AS church FROM memberships m JOIN organisations o ON o.id=m.org_id
        WHERE m.user_id=$1 AND m.status='active' AND EXISTS (SELECT 1 FROM guardians g JOIN memberships c ON c.id=g.child_id WHERE g.guardian_id=m.id AND c.status='active') ORDER BY m.joined_at`,
      [uid],
    );
    const out = [];
    for (const m of ms) {
      const kids = await ctx.db.query<any>(`SELECT c.id, c.full_name, c.dob FROM guardians g JOIN memberships c ON c.id=g.child_id WHERE g.guardian_id=$1 AND c.status='active' ORDER BY c.dob DESC NULLS LAST`, [m.id]);
      const children = [];
      for (const c of kids) {
        const inRow = (await ctx.db.query<any>(`SELECT k.*, s.ends_at FROM kids_checkins k JOIN kids_sessions s ON s.id=k.session_id WHERE k.child_id=$1 AND k.status='in'`, [c.id]))[0];
        const last = (await ctx.db.query<any>(`SELECT class_name FROM kids_sessions s JOIN kids_checkins k ON k.session_id=s.id WHERE k.child_id=$1 ORDER BY k.in_at DESC LIMIT 1`, [c.id]))[0];
        children.push({
          id: c.id, name: c.full_name, age: agoYears(ctx, c.dob),
          inNow: inRow ? { className: (await ctx.db.query<any>(`SELECT class_name FROM kids_sessions WHERE id=$1`, [inRow.session_id]))[0].class_name, tag: inRow.tag, since: inRow.in_at, late: Date.parse(inRow.ends_at) < nowMs() } : null,
          lastClass: last?.class_name ?? null,
        });
      }
      const people = await ctx.db.query<any>(`SELECT id, name, phone, relation, id_number FROM kids_pickup_people WHERE guardian_id=$1 AND active ORDER BY created_at`, [m.id]);
      out.push({ membershipId: m.id, name: m.full_name, church: m.church, children, pickupPeople: people.map((p) => ({ id: p.id, name: p.name, phone: localPhone(p.phone), relation: p.relation, idNumber: p.id_number })) });
    }
    return out;
  }

  app.get('/me/family', auth, async (req) => ({ families: await myFamilies(req.session!.uid) }));

  /** A code that changes every 30 seconds and only a signed-in guardian can ask for (L180). */
  app.post('/me/family/qr', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const m = (await ctx.db.query<any>(`SELECT id, org_id, full_name FROM memberships WHERE id=$1 AND user_id=$2 AND status='active'`, [String(b.membershipId ?? ''), req.session!.uid]))[0];
    if (!m) throw new HttpError(404, 'not found', 'not_found');
    const exp = nowMs() + QR_TTL_MS;
    const g = parseGeo(b.geo);
    const token = `K1.${signData({ k: 'q', m: m.id, o: m.org_id, d: deviceOf(req, b.device), e: exp, ...(g ? { g } : {}) }, 'guardian')}`;
    return { token, expiresAt: new Date(exp).toISOString(), refreshSeconds: 30, name: m.full_name, qrSvg: qrSvg(token) };
  });

  const pickupBody = (b: any) => {
    const name = cap(b.name, 60);
    const phone = normalizePhone(String(b.phone ?? ''));
    if (!name) throw new HttpError(400, 'Enter the name of the person', 'bad_content');
    if (!phone) throw new HttpError(400, 'Enter a valid Kenyan phone number, like 0712 345 678', 'bad_phone');
    return { name, phone, relation: cap(b.relation, 30) || null, idNumber: cap(b.idNumber, 20) || null };
  };

  app.post('/me/family/pickup-people', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const m = (await ctx.db.query<any>(`SELECT id, org_id, branch_id, full_name FROM memberships WHERE id=$1 AND user_id=$2 AND status='active'`, [String(b.membershipId ?? ''), req.session!.uid]))[0];
    if (!m) throw new HttpError(404, 'not found', 'not_found');
    const p = pickupBody(b);
    const n = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM kids_pickup_people WHERE guardian_id=$1 AND active`, [m.id]))[0].n);
    if (n >= 8) throw new HttpError(400, 'You can list up to 8 people. Remove one first.', 'too_many');
    const id = ctx.newId('kpp');
    await ctx.db.query(`INSERT INTO kids_pickup_people (id, org_id, guardian_id, name, phone, relation, id_number, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, m.org_id, m.id, p.name, p.phone, p.relation, p.idNumber, req.session!.uid, nowIso()]);
    await kidsLog(ctx, { orgId: m.org_id, branchId: m.branch_id, action: 'pickup_person_added', result: 'ok', subjectId: m.id, subjectName: m.full_name, detail: `${p.name}${p.relation ? `, ${p.relation}` : ''}, ${maskPhone(p.phone)}`, staffId: req.session!.uid, geo: tg(req), staffName: req.session!.name, method: 'app' });
    return { id };
  });

  app.post('/me/family/pickup-people/:id/remove', auth, async (req) => {
    const p = (await ctx.db.query<any>(
      `SELECT p.*, m.branch_id, m.full_name AS gname FROM kids_pickup_people p JOIN memberships m ON m.id=p.guardian_id WHERE p.id=$1 AND m.user_id=$2 AND p.active`,
      [(req.params as any).id, req.session!.uid],
    ))[0];
    if (!p) throw new HttpError(404, 'not found', 'not_found');
    await ctx.db.query(`UPDATE kids_pickup_people SET active=false WHERE id=$1`, [p.id]);
    await kidsLog(ctx, { orgId: p.org_id, branchId: p.branch_id, action: 'pickup_person_removed', result: 'ok', subjectId: p.guardian_id, subjectName: p.gname, detail: p.name, staffId: req.session!.uid, geo: tg(req), staffName: req.session!.name, method: 'app' });
    return { ok: true };
  });

  // ======================= staff: classes and teachers (L179) =======================

  /** What the signed-in staff member can do with children's check-in, and where. */
  async function scopeOf(req: FastifyRequest) {
    const uid = req.session!.uid;
    const manage = await branchesFor(ctx.db, uid, 'kids.manage');
    const check = await branchesFor(ctx.db, uid, 'kids.checkin');
    if (!manage.length && !check.length) throw new HttpError(403, 'missing permission kids.checkin', 'forbidden');
    const orgHint = (req.query as any)?.org as string | undefined;
    const orgs = [...new Set([...manage, ...check].map((r) => r.orgId))];
    const orgId = orgHint && orgs.includes(orgHint) ? orgHint : orgs[0];
    return { orgId, manage: manage.filter((r) => r.orgId === orgId).map((r) => r.branchId), check: check.filter((r) => r.orgId === orgId).map((r) => r.branchId) };
  }

  async function classRow(req: FastifyRequest, id: string, need: 'teach' | 'manage') {
    const c = (await ctx.db.query<any>(`SELECT c.*, b.name AS branch_name FROM kids_classes c JOIN branches b ON b.id=c.branch_id WHERE c.id=$1`, [id]))[0];
    if (!c) throw new HttpError(404, 'not found', 'not_found');
    const canManage = await inStaffScope(ctx, req, 'kids.manage', c.org_id, c.branch_id);
    if (canManage) return c;
    if (need === 'teach' && (await inStaffScope(ctx, req, 'kids.checkin', c.org_id, c.branch_id)) && (c.teachers as string[]).includes(req.session!.uid)) return c;
    throw new HttpError(404, 'not found', 'not_found');
  }

  async function sessionRow(req: FastifyRequest, id: string) {
    const s = (await ctx.db.query<any>(`SELECT * FROM kids_sessions WHERE id=$1`, [id]))[0];
    if (!s) throw new HttpError(404, 'not found', 'not_found');
    const c = await classRow(req, s.class_id, 'teach');
    return { s, c };
  }

  const teacherNames = async (ids: string[]) => (ids.length ? (await ctx.db.query<any>(`SELECT id, name FROM users WHERE id = ANY($1::text[])`, [ids])).map((u) => ({ id: u.id, name: u.name })) : []);

  const sessionView = async (s: any) => {
    const rows = await ctx.db.query<any>(`SELECT status FROM kids_checkins WHERE session_id=$1`, [s.id]);
    return { id: s.id, status: s.status, startsAt: s.starts_at, endsAt: s.ends_at, graceMin: s.grace_min, escalateMin: s.escalate_min, openedBy: s.opened_by_name, checkedIn: rows.length, stillIn: rows.filter((r) => r.status === 'in').length };
  };

  app.get('/kids/classes', auth, async (req) => {
    const sc = await scopeOf(req);
    const rows = await ctx.db.query<any>(`SELECT c.*, b.name AS branch_name FROM kids_classes c JOIN branches b ON b.id=c.branch_id WHERE c.org_id=$1 ORDER BY b.name, c.name`, [sc.orgId]);
    const out = [];
    for (const c of rows) {
      const manage = sc.manage.includes(c.branch_id);
      const teach = sc.check.includes(c.branch_id) && (c.teachers as string[]).includes(req.session!.uid);
      if (!manage && !teach) continue;
      const open = (await ctx.db.query<any>(`SELECT * FROM kids_sessions WHERE class_id=$1 AND status='open'`, [c.id]))[0];
      out.push({ id: c.id, name: c.name, room: c.room, branchId: c.branch_id, branch: c.branch_name, active: c.active, canManage: manage, teachers: await teacherNames(c.teachers), session: open ? await sessionView(open) : null });
    }
    return { classes: out, canManage: sc.manage.length > 0, branches: (await ctx.db.query<any>(`SELECT id, name, geo_lat, geo_lng, geo_radius_m FROM branches WHERE org_id=$1 AND id = ANY($2::text[]) ORDER BY name`, [sc.orgId, sc.manage])).map((b) => ({ id: b.id, name: b.name, location: b.geo_lat === null ? null : { lat: Number(b.geo_lat), lng: Number(b.geo_lng), radiusM: b.geo_radius_m } })) };
  });

  /** Where a branch is, so children can only be checked in there (L189). */
  app.put('/kids/branches/:id/location', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'kids.manage');
    const id = String((req.params as any).id);
    if (!g.branchIds.includes(id)) throw new HttpError(404, 'not found', 'not_found');
    const b = (req.body ?? {}) as any;
    const name = (await ctx.db.query<any>(`SELECT name FROM branches WHERE id=$1`, [id]))[0]?.name;
    if (b.clear) {
      await ctx.db.query(`UPDATE branches SET geo_lat=NULL, geo_lng=NULL, geo_radius_m=NULL WHERE id=$1`, [id]);
      await ctx.ledger.audit({ orgId: g.orgId, branchId: id, actor: req.session!.uid, action: 'kids.branch_location_cleared', entity: 'branch', entityId: id, summary: `Removed the location check for ${name}. Children can be checked in from anywhere.` });
      return { ok: true, location: null };
    }
    const geo = parseGeo({ lat: b.lat, lng: b.lng, acc: 0 });
    const radius = Math.round(Number(b.radiusM ?? 300));
    if (!geo) throw new HttpError(400, 'Enter a valid latitude and longitude, or use your current location', 'bad_location');
    if (!(radius >= 50 && radius <= 2000)) throw new HttpError(400, 'The distance from the branch must be between 50 and 2,000 metres', 'bad_radius');
    await ctx.db.query(`UPDATE branches SET geo_lat=$2, geo_lng=$3, geo_radius_m=$4 WHERE id=$1`, [id, geo.lat, geo.lng, radius]);
    await ctx.ledger.audit({ orgId: g.orgId, branchId: id, actor: req.session!.uid, action: 'kids.branch_location_set', entity: 'branch', entityId: id, summary: `Set the location of ${name} for children's check-in, within ${radius} m`, meta: { radiusM: radius } });
    return { ok: true, location: { lat: geo.lat, lng: geo.lng, radiusM: radius } };
  });

  /** Staff of a branch who could teach (they hold the check-in permission there). */
  app.get('/kids/teachers', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'kids.manage');
    const branchId = String((req.query as any).branchId ?? '');
    if (!g.branchIds.includes(branchId)) throw new HttpError(404, 'not found', 'not_found');
    return { teachers: (await staffWith(ctx, g.orgId, branchId, 'kids.checkin')).map((u) => ({ id: u.id, name: u.name })) };
  });

  const classBody = async (b: any, orgId: string, branchId: string) => {
    const name = cap(b.name, 40);
    if (!name) throw new HttpError(400, 'Enter a name for the class', 'bad_content');
    const room = cap(b.room, 40) || null;
    const teachers: string[] = [...new Set((Array.isArray(b.teachers) ? b.teachers : []).map(String))] as string[];
    const ok = new Set((await staffWith(ctx, orgId, branchId, 'kids.checkin')).map((u) => u.id));
    for (const t of teachers) if (!ok.has(t)) throw new HttpError(400, 'Every teacher needs the permission "Check children in and out" for this branch. Give it under Team first.', 'bad_teacher');
    return { name, room, teachers };
  };

  app.post('/kids/classes', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'kids.manage');
    const b = (req.body ?? {}) as any;
    if (!g.branchIds.includes(String(b.branchId))) throw new HttpError(404, 'not found', 'not_found');
    const c = await classBody(b, g.orgId, b.branchId);
    if ((await ctx.db.query<any>(`SELECT 1 FROM kids_classes WHERE branch_id=$1 AND lower(name)=lower($2) AND active`, [b.branchId, c.name])).length) throw new HttpError(409, `This branch already has a class called "${c.name}"`, 'duplicate');
    const id = ctx.newId('kcl');
    await ctx.db.query(`INSERT INTO kids_classes (id, org_id, branch_id, name, room, teachers, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, g.orgId, b.branchId, c.name, c.room, JSON.stringify(c.teachers), nowIso()]);
    await ctx.ledger.audit({ orgId: g.orgId, branchId: b.branchId, actor: req.session!.uid, action: 'kids.class_created', entity: 'kids_class', entityId: id, summary: `Created the children's class "${c.name}"` });
    return { id };
  });

  app.patch('/kids/classes/:id', auth, async (req) => {
    const c = await classRow(req, (req.params as any).id, 'manage');
    const b = (req.body ?? {}) as any;
    const n = await classBody({ name: b.name ?? c.name, room: b.room !== undefined ? b.room : c.room, teachers: b.teachers ?? c.teachers }, c.org_id, c.branch_id);
    const active = b.active === undefined ? c.active : !!b.active;
    if (!active && (await ctx.db.query<any>(`SELECT 1 FROM kids_sessions WHERE class_id=$1 AND status='open'`, [c.id])).length) throw new HttpError(409, 'Close the open session before switching this class off', 'open_session');
    await ctx.db.query(`UPDATE kids_classes SET name=$2, room=$3, teachers=$4, active=$5 WHERE id=$1`, [c.id, n.name, n.room, JSON.stringify(n.teachers), active]);
    await ctx.ledger.audit({ orgId: c.org_id, branchId: c.branch_id, actor: req.session!.uid, action: 'kids.class_updated', entity: 'kids_class', entityId: c.id, summary: `Updated the children's class "${n.name}"${active ? '' : ' (switched off)'}`, meta: { teachers: n.teachers } });
    return { ok: true };
  });

  // ======================= sessions =======================

  app.post('/kids/classes/:id/sessions', auth, async (req) => {
    const c = await classRow(req, (req.params as any).id, 'teach');
    if (!c.active) throw new HttpError(409, 'This class is switched off', 'inactive');
    const b = (req.body ?? {}) as any;
    if ((await ctx.db.query<any>(`SELECT 1 FROM kids_sessions WHERE class_id=$1 AND status='open'`, [c.id])).length) throw new HttpError(409, 'This class already has an open session', 'already_open');
    const now = ctx.clock.now();
    const minutes = Math.min(720, Math.max(15, Number(b.minutes) || 120));
    const endsAt = b.endsAt && !Number.isNaN(Date.parse(String(b.endsAt))) ? new Date(Date.parse(String(b.endsAt))) : new Date(now.getTime() + minutes * 60_000);
    if (endsAt.getTime() <= now.getTime()) throw new HttpError(400, 'The finish time must be in the future', 'bad_date');
    const grace = Math.min(120, Math.max(0, Number.isFinite(Number(b.graceMin)) && b.graceMin !== undefined ? Number(b.graceMin) : 15));
    const esc = Math.min(240, Math.max(grace, Number.isFinite(Number(b.escalateMin)) && b.escalateMin !== undefined ? Number(b.escalateMin) : 30));
    const id = ctx.newId('ks');
    await ctx.db.query(
      `INSERT INTO kids_sessions (id, org_id, branch_id, class_id, class_name, starts_at, ends_at, grace_min, escalate_min, opened_by, opened_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, c.org_id, c.branch_id, c.id, c.name, now.toISOString(), endsAt.toISOString(), grace, esc, req.session!.uid, req.session!.name],
    );
    await kidsLog(ctx, { orgId: c.org_id, branchId: c.branch_id, action: 'session_opened', result: 'ok', sessionId: id, className: c.name, staffId: req.session!.uid, geo: tg(req), staffName: req.session!.name, staffDevice: deviceOf(req, b.device), detail: `Until ${hm(endsAt.toISOString())}` });
    return { id };
  });

  app.post('/kids/sessions/:id/close', auth, async (req) => {
    const { s } = await sessionRow(req, (req.params as any).id);
    if (s.status === 'closed') return { ok: true };
    const left = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM kids_checkins WHERE session_id=$1 AND status='in'`, [s.id]))[0].n);
    if (left > 0) throw new HttpError(409, `${left} ${left === 1 ? 'child is' : 'children are'} still checked in. Hand them over or escalate first.`, 'children_in');
    await ctx.db.query(`UPDATE kids_sessions SET status='closed', closed_at=$2 WHERE id=$1`, [s.id, nowIso()]);
    await kidsLog(ctx, { orgId: s.org_id, branchId: s.branch_id, action: 'session_closed', result: 'ok', sessionId: s.id, className: s.class_name, staffId: req.session!.uid, geo: tg(req), staffName: req.session!.name, staffDevice: deviceOf(req, (req.body as any)?.device) });
    return { ok: true };
  });

  const stateOf = (r: any, s: any) => {
    if (r.status === 'out') return 'out';
    if (r.escalated_at) return 'escalated';
    if (r.alerted_at) return 'alerted';
    return Date.parse(s.ends_at) < nowMs() ? 'late' : 'in';
  };

  const rowView = (r: any, s: any) => ({
    id: r.id, childId: r.child_id, name: r.child_name, tag: r.tag, status: r.status, state: stateOf(r, s), inAt: r.in_at, inBy: r.in_by_name, dropper: r.dropper_name, outAt: r.out_at, outBy: r.out_by_name, collector: r.collector_name,
    alertedAt: r.alerted_at, escalatedAt: r.escalated_at, escalatedKind: r.escalation_kind,
  });

  app.get('/kids/sessions/:id', auth, async (req) => {
    const { s, c } = await sessionRow(req, (req.params as any).id);
    const rows = await ctx.db.query<any>(`SELECT * FROM kids_checkins WHERE session_id=$1 ORDER BY in_at, tag, child_name`, [s.id]);
    return { session: await sessionView(s), className: c.name, room: c.room, branch: c.branch_name, children: rows.map((r) => rowView(r, s)), serverNow: nowIso() };
  });

  // ======================= scanning a guardian (L181, L182) =======================

  const proofFor = (s: any, req: FastifyRequest, p: Record<string, unknown>) => signData({ k: 'p', s: s.id, o: s.org_id, by: req.session!.uid, e: nowMs() + PROOF_TTL_MS, ...p }, 'scan');

  function readProof(req: FastifyRequest, s: any, raw: unknown) {
    const p = verifyData(String(raw ?? ''), 'scan', nowMs(), { allowExpired: true });
    if (!p || p.k !== 'p' || p.s !== s.id || p.by !== req.session!.uid) throw new HttpError(400, 'This scan is not valid. Scan again.', 'bad_proof');
    if (Number(p.e) < nowMs()) throw new HttpError(400, 'This scan has timed out. Scan again.', 'proof_expired');
    return p;
  }

  async function childrenToDrop(guardianId: string) {
    const kids = await ctx.db.query<any>(`SELECT c.id, c.full_name, c.dob FROM guardians g JOIN memberships c ON c.id=g.child_id WHERE g.guardian_id=$1 AND c.status='active' AND c.category='child' ORDER BY c.dob DESC NULLS LAST`, [guardianId]);
    const out = [];
    for (const k of kids) {
      const inRow = (await ctx.db.query<any>(`SELECT k.id, s.class_name FROM kids_checkins k JOIN kids_sessions s ON s.id=k.session_id WHERE k.child_id=$1 AND k.status='in'`, [k.id]))[0];
      out.push({ id: k.id, name: k.full_name, age: agoYears(ctx, k.dob), inClass: inRow?.class_name ?? null });
    }
    return out;
  }

  /** The children of a guardian who are in this session now, ready to hand over. */
  async function childrenToCollect(s: any, guardianId: string) {
    const rows = await ctx.db.query<any>(
      `SELECT k.* FROM kids_checkins k JOIN guardians g ON g.child_id=k.child_id WHERE k.session_id=$1 AND k.status='in' AND g.guardian_id=$2 ORDER BY k.tag, k.child_name`,
      [s.id, guardianId],
    );
    return rows.map((r) => ({ ...rowView(r, s), byDifferentPerson: r.dropper_id !== guardianId }));
  }

  app.post('/kids/sessions/:id/scan', auth, async (req) => {
    const { s } = await sessionRow(req, (req.params as any).id);
    if (s.status !== 'open') throw new HttpError(409, 'This session is closed', 'closed');
    const b = (req.body ?? {}) as any;
    const dev = deviceOf(req, b.device);
    const base = { orgId: s.org_id, branchId: s.branch_id, sessionId: s.id, className: s.class_name, staffId: req.session!.uid, geo: tg(req), staffName: req.session!.name, staffDevice: dev, method: 'qr' };
    const raw = String(b.token ?? '').trim();
    const p = raw.startsWith('K1.') ? verifyData(raw.slice(3), 'guardian', nowMs(), { allowExpired: true }) : null;
    if (!p || p.k !== 'q') {
      await kidsLog(ctx, { ...base, action: 'scan', result: 'invalid', detail: 'Not a guardian code' });
      return { result: 'invalid', message: 'This is not a guardian code from the app.' };
    }
    const g = (await ctx.db.query<any>(`SELECT id, full_name, org_id FROM memberships WHERE id=$1 AND status='active'`, [p.m]))[0];
    if (!g || g.org_id !== s.org_id) {
      await kidsLog(ctx, { ...base, action: 'scan', result: 'wrong_church', subjectName: g?.full_name ?? null, subjectId: g?.id ?? null, subjectDevice: String(p.d ?? '') });
      return { result: 'wrong_church', message: 'This code belongs to someone from another church.' };
    }
    if (Number(p.e) < nowMs()) {
      await kidsLog(ctx, { ...base, action: 'scan', result: 'expired', subjectId: g.id, subjectName: g.full_name, subjectDevice: String(p.d ?? ''), detail: 'The code had expired' });
      return { result: 'expired', message: 'This code has expired. Ask the guardian to keep the screen open: it refreshes by itself.' };
    }
    const drop = await childrenToDrop(g.id);
    const collect = await childrenToCollect(s, g.id);
    const gg = parseGeo(p.g);
    const loc = await checkLocation(ctx, s.branch_id, tg(req), gg);
    await kidsLog(ctx, { ...base, guardianGeo: gg, action: 'scan', result: 'ok', subjectId: g.id, subjectName: g.full_name, subjectDevice: String(p.d ?? ''), children: [...collect, ...drop.filter((d) => !d.inClass)].map((c) => c.name).join(', ') || null });
    return { result: 'ok', guardian: { id: g.id, name: g.full_name }, proof: proofFor(s, req, { m: g.id, n: g.full_name, d: String(p.d ?? ''), kind: 'guardian', method: 'qr', ...(gg ? { gg } : {}) }), location: publicLoc(loc), dropOff: drop, collect, noChildren: drop.length === 0 };
  });

  /** Is this device at the branch? The room screen asks, to show it and to grey out check-in when it is not (L188). */
  app.post('/kids/sessions/:id/locate', auth, async (req) => {
    const { s } = await sessionRow(req, (req.params as any).id);
    return { location: publicLoc(await checkLocation(ctx, s.branch_id, tg(req), null)) };
  });

  app.get('/kids/sessions/:id/guardians', auth, async (req) => {
    const { s } = await sessionRow(req, (req.params as any).id);
    const q = cap((req.query as any).q, 40);
    if (q.length < 2) return { guardians: [] };
    const like = `%${q.replace(/[%_]/g, '')}%`;
    const rows = await ctx.db.query<any>(
      `SELECT m.id, m.full_name, m.member_number, m.phone, m.user_id FROM memberships m
        WHERE m.org_id=$1 AND m.status='active' AND m.category='adult' AND m.phone IS NOT NULL AND EXISTS (SELECT 1 FROM guardians g WHERE g.guardian_id=m.id)
          AND (m.full_name ILIKE $2 OR m.member_number ILIKE $2 OR m.phone LIKE $2) ORDER BY m.full_name LIMIT 15`,
      [s.org_id, like],
    );
    const out = [];
    for (const m of rows) out.push({ id: m.id, name: m.full_name, memberNumber: m.member_number, phone: maskPhone(m.phone), hasApp: !!m.user_id, children: await childrenToDrop(m.id) });
    return { guardians: out };
  });

  /** A guardian found by name or number instead of by QR code, for someone with no app (L181). */
  app.post('/kids/sessions/:id/find', auth, async (req) => {
    const { s } = await sessionRow(req, (req.params as any).id);
    if (s.status !== 'open') throw new HttpError(409, 'This session is closed', 'closed');
    const b = (req.body ?? {}) as any;
    const g = (await ctx.db.query<any>(`SELECT id, full_name, phone FROM memberships WHERE id=$1 AND org_id=$2 AND status='active' AND category='adult' AND phone IS NOT NULL`, [String(b.guardianId ?? ''), s.org_id]))[0];
    if (!g) throw new HttpError(404, 'not found', 'not_found');
    const dev = deviceOf(req, b.device);
    await kidsLog(ctx, { orgId: s.org_id, branchId: s.branch_id, sessionId: s.id, className: s.class_name, staffId: req.session!.uid, geo: tg(req), staffName: req.session!.name, staffDevice: dev, action: 'scan', result: 'ok', method: 'search', subjectId: g.id, subjectName: g.full_name, detail: 'Found by name or number' });
    return { result: 'ok', guardian: { id: g.id, name: g.full_name }, proof: proofFor(s, req, { m: g.id, n: g.full_name, d: '', kind: 'guardian', method: 'search' }), location: publicLoc(await checkLocation(ctx, s.branch_id, tg(req), null)), dropOff: await childrenToDrop(g.id), collect: await childrenToCollect(s, g.id) };
  });

  // ======================= drop-off =======================

  const newCode = () => String(randomInt(100000, 1000000));

  async function createCode(s: any, a: { kind: 'dropoff' | 'collect'; ids: string[]; name: string; phone: string; subjectKind: string; subjectId: string }) {
    const code = newCode();
    await ctx.db.query(
      `INSERT INTO kids_codes (id, org_id, session_id, checkin_ids, kind, to_name, to_phone, subject_kind, subject_id, code_hash, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [ctx.newId('kc'), s.org_id, s.id, JSON.stringify(a.ids), a.kind, a.name, a.phone, a.subjectKind, a.subjectId, hashCode(s.id, code), nowIso(), new Date(Math.max(Date.parse(s.ends_at), nowMs()) + CODE_HOURS * 3600_000).toISOString()],
    );
    return code;
  }

  app.post('/kids/sessions/:id/checkin', auth, async (req) => {
    const { s, c } = await sessionRow(req, (req.params as any).id);
    if (s.status !== 'open') throw new HttpError(409, 'This session is closed', 'closed');
    const b = (req.body ?? {}) as any;
    const p = readProof(req, s, b.proof);
    if (p.kind !== 'guardian') throw new HttpError(400, 'Scan or find the guardian first', 'bad_proof');
    const dev = deviceOf(req, b.device);
    const g = (await ctx.db.query<any>(`SELECT id, full_name, phone, user_id FROM memberships WHERE id=$1 AND status='active'`, [p.m]))[0];
    const wanted: string[] = [...new Set((Array.isArray(b.childIds) ? b.childIds : []).map(String))] as string[];
    if (!g || !wanted.length) throw new HttpError(400, 'Choose at least one child', 'no_children');
    const eligible = new Map((await childrenToDrop(g.id)).map((k) => [k.id, k]));
    const names: string[] = [];
    for (const id of wanted) {
      const k = eligible.get(id);
      if (!k) throw new HttpError(400, 'One of those children is not linked to this guardian', 'not_linked');
      if (k.inClass) throw new HttpError(409, `${k.name} is already checked in to ${k.inClass}`, 'already_in');
      names.push(k.name);
    }
    const loc = await checkLocation(ctx, s.branch_id, tg(req), parseGeo(p.gg));
    if (loc.status === 'away' || loc.status === 'unknown') {
      await kidsLog(ctx, { orgId: s.org_id, branchId: s.branch_id, sessionId: s.id, className: s.class_name, staffId: req.session!.uid, geo: tg(req), guardianGeo: parseGeo(p.gg), staffName: req.session!.name, staffDevice: dev, action: 'check_in', result: 'refused', method: String(p.method), subjectId: g.id, subjectName: g.full_name, subjectDevice: String(p.d ?? '') || null, children: names.join(', '), detail: loc.status === 'away' ? 'Refused: away from the branch' : 'Refused: no location available' });
      throw new HttpError(409, publicLoc(loc).message, loc.status === 'away' ? 'away_from_branch' : 'location_needed');
    }
    const rows = await ctx.db.tx(async (q) => {
      const n = (await q.query<any>(`UPDATE kids_sessions SET tag_next=tag_next+1 WHERE id=$1 AND status='open' RETURNING tag_next-1 AS n`, [s.id]))[0];
      if (!n) throw new HttpError(409, 'This session is closed', 'closed');
      const tag = String(n.n).padStart(2, '0');
      const out: any[] = [];
      for (const id of wanted) {
        const rid = ctx.newId('kci');
        await q.query(
          `INSERT INTO kids_checkins (id, org_id, branch_id, session_id, class_id, child_id, child_name, tag, in_at, in_by, in_by_name, in_device, in_method, dropper_id, dropper_name, dropper_device)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [rid, s.org_id, s.branch_id, s.id, s.class_id, id, eligible.get(id)!.name, tag, nowIso(), req.session!.uid, req.session!.name, dev, p.method, g.id, g.full_name, String(p.d ?? '') || null],
        );
        out.push({ id: rid, tag, name: eligible.get(id)!.name, childId: id });
      }
      return out;
    });
    await kidsLog(ctx, { orgId: s.org_id, branchId: s.branch_id, sessionId: s.id, className: s.class_name, staffId: req.session!.uid, geo: tg(req), staffName: req.session!.name, staffDevice: dev, guardianGeo: parseGeo(p.gg), action: 'check_in', result: 'ok', method: String(p.method), subjectId: g.id, subjectName: g.full_name, subjectDevice: String(p.d ?? '') || null, children: names.join(', '), detail: `Tag ${rows[0].tag}` });

    // The guardian is told. With no app, an SMS carries the tag and a pick-up code (L181).
    const who = names.join(' and ');
    const hasApp = !!g.user_id;
    let code: string | null = null;
    if (!hasApp || p.method === 'search') code = await createCode(s, { kind: 'dropoff', ids: rows.map((r) => r.id), name: g.full_name, phone: g.phone, subjectKind: 'guardian', subjectId: g.id });
    const text = `${who} checked in to ${s.class_name} at ${hm(nowIso())}, tag ${rows[0].tag}. To collect, ${hasApp ? 'show your QR code in the app' : 'tell the teacher your pick-up code'}${code ? `${hasApp ? ' or' : ':'} pick-up code ${code}` : ''}.`;
    const r = await notify(ctx, { orgId: s.org_id, branchId: s.branch_id, phone: g.phone, kind: 'announcement', title: `${who} checked in`, body: text, idemKey: `kids:in:${rows[0].id}`, sms: !hasApp || p.method === 'search', link: 'member:kids' });
    await kidsLog(ctx, { orgId: s.org_id, branchId: s.branch_id, sessionId: s.id, className: s.class_name, action: 'message_sent', result: r.sms === 'skipped_no_balance' ? 'sms_not_sent' : 'ok', subjectId: g.id, subjectName: g.full_name, children: who, detail: `Drop-off confirmation: ${r.sms === 'sent' ? 'SMS' : ''}${r.sms === 'sent' && r.inApp ? ' and ' : ''}${r.inApp ? 'in-app' : ''}${r.sms !== 'sent' && !r.inApp ? 'not delivered' : ''}`.trim() });
    // The other guardians of these children hear about it in the app (no SMS cost).
    for (const row of rows) {
      for (const o of await guardiansOf(ctx, row.childId)) {
        if (o.id === g.id || !o.phone || !o.user_id) continue;
        await notify(ctx, { orgId: s.org_id, branchId: s.branch_id, phone: o.phone, kind: 'announcement', title: `${row.name} checked in`, body: `${g.full_name} dropped off ${row.name} at ${s.class_name}, tag ${row.tag}.`, idemKey: `kids:in:${row.id}:${o.id}`, sms: false, link: 'member:kids' });
      }
    }
    void c;
    return { tag: rows[0].tag, children: rows.map((r) => ({ id: r.id, name: r.name })), smsSent: r.sms === 'sent', codeSent: !!code };
  });

  // ======================= pick-up (L182, L183) =======================

  /** Who can collect this child: the registered guardians, and the people they approved (L183). */
  async function collectorsOf(row: any) {
    const gs = await guardiansOf(ctx, row.child_id);
    const people: any[] = [];
    for (const g of gs) for (const p of await ctx.db.query<any>(`SELECT * FROM kids_pickup_people WHERE guardian_id=$1 AND active ORDER BY name`, [g.id])) people.push({ ...p, guardianName: g.name });
    return { guardians: gs.filter((g) => g.phone), people };
  }

  app.get('/kids/checkins/:id/collectors', auth, async (req) => {
    const r = (await ctx.db.query<any>(`SELECT * FROM kids_checkins WHERE id=$1`, [(req.params as any).id]))[0];
    if (!r) throw new HttpError(404, 'not found', 'not_found');
    await sessionRow(req, r.session_id);
    const c = await collectorsOf(r);
    return {
      guardians: c.guardians.map((g) => ({ kind: 'guardian', id: g.id, name: g.name, phone: maskPhone(g.phone), note: g.id === r.dropper_id ? 'Dropped off' : 'Guardian' })),
      people: c.people.map((p) => ({ kind: 'approved', id: p.id, name: p.name, phone: maskPhone(p.phone), note: `${p.relation ?? 'Approved person'}, listed by ${p.guardianName}` })),
    };
  });

  app.post('/kids/checkins/:id/send-code', auth, async (req) => {
    const r = (await ctx.db.query<any>(`SELECT * FROM kids_checkins WHERE id=$1`, [(req.params as any).id]))[0];
    if (!r) throw new HttpError(404, 'not found', 'not_found');
    const { s } = await sessionRow(req, r.session_id);
    if (r.status !== 'in') throw new HttpError(409, `${r.child_name} has already gone home`, 'not_in');
    const b = (req.body ?? {}) as any;
    const dev = deviceOf(req, b.device);
    const all = await collectorsOf(r);
    let name: string, phone: string, ids: string[];
    if (b.kind === 'guardian') {
      const g = all.guardians.find((x) => x.id === b.id);
      if (!g) throw new HttpError(404, 'not found', 'not_found');
      name = g.name; phone = g.phone;
      ids = (await childrenToCollect(s, g.id)).map((k) => k.id);
    } else {
      const p = all.people.find((x) => x.id === b.id);
      if (!p) throw new HttpError(404, 'not found', 'not_found');
      name = p.name; phone = p.phone;
      const mine = await ctx.db.query<any>(`SELECT k.id FROM kids_checkins k JOIN guardians g ON g.child_id=k.child_id WHERE k.session_id=$1 AND k.status='in' AND g.guardian_id=$2`, [s.id, p.guardian_id]);
      ids = mine.map((k) => k.id);
    }
    if (!ids.includes(r.id)) ids.push(r.id);
    const recent = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM kids_codes WHERE session_id=$1 AND kind='collect' AND checkin_ids @> $2::jsonb AND created_at > $3`, [s.id, JSON.stringify([r.id]), new Date(nowMs() - 30 * 60_000).toISOString()]))[0].n);
    if (recent >= 3) throw new HttpError(429, 'Three codes have been sent for this child. Wait a little or call the guardian.', 'too_many');
    const code = await createCode(s, { kind: 'collect', ids, name, phone, subjectKind: b.kind === 'guardian' ? 'guardian' : 'approved', subjectId: String(b.id) });
    const body = `Pick-up code for ${r.child_name}, ${s.class_name}: ${code}. Give it to the teacher to take ${r.child_name} home. If you did not expect this, call the church.`;
    const res = await notify(ctx, { orgId: s.org_id, branchId: s.branch_id, phone, kind: 'announcement', title: 'Your pick-up code', body, idemKey: `kids:code:${r.id}:${code}`, sms: true, link: 'member:kids' });
    await kidsLog(ctx, { orgId: s.org_id, branchId: s.branch_id, sessionId: s.id, className: s.class_name, staffId: req.session!.uid, geo: tg(req), staffName: req.session!.name, staffDevice: dev, action: 'code_sent', result: res.sms === 'sent' ? 'ok' : 'sms_not_sent', method: 'sms', subjectName: name, children: r.child_name, detail: `Pick-up code sent by SMS to ${maskPhone(phone)} (${b.kind === 'guardian' ? 'guardian' : 'approved person'})` });
    if (res.sms !== 'sent') throw new HttpError(502, 'The SMS could not be sent. Check the church\'s SMS balance, or scan the guardian\'s code.', 'sms_failed');
    return { sentTo: maskPhone(phone), name };
  });

  app.post('/kids/sessions/:id/lookup', auth, async (req) => {
    const { s } = await sessionRow(req, (req.params as any).id);
    const b = (req.body ?? {}) as any;
    const dev = deviceOf(req, b.device);
    const base = { orgId: s.org_id, branchId: s.branch_id, sessionId: s.id, className: s.class_name, staffId: req.session!.uid, geo: tg(req), staffName: req.session!.name, staffDevice: dev, method: 'code' };
    const bad = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM kids_log WHERE session_id=$1 AND action='lookup' AND result='bad_code' AND at > $2`, [s.id, new Date(nowMs() - 10 * 60_000).toISOString()]))[0].n);
    if (bad >= MAX_BAD_CODES) throw new HttpError(429, 'Too many wrong codes. Wait a few minutes, or scan the guardian\'s code.', 'too_many');
    const code = String(b.code ?? '').replace(/\D/g, '');
    const row = code.length === 6 ? (await ctx.db.query<any>(`SELECT * FROM kids_codes WHERE session_id=$1 AND code_hash=$2 AND used_at IS NULL AND expires_at > $3 ORDER BY created_at DESC LIMIT 1`, [s.id, hashCode(s.id, code), nowIso()]))[0] : null;
    if (!row) {
      await kidsLog(ctx, { ...base, action: 'lookup', result: 'bad_code', detail: 'Code not recognised' });
      return { result: 'bad_code', message: 'That code is not right, or it was already used. Check it with the guardian.' };
    }
    const ids: string[] = row.checkin_ids;
    const rows = await ctx.db.query<any>(`SELECT * FROM kids_checkins WHERE id = ANY($1::text[]) AND status='in' AND session_id=$2 ORDER BY tag, child_name`, [ids, s.id]);
    if (!rows.length) {
      await kidsLog(ctx, { ...base, action: 'lookup', result: 'already_out', subjectName: row.to_name, detail: 'Everyone on this code has already gone home' });
      return { result: 'already_out', message: 'Everyone on this code has already been collected.' };
    }
    await kidsLog(ctx, { ...base, action: 'lookup', result: 'ok', subjectId: row.subject_id, subjectName: row.to_name, children: rows.map((r) => r.child_name).join(', ') });
    return {
      result: 'ok', holder: row.to_name, kind: row.subject_kind, children: rows.map((r) => ({ ...rowView(r, s), byDifferentPerson: row.subject_kind === 'approved' || r.dropper_id !== row.subject_id })),
      proof: proofFor(s, req, { kind: 'code', n: row.to_name, ids: rows.map((r) => r.id), cid: row.id, sk: row.subject_kind, sid: row.subject_id }),
    };
  });

  app.post('/kids/sessions/:id/checkout', auth, async (req) => {
    const { s } = await sessionRow(req, (req.params as any).id);
    const b = (req.body ?? {}) as any;
    const p = readProof(req, s, b.proof);
    const dev = deviceOf(req, b.device);
    const wanted: string[] = [...new Set((Array.isArray(b.checkinIds) ? b.checkinIds : []).map(String))] as string[];
    if (!wanted.length) throw new HttpError(400, 'Choose at least one child', 'no_children');
    const done: any[] = [];
    const refused: { name: string; reason: string }[] = [];
    for (const id of wanted) {
      const r = (await ctx.db.query<any>(`SELECT * FROM kids_checkins WHERE id=$1 AND session_id=$2`, [id, s.id]))[0];
      if (!r) throw new HttpError(404, 'not found', 'not_found');
      if (r.status !== 'in') { refused.push({ name: r.child_name, reason: 'Already collected' }); continue; }
      let allowed = false;
      if (p.kind === 'guardian') allowed = await guardianCanCollect(ctx, r.child_id, String(p.m));
      else allowed = Array.isArray(p.ids) && (p.ids as string[]).includes(r.id);
      if (!allowed) {
        refused.push({ name: r.child_name, reason: 'This person is not allowed to collect this child' });
        await kidsLog(ctx, { orgId: s.org_id, branchId: s.branch_id, sessionId: s.id, className: s.class_name, staffId: req.session!.uid, geo: tg(req), staffName: req.session!.name, staffDevice: dev, action: 'check_out', result: 'refused', method: String(p.method ?? 'code'), subjectName: String(p.n ?? ''), subjectDevice: String(p.d ?? '') || null, children: r.child_name, detail: 'Not a registered guardian or approved person for this child' });
        continue;
      }
      const upd = await ctx.db.query<any>(
        `UPDATE kids_checkins SET status='out', out_at=$2, out_by=$3, out_by_name=$4, out_device=$5, out_method=$6, collector_id=$7, collector_name=$8, collector_kind=$9, collector_device=$10 WHERE id=$1 AND status='in' RETURNING *`,
        [r.id, nowIso(), req.session!.uid, req.session!.name, dev, p.kind === 'guardian' ? String(p.method ?? 'qr') : 'code', p.kind === 'guardian' ? String(p.m) : String(p.sid ?? ''), String(p.n ?? ''), p.kind === 'guardian' ? 'guardian' : String(p.sk ?? 'guardian'), String(p.d ?? '') || null],
      );
      if (upd[0]) done.push(upd[0]);
    }
    if (p.cid && done.length) await ctx.db.query(`UPDATE kids_codes SET used_at=$2 WHERE id=$1 AND used_at IS NULL`, [String(p.cid), nowIso()]);
    if (done.length) {
      const names = done.map((r) => r.child_name).join(', ');
      const differs = done.some((r) => r.dropper_id !== r.collector_id);
      await kidsLog(ctx, { orgId: s.org_id, branchId: s.branch_id, sessionId: s.id, className: s.class_name, staffId: req.session!.uid, geo: tg(req), staffName: req.session!.name, staffDevice: dev, guardianGeo: parseGeo(p.gg), action: 'check_out', result: 'ok', method: done[0].out_method, subjectId: done[0].collector_id, subjectName: String(p.n ?? ''), subjectDevice: String(p.d ?? '') || null, children: names, detail: differs ? `Collected by someone other than ${done[0].dropper_name}` : null });
      // Every guardian hears who collected. Anyone without the app, or who dropped off and is not the collector, also gets an SMS.
      const told = new Set<string>();
      for (const r of done) {
        for (const g of await guardiansOf(ctx, r.child_id)) {
          if (!g.phone || told.has(`${g.id}:${r.collector_name}`)) continue;
          told.add(`${g.id}:${r.collector_name}`);
          const mine = done.filter((d) => d.child_id && (d.dropper_id === g.id || true));
          void mine;
          const kids = done.map((d) => d.child_name).join(' and ');
          const sms = !g.user_id || (r.dropper_id === g.id && r.collector_id !== g.id);
          await notify(ctx, { orgId: s.org_id, branchId: s.branch_id, phone: g.phone, kind: 'announcement', title: `${kids} collected`, body: `${kids} collected from ${s.class_name} at ${hm(nowIso())} by ${r.collector_name}.`, idemKey: `kids:out:${r.id}:${g.id}`, sms, link: 'member:kids' });
        }
      }
    }
    return { done: done.map((r) => ({ id: r.id, name: r.child_name })), refused, location: publicLoc(await checkLocation(ctx, s.branch_id, tg(req), parseGeo(p.gg))) };
  });

  // ======================= not collected (L184) =======================

  const { escalate } = kidsInternals(ctx);

  app.post('/kids/checkins/:id/escalate', auth, async (req) => {
    const r = (await ctx.db.query<any>(`SELECT * FROM kids_checkins WHERE id=$1`, [(req.params as any).id]))[0];
    if (!r) throw new HttpError(404, 'not found', 'not_found');
    const { s } = await sessionRow(req, r.session_id);
    if (r.status !== 'in') throw new HttpError(409, `${r.child_name} has already gone home`, 'not_in');
    if (r.escalated_at) throw new HttpError(409, 'Staff were already alerted about this child', 'already');
    const b = (req.body ?? {}) as any;
    await escalate(s, r, 'manual', req.session!.uid, req.session!.name, cap(b.note, 200) || null, deviceOf(req, b.device));
    return { ok: true };
  });

  /** The guardians' phone numbers, shown only once a child is late or staff have been alerted (L186). */
  app.get('/kids/checkins/:id/contacts', auth, async (req) => {
    const r = (await ctx.db.query<any>(`SELECT * FROM kids_checkins WHERE id=$1`, [(req.params as any).id]))[0];
    if (!r) throw new HttpError(404, 'not found', 'not_found');
    const { s } = await sessionRow(req, r.session_id);
    if (r.status !== 'in') throw new HttpError(409, `${r.child_name} has already gone home`, 'not_in');
    if (!r.escalated_at && Date.parse(s.ends_at) > nowMs()) throw new HttpError(403, 'Phone numbers are shown when a child is late or staff have been alerted.', 'not_yet');
    const gs = await guardiansOf(ctx, r.child_id);
    await kidsLog(ctx, { orgId: s.org_id, branchId: s.branch_id, sessionId: s.id, className: s.class_name, staffId: req.session!.uid, geo: tg(req), staffName: req.session!.name, staffDevice: deviceOf(req, (req.query as any).device), action: 'contacts_shown', result: 'ok', children: r.child_name, detail: `Showed phone numbers of ${gs.map((g) => g.name).join(', ')}` });
    return { child: r.child_name, guardians: gs.filter((g) => g.phone).map((g) => ({ name: g.name, phone: localPhone(g.phone) })) };
  });

  // ======================= the log and reports (L185) =======================

  app.get('/kids/log', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'kids.manage');
    const q = req.query as any;
    const where = [`org_id=$1`, `branch_id = ANY($2::text[])`];
    const params: unknown[] = [g.orgId, g.branchIds];
    if (q.from) { params.push(new Date(`${String(q.from)}T00:00:00+03:00`).toISOString()); where.push(`at >= $${params.length}`); }
    if (q.to) { params.push(new Date(new Date(`${String(q.to)}T00:00:00+03:00`).getTime() + 86400_000).toISOString()); where.push(`at < $${params.length}`); }
    if (q.action) { params.push(String(q.action)); where.push(`action = $${params.length}`); }
    if (q.sessionId) { params.push(String(q.sessionId)); where.push(`session_id = $${params.length}`); }
    if (q.q) { params.push(`%${String(q.q).replace(/[%_]/g, '')}%`); where.push(`(coalesce(staff_name,'') || ' ' || coalesce(subject_name,'') || ' ' || coalesce(children,'') || ' ' || coalesce(detail,'') || ' ' || coalesce(class_name,'')) ILIKE $${params.length}`); }
    const rows = await ctx.db.query<any>(`SELECT * FROM kids_log WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT 500`, params);
    const place = (r: any) => (r.location ? { locationStatus: ({ ok: 'At the branch', away: 'Away from the branch', unknown: 'Location not shared', unchecked: 'Not checked' } as Record<string, string>)[r.location.status] ?? '', distanceM: r.location.distanceM, locationSource: r.location.source, teacherLocation: geoText(r.location.teacher), guardianLocation: geoText(r.location.guardian) } : { locationStatus: '', distanceM: null, locationSource: null, teacherLocation: null, guardianLocation: null });
    const view = rows.map((r) => ({ id: r.id, at: r.at, action: r.action, result: r.result, className: r.class_name, teacher: r.staff_name, teacherDevice: r.staff_device, guardian: r.subject_name, guardianDevice: r.subject_device, method: r.method, children: r.children, detail: r.detail, ...place(r) }));
    if (q.csv) {
      return csv(view.map((v) => ({ When: new Date(v.at).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }), What: v.action, Result: v.result, Class: v.className ?? '', Teacher: v.teacher ?? '', 'Teacher device': v.teacherDevice ?? '', 'Guardian or person': v.guardian ?? '', 'Guardian device': v.guardianDevice ?? '', 'Location check': v.locationStatus, 'Metres from branch': v.distanceM ?? '', 'Teacher location': v.teacherLocation ?? '', 'Guardian location': v.guardianLocation ?? '', How: v.method ?? '', Children: v.children ?? '', Detail: v.detail ?? '' })));
    }
    return { log: view };
  });

  app.get('/kids/report', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'kids.manage');
    const q = req.query as any;
    const from = q.from ? new Date(`${String(q.from)}T00:00:00+03:00`).toISOString() : new Date(nowMs() - 30 * 86400_000).toISOString();
    const to = q.to ? new Date(new Date(`${String(q.to)}T00:00:00+03:00`).getTime() + 86400_000).toISOString() : new Date(nowMs() + 86400_000).toISOString();
    const sessions = await ctx.db.query<any>(`SELECT s.*, b.name AS branch_name FROM kids_sessions s JOIN branches b ON b.id=s.branch_id WHERE s.org_id=$1 AND s.branch_id = ANY($2::text[]) AND s.starts_at >= $3 AND s.starts_at < $4 ORDER BY s.starts_at DESC LIMIT 200`, [g.orgId, g.branchIds, from, to]);
    const out = [];
    for (const s of sessions) {
      const rows = await ctx.db.query<any>(`SELECT * FROM kids_checkins WHERE session_id=$1`, [s.id]);
      const lateMs = Date.parse(s.ends_at) + s.grace_min * 60_000;
      out.push({
        id: s.id, className: s.class_name, branch: s.branch_name, date: s.starts_at, endsAt: s.ends_at, status: s.status, checkedIn: rows.length,
        stillIn: rows.filter((r) => r.status === 'in').length, late: rows.filter((r) => (r.status === 'in' ? lateMs < nowMs() : Date.parse(r.out_at) > lateMs)).length, escalated: rows.filter((r) => r.escalated_at).length,
      });
    }
    const totals = out.reduce((a, s) => ({ sessions: a.sessions + 1, checkedIn: a.checkedIn + s.checkedIn, late: a.late + s.late, escalated: a.escalated + s.escalated }), { sessions: 0, checkedIn: 0, late: 0, escalated: 0 });
    if (q.csv) return csv(out.map((s) => ({ Date: dayText(s.date), Class: s.className, Branch: s.branch, 'Checked in': s.checkedIn, 'Still in': s.stillIn, 'Collected late': s.late, 'Staff alerted': s.escalated })));
    return { sessions: out, totals };
  });

  /** Staff can list approved pick-up people for a guardian who has no app (L183). */
  app.post('/kids/guardians/:id/pickup-people', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'kids.manage');
    const m = (await ctx.db.query<any>(`SELECT id, org_id, branch_id, full_name FROM memberships WHERE id=$1 AND org_id=$2 AND status='active' AND category='adult'`, [(req.params as any).id, g.orgId]))[0];
    if (!m || !g.branchIds.includes(m.branch_id)) throw new HttpError(404, 'not found', 'not_found');
    const p = pickupBody((req.body ?? {}) as any);
    const id = ctx.newId('kpp');
    await ctx.db.query(`INSERT INTO kids_pickup_people (id, org_id, guardian_id, name, phone, relation, id_number, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, m.org_id, m.id, p.name, p.phone, p.relation, p.idNumber, req.session!.uid, nowIso()]);
    await kidsLog(ctx, { orgId: m.org_id, branchId: m.branch_id, action: 'pickup_person_added', result: 'ok', subjectId: m.id, subjectName: m.full_name, detail: `${p.name}${p.relation ? `, ${p.relation}` : ''}, ${maskPhone(p.phone)}`, staffId: req.session!.uid, geo: tg(req), staffName: req.session!.name, method: 'staff' });
    return { id };
  });
}

/** Late children: guardians are told after the grace period, and staff after the longer wait (L184). Run by the scheduler and after the development clock moves. */
export async function runKidsJobs(ctx: Ctx): Promise<{ alerted: number; escalated: number }> {
  const now = ctx.clock.now().getTime();
  let alerted = 0;
  let escalated = 0;
  const sessions = await ctx.db.query<any>(`SELECT * FROM kids_sessions WHERE status='open'`);
  const helper = kidsInternals(ctx);
  for (const s of sessions) {
    const rows = await ctx.db.query<any>(`SELECT * FROM kids_checkins WHERE session_id=$1 AND status='in'`, [s.id]);
    for (const r of rows) {
      if (!r.alerted_at && now >= Date.parse(s.ends_at) + s.grace_min * 60_000) {
        const claimed = await ctx.db.query<any>(`UPDATE kids_checkins SET alerted_at=$2 WHERE id=$1 AND alerted_at IS NULL AND status='in' RETURNING id`, [r.id, ctx.clock.now().toISOString()]);
        if (claimed[0]) { await helper.alertGuardians(s, r, 'late'); alerted++; }
      }
      const fresh = (await ctx.db.query<any>(`SELECT * FROM kids_checkins WHERE id=$1`, [r.id]))[0];
      if (fresh.status === 'in' && fresh.alerted_at && !fresh.escalated_at && now >= Date.parse(s.ends_at) + s.escalate_min * 60_000) {
        if (await helper.escalate(s, fresh, 'auto', null, null, null, null)) escalated++;
      }
    }
  }
  return { alerted, escalated };
}
