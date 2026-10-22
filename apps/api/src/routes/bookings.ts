import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parseKes } from '../limits';
import { branchesFor, type Permission } from '../auth';
import { diff, maskedSnapshot, recordVersion, type FieldSpec } from '../audit';
import { HttpError, requireSession, type Ctx } from '../ctx';
import { addNotification, type NotificationAudience } from '../notifications';
import { grantsFor, inStaffScope } from '../scope';

// ---------- time helpers (East Africa Time is UTC+3 all year) ----------

const EAT = 3 * 3600_000;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const HOLD_HOURS = 24;
const CANCEL_CUTOFF_HOURS = 24;
const BLOCKING = ['approved', 'awaiting_payment', 'confirmed'];

const eatParts = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + EAT);
  return { date: d.toISOString().slice(0, 10), dow: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
};
const eatToIso = (date: string, minutes: number) => new Date(Date.parse(`${date}T00:00:00Z`) + minutes * 60_000 - EAT).toISOString();
const hm = (s: string) => { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export type Hours = Partial<Record<(typeof DAYS)[number], [string, string][]>>;

/** Working hours for each weekday as local time ranges, for example mon: [["09:00","12:00"],["14:00","17:00"]]. */
export function validateHours(raw: any): Hours {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'Set the hours this can be booked', 'bad_hours');
  const out: Hours = {};
  let any = false;
  for (const d of DAYS) {
    const ranges = raw[d];
    if (ranges === undefined || (Array.isArray(ranges) && ranges.length === 0)) continue;
    if (!Array.isArray(ranges)) throw new HttpError(400, 'The hours for each day must be a list of from and to times', 'bad_hours');
    const parsed = ranges.map((r: any) => [hm(String(r?.[0])), hm(String(r?.[1]))] as [number, number]);
    parsed.sort((a, b) => a[0] - b[0]);
    parsed.forEach(([a, b], i) => {
      if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b) throw new HttpError(400, 'Each time range must start before it ends, for example 09:00 to 17:00', 'bad_hours');
      if (i > 0 && a < parsed[i - 1][1]) throw new HttpError(400, 'Time ranges on the same day cannot overlap', 'bad_hours');
    });
    out[d] = parsed.map(([a, b]) => [`${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`, `${String(Math.floor(b / 60)).padStart(2, '0')}:${String(b % 60).padStart(2, '0')}`] as [string, string]);
    any = true;
  }
  if (!any) throw new HttpError(400, 'Choose at least one day and time it can be booked', 'bad_hours');
  return out;
}

const RESOURCE_SPECS: FieldSpec[] = [
  { field: 'name', label: 'Name' },
  { field: 'kind', label: 'Kind' },
  { field: 'description', label: 'Description' },
  { field: 'branch', label: 'Belongs to' },
  { field: 'owner', label: 'Owner' },
  { field: 'capacity', label: 'Capacity' },
  { field: 'slotMinutes', label: 'Booking length (minutes)' },
  { field: 'maxMinutes', label: 'Longest booking (minutes)' },
  { field: 'hours', label: 'Hours' },
  { field: 'minNoticeHours', label: 'Minimum notice (hours)' },
  { field: 'maxAdvanceDays', label: 'Book up to (days ahead)' },
  { field: 'approval', label: 'Approval' },
  { field: 'price', label: 'Price (cents)' },
  { field: 'pricePer', label: 'Price per' },
  { field: 'active', label: 'Available' },
];

const text = (v: unknown, max: number, label: string, required = false) => {
  const s = String(v ?? '').trim().replace(/[ \t]+/g, ' ');
  if (required && !s) throw new HttpError(400, `Enter the ${label}`, 'bad_content');
  if (s.length > max) throw new HttpError(400, `The ${label} can be at most ${max} characters`, 'bad_content');
  return s || null;
};
const intIn = (v: unknown, lo: number, hi: number, label: string, fallback?: number): number => {
  if ((v === undefined || v === null || v === '') && fallback !== undefined) return fallback;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, `${label} must be a number from ${lo} to ${hi}`, 'bad_number');
  return n;
};

/** Resources, bookings, payment holds and reminders (L140 to L148). */
export function bookingRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };
  const nowIso = () => ctx.clock.now().toISOString();
  const newCode = () => randomBytes(6).toString('hex').toUpperCase(); // 48 bits: the code is a public secret (AZ-17)

  const notify = async (orgId: string, userIds: (string | null | undefined)[], title: string, body: string, link?: string, audience: NotificationAudience = 'member') => {
    for (const u of [...new Set(userIds.filter(Boolean) as string[])]) {
      await addNotification(ctx, { orgId, userId: u, kind: 'announcement', title, body, link, audience });
    }
  };

  /** Staff who may decide requests for a branch: anyone with the bookings permission whose scope covers it. */
  async function deciderUsers(orgId: string, branchId: string | null): Promise<string[]> {
    const rows = await ctx.db.query<any>(`SELECT ra.user_id, ra.scope_type, ra.scope_id, r.permissions FROM role_assignments ra JOIN roles r ON r.id=ra.role_id WHERE ra.org_id=$1`, [orgId]);
    const region = branchId ? (await ctx.db.query<any>(`SELECT region FROM branches WHERE id=$1`, [branchId]))[0]?.region : null;
    return [...new Set(rows.filter((r) => (r.permissions as string[]).includes('bookings.manage') && (r.scope_type === 'org' || (branchId && ((r.scope_type === 'branch' && r.scope_id === branchId) || (r.scope_type === 'region' && r.scope_id === region))))).map((r) => r.user_id as string))];
  }

  // ======================= availability rules =======================

  async function blockedBy(resourceId: string, start: string, end: string) {
    return (await ctx.db.query<any>(`SELECT reason FROM resource_blocks WHERE resource_id=$1 AND removed_at IS NULL AND starts_at < $3 AND ends_at > $2 LIMIT 1`, [resourceId, start, end]))[0] as { reason: string | null } | undefined;
  }

  async function conflictWith(resourceId: string, start: string, end: string, exceptBooking = '') {
    return (await ctx.db.query<any>(
      `SELECT b.id FROM bookings b JOIN booking_items i ON i.booking_id=b.id
        WHERE i.resource_id=$1 AND i.status<>'declined' AND b.status = ANY($5::text[]) AND (b.status<>'awaiting_payment' OR b.hold_until > $6)
          AND b.starts_at < $3 AND b.ends_at > $2 AND b.id<>$4 LIMIT 1`,
      [resourceId, start, end, exceptBooking, BLOCKING, nowIso()],
    ))[0] as { id: string } | undefined;
  }

  /** Whether a start and end fall inside the resource's rules. Throws a plain message when not. */
  async function checkWindow(r: any, start: string, end: string) {
    const label = r.name;
    if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end)) || end <= start) throw new HttpError(400, 'Choose a start time and an end time after it', 'bad_time');
    const a = eatParts(start);
    const b = eatParts(new Date(Date.parse(end) - 1).toISOString());
    if (a.date !== b.date) throw new HttpError(400, 'A booking must start and end on the same day', 'bad_time');
    const minutes = Math.round((Date.parse(end) - Date.parse(start)) / 60_000);
    if (minutes % r.slot_minutes !== 0 || a.minutes % r.slot_minutes !== 0) throw new HttpError(400, `${label} is booked in blocks of ${r.slot_minutes} minutes, starting on the hour or half hour that fits`, 'bad_slot');
    if (minutes > (r.max_minutes ?? 24 * 60)) throw new HttpError(400, `${label} cannot be booked for more than ${r.max_minutes} minutes at a time`, 'too_long');
    const ranges: [string, string][] = (r.hours as Hours)[DAYS[a.dow]] ?? [];
    const endMin = a.minutes + minutes;
    if (!ranges.some(([f, t]) => a.minutes >= hm(f) && endMin <= hm(t))) throw new HttpError(400, `${label} is not available at that time. Pick a time inside its working hours.`, 'outside_hours');
    const now = ctx.clock.now().getTime();
    if (Date.parse(start) < now + r.min_notice_hours * 3600_000) throw new HttpError(400, `${label} needs at least ${r.min_notice_hours} hours notice`, 'too_soon');
    if (Date.parse(start) > now + r.max_advance_days * 86400_000) throw new HttpError(400, `${label} can only be booked up to ${r.max_advance_days} days ahead`, 'too_far');
    const blk = await blockedBy(r.id, start, end);
    if (blk) throw new HttpError(409, `${label} is not available then${blk.reason ? ` (${blk.reason})` : ''}`, 'blocked');
  }

  async function freeSlots(r: any, date: string, minutes: number) {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const ranges: [string, string][] = (r.hours as Hours)[DAYS[dow]] ?? [];
    const out: { startsAt: string; endsAt: string }[] = [];
    for (const [f, t] of ranges) {
      for (let m = hm(f); m + minutes <= hm(t); m += r.slot_minutes) {
        if (m % r.slot_minutes !== 0) continue;
        const startsAt = eatToIso(date, m);
        const endsAt = eatToIso(date, m + minutes);
        try { await checkWindow(r, startsAt, endsAt); } catch { continue; }
        if (await conflictWith(r.id, startsAt, endsAt)) continue;
        out.push({ startsAt, endsAt });
      }
    }
    return out;
  }

  const priceOf = (r: any, minutes: number) => (r.price == null ? 0 : r.price_per === 'hour' ? Math.ceil((Number(r.price) * minutes) / 60) : Number(r.price));

  // ======================= resources, staff side =======================

  const resourceFlat = async (r: any) => ({
    name: r.name, kind: r.kind, description: r.description,
    branch: r.branch_id ? (await ctx.db.query<any>(`SELECT name FROM branches WHERE id=$1`, [r.branch_id]))[0]?.name ?? r.branch_id : 'Whole church',
    owner: r.owner_user_id ? (await ctx.db.query<any>(`SELECT name FROM users WHERE id=$1`, [r.owner_user_id]))[0]?.name ?? null : null,
    capacity: r.capacity ?? null, slotMinutes: r.slot_minutes, maxMinutes: r.max_minutes ?? null, hours: JSON.stringify(r.hours), minNoticeHours: r.min_notice_hours, maxAdvanceDays: r.max_advance_days,
    approval: r.approval, price: r.price == null ? null : Number(r.price), pricePer: r.price_per, active: r.active,
  });

  const resourceView = async (r: any) => ({
    id: r.id, kind: r.kind, name: r.name, description: r.description, branchId: r.branch_id, capacity: r.capacity, ownerUserId: r.owner_user_id,
    ownerName: r.owner_user_id ? (await ctx.db.query<any>(`SELECT name FROM users WHERE id=$1`, [r.owner_user_id]))[0]?.name ?? null : null,
    slotMinutes: r.slot_minutes, maxMinutes: r.max_minutes, hours: r.hours, minNoticeHours: r.min_notice_hours, maxAdvanceDays: r.max_advance_days,
    approval: r.approval, price: r.price == null ? null : Number(r.price), pricePer: r.price_per, active: r.active,
    branchName: r.branch_id ? (await ctx.db.query<any>(`SELECT name FROM branches WHERE id=$1`, [r.branch_id]))[0]?.name ?? null : null,
  });

  async function staffResource(req: FastifyRequest, id: string, perm: Permission) {
    const r = (await ctx.db.query<any>(`SELECT * FROM resources WHERE id=$1`, [id]))[0];
    if (!r || !(await inStaffScope(ctx, req, perm, r.org_id, r.branch_id))) throw new HttpError(404, 'not found', 'not_found');
    return r;
  }

  app.get('/resources', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'bookings.view');
    const rows = await ctx.db.query<any>(`SELECT * FROM resources WHERE org_id=$1 ORDER BY kind, name`, [g.orgId]);
    const out = [];
    for (const r of rows) if (r.branch_id ? g.branchIds.includes(r.branch_id) : g.wholeOrg) out.push(await resourceView(r));
    return out;
  });

  /** People who can be named the owner of a person-resource: anyone with a staff role in this church. */
  app.get('/resources/owners', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'resources.manage');
    return ctx.db.query<any>(`SELECT DISTINCT u.id, u.name FROM role_assignments ra JOIN users u ON u.id=ra.user_id WHERE ra.org_id=$1 ORDER BY u.name`, [g.orgId]);
  });

  async function resourceFields(b: any, existing?: any) {
    const has = (k: string) => k in b;
    const kind = has('kind') || !existing ? b.kind : existing.kind;
    if (!['person', 'place', 'thing'].includes(kind)) throw new HttpError(400, 'Choose person, place or thing', 'bad_kind');
    const slot = has('slotMinutes') || !existing ? intIn(b.slotMinutes, 15, 480, 'The booking length', 60) : existing.slot_minutes;
    if (480 % slot !== 0 && slot % 15 !== 0) throw new HttpError(400, 'The booking length must be a multiple of 15 minutes', 'bad_number');
    let maxMinutes: number | null = has('maxMinutes') ? (b.maxMinutes === null || b.maxMinutes === '' ? null : intIn(b.maxMinutes, slot, 24 * 60, 'The longest booking')) : existing?.max_minutes ?? null;
    if (maxMinutes !== null && maxMinutes % slot !== 0) throw new HttpError(400, 'The longest booking must be a whole number of booking lengths', 'bad_number');
    let price: number | null = existing?.price == null ? null : Number(existing.price);
    if (has('price')) {
      price = null;
      if (b.price !== null && b.price !== '' && b.price !== undefined) {
        price = parseKes(b.price, { min: 0, max: 1_000_000, label: 'the price' });
        if (price === 0) price = null;
        else if (price < 1000 || price > 15_000_000) throw new HttpError(400, 'A price must be between KES 10 and KES 150,000', 'bad_amount');
      }
    }
    const approval = has('approval') || !existing ? (b.approval === 'auto' ? 'auto' : 'manual') : existing.approval;
    return {
      kind,
      name: has('name') || !existing ? text(b.name, 80, 'name', true)! : existing.name,
      description: has('description') ? text(b.description, 500, 'description') : existing?.description ?? null,
      capacity: has('capacity') ? (b.capacity === null || b.capacity === '' ? null : intIn(b.capacity, 1, 100000, 'Capacity')) : existing?.capacity ?? null,
      slot, maxMinutes, price,
      pricePer: has('pricePer') ? (b.pricePer === 'hour' ? 'hour' : 'booking') : existing?.price_per ?? 'booking',
      hours: has('hours') || !existing ? validateHours(b.hours) : existing.hours,
      minNotice: has('minNoticeHours') || !existing ? intIn(b.minNoticeHours, 0, 24 * 60, 'Minimum notice', 24) : existing.min_notice_hours,
      maxAdvance: has('maxAdvanceDays') || !existing ? intIn(b.maxAdvanceDays, 1, 730, 'Days ahead', 90) : existing.max_advance_days,
      approval,
      owner: has('ownerUserId') ? (b.ownerUserId ? String(b.ownerUserId) : null) : existing?.owner_user_id ?? null,
    };
  }

  async function checkOwner(orgId: string, ownerId: string | null) {
    if (!ownerId) return;
    const ok = (await ctx.db.query<any>(`SELECT 1 FROM role_assignments WHERE org_id=$1 AND user_id=$2 LIMIT 1`, [orgId, ownerId]))[0];
    if (!ok) throw new HttpError(400, 'The owner must be someone on your church team', 'bad_owner');
  }

  app.post('/resources', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const g = await grantsFor(ctx, req, 'resources.manage');
    const branchId = b.branchId ? String(b.branchId) : null;
    if (branchId) {
      if (!g.branchIds.includes(branchId)) throw new HttpError(403, 'You do not manage that branch', 'forbidden');
    } else if (!g.wholeOrg) throw new HttpError(403, 'Only people who manage every branch can set up a church-wide resource', 'forbidden');
    const f = await resourceFields(b);
    await checkOwner(g.orgId, f.owner);
    if ((await ctx.db.query<any>(`SELECT 1 FROM resources WHERE org_id=$1 AND lower(name)=lower($2) AND COALESCE(branch_id,'')=$3`, [g.orgId, f.name, branchId ?? '']))[0]) throw new HttpError(409, 'There is already a resource with that name', 'duplicate');
    const id = ctx.newId('res');
    const now = nowIso();
    await ctx.db.query(
      `INSERT INTO resources (id, org_id, branch_id, kind, name, description, capacity, owner_user_id, slot_minutes, max_minutes, hours, min_notice_hours, max_advance_days, approval, price, price_per, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)`,
      [id, g.orgId, branchId, f.kind, f.name, f.description, f.capacity, f.owner, f.slot, f.maxMinutes, JSON.stringify(f.hours), f.minNotice, f.maxAdvance, f.approval, f.price, f.pricePer, req.session!.uid, now],
    );
    const r = (await ctx.db.query<any>(`SELECT * FROM resources WHERE id=$1`, [id]))[0];
    const flat = await resourceFlat(r);
    const evt = await ctx.ledger.audit({ orgId: g.orgId, branchId, actor: req.session!.uid, action: 'resource.create', entity: 'resource', entityId: id, summary: `Set up the ${f.kind} "${f.name}" for booking`, changes: diff(RESOURCE_SPECS, null, flat) });
    await recordVersion(ctx, { orgId: g.orgId, branchId, entity: 'resource', entityId: id, snapshot: maskedSnapshot(RESOURCE_SPECS, flat), summary: 'Created', eventId: evt });
    return { id };
  });

  app.put('/resources/:id', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const old = await staffResource(req, (req.params as any).id, 'resources.manage');
    const f = await resourceFields(b, old);
    if ('ownerUserId' in b) await checkOwner(old.org_id, f.owner);
    const before = await resourceFlat(old);
    await ctx.db.query(
      `UPDATE resources SET kind=$2, name=$3, description=$4, capacity=$5, owner_user_id=$6, slot_minutes=$7, max_minutes=$8, hours=$9, min_notice_hours=$10, max_advance_days=$11, approval=$12, price=$13, price_per=$14, updated_at=$15 WHERE id=$1`,
      [old.id, f.kind, f.name, f.description, f.capacity, f.owner, f.slot, f.maxMinutes, JSON.stringify(f.hours), f.minNotice, f.maxAdvance, f.approval, f.price, f.pricePer, nowIso()],
    );
    const r = (await ctx.db.query<any>(`SELECT * FROM resources WHERE id=$1`, [old.id]))[0];
    const flat = await resourceFlat(r);
    const changes = diff(RESOURCE_SPECS, before, flat);
    if (changes.length) {
      const evt = await ctx.ledger.audit({ orgId: old.org_id, branchId: old.branch_id, actor: req.session!.uid, action: 'resource.update', entity: 'resource', entityId: old.id, summary: `Changed "${f.name}"`, changes });
      await recordVersion(ctx, { orgId: old.org_id, branchId: old.branch_id, entity: 'resource', entityId: old.id, snapshot: maskedSnapshot(RESOURCE_SPECS, flat), summary: changes.map((c) => c.label).join(', '), eventId: evt });
    }
    return { id: old.id };
  });

  app.post('/resources/:id/active', auth, async (req) => {
    const old = await staffResource(req, (req.params as any).id, 'resources.manage');
    const active = (req.body as any)?.active !== false;
    await ctx.db.query(`UPDATE resources SET active=$2, updated_at=$3 WHERE id=$1`, [old.id, active, nowIso()]);
    await ctx.ledger.audit({ orgId: old.org_id, branchId: old.branch_id, actor: req.session!.uid, action: 'resource.update', entity: 'resource', entityId: old.id, summary: `${active ? 'Made available' : 'Took out of service'}: "${old.name}"`, changes: [{ field: 'active', label: 'Available', before: old.active, after: active }] });
    return { id: old.id, active };
  });

  app.get('/resources/:id/blocks', auth, async (req) => {
    const r = await staffResource(req, (req.params as any).id, 'bookings.view');
    return ctx.db.query<any>(`SELECT id, starts_at, ends_at, reason FROM resource_blocks WHERE resource_id=$1 AND removed_at IS NULL AND ends_at > $2 ORDER BY starts_at`, [r.id, nowIso()]);
  });

  app.post('/resources/:id/blocks', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const r = await staffResource(req, (req.params as any).id, 'resources.manage');
    const s = Date.parse(String(b.startsAt));
    const e = Date.parse(String(b.endsAt));
    if (Number.isNaN(s) || Number.isNaN(e) || e <= s) throw new HttpError(400, 'Choose a start and an end after it', 'bad_time');
    const sIso = new Date(s).toISOString();
    const eIso = new Date(e).toISOString();
    if (await conflictWith(r.id, sIso, eIso)) throw new HttpError(409, 'There is already a booking at that time. Cancel it first, then block the time.', 'has_bookings');
    const id = ctx.newId('blk');
    const reason = text(b.reason, 120, 'reason');
    await ctx.db.query(`INSERT INTO resource_blocks (id, resource_id, org_id, starts_at, ends_at, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, r.id, r.org_id, sIso, eIso, reason, req.session!.uid]);
    await ctx.ledger.audit({ orgId: r.org_id, branchId: r.branch_id, actor: req.session!.uid, action: 'resource.block', entity: 'resource', entityId: r.id, summary: `Blocked "${r.name}" from ${fmtTime(sIso)} to ${fmtTime(eIso)}`, reason });
    return { id };
  });

  app.post('/resources/:id/blocks/:bid/remove', auth, async (req) => {
    const r = await staffResource(req, (req.params as any).id, 'resources.manage');
    const x = await ctx.db.query<any>(`UPDATE resource_blocks SET removed_at=$3 WHERE id=$1 AND resource_id=$2 AND removed_at IS NULL RETURNING id`, [(req.params as any).bid, r.id, nowIso()]);
    if (x.length === 0) throw new HttpError(404, 'not found', 'not_found');
    await ctx.ledger.audit({ orgId: r.org_id, branchId: r.branch_id, actor: req.session!.uid, action: 'resource.unblock', entity: 'resource', entityId: r.id, summary: `Removed a blocked time from "${r.name}"` });
    return { ok: true };
  });

  // ======================= booking flow =======================

  async function itemsOf(bookingId: string) {
    return ctx.db.query<any>(
      `SELECT i.resource_id, i.status, i.decided_by, i.decided_at, i.reason, r.name, r.kind, r.owner_user_id, r.branch_id, r.approval, r.price, r.price_per
         FROM booking_items i JOIN resources r ON r.id=i.resource_id WHERE i.booking_id=$1 ORDER BY r.name`,
      [bookingId],
    );
  }

  /** Moves a booking on once every resource has answered. */
  async function progress(bookingId: string): Promise<string> {
    const b = (await ctx.db.query<any>(`SELECT * FROM bookings WHERE id=$1`, [bookingId]))[0];
    if (b.status !== 'requested') return b.status;
    const items = await itemsOf(bookingId);
    const declined = items.find((i) => i.status === 'declined');
    if (declined) {
      await ctx.db.query(`UPDATE bookings SET status='declined', reason=$2, updated_at=$3 WHERE id=$1`, [b.id, declined.reason ?? `${declined.name} cannot take this booking`, nowIso()]);
      await ctx.ledger.audit({ orgId: b.org_id, branchId: b.branch_id, actorType: 'system', action: 'booking.declined', entity: 'booking', entityId: b.id, summary: `Booking "${b.title}" was declined` });
      await notify(b.org_id, [b.requester_id], 'Your booking was not accepted', `"${b.title}" on ${fmtTime(b.starts_at)}: ${declined.reason ?? `${declined.name} cannot take this booking`}`, 'member:bookings');
      return 'declined';
    }
    if (items.some((i) => i.status !== 'approved')) return 'requested';
    for (const i of items) {
      if (await conflictWith(i.resource_id, b.starts_at, b.ends_at, b.id)) {
        await ctx.db.query(`UPDATE bookings SET status='declined', reason='That time was taken by another booking', updated_at=$2 WHERE id=$1`, [b.id, nowIso()]);
        await ctx.ledger.audit({ orgId: b.org_id, branchId: b.branch_id, actorType: 'system', action: 'booking.declined', entity: 'booking', entityId: b.id, summary: `Booking "${b.title}" was declined because the time was taken` });
        await notify(b.org_id, [b.requester_id], 'Your booking was not accepted', `"${b.title}": that time was taken by another booking. Please pick another time.`, 'member:bookings');
        return 'declined';
      }
    }
    const paid = b.price != null && Number(b.price) > 0 && !b.payment_id;
    const status = paid ? 'awaiting_payment' : 'confirmed';
    await ctx.db.query(`UPDATE bookings SET status=$2, hold_until=$3, updated_at=$4 WHERE id=$1`, [b.id, status, paid ? new Date(ctx.clock.now().getTime() + HOLD_HOURS * 3600_000).toISOString() : null, nowIso()]);
    await ctx.ledger.audit({ orgId: b.org_id, branchId: b.branch_id, actorType: 'system', action: paid ? 'booking.awaiting_payment' : 'booking.confirmed', entity: 'booking', entityId: b.id, summary: paid ? `Booking "${b.title}" approved, waiting for payment` : `Booking "${b.title}" confirmed`, meta: { price: b.price == null ? 0 : Number(b.price) } });
    await notify(b.org_id, [b.requester_id], paid ? 'Booking approved: pay to confirm' : 'Your booking is confirmed',
      paid ? `"${b.title}" on ${fmtTime(b.starts_at)} is approved. Pay within ${HOLD_HOURS} hours to keep the time.` : `"${b.title}" is confirmed for ${fmtTime(b.starts_at)}.`, 'member:bookings');
    return status;
  }

  async function memberOrgs(uid: string): Promise<string[]> {
    return (await ctx.db.query<any>(`SELECT DISTINCT org_id FROM memberships WHERE user_id=$1 AND status='active'`, [uid])).map((r) => r.org_id);
  }

  async function bookingView(b: any, viewer: { uid: string; canDecide: (item: any) => boolean }, includeNote: boolean) {
    const items = await itemsOf(b.id);
    const mayDecide = items.some((i) => viewer.canDecide(i));
    const hoursToStart = (Date.parse(b.starts_at) - ctx.clock.now().getTime()) / 3600_000;
    const mine = b.requester_id === viewer.uid;
    return {
      id: b.id, code: b.code, title: b.title, startsAt: b.starts_at, endsAt: b.ends_at, status: b.status, reason: b.reason, attendees: b.attendees,
      requester: b.requester_name, price: b.price == null ? null : Number(b.price), holdUntil: b.hold_until, paid: !!b.payment_id,
      note: includeNote && (mine || mayDecide) ? b.note : undefined,
      items: items.map((i) => ({ resourceId: i.resource_id, name: i.name, kind: i.kind, status: i.status, reason: i.reason, mine: viewer.canDecide(i) })),
      canCancel: mine && ['requested', 'awaiting_payment', 'confirmed'].includes(b.status) && hoursToStart >= CANCEL_CUTOFF_HOURS,
      meetingUrl: mine || mayDecide ? b.meeting_url ?? null : undefined,
      payUrl: b.status === 'awaiting_payment' && mine ? `${ctx.givingUrl}/?booking=${b.code}` : null,
      payCode: b.status === 'awaiting_payment' ? `BK-${b.code}` : null,
    };
  }

  app.post('/me/bookings', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const uid = req.session!.uid;
    const ids: string[] = [...new Set<string>((Array.isArray(b.resourceIds) ? b.resourceIds : [b.resourceId]).filter(Boolean).map(String))];
    if (ids.length === 0 || ids.length > 5) throw new HttpError(400, 'Choose one to five things to book', 'bad_resources');
    const orgs = await memberOrgs(uid);
    const resources: any[] = [];
    for (const id of ids) {
      const r = (await ctx.db.query<any>(`SELECT * FROM resources WHERE id=$1`, [id]))[0];
      if (!r || !r.active || !orgs.includes(r.org_id)) throw new HttpError(404, 'That is not available for booking', 'not_found');
      resources.push(r);
    }
    if (new Set(resources.map((r) => r.org_id)).size > 1) throw new HttpError(400, 'Everything in one booking must belong to the same church', 'bad_resources');
    const orgId = resources[0].org_id;
    const start = new Date(String(b.startsAt)).getTime();
    const end = new Date(String(b.endsAt)).getTime();
    if (Number.isNaN(start) || Number.isNaN(end)) throw new HttpError(400, 'Choose a start time and an end time', 'bad_time');
    const startsAt = new Date(start).toISOString();
    const endsAt = new Date(end).toISOString();
    const attendees = b.attendees === undefined || b.attendees === null || b.attendees === '' ? null : intIn(b.attendees, 1, 100000, 'Number of people');
    for (const r of resources) {
      await checkWindow(r, startsAt, endsAt);
      if (attendees !== null && r.capacity !== null && attendees > r.capacity) throw new HttpError(400, `${r.name} holds up to ${r.capacity} people`, 'over_capacity');
      if (await conflictWith(r.id, startsAt, endsAt)) throw new HttpError(409, `${r.name} is already booked then. Pick another time.`, 'time_taken');
    }
    const open = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM bookings WHERE requester_id=$1 AND status IN ('requested','awaiting_payment')`, [uid]))[0].n);
    if (open >= 10) throw new HttpError(429, 'You have 10 bookings waiting already. Wait for some to be answered first.', 'too_many');
    const minutes = Math.round((end - start) / 60_000);
    const total = resources.reduce((s, r) => s + priceOf(r, minutes), 0);
    const title = text(b.title, 80, 'reason for the booking', true)!;
    const name = (await ctx.db.query<any>(`SELECT full_name FROM memberships WHERE user_id=$1 AND org_id=$2 AND status='active' ORDER BY joined_at LIMIT 1`, [uid, orgId]))[0]?.full_name ?? req.session!.name;
    const id = ctx.newId('bkg');
    const now = nowIso();
    await ctx.db.tx(async (q) => {
      await q.query(`INSERT INTO bookings (id, code, org_id, branch_id, requester_id, requester_name, title, note, attendees, starts_at, ends_at, price, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
        [id, newCode(), orgId, resources[0].branch_id, uid, name, title, text(b.note, 500, 'note'), attendees, startsAt, endsAt, total > 0 ? total : null, now]);
      for (const r of resources) {
        const auto = r.approval === 'auto' && r.owner_user_id !== uid;
        await q.query(`INSERT INTO booking_items (booking_id, resource_id, org_id, status, decided_at, reason) VALUES ($1,$2,$3,$4,$5,$6)`, [id, r.id, orgId, auto ? 'approved' : 'requested', auto ? now : null, auto ? 'Approved automatically' : null]);
      }
    });
    // The log records the request, never what the member wrote in the note (L148).
    await ctx.ledger.audit({ orgId, branchId: resources[0].branch_id, actor: uid, action: 'booking.request', entity: 'booking', entityId: id, summary: `Asked to book ${resources.map((r) => r.name).join(' and ')} on ${fmtTime(startsAt)}`, meta: { resources: ids } });
    const pending = resources.filter((r) => !(r.approval === 'auto' && r.owner_user_id !== uid));
    for (const r of pending) await notify(orgId, [r.owner_user_id, ...(await deciderUsers(orgId, r.branch_id))].filter((u) => u !== uid), 'New booking request', `${name} asked for ${r.name} on ${fmtTime(startsAt)}.`, `staff:bookings?open=${id}`, 'staff');
    const status = await progress(id);
    const row = (await ctx.db.query<any>(`SELECT * FROM bookings WHERE id=$1`, [id]))[0];
    return bookingView(row, { uid, canDecide: () => false }, true).then((v) => ({ ...v, status }));
  });

  app.get('/me/bookings', auth, async (req) => {
    const uid = req.session!.uid;
    const rows = await ctx.db.query<any>(`SELECT * FROM bookings WHERE requester_id=$1 ORDER BY starts_at DESC LIMIT 100`, [uid]);
    const out = [];
    for (const b of rows) out.push(await bookingView(b, { uid, canDecide: () => false }, true));
    return out;
  });

  async function cancelBooking(b: any, actorId: string, byStaff: boolean, reason: string | null) {
    await ctx.db.query(`UPDATE bookings SET status='cancelled', reason=$2, updated_at=$3 WHERE id=$1`, [b.id, reason, nowIso()]);
    const items = await itemsOf(b.id);
    await ctx.ledger.audit({ orgId: b.org_id, branchId: b.branch_id, actor: actorId, action: 'booking.cancel', entity: 'booking', entityId: b.id, summary: `${byStaff ? 'Church cancelled' : 'Member cancelled'} the booking "${b.title}"`, reason, meta: { paid: !!b.payment_id } });
    const who = byStaff ? [b.requester_id] : [...new Set(items.map((i) => i.owner_user_id))];
    await notify(b.org_id, who, 'A booking was cancelled', `"${b.title}" on ${fmtTime(b.starts_at)} was cancelled${reason ? `: ${reason}` : '.'}${b.payment_id ? ' It was paid, so the church will arrange any refund with you.' : ''}`, byStaff ? 'member:bookings' : `staff:bookings?open=${b.id}`, byStaff ? 'member' : 'staff');
  }

  app.post('/me/bookings/:id/cancel', auth, async (req) => {
    const b = (await ctx.db.query<any>(`SELECT * FROM bookings WHERE id=$1 AND requester_id=$2`, [(req.params as any).id, req.session!.uid]))[0];
    if (!b) throw new HttpError(404, 'booking not found', 'not_found');
    if (!['requested', 'awaiting_payment', 'confirmed'].includes(b.status)) throw new HttpError(409, 'This booking can no longer be cancelled', 'wrong_state');
    if ((Date.parse(b.starts_at) - ctx.clock.now().getTime()) / 3600_000 < CANCEL_CUTOFF_HOURS) throw new HttpError(409, `Bookings can be cancelled until ${CANCEL_CUTOFF_HOURS} hours before the start. Please contact the church.`, 'too_late');
    await cancelBooking(b, req.session!.uid, false, text((req.body as any)?.reason, 200, 'reason'));
    return { id: b.id, status: 'cancelled' };
  });

  // ---------- what members may book ----------

  app.get('/me/resources', auth, async (req) => {
    const orgs = await memberOrgs(req.session!.uid);
    if (orgs.length === 0) return [];
    const rows = await ctx.db.query<any>(
      `SELECT r.*, o.name AS church, b.name AS branch_name FROM resources r JOIN organisations o ON o.id=r.org_id LEFT JOIN branches b ON b.id=r.branch_id WHERE r.org_id = ANY($1::text[]) AND r.active ORDER BY r.kind, r.name`,
      [orgs],
    );
    return rows.map((r) => ({
      id: r.id, kind: r.kind, name: r.name, description: r.description, capacity: r.capacity, church: r.church, branch: r.branch_name,
      slotMinutes: r.slot_minutes, maxMinutes: r.max_minutes, hours: r.hours, minNoticeHours: r.min_notice_hours, maxAdvanceDays: r.max_advance_days,
      approval: r.approval, price: r.price == null ? null : Number(r.price), pricePer: r.price_per,
    }));
  });

  app.get('/me/resources/:id/availability', auth, async (req) => {
    const q = req.query as any;
    const orgs = await memberOrgs(req.session!.uid);
    const r = (await ctx.db.query<any>(`SELECT * FROM resources WHERE id=$1 AND active`, [(req.params as any).id]))[0];
    if (!r || !orgs.includes(r.org_id)) throw new HttpError(404, 'That is not available for booking', 'not_found');
    const date = String(q.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new HttpError(400, 'Choose a date', 'bad_date');
    const minutes = intIn(q.minutes, r.slot_minutes, r.max_minutes ?? 24 * 60, 'The length', r.slot_minutes);
    if (minutes % r.slot_minutes !== 0) throw new HttpError(400, `Choose a length in blocks of ${r.slot_minutes} minutes`, 'bad_slot');
    const slots = await freeSlots(r, date, minutes);
    return { date, minutes, slots, price: priceOf(r, minutes) || null };
  });

  // ======================= deciding =======================

  /** True when the user may answer requests for a resource: the bookings permission over its branch, or the owner of a person-resource. */
  async function deciderCheck(uid: string, orgId: string) {
    const rows = await branchesFor(ctx.db, uid, 'bookings.manage');
    const mine = rows.filter((r) => r.orgId === orgId).map((r) => r.branchId);
    const all = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM branches WHERE org_id=$1`, [orgId]))[0].n);
    return (item: any) => item.owner_user_id === uid || (item.branch_id ? mine.includes(item.branch_id) : mine.length === all && all > 0);
  }

  async function decide(uid: string, b: any, resourceIds: string[], approve: boolean, reason: string | null) {
    const can = await deciderCheck(uid, b.org_id);
    if (b.requester_id === uid) throw new HttpError(403, 'You cannot decide your own booking', 'same_person');
    if (b.status !== 'requested') throw new HttpError(409, 'This booking is not waiting for an answer', 'wrong_state');
    if (!approve && !reason) throw new HttpError(400, 'Say why, so the member can pick another time', 'reason_required');
    const items = (await itemsOf(b.id)).filter((i) => resourceIds.includes(i.resource_id));
    if (items.length === 0 || items.some((i) => !can(i))) throw new HttpError(404, 'booking not found', 'not_found');
    for (const i of items) {
      if (i.status !== 'requested') throw new HttpError(409, `${i.name} has already been answered`, 'already_decided');
      if (approve && (await conflictWith(i.resource_id, b.starts_at, b.ends_at, b.id))) throw new HttpError(409, `${i.name} is already booked at that time, so this cannot be approved`, 'time_taken');
    }
    const now = nowIso();
    for (const i of items) await ctx.db.query(`UPDATE booking_items SET status=$3, decided_by=$4, decided_at=$5, reason=$6 WHERE booking_id=$1 AND resource_id=$2`, [b.id, i.resource_id, approve ? 'approved' : 'declined', uid, now, approve ? null : reason]);
    await ctx.ledger.audit({ orgId: b.org_id, branchId: b.branch_id, actor: uid, action: approve ? 'booking.approve' : 'booking.decline', entity: 'booking', entityId: b.id, summary: `${approve ? 'Approved' : 'Declined'} ${items.map((i) => i.name).join(' and ')} for the booking "${b.title}"`, reason, meta: { resources: items.map((i) => i.resource_id) } });
    return progress(b.id);
  }

  app.post('/bookings/:id/items/:rid/decide', auth, async (req) => {
    const b = (await ctx.db.query<any>(`SELECT * FROM bookings WHERE id=$1`, [(req.params as any).id]))[0];
    if (!b) throw new HttpError(404, 'booking not found', 'not_found');
    const body = (req.body ?? {}) as any;
    const status = await decide(req.session!.uid, b, [(req.params as any).rid], body.approve !== false, text(body.reason, 200, 'reason'));
    return { id: b.id, status };
  });

  // The owner of a person-resource answers requests for their own diary, with or without the bookings permission.
  app.get('/me/diary', auth, async (req) => {
    const uid = req.session!.uid;
    const rows = await ctx.db.query<any>(
      `SELECT DISTINCT b.* FROM bookings b JOIN booking_items i ON i.booking_id=b.id JOIN resources r ON r.id=i.resource_id
        WHERE r.owner_user_id=$1 AND b.status IN ('requested','awaiting_payment','confirmed') AND b.ends_at >= $2 ORDER BY b.starts_at LIMIT 100`,
      [uid, nowIso()],
    );
    const out = [];
    for (const b of rows) out.push(await bookingView(b, { uid, canDecide: (i) => i.owner_user_id === uid }, true));
    return out;
  });

  app.post('/me/diary/:id/decide', auth, async (req) => {
    const uid = req.session!.uid;
    const b = (await ctx.db.query<any>(`SELECT * FROM bookings WHERE id=$1`, [(req.params as any).id]))[0];
    const mine = b ? (await itemsOf(b.id)).filter((i) => i.owner_user_id === uid && i.status === 'requested').map((i) => i.resource_id) : [];
    if (!b || mine.length === 0) throw new HttpError(404, 'booking not found', 'not_found');
    const body = (req.body ?? {}) as any;
    return { id: b.id, status: await decide(uid, b, mine, body.approve !== false, text(body.reason, 200, 'reason')) };
  });

  // ======================= staff bookings and calendar =======================

  async function scopeFilter(req: FastifyRequest) {
    const g = await grantsFor(ctx, req, 'bookings.view');
    const can = await deciderCheck(req.session!.uid, g.orgId).catch(() => (() => false) as (i: any) => boolean);
    const sees = (item: any) => (item.branch_id ? g.branchIds.includes(item.branch_id) : g.wholeOrg);
    return { g, can, sees };
  }

  app.get('/bookings', auth, async (req) => {
    const q = req.query as any;
    const { g, can, sees } = await scopeFilter(req);
    const params: unknown[] = [g.orgId];
    let where = `b.org_id=$1`;
    if (q.status) { params.push(String(q.status).split(',')); where += ` AND b.status = ANY($${params.length}::text[])`; }
    if (q.from) { params.push(new Date(String(q.from)).toISOString()); where += ` AND b.ends_at >= $${params.length}`; }
    if (q.to) { params.push(new Date(String(q.to)).toISOString()); where += ` AND b.starts_at <= $${params.length}`; }
    // Search by booking code, the member's name or the reason for the booking. Wildcard characters typed by the user are taken literally.
    const term = String(q.q ?? '').trim().slice(0, 60);
    if (term) { params.push(`%${term.replace(/[!%_]/g, (c) => `!${c}`)}%`); where += ` AND (b.code ILIKE $${params.length} ESCAPE '!' OR b.requester_name ILIKE $${params.length} ESCAPE '!' OR b.title ILIKE $${params.length} ESCAPE '!')`; }
    if (q.resource) { params.push(String(q.resource)); where += ` AND EXISTS (SELECT 1 FROM booking_items i WHERE i.booking_id=b.id AND i.resource_id=$${params.length})`; }
    const rows = await ctx.db.query<any>(`SELECT b.* FROM bookings b WHERE ${where} ORDER BY b.starts_at DESC LIMIT 300`, params);
    const out = [];
    for (const b of rows) {
      const items = await itemsOf(b.id);
      if (!items.some(sees)) continue;
      out.push(await bookingView(b, { uid: req.session!.uid, canDecide: can }, true));
    }
    return out;
  });

  app.get('/bookings/:id', auth, async (req) => {
    const { g, can, sees } = await scopeFilter(req);
    const b = (await ctx.db.query<any>(`SELECT * FROM bookings WHERE id=$1 AND org_id=$2`, [(req.params as any).id, g.orgId]))[0];
    if (!b || !(await itemsOf(b.id)).some(sees)) throw new HttpError(404, 'booking not found', 'not_found');
    return bookingView(b, { uid: req.session!.uid, canDecide: can }, true);
  });

  app.post('/bookings/:id/cancel', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'bookings.manage');
    const b = (await ctx.db.query<any>(`SELECT * FROM bookings WHERE id=$1 AND org_id=$2`, [(req.params as any).id, g.orgId]))[0];
    const items = b ? await itemsOf(b.id) : [];
    if (!b || !items.some((i) => (i.branch_id ? g.branchIds.includes(i.branch_id) : g.wholeOrg))) throw new HttpError(404, 'booking not found', 'not_found');
    if (!['requested', 'awaiting_payment', 'confirmed'].includes(b.status)) throw new HttpError(409, 'This booking can no longer be cancelled', 'wrong_state');
    const reason = text((req.body as any)?.reason, 200, 'reason', true);
    await cancelBooking(b, req.session!.uid, true, reason);
    return { id: b.id, status: 'cancelled' };
  });

  /**
   * The person a booking is with, or a manager, adds a meeting link (any https link) for a call or video session. Only the member and the
   * people who look after the booking can see it. There is no video provider and nothing is recorded (L225).
   */
  app.post('/bookings/:id/meeting-link', auth, async (req) => {
    const uid = req.session!.uid;
    const b = (await ctx.db.query<any>(`SELECT * FROM bookings WHERE id=$1`, [(req.params as any).id]))[0];
    if (!b) throw new HttpError(404, 'booking not found', 'not_found');
    const can = await deciderCheck(uid, b.org_id);
    if (!(await itemsOf(b.id)).some((i) => can(i))) throw new HttpError(404, 'booking not found', 'not_found');
    if (!['approved', 'awaiting_payment', 'confirmed'].includes(b.status)) throw new HttpError(409, 'A meeting link can be added once the booking is approved', 'wrong_state');
    const raw = (req.body as any)?.url;
    const url = raw === null || raw === '' || raw === undefined ? null : String(raw).trim();
    if (url !== null && !/^https:\/\/[^\s]{4,290}$/i.test(url)) throw new HttpError(400, 'The meeting link must start with https://', 'bad_link');
    await ctx.db.query(`UPDATE bookings SET meeting_url=$2, updated_at=$3 WHERE id=$1`, [b.id, url, nowIso()]);
    await ctx.ledger.audit({ orgId: b.org_id, branchId: b.branch_id, actor: uid, action: 'booking.meeting_link', entity: 'booking', entityId: b.id, summary: url ? `Added a meeting link to the booking "${b.title}"` : `Removed the meeting link from the booking "${b.title}"` });
    if (url) await notify(b.org_id, [b.requester_id], 'Your meeting link is ready', `The link for "${b.title}" is now in your booking. Open Bookings to join at the time.`, 'member:bookings');
    return { ok: true, meetingUrl: url };
  });

  /** After the time has passed, staff record whether it happened (L145). */
  app.post('/bookings/:id/complete', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'bookings.manage');
    const b = (await ctx.db.query<any>(`SELECT * FROM bookings WHERE id=$1 AND org_id=$2`, [(req.params as any).id, g.orgId]))[0];
    const items = b ? await itemsOf(b.id) : [];
    if (!b || !items.some((i) => (i.branch_id ? g.branchIds.includes(i.branch_id) : g.wholeOrg))) throw new HttpError(404, 'booking not found', 'not_found');
    if (b.status !== 'confirmed') throw new HttpError(409, 'Only a confirmed booking can be marked as done', 'wrong_state');
    if (b.starts_at > nowIso()) throw new HttpError(409, 'This booking has not started yet', 'too_early');
    const outcome = (req.body as any)?.outcome === 'no_show' ? 'no_show' : 'completed';
    await ctx.db.query(`UPDATE bookings SET status=$2, updated_at=$3 WHERE id=$1`, [b.id, outcome, nowIso()]);
    await ctx.ledger.audit({ orgId: b.org_id, branchId: b.branch_id, actor: req.session!.uid, action: 'booking.complete', entity: 'booking', entityId: b.id, summary: `Marked the booking "${b.title}" as ${outcome === 'no_show' ? 'a no-show' : 'done'}` });
    return { id: b.id, status: outcome };
  });

  /** One calendar of confirmed bookings and events, within what the person manages (L147). */
  app.get('/calendar', auth, async (req) => {
    const q = req.query as any;
    const { g, sees } = await scopeFilter(req);
    const from = q.from ? new Date(String(q.from)).toISOString() : nowIso();
    const to = q.to ? new Date(String(q.to)).toISOString() : new Date(Date.parse(from) + 31 * 86400_000).toISOString();
    const out: any[] = [];
    const bs = await ctx.db.query<any>(`SELECT * FROM bookings WHERE org_id=$1 AND status IN ('confirmed','awaiting_payment') AND ends_at >= $2 AND starts_at <= $3 ORDER BY starts_at`, [g.orgId, from, to]);
    for (const b of bs) {
      const items = await itemsOf(b.id);
      if (!items.some(sees)) continue;
      if (q.resource && !items.some((i) => i.resource_id === q.resource)) continue;
      out.push({ type: 'booking', id: b.id, title: b.title, startsAt: b.starts_at, endsAt: b.ends_at, status: b.status, resources: items.map((i) => i.name), who: b.requester_name });
    }
    if (!q.resource) {
      const ev = await branchesFor(ctx.db, req.session!.uid, 'events.view');
      const evBranches = ev.filter((r) => r.orgId === g.orgId).map((r) => r.branchId);
      if (evBranches.length) {
        const es = await ctx.db.query<any>(`SELECT * FROM events WHERE org_id=$1 AND status='scheduled' AND COALESCE(ends_at, starts_at) >= $2 AND starts_at <= $3 ORDER BY starts_at`, [g.orgId, from, to]);
        for (const e of es) if (e.branch_id ? evBranches.includes(e.branch_id) : g.wholeOrg) out.push({ type: 'event', id: e.id, title: e.title, startsAt: e.starts_at, endsAt: e.ends_at, status: e.status, resources: e.location ? [e.location] : [], who: null });
      }
    }
    return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  });

  // ======================= paying for a booking =======================

  app.get('/public/booking/:code', async (req) => {
    const b = (await ctx.db.query<any>(`SELECT * FROM bookings WHERE code=$1 AND status='awaiting_payment' AND hold_until > $2`, [String((req.params as any).code).toUpperCase(), nowIso()]))[0];
    if (!b) throw new HttpError(404, 'There is no booking waiting for payment under that link. It may already be paid, or the time may have been released.', 'not_found');
    const items = await itemsOf(b.id);
    const branch = (await ctx.db.query<any>(`SELECT code, name FROM branches WHERE id=COALESCE($2, (SELECT id FROM branches WHERE org_id=$1 ORDER BY code LIMIT 1))`, [b.org_id, b.branch_id]))[0];
    return { code: b.code, title: b.title, price: Number(b.price), startsAt: b.starts_at, endsAt: b.ends_at, holdUntil: b.hold_until, resources: items.map((i) => i.name), churchCode: branch.code, church: branch.name, purpose: `BK-${b.code}` };
  });
}

/** A booking's payment arrived (reference BK-code): it is confirmed (L144). */
export async function bookingPaid(ctx: Ctx, code: string, paymentId: string): Promise<void> {
  const now = ctx.clock.now().toISOString();
  const b = (await ctx.db.query<any>(`UPDATE bookings SET status='confirmed', payment_id=$2, hold_until=NULL, updated_at=$3 WHERE code=$1 AND status='awaiting_payment' RETURNING *`, [code, paymentId, now]))[0];
  if (!b) return;
  await ctx.ledger.audit({ orgId: b.org_id, branchId: b.branch_id, actorType: 'psp', action: 'booking.paid', entity: 'booking', entityId: b.id, summary: `Payment received for the booking "${b.title}". It is confirmed.`, links: { paymentId } });
  await addNotification(ctx, { orgId: b.org_id, userId: b.requester_id, kind: 'announcement', title: 'Booking confirmed', body: `Payment received. "${b.title}" is confirmed for ${fmtTime(b.starts_at)}.`, link: 'member:bookings' });
}

/** Releases unpaid holds after 24 hours and sends reminders a day before (L144, L146). Run by the scheduler and after the development clock moves. */
export async function runBookingJobs(ctx: Ctx): Promise<{ lapsed: number; reminders: number }> {
  const now = ctx.clock.now().toISOString();
  const lapsed = await ctx.db.query<any>(`UPDATE bookings SET status='lapsed', reason='Not paid in time', updated_at=$1 WHERE status='awaiting_payment' AND hold_until <= $1 RETURNING *`, [now]);
  for (const b of lapsed) {
    await ctx.ledger.audit({ orgId: b.org_id, branchId: b.branch_id, actorType: 'system', action: 'booking.lapsed', entity: 'booking', entityId: b.id, summary: `The booking "${b.title}" was released because it was not paid in time` });
    await addNotification(ctx, { orgId: b.org_id, userId: b.requester_id, kind: 'announcement', title: 'Booking released', body: `"${b.title}" was released because payment did not arrive within 24 hours. You can book again.`, link: 'member:book' });
  }
  const due = await ctx.db.query<any>(`UPDATE bookings SET reminder_sent=true WHERE status='confirmed' AND NOT reminder_sent AND starts_at > $1 AND starts_at <= $2 RETURNING *`, [now, new Date(ctx.clock.now().getTime() + 24 * 3600_000).toISOString()]);
  for (const b of due) {
    const owners = (await ctx.db.query<any>(`SELECT DISTINCT r.owner_user_id FROM booking_items i JOIN resources r ON r.id=i.resource_id WHERE i.booking_id=$1 AND r.owner_user_id IS NOT NULL`, [b.id])).map((r) => r.owner_user_id as string);
    for (const u of new Set([b.requester_id, ...owners])) {
      const mine = u === b.requester_id; // the person who booked sees it in the member app, the room's owner in the staff app
      await addNotification(ctx, { orgId: b.org_id, userId: u, kind: 'announcement', title: `Tomorrow: ${b.title}`, body: `${fmtTime(b.starts_at)} to ${fmtTime(b.ends_at)}.`, link: mine ? 'member:bookings' : `staff:bookings?open=${b.id}`, audience: mine ? 'member' : 'staff' });
    }
  }
  return { lapsed: lapsed.length, reminders: due.length };
}
