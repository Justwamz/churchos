import { randomInt } from 'node:crypto';
import { maskPhone } from '@churchos/shared';
import { brandingInfo } from './branding';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { branchesFor, normalizePhone, signData, verifyData, type Permission } from '../auth';
import { HttpError, requireSession, type Ctx } from '../ctx';
import { addDays, dueAt, eatDateOf, eatToday, isoWeekday, lastDayOfMonth, lastDayOfYear, weekStartOf, DAY } from '../eat';
import { grantsFor, inStaffScope } from '../scope';
import { notify } from '../sms';
import { phoneSearchAllowed } from '../phone-search';
import { abuse, abuseDisabled, safeSmsName, windowHit } from '../abuse';
import { clientIp, rateLimit } from '../ratelimit';
import { sendEmail } from '../wallets';
import { csv } from './helpers';
import { MAX_ACCURACY_M, metresBetween, parseGeo } from './kids';
import { qrSvg } from './tickets';
import { wordsFor } from './words';

/** Attendance (L204 to L216): the weekly schedule, check-ins, visitors, the live link and the Monday report. */

const MIN = 60_000;
const HOUR = 3600_000;
const DOOR_TTL_MS = 5 * MIN;
const MEMBER_CODE_TTL_MS = 45_000;
const USHER_LATE_MS = 12 * HOUR;
export const DEFAULT_WELCOME = 'Hello {name}, welcome to {church}! We were so glad to have you with us at {service}. If we can pray with you or help in any way, please call us. God bless you.';
const RELEASES = ['now', 'day_before', 'hour_before', 'minutes_20'] as const;
const RELEASE_LABEL: Record<string, string> = { now: 'Straight away', day_before: 'A day before', hour_before: 'An hour before', minutes_20: '20 minutes before' };
const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const cap = (v: unknown, n: number) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, n);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const timeOk = (t: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const when = (iso: string) => new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dayText = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-KE', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
const streamOk = (u: string | null) => !u || (u.length <= 500 && /^https:\/\/[^\s]+$/i.test(u));

/** The lectionary day that falls on the date of a service, if the church entered one (Slice 22). */
const LECT_COLS = `ld.title AS lect_title, ld.season AS lect_season, ld.cycle AS lect_cycle, ld.colour AS lect_colour, ld.readings AS lect_readings, ld.note AS lect_note`;
const LECT_JOIN = `LEFT JOIN lectionary_days ld ON ld.org_id=s.org_id AND ld.active AND ld.date = ((s.starts_at::timestamptz + interval '3 hours')::date)::text`;

type ReadingMode = 'staff' | 'locked' | 'open';

/** When members may see the reading or notices of a service (L211). */
export function readingPublishAt(startsAt: string, release: string): number {
  const t = Date.parse(startsAt);
  return release === 'now' ? 0 : release === 'hour_before' ? t - HOUR : release === 'minutes_20' ? t - 20 * MIN : t - DAY;
}

export interface WeekReport {
  weekStart: string;
  weekEnd: string;
  services: any[];
  totals: { services: number; members: number; firstVisitors: number; returningVisitors: number; online: number; headcount: number | null };
  previous: WeekReport['totals'];
  average4: WeekReport['totals'];
  firstVisitors: { name: string; branch: string; service: string }[];
  care: any[];
  events: any[];
  kids: { className: string; count: number }[];
  coverage: number | null;
}

export function attendanceRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };
  const nowIso = () => ctx.clock.now().toISOString();
  const nowMs = () => ctx.clock.now().getTime();

  // ======================= helpers =======================

  async function serviceRow(id: string) {
    const s = (await ctx.db.query<any>(`SELECT s.*, b.name AS branch_name, b.code AS branch_code, o.name AS church, ${LECT_COLS} FROM services s JOIN branches b ON b.id=s.branch_id JOIN organisations o ON o.id=s.org_id ${LECT_JOIN} WHERE s.id=$1`, [id]))[0];
    if (!s) throw new HttpError(404, 'not found', 'not_found');
    return s;
  }

  async function serviceFor(req: FastifyRequest, id: string, perms: Permission[]) {
    const s = await serviceRow(id);
    for (const p of perms) if (await inStaffScope(ctx, req, p, s.org_id, s.branch_id)) return s;
    throw new HttpError(404, 'not found', 'not_found');
  }

  const cancelledErr = async (s: any) => new HttpError(409, `This ${(await wordsFor(ctx, s.org_id)).oneLower} was cancelled`, 'cancelled');

  const state = (s: any): 'cancelled' | 'before' | 'open' | 'closed' => {
    if (s.status === 'cancelled') return 'cancelled';
    const n = nowMs();
    return n < Date.parse(s.opens_at) ? 'before' : n > Date.parse(s.closes_at) ? 'closed' : 'open';
  };

  const lectOf = (s: any) => (s.lect_title ? { title: s.lect_title, season: s.lect_season ?? null, cycle: s.lect_cycle ?? null, colour: s.lect_colour ?? null, readings: JSON.parse(s.lect_readings || '[]') as { label: string; ref: string }[], note: s.lect_note ?? null } : null);

  /**
   * The reading of a service. Members and visitors get it only after they have checked in (Slice 22); before that they are told it is waiting.
   * 'staff' sees everything, 'locked' sees that a reading exists, 'open' sees the reading itself.
   */
  const readingOf = (s: any, mode: ReadingMode | boolean) => {
    const m: ReadingMode = mode === true ? 'staff' : mode === false ? 'locked' : mode;
    const lect = lectOf(s);
    if (!s.reading_title && !s.reading_body && !s.reading_ref && !lect) return null;
    const at = readingPublishAt(s.starts_at, s.reading_release);
    const published = nowMs() >= at;
    if (m !== 'staff' && !published) return { published: false, release: s.reading_release, releasesAt: new Date(at).toISOString() };
    if (m === 'locked') return { published: true, locked: true, release: s.reading_release };
    return { title: s.reading_title, ref: s.reading_ref, body: s.reading_body, release: s.reading_release, published, locked: false, lectionary: lect };
  };

  const liveLink = (s: any) => `${ctx.givingUrl}/live/${s.code}`;
  const branchLiveLink = (s: any) => `${ctx.givingUrl}/live/b-${s.branch_code}`;

  async function counts(ids: string[]) {
    if (!ids.length) return new Map<string, any>();
    const rows = await ctx.db.query<any>(
      `SELECT service_id,
         count(*) FILTER (WHERE mode='in_person' AND kind='member')::int AS members,
         count(*) FILTER (WHERE mode='in_person' AND kind='visitor')::int AS visitors,
         count(*) FILTER (WHERE mode='online')::int AS online
       FROM attendance WHERE service_id = ANY($1::text[]) GROUP BY service_id`,
      [ids],
    );
    return new Map(rows.map((r) => [r.service_id, r]));
  }

  const headcountOf = (s: any) => (s.headcount_adults === null && s.headcount_children === null && s.headcount_visitors === null ? null : { adults: s.headcount_adults ?? 0, children: s.headcount_children ?? 0, visitors: s.headcount_visitors ?? 0, total: (s.headcount_adults ?? 0) + (s.headcount_children ?? 0) + (s.headcount_visitors ?? 0), at: s.headcount_at });

  function serviceView(s: any, c: any, staff: boolean) {
    const hc = headcountOf(s);
    const inPerson = (c?.members ?? 0) + (c?.visitors ?? 0);
    return {
      id: s.id, code: s.code, name: s.name, branchId: s.branch_id, branch: s.branch_name, church: s.church, scheduleId: s.schedule_id, startsAt: s.starts_at, endsAt: s.ends_at, status: s.status, state: state(s),
      opensAt: s.opens_at, closesAt: s.closes_at, streamUrl: s.stream_url, liveLink: s.stream_url ? liveLink(s) : null, place: staff && s.geo_lat !== null && s.geo_lat !== undefined ? { name: s.place_name ?? null, lat: Number(s.geo_lat), lng: Number(s.geo_lng), radiusM: s.geo_radius_m } : null, reading: readingOf(s, staff), readingRelease: s.reading_release,
      counts: { members: c?.members ?? 0, visitors: c?.visitors ?? 0, online: c?.online ?? 0, inPerson }, headcount: hc, onlinePeak: s.online_peak,
      coverage: hc && hc.total > 0 ? Math.round((inPerson / hc.total) * 100) : null,
    };
  }

  const SELECT_SERVICE = `SELECT s.*, b.name AS branch_name, b.code AS branch_code, o.name AS church, ${LECT_COLS} FROM services s JOIN branches b ON b.id=s.branch_id JOIN organisations o ON o.id=s.org_id ${LECT_JOIN}`;

  async function genCode() {
    for (let i = 0; i < 20; i++) {
      const code = [...Array(8)].map(() => '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'[randomInt(32)]).join(''); // 40 bits, secure random (AZ-17)
      if (!(await ctx.db.query<any>(`SELECT 1 FROM services WHERE code=$1`, [code])).length) return code;
    }
    throw new HttpError(500, 'Could not make a code', 'internal');
  }

  async function insertService(a: { org: string; branch: string; schedule: string | null; name: string; startsAt: string; endsAt: string; opensAt: string; closesAt: string; stream: string | null; by: string }) {
    const id = ctx.newId('svc');
    await ctx.db.query(
      `INSERT INTO services (id, org_id, branch_id, schedule_id, code, name, starts_at, ends_at, opens_at, closes_at, stream_url, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
      [id, a.org, a.branch, a.schedule, await genCode(), a.name, a.startsAt, a.endsAt, a.opensAt, a.closesAt, a.stream, a.by, nowIso()],
    );
    return id;
  }

  /** Makes the services of a schedule on every matching day from `from` to `to`, skipping ones that exist or are over. */
  async function generate(sch: any, from: string, to: string, by: string): Promise<number> {
    let n = 0;
    for (let d = from; d <= to && n < 400; d = addDays(d, 1)) {
      if (isoWeekday(d) !== sch.weekday) continue;
      const startsAt = dueAt(d, sch.start_time);
      const endsAt = new Date(Date.parse(startsAt) + sch.duration_min * MIN).toISOString();
      if (Date.parse(endsAt) < nowMs()) continue;
      if ((await ctx.db.query<any>(`SELECT 1 FROM services WHERE schedule_id=$1 AND starts_at=$2`, [sch.id, startsAt])).length) continue;
      await insertService({ org: sch.org_id, branch: sch.branch_id, schedule: sch.id, name: sch.name, startsAt, endsAt, opensAt: new Date(Date.parse(startsAt) - sch.opens_before_min * MIN).toISOString(), closesAt: new Date(Date.parse(startsAt) + sch.closes_after_min * MIN).toISOString(), stream: sch.stream_url, by });
      n++;
    }
    return n;
  }

  function rangeEnd(b: any, w: { manyLower: string }): string {
    const today = eatToday(ctx.clock.now());
    const r = String(b.range ?? '');
    if (r === 'week') return addDays(weekStartOf(today), 6);
    if (r === 'month') return lastDayOfMonth(today);
    if (r === 'year') return lastDayOfYear(today);
    if (r === 'until') {
      const u = String(b.until ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(u) || u < today || u > addDays(today, 3 * 366)) throw new HttpError(400, 'Choose an end date from today to three years ahead', 'bad_date');
      return u;
    }
    throw new HttpError(400, `Choose how far ahead to create the ${w.manyLower}: this week, this month, this year, or until a date`, 'bad_range');
  }

  async function scopeBranches(req: FastifyRequest, perms: Permission[]) {
    let orgId = '';
    const ids = new Set<string>();
    for (const p of perms) {
      const rows = await branchesFor(ctx.db, req.session!.uid, p);
      const org = (req.query as any)?.org as string | undefined;
      for (const r of rows) { if (!orgId || (org && r.orgId === org)) orgId = r.orgId; }
      for (const r of rows) if (r.orgId === orgId) ids.add(r.branchId);
    }
    if (!ids.size) throw new HttpError(403, `missing permission ${perms[0]}`, 'forbidden');
    const all = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM branches WHERE org_id=$1`, [orgId]))[0].n);
    return { orgId, branchIds: [...ids], wholeOrg: ids.size === all };
  }

  const pickBranches = (sc: { branchIds: string[] }, wanted: unknown) => {
    const w = String(wanted ?? '');
    if (w && w !== 'all') { if (!sc.branchIds.includes(w)) throw new HttpError(404, 'not found', 'not_found'); return [w]; }
    return sc.branchIds;
  };

  async function memberByPhone(orgId: string, phone: string) {
    return (await ctx.db.query<any>(`SELECT id, full_name, member_number, branch_id FROM memberships WHERE org_id=$1 AND phone=$2 AND status='active' ORDER BY joined_at LIMIT 1`, [orgId, phone]))[0];
  }

  // ======================= recording who came =======================

  async function record(s: any, a: { kind: 'member' | 'visitor'; membershipId?: string | null; visitorId?: string | null; name: string; mode: 'in_person' | 'online'; via: string; invitedBy?: string | null; location?: string | null; distanceM?: number | null; accuracyM?: number | null; byUser?: string | null; byName?: string | null }) {
    const r = await ctx.db.query<any>(
      `INSERT INTO attendance (id, org_id, branch_id, service_id, kind, membership_id, visitor_id, name, mode, via, invited_by, location, at, by_user, by_name, distance_m, accuracy_m) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT DO NOTHING RETURNING id`,
      [ctx.newId('att'), s.org_id, s.branch_id, s.id, a.kind, a.membershipId ?? null, a.visitorId ?? null, a.name, a.mode, a.via, a.invitedBy ?? null, a.location ?? null, nowIso(), a.byUser ?? null, a.byName ?? null, a.distanceM ?? null, a.accuracyM ?? null],
    );
    return !!r[0];
  }

  async function settingsFor(orgId: string) {
    const r = (await ctx.db.query<any>(`SELECT * FROM attendance_settings WHERE org_id=$1`, [orgId]))[0];
    return r ?? { org_id: orgId, welcome_enabled: true, welcome_template: DEFAULT_WELCOME };
  }

  const renderWelcome = (tpl: string, v: { name: string; church: string; branch: string; service: string }) =>
    tpl.replace(/\{name\}/gi, v.name.split(' ')[0]).replace(/\{church\}/gi, v.church).replace(/\{branch\}/gi, v.branch).replace(/\{service\}/gi, v.service);

  /** A person who gave a name and a number: a member if the number is a member's, otherwise a visitor (L209, L210). */
  async function identify(s: any, p: { name: string; phone: string; mode: 'in_person' | 'online'; via: string; invitedBy?: string | null; byUser?: string | null; byName?: string | null; from?: { ip: string; token: string } }) {
    const m = await memberByPhone(s.org_id, p.phone);
    if (m) {
      const created = await record(s, { kind: 'member', membershipId: m.id, name: m.full_name, mode: p.mode, via: p.via, byUser: p.byUser, byName: p.byName });
      return { kind: 'member' as const, name: m.full_name, first: false, already: !created, returning: false };
    }
    let v = (await ctx.db.query<any>(`SELECT * FROM visitors WHERE org_id=$1 AND phone=$2`, [s.org_id, p.phone]))[0];
    let first = false;
    if (!v) {
      first = true;
      const id = ctx.newId('vis');
      await ctx.db.query(
        `INSERT INTO visitors (id, org_id, branch_id, name, phone, invited_by, first_service_id, first_seen_at, last_seen_at, visits, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,0,$8)`,
        [id, s.org_id, s.branch_id, p.name, p.phone, p.invitedBy ?? null, s.id, nowIso()],
      );
      v = (await ctx.db.query<any>(`SELECT * FROM visitors WHERE id=$1`, [id]))[0];
    }
    const created = await record(s, { kind: 'visitor', visitorId: v.id, name: v.name, mode: p.mode, via: p.via, invitedBy: p.invitedBy ?? v.invited_by, byUser: p.byUser, byName: p.byName });
    if (created) {
      const visits = v.visits + 1;
      const status = visits >= 2 && (v.status === 'new' || v.status === 'contacted') ? 'returning' : v.status;
      await ctx.db.query(`UPDATE visitors SET visits=$2, last_seen_at=$3, status=$4 WHERE id=$1`, [v.id, visits, nowIso(), status]);
    }
    if (first) await welcome(s, v, p.from);
    return { kind: 'visitor' as const, name: v.name, first, already: !created, returning: !first };
  }

  /**
   * LG-04: the church pays for this SMS, so a stranger cannot use it to text an arbitrary number with text of their choosing.
   * Only the first word of the typed name is used, after it is cleaned to letters; a name that does not survive gets no SMS. The number must not
   * belong to a registered person or an opted-out number, gets one welcome per church per 30 days, and public callers are capped per door code and per IP.
   */
  async function welcome(s: any, v: any, from?: { ip: string; token: string }) {
    const set = await settingsFor(s.org_id);
    if (!set.welcome_enabled) { await ctx.db.query(`UPDATE visitors SET welcome_status='off' WHERE id=$1`, [v.id]); return; }
    const skip = async (why: string) => { await ctx.db.query(`UPDATE visitors SET welcome_status=$2 WHERE id=$1`, [v.id, why]); };
    const safe = safeSmsName(v.name);
    if (!safe) return skip('not_sent');
    const L = abuse();
    if ((await ctx.db.query<any>(`SELECT 1 FROM users WHERE phone=$1`, [v.phone]))[0]) return skip('not_sent');
    if ((await ctx.db.query<any>(`SELECT 1 FROM contact_prefs WHERE phone=$1 AND sms_opt_out`, [v.phone]))[0]) return skip('not_sent');
    if (!abuseDisabled()) {
      if (!rateLimit(ctx, `welcome:phone:${s.org_id}:${v.phone}`, { max: 1, windowMs: L.welcomePhoneDays * 86_400_000 }).ok) return skip('not_sent');
      if (from) {
        if (!rateLimit(ctx, `welcome:token:${from.token}`, { max: L.welcomeTokenHour, windowMs: 3600_000 }).ok) return skip('not_sent');
        if (!rateLimit(ctx, `welcome:ip:${from.ip}`, { max: L.welcomeIpHour, windowMs: 3600_000 }).ok) return skip('not_sent');
      }
    }
    const body = renderWelcome(set.welcome_template, { name: safe, church: s.church, branch: s.branch_name, service: s.name });
    const r = await notify(ctx, { orgId: s.org_id, branchId: s.branch_id, phone: v.phone, kind: 'announcement', title: `Welcome to ${s.church}`, body, idemKey: `welcome:${v.id}`, sms: true });
    await ctx.db.query(`UPDATE visitors SET welcome_status=$2, welcome_at=$3 WHERE id=$1`, [v.id, r.sms === 'sent' ? 'sent' : 'not_sent', nowIso()]);
  }

  // ======================= staff: the schedule (L204) =======================

  async function schedulesView(rows: any[]) {
    const out = [];
    for (const r of rows) {
      const n = (await ctx.db.query<any>(`SELECT count(*) FILTER (WHERE starts_at > $2 AND status='scheduled')::int AS upcoming, max(starts_at) AS last FROM services WHERE schedule_id=$1`, [r.id, nowIso()]))[0];
      out.push({ id: r.id, branchId: r.branch_id, branch: r.branch_name, name: r.name, weekday: r.weekday, weekdayName: DAY_NAMES[r.weekday], startTime: r.start_time, durationMin: r.duration_min, streamUrl: r.stream_url, opensBeforeMin: r.opens_before_min, closesAfterMin: r.closes_after_min, active: r.active, upcoming: n.upcoming, lastServiceAt: n.last });
    }
    return out;
  }

  app.get('/attendance/schedules', auth, async (req) => {
    const sc = await scopeBranches(req, ['attendance.manage', 'attendance.view']);
    const rows = await ctx.db.query<any>(`SELECT s.*, b.name AS branch_name FROM service_schedules s JOIN branches b ON b.id=s.branch_id WHERE s.org_id=$1 AND s.branch_id = ANY($2::text[]) ORDER BY b.name, s.weekday, s.start_time`, [sc.orgId, sc.branchIds]);
    const canManage = (await branchesFor(ctx.db, req.session!.uid, 'attendance.manage')).some((b) => b.orgId === sc.orgId);
    const branches = await ctx.db.query<any>(`SELECT id, name FROM branches WHERE org_id=$1 AND id = ANY($2::text[]) ORDER BY name`, [sc.orgId, sc.branchIds]);
    return { schedules: await schedulesView(rows), canManage, branches: branches.map((b) => ({ id: b.id, name: b.name })) };
  });

  function scheduleBody(b: any, existing: any, w: { oneLower: string }) {
    const g = (k: string, d: any) => (b[k] !== undefined ? b[k] : d);
    const name = cap(g('name', existing?.name), 60);
    if (!name) throw new HttpError(400, `Enter a name for the ${w.oneLower}`, 'bad_content');
    const startTime = String(g('startTime', existing?.start_time));
    if (!timeOk(startTime)) throw new HttpError(400, 'Choose a start time', 'bad_time');
    const durationMin = Number(g('durationMin', existing?.duration_min ?? 90));
    if (!Number.isInteger(durationMin) || durationMin < 15 || durationMin > 480) throw new HttpError(400, `A ${w.oneLower} lasts from 15 minutes to 8 hours`, 'bad_duration');
    const opens = Number(g('opensBeforeMin', existing?.opens_before_min ?? 20));
    const closes = Number(g('closesAfterMin', existing?.closes_after_min ?? 120));
    if (!Number.isInteger(opens) || opens < 0 || opens > 240) throw new HttpError(400, 'Check-in can open from 0 to 240 minutes before the start', 'bad_window');
    if (!Number.isInteger(closes) || closes < 15 || closes > 720) throw new HttpError(400, 'Check-in can close from 15 minutes to 12 hours after the start', 'bad_window');
    const stream = g('streamUrl', existing?.stream_url) ? String(g('streamUrl', existing?.stream_url)).trim() : null;
    if (!streamOk(stream)) throw new HttpError(400, 'The live stream link must start with https://', 'bad_stream');
    return { name, startTime, durationMin, opens, closes, stream };
  }

  app.post('/attendance/schedules', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'attendance.manage');
    const b = (req.body ?? {}) as any;
    if (!g.branchIds.includes(String(b.branchId))) throw new HttpError(404, 'not found', 'not_found');
    const f = scheduleBody(b, undefined, await wordsFor(ctx, g.orgId));
    const days: number[] = [...new Set((Array.isArray(b.weekdays) ? b.weekdays : [b.weekday]).map(Number))] as number[];
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) throw new HttpError(400, 'Choose the day or days of the week', 'bad_day');
    const to = rangeEnd(b, await wordsFor(ctx, g.orgId));
    const today = eatToday(ctx.clock.now());
    const ids: string[] = [];
    let generated = 0;
    for (const d of days) {
      const id = ctx.newId('sch');
      await ctx.db.query(`INSERT INTO service_schedules (id, org_id, branch_id, name, weekday, start_time, duration_min, stream_url, opens_before_min, closes_after_min, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, g.orgId, b.branchId, f.name, d, f.startTime, f.durationMin, f.stream, f.opens, f.closes, req.session!.uid, nowIso()]);
      const sch = (await ctx.db.query<any>(`SELECT * FROM service_schedules WHERE id=$1`, [id]))[0];
      generated += await generate(sch, today, to, req.session!.uid);
      ids.push(id);
    }
    await ctx.ledger.audit({ orgId: g.orgId, branchId: b.branchId, actor: req.session!.uid, action: 'attendance.schedule_created', entity: 'service_schedule', entityId: ids[0], summary: `Set up "${f.name}" on ${days.map((d) => DAY_NAMES[d]).join(', ')} at ${f.startTime}, ${generated} services created until ${to}` });
    return { ids, generated, until: to };
  });

  async function scheduleFor(req: FastifyRequest, id: string) {
    const s = (await ctx.db.query<any>(`SELECT * FROM service_schedules WHERE id=$1`, [id]))[0];
    if (!s || !(await inStaffScope(ctx, req, 'attendance.manage', s.org_id, s.branch_id))) throw new HttpError(404, 'not found', 'not_found');
    return s;
  }

  app.patch('/attendance/schedules/:id', auth, async (req) => {
    const s = await scheduleFor(req, (req.params as any).id);
    const b = (req.body ?? {}) as any;
    const f = scheduleBody(b, s, await wordsFor(ctx, s.org_id));
    await ctx.db.query(`UPDATE service_schedules SET name=$2, start_time=$3, duration_min=$4, stream_url=$5, opens_before_min=$6, closes_after_min=$7 WHERE id=$1`, [s.id, f.name, f.startTime, f.durationMin, f.stream, f.opens, f.closes]);
    let updated = 0;
    if (b.applyToFuture) {
      const future = await ctx.db.query<any>(`SELECT id, starts_at FROM services WHERE schedule_id=$1 AND status='scheduled' AND starts_at > $2`, [s.id, nowIso()]);
      for (const x of future) {
        const startsAt = dueAt(eatDateOf(x.starts_at), f.startTime);
        await ctx.db.query(`UPDATE services SET name=$2, starts_at=$3, ends_at=$4, opens_at=$5, closes_at=$6, stream_url=$7, updated_at=$8 WHERE id=$1`, [x.id, f.name, startsAt, new Date(Date.parse(startsAt) + f.durationMin * MIN).toISOString(), new Date(Date.parse(startsAt) - f.opens * MIN).toISOString(), new Date(Date.parse(startsAt) + f.closes * MIN).toISOString(), f.stream, nowIso()]);
        updated++;
      }
    }
    await ctx.ledger.audit({ orgId: s.org_id, branchId: s.branch_id, actor: req.session!.uid, action: 'attendance.schedule_updated', entity: 'service_schedule', entityId: s.id, summary: `Changed the schedule "${f.name}"${b.applyToFuture ? `, applied to ${updated} coming services` : ''}` });
    return { ok: true, updated };
  });

  app.post('/attendance/schedules/:id/extend', auth, async (req) => {
    const s = await scheduleFor(req, (req.params as any).id);
    if (!s.active) throw new HttpError(409, 'This schedule was stopped', 'wrong_state');
    const to = rangeEnd((req.body ?? {}) as any, await wordsFor(ctx, s.org_id));
    const last = (await ctx.db.query<any>(`SELECT max(starts_at) AS last FROM services WHERE schedule_id=$1`, [s.id]))[0].last;
    const today = eatToday(ctx.clock.now());
    const from = last && eatDateOf(last) >= today ? addDays(eatDateOf(last), 1) : today;
    const n = from > to ? 0 : await generate(s, from, to, req.session!.uid);
    await ctx.ledger.audit({ orgId: s.org_id, branchId: s.branch_id, actor: req.session!.uid, action: 'attendance.schedule_extended', entity: 'service_schedule', entityId: s.id, summary: `Extended "${s.name}" until ${to}, ${n} services added` });
    return { generated: n, until: to };
  });

  app.post('/attendance/schedules/:id/stop', auth, async (req) => {
    const s = await scheduleFor(req, (req.params as any).id);
    await ctx.db.query(`UPDATE service_schedules SET active=false WHERE id=$1`, [s.id]);
    const gone = await ctx.db.query<any>(`UPDATE services SET status='cancelled', updated_at=$3 WHERE schedule_id=$1 AND status='scheduled' AND starts_at > $2 AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.service_id=services.id) RETURNING id`, [s.id, nowIso(), nowIso()]);
    await ctx.ledger.audit({ orgId: s.org_id, branchId: s.branch_id, actor: req.session!.uid, action: 'attendance.schedule_stopped', entity: 'service_schedule', entityId: s.id, summary: `Stopped the schedule "${s.name}", ${gone.length} coming services cancelled` });
    return { cancelled: gone.length };
  });

  // ======================= staff: services =======================

  app.get('/attendance/services', auth, async (req) => {
    const sc = await scopeBranches(req, ['attendance.manage', 'attendance.view', 'attendance.checkin']);
    const q = req.query as any;
    const today = eatToday(ctx.clock.now());
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(q.from ?? '')) ? String(q.from) : addDays(today, -1);
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(q.to ?? '')) ? String(q.to) : addDays(today, 30);
    const where = [`s.org_id=$1`, `s.branch_id = ANY($2::text[])`, `s.starts_at >= $3`, `s.starts_at < $4`];
    const params: unknown[] = [sc.orgId, pickBranches(sc, q.branchId), dueAt(from, '00:00'), dueAt(addDays(to, 1), '00:00')];
    if (q.status) { params.push(String(q.status)); where.push(`s.status=$${params.length}`); }
    const rows = await ctx.db.query<any>(`${SELECT_SERVICE} WHERE ${where.join(' AND ')} ORDER BY s.starts_at LIMIT 400`, params);
    const c = await counts(rows.map((r) => r.id));
    return { services: rows.map((r) => serviceView(r, c.get(r.id), true)) };
  });

  app.post('/attendance/services', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'attendance.manage');
    const b = (req.body ?? {}) as any;
    if (!g.branchIds.includes(String(b.branchId))) throw new HttpError(404, 'not found', 'not_found');
    const w = await wordsFor(ctx, g.orgId);
    const name = cap(b.name, 60);
    if (!name) throw new HttpError(400, `Enter a name for the ${w.oneLower}`, 'bad_content');
    const t = Date.parse(String(b.startsAt));
    if (Number.isNaN(t)) throw new HttpError(400, 'Choose a start time', 'bad_date');
    const dur = Number(b.durationMin ?? 90);
    if (!Number.isInteger(dur) || dur < 15 || dur > 480) throw new HttpError(400, `A ${w.oneLower} lasts from 15 minutes to 8 hours`, 'bad_duration');
    const stream = b.streamUrl ? String(b.streamUrl).trim() : null;
    if (!streamOk(stream)) throw new HttpError(400, 'The live stream link must start with https://', 'bad_stream');
    const startsAt = new Date(t).toISOString();
    const id = await insertService({ org: g.orgId, branch: b.branchId, schedule: null, name, startsAt, endsAt: new Date(t + dur * MIN).toISOString(), opensAt: new Date(t - 20 * MIN).toISOString(), closesAt: new Date(t + 120 * MIN).toISOString(), stream, by: req.session!.uid });
    await ctx.ledger.audit({ orgId: g.orgId, branchId: b.branchId, actor: req.session!.uid, action: 'attendance.service_created', entity: 'service', entityId: id, summary: `Added the service "${name}" on ${when(startsAt)}` });
    return { id };
  });

  app.patch('/attendance/services/:id', auth, async (req) => {
    const s = await serviceFor(req, (req.params as any).id, ['attendance.manage']);
    const b = (req.body ?? {}) as any;
    const name = b.name !== undefined ? cap(b.name, 60) : s.name;
    if (!name) throw new HttpError(400, `Enter a name for the ${(await wordsFor(ctx, s.org_id)).oneLower}`, 'bad_content');
    let startsAt = s.starts_at, endsAt = s.ends_at, opens = s.opens_at, closes = s.closes_at;
    if (b.startsAt !== undefined) {
      const t = Date.parse(String(b.startsAt));
      if (Number.isNaN(t)) throw new HttpError(400, 'Choose a start time', 'bad_date');
      const dur = Date.parse(s.ends_at) - Date.parse(s.starts_at);
      const before = Date.parse(s.starts_at) - Date.parse(s.opens_at);
      const after = Date.parse(s.closes_at) - Date.parse(s.starts_at);
      startsAt = new Date(t).toISOString();
      endsAt = new Date(t + (b.durationMin ? Number(b.durationMin) * MIN : dur)).toISOString();
      opens = new Date(t - before).toISOString();
      closes = new Date(t + after).toISOString();
    }
    const status = b.status === 'cancelled' || b.status === 'scheduled' ? b.status : s.status;
    const stream = b.streamUrl !== undefined ? (b.streamUrl ? String(b.streamUrl).trim() : null) : s.stream_url;
    if (!streamOk(stream)) throw new HttpError(400, 'The live stream link must start with https://', 'bad_stream');
    await ctx.db.query(`UPDATE services SET name=$2, starts_at=$3, ends_at=$4, opens_at=$5, closes_at=$6, status=$7, stream_url=$8, updated_at=$9 WHERE id=$1`, [s.id, name, startsAt, endsAt, opens, closes, status, stream, nowIso()]);
    await ctx.ledger.audit({ orgId: s.org_id, branchId: s.branch_id, actor: req.session!.uid, action: status !== s.status ? `attendance.service_${status === 'cancelled' ? 'cancelled' : 'restored'}` : 'attendance.service_updated', entity: 'service', entityId: s.id, summary: status !== s.status ? `${status === 'cancelled' ? 'Cancelled' : 'Restored'} "${s.name}" on ${when(s.starts_at)}` : `Changed "${name}" (${when(startsAt)})` });
    return { ok: true };
  });

  app.put('/attendance/services/:id/reading', auth, async (req) => {
    const s = await serviceFor(req, (req.params as any).id, ['attendance.manage']);
    const b = (req.body ?? {}) as any;
    const title = cap(b.title, 100) || null;
    const ref = cap(b.ref, 80) || null;
    const body = String(b.body ?? '').trim().slice(0, 6000) || null;
    const release = String(b.release ?? 'day_before');
    if (!(RELEASES as readonly string[]).includes(release)) throw new HttpError(400, 'Choose when members will see it', 'bad_release');
    if (!title && !body && !ref) throw new HttpError(400, 'Enter a reading, a theme or some notices', 'bad_content');
    await ctx.db.query(`UPDATE services SET reading_title=$2, reading_ref=$3, reading_body=$4, reading_release=$5, updated_at=$6 WHERE id=$1`, [s.id, title, ref, body, release, nowIso()]);
    await ctx.ledger.audit({ orgId: s.org_id, branchId: s.branch_id, actor: req.session!.uid, action: 'attendance.reading_set', entity: 'service', entityId: s.id, summary: `Added the reading or notices for "${s.name}" on ${when(s.starts_at)}, shown ${RELEASE_LABEL[release].toLowerCase()}` });
    return { ok: true, publishAt: new Date(readingPublishAt(s.starts_at, release)).toISOString() };
  });

  app.put('/attendance/services/:id/headcount', auth, async (req) => {
    const s = await serviceFor(req, (req.params as any).id, ['attendance.checkin', 'attendance.manage']);
    if (s.status === 'cancelled') throw await cancelledErr(s);
    const b = (req.body ?? {}) as any;
    const n = (k: string) => { const v = Number(b[k] ?? 0); if (!Number.isInteger(v) || v < 0 || v > 100000) throw new HttpError(400, 'Enter whole numbers, 0 or more', 'bad_number'); return v; };
    const adults = n('adults'), children = n('children'), visitors = n('visitors');
    await ctx.db.query(`UPDATE services SET headcount_adults=$2, headcount_children=$3, headcount_visitors=$4, headcount_by=$5, headcount_at=$6, updated_at=$6 WHERE id=$1`, [s.id, adults, children, visitors, req.session!.name, nowIso()]);
    await ctx.ledger.audit({ orgId: s.org_id, branchId: s.branch_id, actor: req.session!.uid, action: 'attendance.headcount', entity: 'service', entityId: s.id, summary: `Headcount for "${s.name}" on ${when(s.starts_at)}: ${adults} adults, ${children} children, ${visitors} visitors`, meta: { adults, children, visitors } });
    return { ok: true, total: adults + children + visitors };
  });

  app.put('/attendance/services/:id/online', auth, async (req) => {
    const s = await serviceFor(req, (req.params as any).id, ['attendance.checkin', 'attendance.manage']);
    const v = Number((req.body as any)?.peak);
    if (!Number.isInteger(v) || v < 0 || v > 10_000_000) throw new HttpError(400, 'Enter the highest number of people watching at one time', 'bad_number');
    await ctx.db.query(`UPDATE services SET online_peak=$2, updated_at=$3 WHERE id=$1`, [s.id, v, nowIso()]);
    await ctx.ledger.audit({ orgId: s.org_id, branchId: s.branch_id, actor: req.session!.uid, action: 'attendance.online_peak', entity: 'service', entityId: s.id, summary: `Online peak for "${s.name}": ${v} watching`, meta: { peak: v } });
    return { ok: true };
  });

  // ======================= staff: at the door (L207, L208) =======================

  app.get('/attendance/open', auth, async (req) => {
    const sc = await scopeBranches(req, ['attendance.checkin', 'attendance.manage']);
    const rows = await ctx.db.query<any>(`${SELECT_SERVICE} WHERE s.org_id=$1 AND s.branch_id = ANY($2::text[]) AND s.status='scheduled' AND s.opens_at <= $3 AND s.starts_at > $4 ORDER BY s.starts_at`, [sc.orgId, sc.branchIds, new Date(nowMs() + 2 * HOUR).toISOString(), new Date(nowMs() - USHER_LATE_MS).toISOString()]);
    const c = await counts(rows.map((r) => r.id));
    return { services: rows.map((r) => serviceView(r, c.get(r.id), true)) };
  });

  app.get('/attendance/services/:id/live', auth, async (req) => {
    const s = await serviceFor(req, (req.params as any).id, ['attendance.checkin', 'attendance.manage', 'attendance.view']);
    const c = await counts([s.id]);
    const recent = await ctx.db.query<any>(`SELECT name, kind, via, mode, at FROM attendance WHERE service_id=$1 ORDER BY at DESC LIMIT 12`, [s.id]);
    return { service: serviceView(s, c.get(s.id), true), recent: recent.map((r) => ({ name: r.name, kind: r.kind, via: r.via, mode: r.mode, at: r.at })) };
  });

  app.get('/attendance/services/:id/door', auth, async (req) => {
    const s = await serviceFor(req, (req.params as any).id, ['attendance.checkin', 'attendance.manage']);
    if (s.status === 'cancelled') throw await cancelledErr(s);
    const exp = nowMs() + DOOR_TTL_MS;
    const url = `${ctx.givingUrl}/here/D1.${signData({ k: 'd', s: s.id, e: exp }, 'door')}`;
    return { url, qrSvg: qrSvg(url), refreshSeconds: 45, expiresAt: new Date(exp).toISOString(), service: { id: s.id, name: s.name, church: s.church, branch: s.branch_name, startsAt: s.starts_at } };
  });

  app.post('/attendance/services/:id/scan', auth, async (req) => {
    const s = await serviceFor(req, (req.params as any).id, ['attendance.checkin', 'attendance.manage']);
    if (s.status === 'cancelled') throw await cancelledErr(s);
    const raw = String((req.body as any)?.token ?? '').trim();
    const p = raw.startsWith('A1.') ? verifyData(raw.slice(3), 'qr', nowMs(), { allowExpired: true }) : null;
    if (!p || p.k !== 'a') return { result: 'invalid', message: 'This is not a member code from the app.' };
    if (Number(p.e) < nowMs()) return { result: 'expired', message: 'This code has expired. Ask the member to keep the screen open: it refreshes by itself.' };
    const m = (await ctx.db.query<any>(`SELECT id, full_name, member_number, org_id FROM memberships WHERE id=$1 AND status='active'`, [p.m]))[0];
    if (!m || m.org_id !== s.org_id) return { result: 'wrong_church', message: 'This code belongs to someone from another church.' };
    const created = await record(s, { kind: 'member', membershipId: m.id, name: m.full_name, mode: 'in_person', via: 'usher', byUser: req.session!.uid, byName: req.session!.name });
    return { result: created ? 'ok' : 'already', name: m.full_name, memberNumber: m.member_number, message: created ? 'Welcome.' : `Already counted for this ${(await wordsFor(ctx, s.org_id)).oneLower}.` };
  });

  app.get('/attendance/services/:id/members', auth, async (req) => {
    const s = await serviceFor(req, (req.params as any).id, ['attendance.checkin', 'attendance.manage']);
    const q = cap((req.query as any).q, 40);
    if (q.length < 2) return { members: [] };
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const byPhone = await phoneSearchAllowed(ctx, req, s.org_id, q); // real phone matches only for staff who may reveal it (AZ-08)
    const rows = await ctx.db.query<any>(
      `SELECT m.id, m.full_name, m.member_number, EXISTS (SELECT 1 FROM attendance a WHERE a.service_id=$3 AND a.membership_id=m.id AND a.mode='in_person') AS here
         FROM memberships m WHERE m.org_id=$1 AND m.status='active' AND m.category='adult' AND (m.full_name ILIKE $2 OR m.member_number ILIKE $2${byPhone ? ' OR m.phone LIKE $2' : ''}) ORDER BY m.full_name LIMIT 15`,
      [s.org_id, like, s.id],
    );
    return { members: rows.map((m) => ({ id: m.id, name: m.full_name, memberNumber: m.member_number, here: m.here })) };
  });

  app.post('/attendance/services/:id/mark', auth, async (req) => {
    const s = await serviceFor(req, (req.params as any).id, ['attendance.checkin', 'attendance.manage']);
    if (s.status === 'cancelled') throw await cancelledErr(s);
    const m = (await ctx.db.query<any>(`SELECT id, full_name FROM memberships WHERE id=$1 AND org_id=$2 AND status='active'`, [String((req.body as any)?.membershipId ?? ''), s.org_id]))[0];
    if (!m) throw new HttpError(404, 'not found', 'not_found');
    const created = await record(s, { kind: 'member', membershipId: m.id, name: m.full_name, mode: 'in_person', via: 'usher', byUser: req.session!.uid, byName: req.session!.name });
    return { result: created ? 'ok' : 'already', name: m.full_name };
  });

  function visitorBody(b: any) {
    const name = cap(b.name, 60);
    if (name.length < 2) throw new HttpError(400, 'Enter your name', 'bad_name');
    const phone = normalizePhone(String(b.phone ?? ''));
    if (!phone) throw new HttpError(400, 'Enter a valid Kenyan phone number, for example 0712 345 678', 'bad_phone');
    return { name, phone };
  }

  app.post('/attendance/services/:id/visitor', auth, async (req) => {
    const s = await serviceFor(req, (req.params as any).id, ['attendance.checkin', 'attendance.manage']);
    if (s.status === 'cancelled') throw await cancelledErr(s);
    const b = (req.body ?? {}) as any;
    const v = visitorBody(b);
    const r = await identify(s, { ...v, mode: 'in_person', via: 'usher', byUser: req.session!.uid, byName: req.session!.name });
    return { kind: r.kind, name: r.name, first: r.first, returning: r.returning, already: r.already };
  });

  // ======================= members (L206, L211, L212, L213) =======================

  async function myMemberships(uid: string) {
    return ctx.db.query<any>(`SELECT m.id, m.org_id, m.branch_id, m.full_name FROM memberships m WHERE m.user_id=$1 AND m.status='active' AND m.category='adult' ORDER BY m.joined_at`, [uid]);
  }

  /** Is the phone at the place of this service? A service can have its own place (a crusade ground, a hall for the day); otherwise the branch location is used. */
  async function checkPlace(s: any, geo: { lat: number; lng: number; acc: number } | null) {
    const own = s.geo_lat !== null && s.geo_lat !== undefined;
    const b = own ? { place: s.place_name || s.name, lat: Number(s.geo_lat), lng: Number(s.geo_lng), radius: Number(s.geo_radius_m) } : await (async () => {
      const r = (await ctx.db.query<any>(`SELECT name, geo_lat, geo_lng, geo_radius_m FROM branches WHERE id=$1`, [s.branch_id]))[0];
      return r && r.geo_lat !== null && r.geo_lat !== undefined ? { place: r.name as string, lat: Number(r.geo_lat), lng: Number(r.geo_lng), radius: Number(r.geo_radius_m) } : null;
    })();
    if (!b) return { status: 'unchecked' as const, distanceM: null as number | null, radiusM: null as number | null, place: s.branch_name as string };
    const g = geo && geo.acc <= MAX_ACCURACY_M ? geo : null;
    if (!g) return { status: 'unknown' as const, distanceM: null, radiusM: b.radius, place: b.place };
    const d = Math.round(metresBetween(g, { lat: b.lat, lng: b.lng }));
    return { status: (d - Math.min(g.acc, 100) > b.radius ? 'away' : 'ok') as 'away' | 'ok', distanceM: d, radiusM: b.radius, place: b.place };
  }

  app.get('/me/services', auth, async (req) => {
    const ms = await myMemberships(req.session!.uid);
    if (!ms.length) return { services: [] };
    const rows = await ctx.db.query<any>(
      `${SELECT_SERVICE} WHERE s.branch_id = ANY($1::text[]) AND s.status='scheduled' AND s.ends_at >= $2 AND s.starts_at <= $3 ORDER BY s.starts_at LIMIT 30`,
      [[...new Set(ms.map((m) => m.branch_id))], new Date(nowMs() - 2 * HOUR).toISOString(), new Date(nowMs() + 8 * DAY).toISOString()],
    );
    const mine = new Map<string, any>();
    for (const a of await ctx.db.query<any>(`SELECT service_id, mode FROM attendance WHERE membership_id = ANY($1::text[]) AND service_id = ANY($2::text[])`, [ms.map((m) => m.id), rows.map((r) => r.id)])) {
      const e = mine.get(a.service_id) ?? { inPerson: false, online: false };
      if (a.mode === 'in_person') e.inPerson = true; else e.online = true;
      mine.set(a.service_id, e);
    }
    const out = rows.map((s) => {
      const v = serviceView(s, null, false);
      const m = ms.find((x) => x.branch_id === s.branch_id)!;
      const mineHere = mine.get(s.id);
      return { ...v, reading: readingOf(s, mineHere?.inPerson || mineHere?.online ? 'open' : 'locked'), membershipId: m.id, counts: undefined, headcount: undefined, coverage: undefined, mine: mine.get(s.id) ?? { inPerson: false, online: false }, branchLiveLink: s.stream_url ? branchLiveLink(s) : null };
    });
    return { services: out };
  });

  /** A member checks in, at the church or online. At the church, where the branch has a location set, the phone must be inside it (L206). */
  app.post('/me/services/:id/check-in', auth, async (req) => {
    const s = await serviceRow((req.params as any).id);
    const b = (req.body ?? {}) as any;
    const m = (await myMemberships(req.session!.uid)).find((x) => x.org_id === s.org_id && x.branch_id === s.branch_id) ?? (await myMemberships(req.session!.uid)).find((x) => x.org_id === s.org_id);
    if (!m) throw new HttpError(404, 'not found', 'not_found');
    const st = state(s);
    if (st === 'cancelled') throw await cancelledErr(s);
    if (st === 'before') throw new HttpError(409, `Check-in opens at ${when(s.opens_at)}`, 'not_open');
    if (st === 'closed') throw new HttpError(409, `Check-in for this ${(await wordsFor(ctx, s.org_id)).oneLower} has closed`, 'closed');
    const mode = b.mode === 'online' ? 'online' : 'in_person';
    let location: string | null = null;
    let distanceM: number | null = null;
    let accuracyM: number | null = null;
    if (mode === 'in_person') {
      const geo = parseGeo(b.geo);
      const loc = await checkPlace(s, geo);
      location = loc.status;
      distanceM = loc.distanceM;
      accuracyM = geo?.acc ?? null;
      if (loc.status === 'away' || loc.status === 'unknown') {
        await ctx.db.query(`INSERT INTO attendance_blocked (id, org_id, branch_id, service_id, membership_id, name, status, distance_m, accuracy_m, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [ctx.newId('abl'), s.org_id, s.branch_id, s.id, m.id, m.full_name, loc.status, distanceM, accuracyM, nowIso()]);
      }
      if (loc.status === 'away') throw new HttpError(409, `You are about ${loc.distanceM! >= 1000 ? `${(loc.distanceM! / 1000).toFixed(1)} km` : `${loc.distanceM} m`} from ${loc.place}. Check in when you are there, or choose "I am watching online".`, 'away_from_branch');
      if (loc.status === 'unknown') throw new HttpError(409, "We can't tell where you are. Allow location for the app, or ask an usher to scan your code.", 'location_needed');
    }
    const created = await record(s, { kind: 'member', membershipId: m.id, name: m.full_name, mode, via: 'app', location, distanceM, accuracyM });
    return { ok: true, already: !created, mode, reading: readingOf(s, 'open') };
  });

  /** "Watch live": a member is counted online and sent to the stream. */
  app.post('/me/services/:id/watch', auth, async (req) => {
    const s = await serviceRow((req.params as any).id);
    const m = (await myMemberships(req.session!.uid)).find((x) => x.org_id === s.org_id);
    if (!m) throw new HttpError(404, 'not found', 'not_found');
    if (!s.stream_url) throw new HttpError(409, `There is no live stream for this ${(await wordsFor(ctx, s.org_id)).oneLower}`, 'no_stream');
    if (state(s) === 'open') await record(s, { kind: 'member', membershipId: m.id, name: m.full_name, mode: 'online', via: 'app' });
    return { url: s.stream_url };
  });

  app.get('/me/services/:id/invite', auth, async (req) => {
    const s = await serviceRow((req.params as any).id);
    const m = (await myMemberships(req.session!.uid)).find((x) => x.org_id === s.org_id);
    if (!m) throw new HttpError(404, 'not found', 'not_found');
    if (s.status === 'cancelled') throw await cancelledErr(s);
    const exp = Math.max(Date.parse(s.closes_at), nowMs()) + 6 * HOUR;
    const code = `I1.${signData({ k: 'i', s: s.id, m: m.id, e: exp }, 'invite')}`;
    const here = `${ctx.givingUrl}/here/${code}`;
    const live = s.stream_url ? `${ctx.givingUrl}/live/${s.code}?ref=${encodeURIComponent(code)}` : null;
    const invited = Number((await ctx.db.query<any>(`SELECT count(DISTINCT visitor_id)::int AS n FROM attendance WHERE invited_by=$1 AND kind='visitor'`, [m.id]))[0].n);
    return { link: here, liveLink: live, qrSvg: qrSvg(here), invited, message: `Join us for ${s.name} at ${s.church}, ${when(s.starts_at)}. ${here}` };
  });

  app.post('/me/attendance/qr', auth, async (req) => {
    const m = (await myMemberships(req.session!.uid)).find((x) => x.id === String((req.body as any)?.membershipId ?? '')) ?? (await myMemberships(req.session!.uid))[0];
    if (!m) throw new HttpError(404, 'not found', 'not_found');
    const exp = nowMs() + MEMBER_CODE_TTL_MS;
    const token = `A1.${signData({ k: 'a', m: m.id, o: m.org_id, e: exp }, 'qr')}`;
    return { token, qrSvg: qrSvg(token), expiresAt: new Date(exp).toISOString(), refreshSeconds: 30, name: m.full_name };
  });

  app.get('/me/attendance', auth, async (req) => {
    const ms = await myMemberships(req.session!.uid);
    if (!ms.length) return { recent: [], weeks: 0, invited: 0 };
    const ids = ms.map((m) => m.id);
    const recent = await ctx.db.query<any>(`SELECT s.name, s.starts_at, a.mode FROM attendance a JOIN services s ON s.id=a.service_id WHERE a.membership_id = ANY($1::text[]) ORDER BY s.starts_at DESC LIMIT 12`, [ids]);
    const since = new Date(nowMs() - 8 * 7 * DAY).toISOString();
    const rows = await ctx.db.query<any>(`SELECT s.starts_at FROM attendance a JOIN services s ON s.id=a.service_id WHERE a.membership_id = ANY($1::text[]) AND s.starts_at >= $2`, [ids, since]);
    const weeks = new Set(rows.map((r) => weekStartOf(eatDateOf(r.starts_at)))).size;
    const invited = Number((await ctx.db.query<any>(`SELECT count(DISTINCT visitor_id)::int AS n FROM attendance WHERE invited_by = ANY($1::text[]) AND kind='visitor'`, [ids]))[0].n);
    return { recent: recent.map((r) => ({ name: r.name, startsAt: r.starts_at, mode: r.mode })), weeks, invited };
  });

  // ======================= public: the door code, invitations and the live link (L208, L212, L213) =======================

  function readToken(raw: string) {
    const kind = raw.startsWith('D1.') ? 'door' : raw.startsWith('I1.') ? 'invite' : null;
    const p = kind ? verifyData(raw.slice(3), kind === 'door' ? 'door' : 'invite', nowMs(), { allowExpired: true }) : null;
    if (!kind || !p || (p.k !== 'd' && p.k !== 'i')) throw new HttpError(404, 'This code is not valid', 'bad_code');
    if (Number(p.e) < nowMs()) throw new HttpError(410, 'This code has expired. Scan the code at the door again.', 'expired');
    return { kind, p };
  }

  async function publicService(s: any, extra: Record<string, unknown> = {}) {
    const st = state(s);
    return { words: await wordsFor(ctx, s.org_id), branding: await brandingInfo(ctx, s.org_id), name: s.name, church: s.church, branch: s.branch_name, startsAt: s.starts_at, state: st, opensAt: s.opens_at, closesAt: s.closes_at, hasStream: !!s.stream_url, reading: readingOf(s, false), ...extra };
  }

  app.get('/public/here/:token', async (req) => {
    const { kind, p } = readToken((req.params as any).token);
    const s = await serviceRow(String(p.s));
    const inviter = kind === 'invite' ? (await ctx.db.query<any>(`SELECT full_name FROM memberships WHERE id=$1`, [p.m]))[0]?.full_name : null;
    return publicService(s, { invitedBy: inviter ? inviter.split(' ')[0] : null });
  });

  app.post('/public/here/:token', async (req) => {
    windowHit(ctx, `checkin:token:${String((req.params as any).token).slice(0, 80)}`, 600, 10 * MIN, 'Too many check-ins on this code just now. Please wait a minute and try again.');
    const { kind, p } = readToken((req.params as any).token);
    const s = await serviceRow(String(p.s));
    const st = state(s);
    if (st === 'cancelled') throw await cancelledErr(s);
    if (st === 'before') throw new HttpError(409, `Check-in opens at ${when(s.opens_at)}`, 'not_open');
    if (st === 'closed') throw new HttpError(409, `Check-in for this ${(await wordsFor(ctx, s.org_id)).oneLower} has closed`, 'closed');
    const b = (req.body ?? {}) as any;
    const v = visitorBody(b);
    const mode = b.mode === 'online' && s.stream_url ? 'online' : 'in_person';
    const r = await identify(s, { ...v, mode, via: kind === 'invite' ? 'invite' : 'door', invitedBy: kind === 'invite' ? String(p.m) : null, from: { ip: clientIp(req), token: String((req.params as any).token).slice(0, 80) } });
    return { status: r.already ? 'already' : 'recorded', kind: r.kind, name: r.name.split(' ')[0], first: r.first, returning: r.returning, reading: readingOf(s, 'open'), streamUrl: mode === 'online' ? s.stream_url : null };
  });

  async function liveService(code: string) {
    const c = String(code ?? '').trim();
    if (c.toLowerCase().startsWith('b-')) {
      const now = nowIso();
      const bOrg = (await ctx.db.query<any>(`SELECT org_id FROM branches WHERE code=$1`, [c.slice(2).toUpperCase()]))[0]?.org_id;
      const open = (await ctx.db.query<any>(`${SELECT_SERVICE} WHERE b.code=$1 AND s.status='scheduled' AND s.stream_url IS NOT NULL AND s.opens_at <= $2 AND s.closes_at >= $2 ORDER BY s.starts_at LIMIT 1`, [c.slice(2).toUpperCase(), now]))[0];
      const next = open ?? (await ctx.db.query<any>(`${SELECT_SERVICE} WHERE b.code=$1 AND s.status='scheduled' AND s.stream_url IS NOT NULL AND s.starts_at > $2 ORDER BY s.starts_at LIMIT 1`, [c.slice(2).toUpperCase(), now]))[0];
      if (!next) throw new HttpError(404, `There is no live ${(await wordsFor(ctx, bOrg)).oneLower} coming up for this church yet`, 'no_service');
      return next;
    }
    const s = (await ctx.db.query<any>(`${SELECT_SERVICE} WHERE s.code=$1`, [c.toUpperCase()]))[0];
    if (!s) throw new HttpError(404, 'We could not find that service', 'not_found');
    return s;
  }

  app.get('/public/live/:code', async (req) => {
    const s = await liveService((req.params as any).code);
    return publicService(s, { code: s.code, live: state(s) === 'open', startsInMin: Math.max(0, Math.round((Date.parse(s.starts_at) - nowMs()) / MIN)) });
  });

  app.post('/public/live/:code', async (req) => {
    windowHit(ctx, `checkin:live:${String((req.params as any).code).slice(0, 40)}`, 600, 10 * MIN, 'Too many check-ins on this link just now. Please wait a minute and try again.');
    const s = await liveService((req.params as any).code);
    if (s.status === 'cancelled') throw await cancelledErr(s);
    if (!s.stream_url) throw new HttpError(409, 'The live stream link is not ready yet. Please try again a little later.', 'no_stream');
    const b = (req.body ?? {}) as any;
    const v = visitorBody(b);
    let invitedBy: string | null = null;
    if (b.ref && String(b.ref).startsWith('I1.')) { const p = verifyData(String(b.ref).slice(3), 'invite', nowMs(), { allowExpired: true }); if (p && p.k === 'i') invitedBy = String(p.m); }
    // Counted while the service is on. Before or after, the person is still sent to the stream.
    let counted = false;
    let first = false;
    if (state(s) === 'open') { const r = await identify(s, { ...v, mode: 'online', via: 'live_link', invitedBy, from: { ip: clientIp(req), token: `live:${s.id}` } }); counted = !r.already; first = r.first; }
    return { url: s.stream_url, counted, first, name: v.name.split(' ')[0] };
  });

  // ======================= visitors (L209, L210) =======================

  async function syncVisitors(orgId: string) {
    const rows = await ctx.db.query<any>(`SELECT v.id, m.id AS mid FROM visitors v JOIN memberships m ON m.org_id=v.org_id AND m.phone=v.phone AND m.status='active' WHERE v.org_id=$1 AND v.status <> 'member'`, [orgId]);
    for (const r of rows) await ctx.db.query(`UPDATE visitors SET status='member', membership_id=$2 WHERE id=$1`, [r.id, r.mid]);
  }

  app.get('/attendance/visitors', auth, async (req) => {
    const sc = await scopeBranches(req, ['attendance.view']);
    await syncVisitors(sc.orgId);
    const q = req.query as any;
    const where = [`v.org_id=$1`, `v.branch_id = ANY($2::text[])`];
    const params: unknown[] = [sc.orgId, pickBranches(sc, q.branchId)];
    // Full phone numbers (and phone search) only for staff who hold members.reveal over these branches; the rest see them masked (AZ-16).
    const revealHeld = new Set((await branchesFor(ctx.db, req.session!.uid, 'members.reveal')).filter((r) => r.orgId === sc.orgId).map((r) => r.branchId));
    const revealPhones = (params[1] as string[]).length > 0 && (params[1] as string[]).every((b) => revealHeld.has(b));
    if (q.status) { params.push(String(q.status)); where.push(`v.status=$${params.length}`); }
    if (q.q) { params.push(`%${String(q.q).replace(/[\\%_]/g, (c) => '\\' + c)}%`); where.push(`(v.name ILIKE $${params.length}${revealPhones && (await phoneSearchAllowed(ctx, req, sc.orgId, String(q.q), pickBranches(sc, q.branchId))) ? ` OR v.phone LIKE $${params.length}` : ''})`); }
    const rows = await ctx.db.query<any>(
      `SELECT v.*, b.name AS branch_name, s.name AS service_name, s.starts_at AS service_at, inv.full_name AS invited_name FROM visitors v JOIN branches b ON b.id=v.branch_id LEFT JOIN services s ON s.id=v.first_service_id LEFT JOIN memberships inv ON inv.id=v.invited_by
        WHERE ${where.join(' AND ')} ORDER BY (v.status='new') DESC, v.first_seen_at DESC LIMIT 500`,
      params,
    );
    if (revealPhones && rows.length) await ctx.ledger.audit({ orgId: sc.orgId, actor: req.session!.uid, action: 'access.reveal', category: 'access', entity: 'visitor_list', entityId: sc.orgId, summary: `Saw the full phone numbers of ${rows.length} visitors${q.csv ? ' (download)' : ''}`, meta: { visitors: rows.length } });
    const view = rows.map((v) => ({ id: v.id, name: v.name, phone: revealPhones ? `0${String(v.phone).slice(3)}` : maskPhone(v.phone), branch: v.branch_name, firstService: v.service_name, firstSeenAt: v.first_seen_at, lastSeenAt: v.last_seen_at, visits: v.visits, status: v.status, welcome: v.welcome_status, invitedBy: v.invited_name, contactedBy: v.contacted_by_name, contactedAt: v.contacted_at, note: v.note }));
    if (q.csv) return csv(view.map((v) => ({ Name: v.name, Phone: v.phone, Branch: v.branch, 'First came': v.firstService ?? '', Date: v.firstSeenAt, Visits: v.visits, Status: v.status, 'Invited by': v.invitedBy ?? '', 'Welcome SMS': v.welcome, Note: v.note ?? '' })));
    return { visitors: view, summary: { new: view.filter((v) => v.status === 'new').length, returning: view.filter((v) => v.status === 'returning').length, members: view.filter((v) => v.status === 'member').length } };
  });

  app.post('/attendance/visitors/:id', auth, async (req) => {
    const v = (await ctx.db.query<any>(`SELECT * FROM visitors WHERE id=$1`, [(req.params as any).id]))[0];
    if (!v || !(await inStaffScope(ctx, req, 'attendance.view', v.org_id, v.branch_id))) throw new HttpError(404, 'not found', 'not_found');
    const b = (req.body ?? {}) as any;
    const status = b.status === undefined ? v.status : String(b.status);
    if (!['new', 'contacted', 'returning', 'not_interested'].includes(status) || v.status === 'member') throw new HttpError(400, 'Choose contacted, not interested or new', 'bad_status');
    const note = b.note !== undefined ? cap(b.note, 400) || null : v.note;
    const contacted = status === 'contacted' && v.status !== 'contacted';
    await ctx.db.query(`UPDATE visitors SET status=$2, note=$3, contacted_by=CASE WHEN $4 THEN $5 ELSE contacted_by END, contacted_by_name=CASE WHEN $4 THEN $6 ELSE contacted_by_name END, contacted_at=CASE WHEN $4 THEN $7 ELSE contacted_at END WHERE id=$1`, [v.id, status, note, contacted, req.session!.uid, req.session!.name, nowIso()]);
    await ctx.ledger.audit({ orgId: v.org_id, branchId: v.branch_id, actor: req.session!.uid, action: 'attendance.visitor_followup', entity: 'visitor', entityId: v.id, summary: `${status === v.status ? 'Updated the note for' : `Marked ${status.replace('_', ' ')}:`} visitor ${v.name}` });
    return { ok: true };
  });

  // ======================= settings, summary and the Monday report (L210, L214, L215) =======================

  app.get('/attendance/settings', auth, async (req) => {
    const sc = await scopeBranches(req, ['attendance.manage', 'attendance.view']);
    const s = await settingsFor(sc.orgId);
    const church = (await ctx.db.query<any>(`SELECT name FROM organisations WHERE id=$1`, [sc.orgId]))[0].name;
    return { welcomeEnabled: s.welcome_enabled, welcomeTemplate: s.welcome_template, defaultTemplate: DEFAULT_WELCOME, preview: renderWelcome(s.welcome_template, { name: 'Peter Mwangi', church, branch: 'Main branch', service: 'Sunday Service' }), canManage: (await branchesFor(ctx.db, req.session!.uid, 'attendance.manage')).some((b) => b.orgId === sc.orgId) };
  });

  app.put('/attendance/settings', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'attendance.manage');
    const b = (req.body ?? {}) as any;
    const enabled = b.welcomeEnabled !== false;
    const tpl = String(b.welcomeTemplate ?? DEFAULT_WELCOME).trim();
    if (enabled && (tpl.length < 10 || tpl.length > 320)) throw new HttpError(400, 'The welcome message must be between 10 and 320 characters', 'bad_template');
    await ctx.db.query(`INSERT INTO attendance_settings (org_id, welcome_enabled, welcome_template, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (org_id) DO UPDATE SET welcome_enabled=$2, welcome_template=$3, updated_by=$4, updated_at=$5`, [g.orgId, enabled, tpl || DEFAULT_WELCOME, req.session!.uid, nowIso()]);
    await ctx.ledger.audit({ orgId: g.orgId, actor: req.session!.uid, action: 'attendance.welcome_settings', entity: 'organisation', entityId: g.orgId, summary: enabled ? 'Changed the welcome message for first-time visitors' : 'Switched off the welcome message for first-time visitors' });
    return { ok: true };
  });

  app.get('/attendance/prefs', auth, async (req) => {
    await scopeBranches(req, ['attendance.view']);
    const p = (await ctx.db.query<any>(`SELECT weekly_email FROM attendance_prefs WHERE user_id=$1`, [req.session!.uid]))[0];
    return { weeklyEmail: p ? p.weekly_email : true };
  });
  app.put('/attendance/prefs', auth, async (req) => {
    await scopeBranches(req, ['attendance.view']);
    const on = (req.body as any)?.weeklyEmail !== false;
    await ctx.db.query(`INSERT INTO attendance_prefs (user_id, weekly_email) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET weekly_email=$2`, [req.session!.uid, on]);
    return { weeklyEmail: on };
  });

  const lastFullWeek = () => addDays(weekStartOf(eatToday(ctx.clock.now())), -7);

  app.get('/attendance/summary', auth, async (req) => {
    const sc = await scopeBranches(req, ['attendance.view']);
    const q = req.query as any;
    const branchIds = pickBranches(sc, q.branchId);
    const weeksN = Math.min(26, Math.max(2, Number(q.weeks) || 8));
    const thisWeek = weekStartOf(eatToday(ctx.clock.now()));
    const weeks = [];
    for (let i = weeksN - 1; i >= 0; i--) {
      const ws = addDays(thisWeek, -7 * i);
      weeks.push({ weekStart: ws, ...(await weekTotals(sc.orgId, branchIds, ws)) });
    }
    const report = await weekReport(sc.orgId, branchIds, lastFullWeek());
    return { weeks, lastWeek: report };
  });

  app.get('/attendance/care', auth, async (req) => {
    const sc = await scopeBranches(req, ['attendance.view']);
    return { members: await careList(sc.orgId, pickBranches(sc, (req.query as any).branchId), lastFullWeek()), asOfWeek: lastFullWeek() };
  });

  // ---- numbers ----

  const bounds = (ws: string) => [dueAt(ws, '00:00'), dueAt(addDays(ws, 7), '00:00')] as const;

  async function weekTotals(orgId: string, branchIds: string[], ws: string) {
    const [from, to] = bounds(ws);
    const r = (await ctx.db.query<any>(
      `SELECT count(DISTINCT a.membership_id) FILTER (WHERE a.kind='member' AND a.mode='in_person')::int AS members,
              count(DISTINCT a.visitor_id) FILTER (WHERE a.kind='visitor' AND a.mode='in_person' AND v.first_seen_at >= $3 AND v.first_seen_at < $4)::int AS first_visitors,
              count(DISTINCT a.visitor_id) FILTER (WHERE a.kind='visitor' AND a.mode='in_person' AND NOT (v.first_seen_at >= $3 AND v.first_seen_at < $4))::int AS returning_visitors,
              count(DISTINCT COALESCE(a.membership_id, a.visitor_id)) FILTER (WHERE a.mode='online')::int AS online
         FROM attendance a JOIN services s ON s.id=a.service_id LEFT JOIN visitors v ON v.id=a.visitor_id
        WHERE s.org_id=$1 AND s.branch_id = ANY($2::text[]) AND s.status='scheduled' AND s.starts_at >= $3 AND s.starts_at < $4`,
      [orgId, branchIds, from, to],
    ))[0];
    const hc = (await ctx.db.query<any>(`SELECT count(*)::int AS services, sum(COALESCE(headcount_adults,0)+COALESCE(headcount_children,0)+COALESCE(headcount_visitors,0)) FILTER (WHERE headcount_adults IS NOT NULL OR headcount_children IS NOT NULL OR headcount_visitors IS NOT NULL) AS headcount FROM services WHERE org_id=$1 AND branch_id = ANY($2::text[]) AND status='scheduled' AND starts_at >= $3 AND starts_at < $4`, [orgId, branchIds, from, to]))[0];
    return { services: hc.services, members: r.members, firstVisitors: r.first_visitors, returningVisitors: r.returning_visitors, online: r.online, headcount: hc.headcount === null ? null : Number(hc.headcount) };
  }

  async function careList(orgId: string, branchIds: string[], reportWeek: string) {
    const earlierFrom = dueAt(addDays(reportWeek, -7 * 8), '00:00');
    const recentFrom = dueAt(addDays(reportWeek, -7 * 2), '00:00');
    const end = dueAt(addDays(reportWeek, 7), '00:00');
    const rows = await ctx.db.query<any>(
      `SELECT a.membership_id, s.starts_at, m.full_name, m.member_number, m.branch_id, b.name AS branch FROM attendance a JOIN services s ON s.id=a.service_id JOIN memberships m ON m.id=a.membership_id JOIN branches b ON b.id=m.branch_id
        WHERE a.kind='member' AND s.org_id=$1 AND m.branch_id = ANY($2::text[]) AND m.status='active' AND s.starts_at >= $3 AND s.starts_at < $4`,
      [orgId, branchIds, earlierFrom, end],
    );
    const by = new Map<string, { name: string; number: string; branch: string; earlier: Set<string>; recent: boolean; last: string }>();
    for (const r of rows) {
      const e = by.get(r.membership_id) ?? { name: r.full_name, number: r.member_number, branch: r.branch, earlier: new Set<string>(), recent: false, last: '' };
      if (r.starts_at >= recentFrom) e.recent = true; else e.earlier.add(weekStartOf(eatDateOf(r.starts_at)));
      if (r.starts_at > e.last) e.last = r.starts_at;
      by.set(r.membership_id, e);
    }
    return [...by.entries()].filter(([, e]) => !e.recent && e.earlier.size >= 3).map(([id, e]) => ({ id, name: e.name, memberNumber: e.number, branch: e.branch, lastSeen: e.last, weeksBefore: e.earlier.size })).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }

  async function weekReport(orgId: string, branchIds: string[], ws: string): Promise<WeekReport> {
    const [from, to] = bounds(ws);
    const svc = await ctx.db.query<any>(
      `SELECT s.id, s.name, s.starts_at, s.headcount_adults, s.headcount_children, s.headcount_visitors, s.online_peak, b.name AS branch,
         count(a.id) FILTER (WHERE a.mode='in_person' AND a.kind='member')::int AS members,
         count(a.id) FILTER (WHERE a.mode='in_person' AND a.kind='visitor' AND v.first_service_id = s.id)::int AS first_visitors,
         count(a.id) FILTER (WHERE a.mode='in_person' AND a.kind='visitor' AND v.first_service_id IS DISTINCT FROM s.id)::int AS returning_visitors,
         count(a.id) FILTER (WHERE a.mode='online')::int AS online
       FROM services s JOIN branches b ON b.id=s.branch_id LEFT JOIN attendance a ON a.service_id=s.id LEFT JOIN visitors v ON v.id=a.visitor_id
       WHERE s.org_id=$1 AND s.branch_id = ANY($2::text[]) AND s.status='scheduled' AND s.starts_at >= $3 AND s.starts_at < $4 GROUP BY s.id, b.name ORDER BY s.starts_at, b.name`,
      [orgId, branchIds, from, to],
    );
    const services = svc.map((s) => {
      const hc = s.headcount_adults === null && s.headcount_children === null && s.headcount_visitors === null ? null : (s.headcount_adults ?? 0) + (s.headcount_children ?? 0) + (s.headcount_visitors ?? 0);
      const inPerson = s.members + s.first_visitors + s.returning_visitors;
      return { id: s.id, name: s.name, branch: s.branch, startsAt: s.starts_at, members: s.members, firstVisitors: s.first_visitors, returningVisitors: s.returning_visitors, online: s.online, onlinePeak: s.online_peak, headcount: hc, coverage: hc && hc > 0 ? Math.round((inPerson / hc) * 100) : null };
    });
    const totals = await weekTotals(orgId, branchIds, ws);
    const previous = await weekTotals(orgId, branchIds, addDays(ws, -7));
    const four = [] as Awaited<ReturnType<typeof weekTotals>>[];
    for (let i = 1; i <= 4; i++) four.push(await weekTotals(orgId, branchIds, addDays(ws, -7 * i)));
    const avg = (f: (t: (typeof four)[number]) => number | null) => { const v = four.map(f).filter((x): x is number => x !== null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : 0; };
    const average4 = { services: avg((t) => t.services), members: avg((t) => t.members), firstVisitors: avg((t) => t.firstVisitors), returningVisitors: avg((t) => t.returningVisitors), online: avg((t) => t.online), headcount: four.some((t) => t.headcount !== null) ? avg((t) => t.headcount) : null };
    const first = await ctx.db.query<any>(`SELECT v.name, b.name AS branch, s.name AS service FROM visitors v JOIN branches b ON b.id=v.branch_id LEFT JOIN services s ON s.id=v.first_service_id WHERE v.org_id=$1 AND v.branch_id = ANY($2::text[]) AND v.first_seen_at >= $3 AND v.first_seen_at < $4 ORDER BY v.first_seen_at`, [orgId, branchIds, from, to]);
    const events = await ctx.db.query<any>(
      `SELECT e.title, e.ticketed, e.starts_at, (SELECT count(*)::int FROM tickets t WHERE t.event_id=e.id AND t.status IN ('valid','used')) AS sold, (SELECT count(*)::int FROM tickets t WHERE t.event_id=e.id AND t.status='used') AS scanned,
              (SELECT COALESCE(SUM(1 + r.guests),0)::int FROM event_rsvps r WHERE r.event_id=e.id AND r.response='going') AS going
         FROM events e WHERE e.org_id=$1 AND (e.branch_id IS NULL OR e.branch_id = ANY($2::text[])) AND e.status='scheduled' AND e.starts_at >= $3 AND e.starts_at < $4 ORDER BY e.starts_at`,
      [orgId, branchIds, from, to],
    );
    const kids = await ctx.db.query<any>(`SELECT s.class_name, count(k.id)::int AS n FROM kids_checkins k JOIN kids_sessions s ON s.id=k.session_id WHERE s.org_id=$1 AND s.branch_id = ANY($2::text[]) AND k.in_at >= $3 AND k.in_at < $4 GROUP BY s.class_name ORDER BY s.class_name`, [orgId, branchIds, from, to]);
    const withHc = services.filter((s) => s.headcount && s.headcount > 0);
    const coverage = withHc.length ? Math.round((withHc.reduce((a, s) => a + s.members + s.firstVisitors + s.returningVisitors, 0) / withHc.reduce((a, s) => a + (s.headcount ?? 0), 0)) * 100) : null;
    return {
      weekStart: ws, weekEnd: addDays(ws, 6), services, totals, previous, average4, coverage,
      firstVisitors: first.map((f) => ({ name: f.name, branch: f.branch, service: f.service ?? '' })),
      care: await careList(orgId, branchIds, ws),
      events: events.map((e) => ({ title: e.title, startsAt: e.starts_at, kind: e.ticketed ? 'tickets' : 'replies', sold: e.ticketed ? e.sold : null, scanned: e.ticketed ? e.scanned : null, going: e.ticketed ? null : e.going })),
      kids: kids.map((k) => ({ className: k.class_name, count: k.n })),
    };
  }

  // ---- the email ----

  const arrow = (now: number | null, then: number | null) => (now === null || then === null ? '' : now > then ? ` (up ${now - then})` : now < then ? ` (down ${then - now})` : ' (same)');

  function renderReport(church: string, scope: string, r: WeekReport, branches: { name: string; r: WeekReport }[], w: { one: string; oneLower: string; manyLower: string }) {
    const t = r.totals;
    const range = `${dayText(r.weekStart)} to ${dayText(r.weekEnd)}`;
    const subject = `${church} attendance, ${range}`;
    const lines: string[] = [`${church}: attendance for the week ${range}${scope ? ` (${scope})` : ''}`, ''];
    lines.push(`Members who came: ${t.members}${arrow(t.members, r.previous.members)}. Usual: ${r.average4.members}.`);
    lines.push(`First-time visitors: ${t.firstVisitors}${arrow(t.firstVisitors, r.previous.firstVisitors)}. Returning visitors: ${t.returningVisitors}${arrow(t.returningVisitors, r.previous.returningVisitors)}.`);
    lines.push(`Watching online: ${t.online}${arrow(t.online, r.previous.online)}.`);
    if (t.headcount !== null) lines.push(`Headcount across ${w.manyLower}: ${t.headcount}${r.coverage !== null ? `. Check-ins cover ${r.coverage}% of the headcount, so the member and visitor numbers are a sample.` : ''}`);
    lines.push('', `Each ${w.oneLower}:`);
    for (const s of r.services) lines.push(`- ${s.name}, ${s.branch}, ${when(s.startsAt)}: ${s.members} members, ${s.firstVisitors} first-time and ${s.returningVisitors} returning visitors, ${s.online} online${s.onlinePeak !== null ? ` (peak ${s.onlinePeak})` : ''}${s.headcount !== null ? `, headcount ${s.headcount}${s.coverage !== null ? ` (${s.coverage}% checked in)` : ''}` : ''}`);
    if (!r.services.length) lines.push(`- No ${w.manyLower} were held this week.`);
    if (r.firstVisitors.length) { lines.push('', `First-time visitors to follow up (${r.firstVisitors.length}):`); for (const v of r.firstVisitors.slice(0, 40)) lines.push(`- ${v.name}, ${v.branch}${v.service ? `, ${v.service}` : ''}`); }
    if (r.care.length) { lines.push('', `Regular members who have not come for three weeks (${r.care.length}):`); for (const m of r.care.slice(0, 40)) lines.push(`- ${m.name} (${m.memberNumber}), ${m.branch}, last seen ${dayText(eatDateOf(m.lastSeen))}`); }
    if (r.events.length) { lines.push('', 'Events:'); for (const e of r.events) lines.push(`- ${e.title}, ${when(e.startsAt)}: ${e.kind === 'tickets' ? `${e.sold} tickets sold, ${e.scanned} scanned at the door` : `${e.going} replied going`}`); }
    if (r.kids.length) { lines.push('', 'Children in class:'); for (const k of r.kids) lines.push(`- ${k.className}: ${k.count} check-ins`); }
    if (branches.length) { lines.push('', 'By branch:'); for (const b of branches) lines.push(`- ${b.name}: ${b.r.totals.members} members, ${b.r.totals.firstVisitors} first-time visitors, ${b.r.totals.returningVisitors} returning, ${b.r.totals.online} online${b.r.totals.headcount !== null ? `, headcount ${b.r.totals.headcount}` : ''}`); }
    lines.push('', `Open the staff app, Attendance, for names, numbers and follow-up. You are getting this because you can see attendance. You can switch it off under Attendance.`);
    const td = 'style="padding:6px 10px;border-bottom:1px solid #eee"';
    const rowsHtml = r.services.map((s) => `<tr><td ${td}>${esc(s.name)}<br/><span style="color:#667;font-size:12px">${esc(s.branch)}, ${esc(when(s.startsAt))}</span></td><td ${td}>${s.members}</td><td ${td}>${s.firstVisitors}</td><td ${td}>${s.returningVisitors}</td><td ${td}>${s.online}</td><td ${td}>${s.headcount ?? '-'}</td></tr>`).join('');
    const html = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#17212b"><h2 style="color:#0e5a52;margin-bottom:4px">${esc(church)}</h2><div style="color:#667">Attendance for ${esc(range)}${scope ? `, ${esc(scope)}` : ''}</div>
      <table style="width:100%;margin:16px 0;text-align:center"><tr><td><div style="font-size:26px;font-weight:700">${t.members}</div><div style="font-size:12px;color:#667">Members${esc(arrow(t.members, r.previous.members))}</div></td><td><div style="font-size:26px;font-weight:700">${t.firstVisitors}</div><div style="font-size:12px;color:#667">First-time visitors${esc(arrow(t.firstVisitors, r.previous.firstVisitors))}</div></td><td><div style="font-size:26px;font-weight:700">${t.returningVisitors}</div><div style="font-size:12px;color:#667">Returning</div></td><td><div style="font-size:26px;font-weight:700">${t.online}</div><div style="font-size:12px;color:#667">Online</div></td></tr></table>
      <p style="color:#667;font-size:13px">Usual week (last four): ${r.average4.members} members, ${r.average4.firstVisitors} first-time visitors, ${r.average4.online} online.${r.coverage !== null ? ` Check-ins cover ${r.coverage}% of the headcount.` : ''}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px"><tr style="text-align:left;color:#667"><th ${td}>${esc(w.one)}</th><th ${td}>Members</th><th ${td}>First-time</th><th ${td}>Returning</th><th ${td}>Online</th><th ${td}>Headcount</th></tr>${rowsHtml || `<tr><td ${td} colspan="6">No ${esc(w.manyLower)} were held this week.</td></tr>`}</table>
      ${r.firstVisitors.length ? `<h3>First-time visitors to follow up (${r.firstVisitors.length})</h3><ul>${r.firstVisitors.slice(0, 40).map((v) => `<li>${esc(v.name)}, ${esc(v.branch)}</li>`).join('')}</ul>` : ''}
      ${r.care.length ? `<h3>Regular members who have not come for three weeks (${r.care.length})</h3><ul>${r.care.slice(0, 40).map((m) => `<li>${esc(m.name)} (${esc(m.memberNumber)}), ${esc(m.branch)}, last seen ${esc(dayText(eatDateOf(m.lastSeen)))}</li>`).join('')}</ul>` : ''}
      ${r.events.length ? `<h3>Events</h3><ul>${r.events.map((e) => `<li>${esc(e.title)}: ${e.kind === 'tickets' ? `${e.sold} tickets sold, ${e.scanned} scanned` : `${e.going} replied going`}</li>`).join('')}</ul>` : ''}
      ${r.kids.length ? `<h3>Children in class</h3><ul>${r.kids.map((k) => `<li>${esc(k.className)}: ${k.count}</li>`).join('')}</ul>` : ''}
      ${branches.length ? `<h3>By branch</h3><table style="width:100%;border-collapse:collapse;font-size:14px">${branches.map((b) => `<tr><td ${td}>${esc(b.name)}</td><td ${td}>${b.r.totals.members} members</td><td ${td}>${b.r.totals.firstVisitors} first-time</td><td ${td}>${b.r.totals.online} online</td></tr>`).join('')}</table>` : ''}
      <p style="color:#667;font-size:12px;margin-top:20px">Open the staff app, Attendance, for names and follow-up. You get this because you can see attendance. You can switch it off under Attendance.</p></div>`;
    return { subject, text: lines.join('\n'), html };
  }

  /** Sends the report for one person's scope. */
  async function sendReportTo(user: { id: string; name: string; email: string }, orgId: string, ws: string): Promise<boolean> {
    const rows = await branchesFor(ctx.db, user.id, 'attendance.view');
    const mine = rows.filter((r) => r.orgId === orgId).map((r) => r.branchId);
    if (!mine.length) return false;
    const all = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM branches WHERE org_id=$1`, [orgId]))[0].n);
    const church = (await ctx.db.query<any>(`SELECT name FROM organisations WHERE id=$1`, [orgId]))[0].name;
    const whole = mine.length === all && all > 1;
    const r = await weekReport(orgId, mine, ws);
    if (!r.services.length && !r.firstVisitors.length) return false;
    const names = await ctx.db.query<any>(`SELECT id, name FROM branches WHERE id = ANY($1::text[]) ORDER BY name`, [mine]);
    const perBranch: { name: string; r: WeekReport }[] = [];
    if (whole || mine.length > 1) for (const b of names) perBranch.push({ name: b.name, r: await weekReport(orgId, [b.id], ws) });
    const scope = whole ? 'all branches' : mine.length === 1 ? names[0].name : names.map((n) => n.name).join(', ');
    const m = renderReport(church, scope, r, perBranch, await wordsFor(ctx, orgId));
    return sendEmail(ctx, orgId, user.email, m.subject, m.text, m.html);
  }

  app.post('/attendance/report/send-now', auth, async (req) => {
    const sc = await scopeBranches(req, ['attendance.view']);
    const u = (await ctx.db.query<any>(`SELECT id, name, email, email_verified FROM users WHERE id=$1`, [req.session!.uid]))[0];
    if (!u.email || !u.email_verified) throw new HttpError(409, 'Add and confirm your email address in your profile first', 'no_email');
    const ok = await sendReportTo(u, sc.orgId, lastFullWeek());
    if (!ok) throw new HttpError(409, `There were no ${(await wordsFor(ctx, sc.orgId)).manyLower} or visitors last week to report on`, 'nothing');
    return { sent: true, week: lastFullWeek() };
  });

  // keep the helper reachable by the scheduler
  HOOKS.set(ctx, { sendReportTo });
  // The same recording rules, for the kiosk (routes/kiosk.ts).
  return { identify, record, state, serviceRow };
}

const HOOKS = new WeakMap<Ctx, { sendReportTo: (user: { id: string; name: string; email: string }, orgId: string, ws: string) => Promise<boolean> }>();

/** Every Monday at 7:00 Nairobi time, the people who can see attendance get the report for the week that passed (L214). */
export async function runAttendanceJobs(ctx: Ctx): Promise<{ sent: number }> {
  const h = HOOKS.get(ctx);
  if (!h) return { sent: 0 };
  const now = ctx.clock.now();
  const monday = weekStartOf(eatToday(now));
  if (now.getTime() < Date.parse(dueAt(monday, '07:00'))) return { sent: 0 };
  const ws = addDays(monday, -7);
  const orgs = await ctx.db.query<any>(`SELECT DISTINCT org_id FROM services WHERE starts_at >= $1 AND starts_at < $2`, [dueAt(ws, '00:00'), dueAt(monday, '00:00')]);
  let sent = 0;
  for (const o of orgs) {
    const users = await ctx.db.query<any>(`SELECT DISTINCT u.id, u.name, u.email FROM role_assignments ra JOIN users u ON u.id=ra.user_id WHERE ra.org_id=$1 AND u.email IS NOT NULL AND u.email_verified`, [o.org_id]);
    for (const u of users) {
      if ((await branchesFor(ctx.db, u.id, 'attendance.view')).every((b) => b.orgId !== o.org_id)) continue;
      const pref = (await ctx.db.query<any>(`SELECT weekly_email FROM attendance_prefs WHERE user_id=$1`, [u.id]))[0];
      if (pref && !pref.weekly_email) continue;
      const claimed = await ctx.db.query<any>(`INSERT INTO attendance_report_runs (key, sent_at) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING key`, [`${o.org_id}:${ws}:${u.id}`, now.toISOString()]);
      if (!claimed[0]) continue;
      if (await h.sendReportTo(u, o.org_id, ws)) sent++;
    }
  }
  return { sent };
}
