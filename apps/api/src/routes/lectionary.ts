import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError, requireSession, type Ctx } from '../ctx';
import { addDays, eatDateOf, eatToday, weekStartOf } from '../eat';
import { grantsFor, inStaffScope } from '../scope';
import { parseGeo } from './kids';
import { readingPublishAt } from './attendance';

/**
 * The lectionary and the boundary of a service (Slice 22, L250 to L256).
 * Staff enter the Sunday names and the scripture references of the Revised Common Lectionary themselves: ChurchOS carries no lectionary text and no
 * copied list. A member opens the reading of the day by checking in, and where a place is set the phone has to be there.
 */

export const SEASONS = ['Advent', 'Christmas', 'Epiphany', 'Lent', 'Holy Week', 'Easter', 'Pentecost', 'Ordinary Time'];
export const COLOURS = ['white', 'red', 'green', 'purple', 'rose', 'blue', 'gold', 'black'];
const MAX_READINGS = 6;
const REF_OK = /^[\p{L}\d][\p{L}\d\s.:,\-–()]*$/u;
const cap = (v: unknown, n: number) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, n);
const dateOk = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const dayText = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-KE', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

export interface Reading { label: string; ref: string }

/** A label for a reference when the church did not give one: psalms, gospels, and first and second readings. */
export function labelReadings(refs: string[]): Reading[] {
  let others = 0;
  return refs.map((ref) => {
    if (/^(psalm|ps\.?)\s/i.test(ref)) return { label: 'Psalm', ref };
    if (/^(matthew|mark|luke|john)\b/i.test(ref)) return { label: 'Gospel', ref };
    others++;
    return { label: others === 1 ? 'First reading' : others === 2 ? 'Second reading' : `Reading ${others + 1}`, ref };
  });
}

function checkReadings(raw: unknown): Reading[] {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > MAX_READINGS) throw new HttpError(400, `A day can have up to ${MAX_READINGS} readings`, 'too_many_readings');
  const out: Reading[] = [];
  for (const r of list) {
    const ref = cap((r as any)?.ref ?? r, 80);
    if (!ref) continue;
    if (ref.length < 3 || !REF_OK.test(ref)) throw new HttpError(400, `"${ref}" does not look like a scripture reference. Write it like John 10:1-18.`, 'bad_reference');
    const label = cap((r as any)?.label, 30);
    out.push({ label, ref });
  }
  const auto = labelReadings(out.map((o) => o.ref));
  return out.map((o, i) => ({ label: o.label || auto[i].label, ref: o.ref }));
}

export function lectionaryRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };
  const nowIso = () => ctx.clock.now().toISOString();
  const nowMs = () => ctx.clock.now().getTime();

  const view = (r: any) => ({ id: r.id, date: r.date, title: r.title, season: r.season ?? null, cycle: r.cycle ?? null, colour: r.colour ?? null, readings: JSON.parse(r.readings || '[]') as Reading[], note: r.note ?? null, updatedAt: r.updated_at });

  async function manageOrg(req: FastifyRequest) {
    return grantsFor(ctx, req, 'attendance.manage');
  }

  // ======================= the lectionary =======================

  app.get('/lectionary', auth, async (req) => {
    let g: Awaited<ReturnType<typeof grantsFor>>;
    let canManage = true;
    try { g = await manageOrg(req); } catch { canManage = false; g = await grantsFor(ctx, req, 'attendance.view'); }
    const q = req.query as any;
    const today = eatToday(ctx.clock.now());
    const from = dateOk(String(q.from ?? '')) ? String(q.from) : addDays(today, -7);
    const to = dateOk(String(q.to ?? '')) ? String(q.to) : addDays(today, 120);
    const rows = await ctx.db.query<any>(`SELECT * FROM lectionary_days WHERE org_id=$1 AND active AND date >= $2 AND date <= $3 ORDER BY date LIMIT 400`, [g.orgId, from, to]);
    return { days: rows.map(view), canManage, seasons: SEASONS, colours: COLOURS, from, to, today };
  });

  async function save(g: { orgId: string }, uid: string, date: string, b: any) {
    if (!dateOk(date)) throw new HttpError(400, 'Choose a valid date', 'bad_date');
    const title = cap(b.title, 100);
    if (title.length < 3) throw new HttpError(400, 'Enter the name of the day, for example "Third Sunday of Lent"', 'bad_content');
    const season = b.season ? cap(b.season, 30) : null;
    if (season && !SEASONS.includes(season)) throw new HttpError(400, 'Choose a season from the list', 'bad_season');
    const cycle = b.cycle ? String(b.cycle).toUpperCase() : null;
    if (cycle && !['A', 'B', 'C'].includes(cycle)) throw new HttpError(400, 'The lectionary year is A, B or C', 'bad_cycle');
    const colour = b.colour ? cap(b.colour, 20).toLowerCase() : null;
    if (colour && !COLOURS.includes(colour)) throw new HttpError(400, 'Choose a colour from the list', 'bad_colour');
    const readings = checkReadings(b.readings);
    if (!readings.length) throw new HttpError(400, 'Add at least one reading', 'bad_content');
    const note = cap(b.note, 300) || null;
    const id = ctx.newId('lct');
    const row = (await ctx.db.query<any>(
      `INSERT INTO lectionary_days (id, org_id, date, title, season, cycle, colour, readings, note, active, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11)
       ON CONFLICT (org_id, date) DO UPDATE SET title=$4, season=$5, cycle=$6, colour=$7, readings=$8, note=$9, active=true, updated_by=$10, updated_at=$11 RETURNING id, (xmax = 0) AS created`,
      [id, g.orgId, date, title, season, cycle, colour, JSON.stringify(readings), note, uid, nowIso()],
    ))[0];
    return { id: row.id as string, created: !!row.created, title };
  }

  app.put('/lectionary/:date', auth, async (req) => {
    const g = await manageOrg(req);
    const date = String((req.params as any).date);
    const r = await save(g, req.session!.uid, date, req.body ?? {});
    await ctx.ledger.audit({ orgId: g.orgId, actor: req.session!.uid, action: 'lectionary.set', entity: 'lectionary_day', entityId: r.id, summary: `${r.created ? 'Added' : 'Changed'} the readings for ${dayText(date)}: ${r.title}` });
    return { id: r.id, created: r.created };
  });

  app.post('/lectionary/:date/remove', auth, async (req) => {
    const g = await manageOrg(req);
    const date = String((req.params as any).date);
    const r = await ctx.db.query<any>(`UPDATE lectionary_days SET active=false, updated_by=$3, updated_at=$4 WHERE org_id=$1 AND date=$2 AND active RETURNING id, title`, [g.orgId, date, req.session!.uid, nowIso()]);
    if (!r[0]) throw new HttpError(404, 'not found', 'not_found');
    await ctx.ledger.audit({ orgId: g.orgId, actor: req.session!.uid, action: 'lectionary.removed', entity: 'lectionary_day', entityId: r[0].id, summary: `Removed the readings for ${dayText(date)}: ${r[0].title}` });
    return { ok: true };
  });

  /**
   * Many days at once. One line each: date | name of the day | A, B or C | references separated by semicolons. Lines that cannot be read are reported and the
   * rest are saved, so a church can paste a whole season from its own lectionary book and fix what is flagged.
   */
  app.post('/lectionary/import', auth, async (req) => {
    const g = await manageOrg(req);
    const lines = String((req.body as any)?.text ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (!lines.length) throw new HttpError(400, 'Paste at least one line', 'bad_content');
    if (lines.length > 400) throw new HttpError(400, 'Paste at most 400 lines at a time', 'too_many');
    let added = 0, changed = 0;
    const errors: { line: number; text: string; message: string }[] = [];
    for (const [i, line] of lines.entries()) {
      const parts = line.split('|').map((p) => p.trim());
      try {
        if (parts.length < 3) throw new HttpError(400, 'Use: date | name of the day | A, B or C | readings separated by semicolons', 'bad_line');
        const [date, title] = parts;
        const hasCycle = parts.length >= 4;
        const cycle = hasCycle ? parts[2] : '';
        const refs = (hasCycle ? parts[3] : parts[2]).split(';').map((r) => r.trim()).filter(Boolean);
        const r = await save(g, req.session!.uid, date, { title, cycle: cycle || null, readings: refs });
        if (r.created) added++; else changed++;
      } catch (e: any) {
        errors.push({ line: i + 1, text: line.slice(0, 80), message: e.message ?? 'Could not read this line' });
      }
    }
    await ctx.ledger.audit({ orgId: g.orgId, actor: req.session!.uid, action: 'lectionary.import', entity: 'organisation', entityId: g.orgId, summary: `Pasted ${lines.length} lines of readings: ${added} added, ${changed} changed, ${errors.length} could not be read`, meta: { added, changed, errors: errors.length } });
    return { added, changed, errors };
  });

  // ======================= the boundary =======================

  /** Where each branch is, and how well the boundary has worked over the last eight weeks. */
  app.get('/attendance/boundaries', auth, async (req) => {
    let canManage = true;
    let g: Awaited<ReturnType<typeof grantsFor>>;
    try { g = await grantsFor(ctx, req, 'attendance.manage'); } catch { canManage = false; g = await grantsFor(ctx, req, 'attendance.view'); }
    const since = new Date(nowMs() - 56 * 86_400_000).toISOString();
    const branches = await ctx.db.query<any>(`SELECT id, name, geo_lat, geo_lng, geo_radius_m FROM branches WHERE org_id=$1 AND id = ANY($2::text[]) ORDER BY name`, [g.orgId, g.branchIds]);
    const att = await ctx.db.query<any>(
      `SELECT branch_id, count(*) FILTER (WHERE via='app' AND location='ok')::int AS verified, count(*) FILTER (WHERE via='app' AND (location IS NULL OR location='unchecked'))::int AS unchecked, count(*) FILTER (WHERE via <> 'app')::int AS staff
         FROM attendance WHERE org_id=$1 AND mode='in_person' AND at >= $2 GROUP BY branch_id`,
      [g.orgId, since],
    );
    const blocked = await ctx.db.query<any>(`SELECT branch_id, count(*)::int AS n FROM attendance_blocked WHERE org_id=$1 AND at >= $2 GROUP BY branch_id`, [g.orgId, since]);
    const recent = await ctx.db.query<any>(
      `SELECT x.at, x.name, x.status, x.distance_m, x.accuracy_m, s.name AS service, b.name AS branch FROM attendance_blocked x JOIN services s ON s.id=x.service_id JOIN branches b ON b.id=x.branch_id WHERE x.org_id=$1 AND x.branch_id = ANY($2::text[]) ORDER BY x.at DESC LIMIT 30`,
      [g.orgId, g.branchIds],
    );
    return {
      canManage,
      branches: branches.map((b) => {
        const a = att.find((x) => x.branch_id === b.id);
        return { id: b.id, name: b.name, location: b.geo_lat === null || b.geo_lat === undefined ? null : { lat: Number(b.geo_lat), lng: Number(b.geo_lng), radiusM: b.geo_radius_m }, stats: { verified: a?.verified ?? 0, unchecked: a?.unchecked ?? 0, staff: a?.staff ?? 0, blocked: blocked.find((x) => x.branch_id === b.id)?.n ?? 0 } };
      }),
      blocked: recent.map((r) => ({ at: r.at, name: r.name, status: r.status, distanceM: r.distance_m, accuracyM: r.accuracy_m, service: r.service, branch: r.branch })),
    };
  });

  app.put('/attendance/branches/:id/location', auth, async (req) => {
    const g = await manageOrg(req);
    const id = String((req.params as any).id);
    if (!g.branchIds.includes(id)) throw new HttpError(404, 'not found', 'not_found');
    const b = (req.body ?? {}) as any;
    const name = (await ctx.db.query<any>(`SELECT name FROM branches WHERE id=$1`, [id]))[0]?.name;
    if (b.clear) {
      await ctx.db.query(`UPDATE branches SET geo_lat=NULL, geo_lng=NULL, geo_radius_m=NULL WHERE id=$1`, [id]);
      await ctx.ledger.audit({ orgId: g.orgId, branchId: id, actor: req.session!.uid, action: 'attendance.branch_location_cleared', entity: 'branch', entityId: id, summary: `Removed the location of ${name}. Members can check in from anywhere.` });
      return { ok: true, location: null };
    }
    const geo = parseGeo({ lat: b.lat, lng: b.lng, acc: 0 });
    const radius = Math.round(Number(b.radiusM ?? 200));
    if (!geo) throw new HttpError(400, 'Enter a valid latitude and longitude, or use your current location', 'bad_location');
    if (!(radius >= 30 && radius <= 2000)) throw new HttpError(400, 'The distance must be between 30 and 2,000 metres', 'bad_radius');
    await ctx.db.query(`UPDATE branches SET geo_lat=$2, geo_lng=$3, geo_radius_m=$4 WHERE id=$1`, [id, geo.lat, geo.lng, radius]);
    await ctx.ledger.audit({ orgId: g.orgId, branchId: id, actor: req.session!.uid, action: 'attendance.branch_location_set', entity: 'branch', entityId: id, summary: `Set the location of ${name} for check-in, within ${radius} m`, meta: { radiusM: radius } });
    return { ok: true, location: { lat: geo.lat, lng: geo.lng, radiusM: radius } };
  });

  /** One service can happen somewhere else (a ground, a hall for the day): it then has its own place, and the branch location is not used for it. */
  app.put('/attendance/services/:id/place', auth, async (req) => {
    const s = (await ctx.db.query<any>(`SELECT id, org_id, branch_id, name, starts_at FROM services WHERE id=$1`, [(req.params as any).id]))[0];
    if (!s || !(await inStaffScope(ctx, req, 'attendance.manage', s.org_id, s.branch_id))) throw new HttpError(404, 'not found', 'not_found');
    const b = (req.body ?? {}) as any;
    if (b.clear) {
      await ctx.db.query(`UPDATE services SET geo_lat=NULL, geo_lng=NULL, geo_radius_m=NULL, place_name=NULL, updated_at=$2 WHERE id=$1`, [s.id, nowIso()]);
      await ctx.ledger.audit({ orgId: s.org_id, branchId: s.branch_id, actor: req.session!.uid, action: 'attendance.service_place_cleared', entity: 'service', entityId: s.id, summary: `"${s.name}" now uses the branch location` });
      return { ok: true, place: null };
    }
    const geo = parseGeo({ lat: b.lat, lng: b.lng, acc: 0 });
    const radius = Math.round(Number(b.radiusM ?? 200));
    const place = cap(b.name, 80) || null;
    if (!geo) throw new HttpError(400, 'Enter a valid latitude and longitude, or use your current location', 'bad_location');
    if (!(radius >= 30 && radius <= 5000)) throw new HttpError(400, 'The distance must be between 30 and 5,000 metres', 'bad_radius');
    await ctx.db.query(`UPDATE services SET geo_lat=$2, geo_lng=$3, geo_radius_m=$4, place_name=$5, updated_at=$6 WHERE id=$1`, [s.id, geo.lat, geo.lng, radius, place, nowIso()]);
    await ctx.ledger.audit({ orgId: s.org_id, branchId: s.branch_id, actor: req.session!.uid, action: 'attendance.service_place_set', entity: 'service', entityId: s.id, summary: `Set a place for "${s.name}"${place ? `: ${place}` : ''}, within ${radius} m`, meta: { radiusM: radius } });
    return { ok: true, place: { name: place, lat: geo.lat, lng: geo.lng, radiusM: radius } };
  });

  // ======================= the member =======================

  const LECT = `ld.title AS lect_title, ld.season AS lect_season, ld.cycle AS lect_cycle, ld.colour AS lect_colour, ld.readings AS lect_readings, ld.note AS lect_note`;
  const LJOIN = `LEFT JOIN lectionary_days ld ON ld.org_id=s.org_id AND ld.active AND ld.date = ((s.starts_at::timestamptz + interval '3 hours')::date)::text`;

  const readingBody = (s: any) => ({
    service: { id: s.id, name: s.name, startsAt: s.starts_at, church: s.church, branch: s.branch_name },
    title: s.reading_title ?? null, ref: s.reading_ref ?? null, body: s.reading_body ?? null,
    lectionary: s.lect_title ? { title: s.lect_title, season: s.lect_season ?? null, cycle: s.lect_cycle ?? null, colour: s.lect_colour ?? null, readings: JSON.parse(s.lect_readings || '[]') as Reading[], note: s.lect_note ?? null } : null,
  });

  /** The reading of a service, for a member who has checked in to it (at the church or online). */
  app.get('/me/services/:id/reading', auth, async (req) => {
    const s = (await ctx.db.query<any>(`SELECT s.*, b.name AS branch_name, o.name AS church, ${LECT} FROM services s JOIN branches b ON b.id=s.branch_id JOIN organisations o ON o.id=s.org_id ${LJOIN} WHERE s.id=$1`, [(req.params as any).id]))[0];
    const mine = s ? await ctx.db.query<any>(`SELECT id FROM memberships WHERE user_id=$1 AND org_id=$2 AND status='active'`, [req.session!.uid, s.org_id]) : [];
    if (!s || !mine.length) throw new HttpError(404, 'not found', 'not_found');
    const body = readingBody(s);
    if (!body.title && !body.ref && !body.body && !body.lectionary) return { reading: null };
    const here = await ctx.db.query<any>(`SELECT 1 FROM attendance WHERE service_id=$1 AND membership_id = ANY($2::text[]) LIMIT 1`, [s.id, mine.map((m) => m.id)]);
    if (!here.length) throw new HttpError(403, "Check in to open today's reading", 'check_in_first');
    if (nowMs() < readingPublishAt(s.starts_at, s.reading_release)) throw new HttpError(409, 'This reading is not ready yet', 'not_yet');
    return { reading: body };
  });

  /** Readings a member has opened by checking in, and how many weeks in a row they have come. */
  app.get('/me/readings', auth, async (req) => {
    const ms = await ctx.db.query<any>(`SELECT id, org_id FROM memberships WHERE user_id=$1 AND status='active'`, [req.session!.uid]);
    if (!ms.length) return { streak: 0, opened: 0, recent: [] };
    const rows = await ctx.db.query<any>(
      `SELECT DISTINCT ON (s.id) s.*, a.mode AS my_mode, b.name AS branch_name, o.name AS church, ${LECT}
         FROM attendance a JOIN services s ON s.id=a.service_id JOIN branches b ON b.id=s.branch_id JOIN organisations o ON o.id=s.org_id ${LJOIN}
        WHERE a.membership_id = ANY($1::text[]) ORDER BY s.id, a.at LIMIT 400`,
      [ms.map((m) => m.id)],
    );
    rows.sort((a, b) => (a.starts_at < b.starts_at ? 1 : -1));
    const weeks = new Set(rows.map((r) => weekStartOf(eatDateOf(r.starts_at))));
    let cursor = weekStartOf(eatToday(ctx.clock.now()));
    if (!weeks.has(cursor)) cursor = addDays(cursor, -7);
    let streak = 0;
    while (weeks.has(cursor)) { streak++; cursor = addDays(cursor, -7); }
    const withReading = rows.filter((r) => r.lect_title || r.reading_title || r.reading_ref || r.reading_body);
    return { streak, opened: withReading.length, recent: withReading.slice(0, 12).map((r) => ({ ...readingBody(r), mode: r.my_mode })) };
  });
}
