import type { FastifyInstance, FastifyRequest } from 'fastify';
import { diff, maskedSnapshot, recordVersion, type FieldSpec } from '../audit';
import { HttpError, requireSession, type Ctx } from '../ctx';
import { addNotification } from '../notifications';
import { notifyTicketBuyersOfCancel } from './tickets';
import { audienceLabel, audienceMatchSql, audienceOf, audienceUserIds, grantsFor, inStaffScope, type Audience } from '../scope';
import type { Permission } from '../auth';
import { formGuard } from '../abuse';

const NOTICE_SPECS: FieldSpec[] = [
  { field: 'title', label: 'Headline' },
  { field: 'body', label: 'Text' },
  { field: 'audience', label: 'Who sees it' },
  { field: 'pinned', label: 'Pinned' },
  { field: 'publishAt', label: 'Shows from' },
  { field: 'expiresAt', label: 'Shows until' },
  { field: 'status', label: 'Status' },
];
const EVENT_SPECS: FieldSpec[] = [
  { field: 'title', label: 'Title' },
  { field: 'description', label: 'Description' },
  { field: 'location', label: 'Place' },
  { field: 'startsAt', label: 'Starts' },
  { field: 'endsAt', label: 'Ends' },
  { field: 'audience', label: 'Who it is for' },
  { field: 'rsvp', label: 'Asks for replies' },
  { field: 'capacity', label: 'Capacity' },
  { field: 'status', label: 'Status' },
];

const MAX_GUESTS = 10;

const text = (v: unknown, max: number, label: string, required = false) => {
  const s = String(v ?? '').trim().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  if (required && !s) throw new HttpError(400, `Enter the ${label}`, 'bad_content');
  if (s.length > max) throw new HttpError(400, `The ${label} can be at most ${max} characters`, 'bad_content');
  return s || null;
};

/** Notices, events and group walls (L133 to L139). */
export function communityRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };
  const nowIso = () => ctx.clock.now().toISOString();

  // Events, groups and notices are all member-app things.
  const notify = async (orgId: string, userIds: string[], title: string, body: string, link?: string) => {
    for (const u of [...new Set(userIds)]) await addNotification(ctx, { orgId, userId: u, kind: 'announcement', title, body, link });
  };

  function when(raw: unknown, label: string): string | null {
    if (raw === undefined || raw === null || raw === '') return null;
    const d = new Date(String(raw));
    if (Number.isNaN(d.getTime())) throw new HttpError(400, `Choose a valid ${label}`, 'bad_date');
    return d.toISOString();
  }

  async function staffRow(req: FastifyRequest, table: 'notices' | 'events', id: string, perm: Permission) {
    const r = (await ctx.db.query<any>(`SELECT * FROM ${table} WHERE id=$1`, [id]))[0];
    if (!r || !(await inStaffScope(ctx, req, perm, r.org_id, r.branch_id))) throw new HttpError(404, 'not found', 'not_found');
    return r;
  }

  // ======================= notices, staff side =======================

  const noticeState = (n: any, now: string) => (n.status === 'archived' ? 'archived' : n.publish_at > now ? 'scheduled' : n.expires_at && n.expires_at <= now ? 'expired' : 'live');
  const noticeFlat = async (n: any) => ({ title: n.title, body: n.body, audience: await audienceLabel(ctx, n.audience), pinned: n.pinned, publishAt: n.publish_at, expiresAt: n.expires_at ?? 'No end', status: n.status });
  const noticeView = async (n: any) => ({ id: n.id, title: n.title, body: n.body, audience: n.audience, audienceLabel: await audienceLabel(ctx, n.audience), pinned: n.pinned, publishAt: n.publish_at, expiresAt: n.expires_at, notify: n.notify, status: n.status, state: noticeState(n, nowIso()), createdBy: n.created_by_name ?? null, createdAt: n.created_at });
  const NOTICE_SELECT = `SELECT n.*, u.name AS created_by_name FROM notices n LEFT JOIN users u ON u.id=n.created_by`;

  app.get('/notices', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'notices.view');
    const rows = await ctx.db.query<any>(`${NOTICE_SELECT} WHERE n.org_id=$1 ORDER BY n.pinned DESC, n.publish_at DESC LIMIT 200`, [g.orgId]);
    const out = [];
    for (const n of rows) if (n.branch_id ? g.branchIds.includes(n.branch_id) : g.wholeOrg) out.push(await noticeView(n));
    return out;
  });

  async function noticeFields(b: any, existing?: any) {
    const publishAt = 'publishAt' in b ? when(b.publishAt, 'start time') ?? nowIso() : existing?.publish_at ?? nowIso();
    const expiresAt = 'expiresAt' in b ? when(b.expiresAt, 'end time') : existing?.expires_at ?? null;
    if (expiresAt && expiresAt <= publishAt) throw new HttpError(400, 'The end time must be after the start time', 'bad_date');
    if (expiresAt && expiresAt <= nowIso()) throw new HttpError(400, 'The end time is already past', 'bad_date');
    return {
      title: 'title' in b || !existing ? text(b.title, 80, 'headline', true)! : existing.title,
      body: 'body' in b || !existing ? text(b.body, 2000, 'text', true)! : existing.body,
      pinned: 'pinned' in b ? !!b.pinned : existing?.pinned ?? false,
      notify: 'notify' in b ? !!b.notify : existing?.notify ?? false,
      publishAt, expiresAt,
    };
  }

  app.post('/notices', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const g = await grantsFor(ctx, req, 'notices.manage');
    const aud = await audienceOf(ctx, b.audience, g);
    const f = await noticeFields(b);
    const id = ctx.newId('ntc');
    const now = nowIso();
    await ctx.db.query(
      `INSERT INTO notices (id, org_id, branch_id, title, body, audience, pinned, publish_at, expires_at, notify, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
      [id, g.orgId, aud.branchId, f.title, f.body, JSON.stringify(aud.audience), f.pinned, f.publishAt, f.expiresAt, f.notify, req.session!.uid, now],
    );
    const n = (await ctx.db.query<any>(`SELECT * FROM notices WHERE id=$1`, [id]))[0];
    const flat = await noticeFlat(n);
    const evt = await ctx.ledger.audit({ orgId: g.orgId, branchId: aud.branchId, actor: req.session!.uid, action: 'notice.create', entity: 'notice', entityId: id, summary: `Published the notice "${f.title}" to ${aud.label}`, changes: diff(NOTICE_SPECS, null, flat) });
    await recordVersion(ctx, { orgId: g.orgId, branchId: aud.branchId, entity: 'notice', entityId: id, snapshot: maskedSnapshot(NOTICE_SPECS, flat), summary: 'Created', eventId: evt });
    await runCommunityJobs(ctx); // a notice that is live now and asks to alert members goes out at once
    return { id };
  });

  app.put('/notices/:id', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const old = await staffRow(req, 'notices', (req.params as any).id, 'notices.manage');
    if (old.status === 'archived') throw new HttpError(409, 'This notice was archived and cannot be changed', 'locked');
    const g = await grantsFor(ctx, req, 'notices.manage', old.org_id);
    const aud = b.audience ? await audienceOf(ctx, b.audience, g) : { audience: old.audience as Audience, branchId: old.branch_id as string | null, label: '' };
    const f = await noticeFields(b, old);
    const before = await noticeFlat(old);
    await ctx.db.query(`UPDATE notices SET title=$2, body=$3, audience=$4, branch_id=$5, pinned=$6, publish_at=$7, expires_at=$8, notify=$9, updated_at=$10 WHERE id=$1`, [old.id, f.title, f.body, JSON.stringify(aud.audience), aud.branchId, f.pinned, f.publishAt, f.expiresAt, f.notify, nowIso()]);
    const n = (await ctx.db.query<any>(`SELECT * FROM notices WHERE id=$1`, [old.id]))[0];
    const flat = await noticeFlat(n);
    const changes = diff(NOTICE_SPECS, before, flat);
    if (changes.length) {
      const evt = await ctx.ledger.audit({ orgId: old.org_id, branchId: n.branch_id, actor: req.session!.uid, action: 'notice.update', entity: 'notice', entityId: old.id, summary: `Changed the notice "${f.title}"`, changes });
      await recordVersion(ctx, { orgId: old.org_id, branchId: n.branch_id, entity: 'notice', entityId: old.id, snapshot: maskedSnapshot(NOTICE_SPECS, flat), summary: changes.map((c) => c.label).join(', '), eventId: evt });
    }
    return { id: old.id };
  });

  app.post('/notices/:id/archive', auth, async (req) => {
    const old = await staffRow(req, 'notices', (req.params as any).id, 'notices.manage');
    if (old.status === 'archived') throw new HttpError(409, 'Already archived', 'wrong_state');
    const before = await noticeFlat(old);
    await ctx.db.query(`UPDATE notices SET status='archived', updated_at=$2 WHERE id=$1`, [old.id, nowIso()]);
    const flat = { ...before, status: 'archived' };
    const evt = await ctx.ledger.audit({ orgId: old.org_id, branchId: old.branch_id, actor: req.session!.uid, action: 'notice.archive', entity: 'notice', entityId: old.id, summary: `Took down the notice "${old.title}"`, changes: diff(NOTICE_SPECS, before, flat) });
    await recordVersion(ctx, { orgId: old.org_id, branchId: old.branch_id, entity: 'notice', entityId: old.id, snapshot: maskedSnapshot(NOTICE_SPECS, flat), summary: 'Archived', eventId: evt });
    return { id: old.id, status: 'archived' };
  });

  // ======================= notices, member side =======================

  app.get('/me/notices', auth, async (req) => {
    const rows = await ctx.db.query<any>(
      `SELECT n.id, n.title, n.body, n.pinned, n.publish_at, o.name AS church FROM notices n JOIN organisations o ON o.id=n.org_id
        WHERE n.status='published' AND n.publish_at <= $2 AND (n.expires_at IS NULL OR n.expires_at > $2) AND ${audienceMatchSql('n', '$1')}
        ORDER BY n.pinned DESC, n.publish_at DESC LIMIT 50`,
      [req.session!.uid, nowIso()],
    );
    return rows.map((n) => ({ id: n.id, title: n.title, body: n.body, pinned: n.pinned, publishedAt: n.publish_at, church: n.church }));
  });

  // ======================= events, staff side =======================

  const eventFlat = async (e: any) => ({ title: e.title, description: e.description, location: e.location, startsAt: e.starts_at, endsAt: e.ends_at ?? null, audience: await audienceLabel(ctx, e.audience), rsvp: e.rsvp, capacity: e.capacity ?? null, status: e.status });

  async function rsvpTotals(eventId: string) {
    const r = (await ctx.db.query<any>(`SELECT COUNT(*) FILTER (WHERE response='going')::int AS going, COALESCE(SUM(1+guests) FILTER (WHERE response='going'),0)::int AS people, COUNT(*) FILTER (WHERE response='not_going')::int AS declined FROM event_rsvps WHERE event_id=$1`, [eventId]))[0];
    return { going: r.going as number, people: r.people as number, declined: r.declined as number };
  }

  async function eventView(e: any) {
    const t = await rsvpTotals(e.id);
    return {
      id: e.id, title: e.title, description: e.description, location: e.location, startsAt: e.starts_at, endsAt: e.ends_at, audience: e.audience, audienceLabel: await audienceLabel(ctx, e.audience),
      rsvp: e.rsvp, capacity: e.capacity, status: e.status, cancelReason: e.cancel_reason, createdBy: e.created_by_name ?? null,
      goingReplies: t.going, peopleComing: t.people, notComing: t.declined, spotsLeft: e.capacity == null ? null : Math.max(0, e.capacity - t.people),
      ticketed: !!e.ticketed, code: e.code ?? null, hasPoster: !!e.poster_data,
      ticketsSold: e.ticketed ? Number((await ctx.db.query<any>(`SELECT count(*) AS n FROM tickets WHERE event_id=$1 AND status IN ('valid','used')`, [e.id]))[0].n) : 0,
    };
  }
  const EVENT_SELECT = `SELECT e.*, u.name AS created_by_name FROM events e LEFT JOIN users u ON u.id=e.created_by`;

  app.get('/events', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'events.view');
    const past = (req.query as any).past === '1';
    const rows = await ctx.db.query<any>(`${EVENT_SELECT} WHERE e.org_id=$1 AND ${past ? "COALESCE(e.ends_at, e.starts_at) < $2 AND e.status <> 'postponed'" : "(COALESCE(e.ends_at, e.starts_at) >= $2 OR e.status = 'postponed')"} ORDER BY e.starts_at ${past ? 'DESC' : 'ASC'} LIMIT 200`, [g.orgId, nowIso()]);
    const out = [];
    for (const e of rows) if (e.branch_id ? g.branchIds.includes(e.branch_id) : g.wholeOrg) out.push(await eventView(e));
    return out;
  });

  function eventFields(b: any, existing?: any) {
    const startsAt = 'startsAt' in b || !existing ? when(b.startsAt, 'start time') : existing.starts_at;
    if (!startsAt) throw new HttpError(400, 'Choose when the event starts', 'bad_date');
    if (!existing && startsAt < new Date(ctx.clock.now().getTime() - 5 * 60_000).toISOString()) throw new HttpError(400, 'The start time is in the past', 'bad_date');
    const endsAt = 'endsAt' in b ? when(b.endsAt, 'end time') : existing?.ends_at ?? null;
    if (endsAt && endsAt < startsAt) throw new HttpError(400, 'The event cannot end before it starts', 'bad_date');
    let capacity: number | null = 'capacity' in b ? (b.capacity === null || b.capacity === '' ? null : Math.floor(Number(b.capacity))) : existing?.capacity ?? null;
    if (capacity !== null && (!Number.isFinite(capacity) || capacity < 1 || capacity > 100000)) throw new HttpError(400, 'Capacity must be a number from 1 to 100,000, or left empty', 'bad_capacity');
    const rsvp = 'rsvp' in b ? !!b.rsvp : existing?.rsvp ?? false;
    if (!rsvp) capacity = null;
    return {
      title: 'title' in b || !existing ? text(b.title, 80, 'title', true)! : existing.title,
      description: 'description' in b ? text(b.description, 1000, 'description') : existing?.description ?? null,
      location: 'location' in b ? text(b.location, 120, 'place') : existing?.location ?? null,
      startsAt, endsAt, rsvp, capacity,
    };
  }

  app.post('/events', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const g = await grantsFor(ctx, req, 'events.manage');
    const aud = await audienceOf(ctx, b.audience, g);
    const f = eventFields(b);
    const id = ctx.newId('evt');
    const now = nowIso();
    await ctx.db.query(
      `INSERT INTO events (id, org_id, branch_id, title, description, location, starts_at, ends_at, audience, rsvp, capacity, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
      [id, g.orgId, aud.branchId, f.title, f.description, f.location, f.startsAt, f.endsAt, JSON.stringify(aud.audience), f.rsvp, f.capacity, req.session!.uid, now],
    );
    const e = (await ctx.db.query<any>(`SELECT * FROM events WHERE id=$1`, [id]))[0];
    const flat = await eventFlat(e);
    const evt = await ctx.ledger.audit({ orgId: g.orgId, branchId: aud.branchId, actor: req.session!.uid, action: 'event.create', entity: 'event', entityId: id, summary: `Created the event "${f.title}" for ${aud.label}`, changes: diff(EVENT_SPECS, null, flat) });
    await recordVersion(ctx, { orgId: g.orgId, branchId: aud.branchId, entity: 'event', entityId: id, snapshot: maskedSnapshot(EVENT_SPECS, flat), summary: 'Created', eventId: evt });
    return { id };
  });

  app.put('/events/:id', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const old = await staffRow(req, 'events', (req.params as any).id, 'events.manage');
    if (old.status === 'cancelled') throw new HttpError(409, 'This event was cancelled and cannot be changed', 'locked');
    const g = await grantsFor(ctx, req, 'events.manage', old.org_id);
    const aud = b.audience ? await audienceOf(ctx, b.audience, g) : { audience: old.audience as Audience, branchId: old.branch_id as string | null, label: '' };
    const f = eventFields(b, old);
    const t = await rsvpTotals(old.id);
    if (f.capacity !== null && f.capacity < t.people) throw new HttpError(409, `${t.people} people have already said they are coming, so the capacity cannot be less than that`, 'capacity_too_low');
    const before = await eventFlat(old);
    const moved = f.startsAt !== old.starts_at;
    await ctx.db.query(`UPDATE events SET title=$2, description=$3, location=$4, starts_at=$5, ends_at=$6, audience=$7, branch_id=$8, rsvp=$9, capacity=$10, reminder_sent=$11, updated_at=$12 WHERE id=$1`, [old.id, f.title, f.description, f.location, f.startsAt, f.endsAt, JSON.stringify(aud.audience), aud.branchId, f.rsvp, f.capacity, moved ? false : old.reminder_sent, nowIso()]);
    const e = (await ctx.db.query<any>(`SELECT * FROM events WHERE id=$1`, [old.id]))[0];
    const flat = await eventFlat(e);
    const changes = diff(EVENT_SPECS, before, flat);
    if (changes.length) {
      const evt = await ctx.ledger.audit({ orgId: old.org_id, branchId: e.branch_id, actor: req.session!.uid, action: 'event.update', entity: 'event', entityId: old.id, summary: `Changed the event "${f.title}"`, changes });
      await recordVersion(ctx, { orgId: old.org_id, branchId: e.branch_id, entity: 'event', entityId: old.id, snapshot: maskedSnapshot(EVENT_SPECS, flat), summary: changes.map((c) => c.label).join(', '), eventId: evt });
    }
    if (moved) {
      const going = (await ctx.db.query<any>(`SELECT user_id FROM event_rsvps WHERE event_id=$1 AND response='going'`, [old.id])).map((r) => r.user_id);
      await notify(old.org_id, going, 'An event has moved', `"${f.title}" now starts ${new Date(f.startsAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' })}.`, 'member:events');
    }
    return { id: old.id };
  });

  app.post('/events/:id/cancel', auth, async (req) => {
    const old = await staffRow(req, 'events', (req.params as any).id, 'events.manage');
    if (old.status === 'cancelled') throw new HttpError(409, 'Already cancelled', 'wrong_state');
    const reason = text((req.body as any)?.reason, 200, 'reason');
    const before = await eventFlat(old);
    await ctx.db.query(`UPDATE events SET status='cancelled', cancel_reason=$2, updated_at=$3 WHERE id=$1`, [old.id, reason, nowIso()]);
    const flat = { ...before, status: 'cancelled' };
    const evt = await ctx.ledger.audit({ orgId: old.org_id, branchId: old.branch_id, actor: req.session!.uid, action: 'event.cancel', entity: 'event', entityId: old.id, summary: `Cancelled the event "${old.title}"`, changes: diff(EVENT_SPECS, before, flat), reason });
    await recordVersion(ctx, { orgId: old.org_id, branchId: old.branch_id, entity: 'event', entityId: old.id, snapshot: maskedSnapshot(EVENT_SPECS, flat), summary: 'Cancelled', eventId: evt });
    const going = (await ctx.db.query<any>(`SELECT user_id FROM event_rsvps WHERE event_id=$1 AND response='going'`, [old.id])).map((r) => r.user_id);
    await notify(old.org_id, going, 'An event was cancelled', `"${old.title}" was cancelled.${reason ? ` ${reason}` : ''}`, 'member:events');
    const tk = await notifyTicketBuyersOfCancel(ctx, old, reason);
    return { id: old.id, status: 'cancelled', told: going.length, ticketOrdersTold: tk.orders, ordersToRefund: tk.ordersToRefund, ticketsToRefund: tk.ticketsToRefund };
  });

  /** Who is coming: names and guest counts, never phone numbers (L135). */
  app.get('/events/:id/rsvps', auth, async (req) => {
    const e = await staffRow(req, 'events', (req.params as any).id, 'events.manage');
    const rows = await ctx.db.query<any>(`SELECT name, response, guests, updated_at FROM event_rsvps WHERE event_id=$1 ORDER BY name`, [e.id]);
    return { going: rows.filter((r) => r.response === 'going').map((r) => ({ name: r.name, guests: r.guests })), notGoing: rows.filter((r) => r.response === 'not_going').map((r) => ({ name: r.name })), totals: await rsvpTotals(e.id) };
  });

  // ======================= events, member side =======================

  /** What a member needs to know to buy a ticket: whether there are tickets, from what price, and whether they sold out (L170). */
  async function ticketFacts(e: any) {
    if (!e.ticketed) return { ticketed: false };
    const r = (await ctx.db.query<any>(`SELECT COALESCE(MIN(price),0) AS from_price, COALESCE(SUM(quantity),0)::int AS cap FROM ticket_types WHERE event_id=$1 AND active`, [e.id]))[0];
    const sold = Number((await ctx.db.query<any>(`SELECT count(*) AS n FROM tickets WHERE event_id=$1 AND status IN ('valid','used')`, [e.id]))[0].n);
    return { ticketed: true, code: e.code, ticketFrom: Number(r.from_price), soldOut: r.cap > 0 && sold >= r.cap, posterUrl: e.poster_data ? `/public/event/${e.code}/poster` : null };
  }

  app.get('/me/events', auth, async (req) => {
    const rows = await ctx.db.query<any>(
      `SELECT e.*, o.name AS church, (SELECT response FROM event_rsvps r WHERE r.event_id=e.id AND r.user_id=$1) AS my_response, (SELECT guests FROM event_rsvps r WHERE r.event_id=e.id AND r.user_id=$1) AS my_guests
         FROM events e JOIN organisations o ON o.id=e.org_id
        WHERE (COALESCE(e.ends_at, e.starts_at) >= $2 OR e.status = 'postponed') AND ${audienceMatchSql('e', '$1')} ORDER BY e.starts_at LIMIT 100`,
      [req.session!.uid, nowIso()],
    );
    const out = [];
    for (const e of rows) {
      const t = await rsvpTotals(e.id);
      const spotsLeft = e.capacity == null ? null : Math.max(0, e.capacity - t.people);
      out.push({
        id: e.id, title: e.title, description: e.description, location: e.location, startsAt: e.starts_at, endsAt: e.ends_at, church: e.church, status: e.status, cancelReason: e.cancel_reason,
        rsvp: e.rsvp, capacity: e.capacity, peopleComing: t.people, spotsLeft, full: spotsLeft === 0, myResponse: e.my_response ?? null, myGuests: e.my_guests ?? 0,
        ...(await ticketFacts(e)),
      });
    }
    return out;
  });

  app.post('/me/events/:id/rsvp', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const uid = req.session!.uid;
    const e = (await ctx.db.query<any>(`SELECT e.* FROM events e WHERE e.id=$2 AND ${audienceMatchSql('e', '$1')}`, [uid, (req.params as any).id]))[0];
    if (!e) throw new HttpError(404, 'event not found', 'not_found');
    if (!e.rsvp) throw new HttpError(400, 'This event does not ask for replies', 'no_rsvp');
    if (e.status === 'cancelled') throw new HttpError(409, 'This event was cancelled', 'cancelled');
    if (e.status !== 'postponed' && e.starts_at < nowIso()) throw new HttpError(409, 'This event has already started', 'started');
    const response = b.response === 'going' || b.response === 'not_going' ? b.response : null;
    if (!response) throw new HttpError(400, 'Choose Going or Not going', 'bad_response');
    const guests = response === 'going' ? Math.floor(Number(b.guests ?? 0)) : 0;
    if (!Number.isFinite(guests) || guests < 0 || guests > MAX_GUESTS) throw new HttpError(400, `You can bring up to ${MAX_GUESTS} guests`, 'bad_guests');
    if (response === 'going' && e.capacity != null) {
      const others = (await ctx.db.query<any>(`SELECT COALESCE(SUM(1+guests),0)::int AS n FROM event_rsvps WHERE event_id=$1 AND response='going' AND user_id<>$2`, [e.id, uid]))[0].n as number;
      if (others + 1 + guests > e.capacity) throw new HttpError(409, others >= e.capacity ? 'This event is full' : `Only ${e.capacity - others} places are left, so you can bring ${Math.max(0, e.capacity - others - 1)} guests`, 'event_full');
    }
    const name = (await ctx.db.query<any>(`SELECT full_name FROM memberships WHERE user_id=$1 AND org_id=$2 AND status='active' ORDER BY joined_at LIMIT 1`, [uid, e.org_id]))[0]?.full_name ?? req.session!.name;
    await ctx.db.query(
      `INSERT INTO event_rsvps (event_id, user_id, org_id, name, response, guests, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (event_id, user_id) DO UPDATE SET response=$5, guests=$6, updated_at=$7`,
      [e.id, uid, e.org_id, name, response, guests, nowIso()],
    );
    const t = await rsvpTotals(e.id);
    return { response, guests, peopleComing: t.people, spotsLeft: e.capacity == null ? null : Math.max(0, e.capacity - t.people) };
  });

  // ======================= group walls (L136) =======================

  async function myRole(uid: string, groupId: string) {
    return (await ctx.db.query<any>(
      `SELECT gm.role, gm.membership_id, m.org_id, g.posting, g.name, g.branch_id, m.full_name FROM group_members gm JOIN memberships m ON m.id=gm.membership_id JOIN groups g ON g.id=gm.group_id
        WHERE gm.group_id=$1 AND m.user_id=$2 AND m.status='active' ORDER BY (gm.role='leader') DESC LIMIT 1`,
      [groupId, uid],
    ))[0] as { role: 'leader' | 'member'; membership_id: string; org_id: string; posting: string; name: string; branch_id: string | null; full_name: string } | undefined;
  }
  async function memberOf(req: FastifyRequest) {
    const mine = await myRole(req.session!.uid, (req.params as any).id);
    if (!mine) throw new HttpError(404, 'group not found', 'not_found'); // not a member: the wall does not exist for them (L53)
    return mine;
  }

  app.get('/me/groups/:id/wall', auth, async (req) => {
    const mine = await memberOf(req);
    const id = (req.params as any).id;
    const before = String((req.query as any).before ?? '') || nowIso();
    const posts = await ctx.db.query<any>(`SELECT * FROM group_posts WHERE group_id=$1 AND deleted_at IS NULL AND (pinned OR created_at < $2) ORDER BY pinned DESC, created_at DESC LIMIT 40`, [id, before]);
    const ids = posts.map((p) => p.id);
    const comments = ids.length ? await ctx.db.query<any>(`SELECT * FROM group_comments WHERE post_id = ANY($1::text[]) AND deleted_at IS NULL ORDER BY created_at`, [ids]) : [];
    const uid = req.session!.uid;
    return {
      group: { id, name: mine.name, role: mine.role },
      canPost: mine.role === 'leader' || mine.posting === 'members',
      posts: posts.map((p) => ({
        id: p.id, kind: p.kind, body: p.body, pinned: p.pinned, author: p.author_name, mine: p.author_id === uid, createdAt: p.created_at,
        comments: comments.filter((c) => c.post_id === p.id).map((c) => ({ id: c.id, author: c.author_name, body: c.body, mine: c.author_id === uid, createdAt: c.created_at })),
      })),
    };
  });

  app.post('/me/groups/:id/wall', auth, async (req) => {
    formGuard(ctx, req.session!.uid, 'wall');
    const b = (req.body ?? {}) as any;
    const mine = await memberOf(req);
    const id = (req.params as any).id;
    if (mine.role !== 'leader' && mine.posting === 'leaders') throw new HttpError(403, 'Only the leaders of this group can post', 'forbidden');
    const kind = b.kind === 'announcement' ? 'announcement' : 'post';
    if (kind === 'announcement' && mine.role !== 'leader') throw new HttpError(403, 'Only a leader can post an announcement', 'forbidden');
    const body = text(b.body, 1000, 'post', true)!;
    const pid = ctx.newId('gpo');
    await ctx.db.query(`INSERT INTO group_posts (id, org_id, group_id, author_id, author_name, kind, body, pinned, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [pid, mine.org_id, id, req.session!.uid, mine.full_name, kind, body, kind === 'announcement', nowIso()]);
    // The log records that something was posted, never what it said (L139).
    await ctx.ledger.audit({ orgId: mine.org_id, branchId: mine.branch_id, actor: req.session!.uid, action: 'wall.post', entity: 'group_post', entityId: pid, summary: `Posted ${kind === 'announcement' ? 'an announcement' : 'a post'} on the wall of ${mine.name}`, links: { groupId: id } });
    if (kind === 'announcement' && b.notify) {
      const ids = (await audienceUserIds(ctx, mine.org_id, { type: 'group', id })).filter((u) => u !== req.session!.uid);
      await notify(mine.org_id, ids, `New announcement in ${mine.name}`, body.length > 140 ? `${body.slice(0, 137)}...` : body, 'member:groups');
    }
    return { id: pid };
  });

  async function postOf(req: FastifyRequest, mine: { org_id: string }) {
    const p = (await ctx.db.query<any>(`SELECT * FROM group_posts WHERE id=$1 AND group_id=$2 AND deleted_at IS NULL`, [(req.params as any).pid, (req.params as any).id]))[0];
    if (!p || p.org_id !== mine.org_id) throw new HttpError(404, 'post not found', 'not_found');
    return p;
  }

  app.post('/me/groups/:id/wall/:pid/comments', auth, async (req) => {
    formGuard(ctx, req.session!.uid, 'wall');
    const mine = await memberOf(req);
    const p = await postOf(req, mine);
    const body = text((req.body as any)?.body, 500, 'comment', true)!;
    const cid = ctx.newId('gco');
    await ctx.db.query(`INSERT INTO group_comments (id, org_id, group_id, post_id, author_id, author_name, body, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [cid, mine.org_id, p.group_id, p.id, req.session!.uid, mine.full_name, body, nowIso()]);
    await ctx.ledger.audit({ orgId: mine.org_id, branchId: mine.branch_id, actor: req.session!.uid, action: 'wall.comment', entity: 'group_comment', entityId: cid, summary: `Commented on a post in ${mine.name}`, links: { groupId: p.group_id } });
    return { id: cid };
  });

  app.post('/me/groups/:id/wall/:pid/pin', auth, async (req) => {
    const mine = await memberOf(req);
    if (mine.role !== 'leader') throw new HttpError(403, 'Only a leader can pin a post', 'forbidden');
    const p = await postOf(req, mine);
    const pinned = (req.body as any)?.pinned !== false;
    await ctx.db.query(`UPDATE group_posts SET pinned=$2 WHERE id=$1`, [p.id, pinned]);
    await ctx.ledger.audit({ orgId: mine.org_id, branchId: mine.branch_id, actor: req.session!.uid, action: 'wall.pin', entity: 'group_post', entityId: p.id, summary: `${pinned ? 'Pinned' : 'Unpinned'} a post in ${mine.name}`, links: { groupId: p.group_id } });
    return { id: p.id, pinned };
  });

  app.post('/me/groups/:id/wall/:pid/remove', auth, async (req) => {
    const mine = await memberOf(req);
    const p = await postOf(req, mine);
    const own = p.author_id === req.session!.uid;
    if (!own && mine.role !== 'leader') throw new HttpError(403, 'Only the author or a leader can remove a post', 'forbidden');
    await ctx.db.query(`UPDATE group_posts SET deleted_at=$2, deleted_by=$3 WHERE id=$1`, [p.id, nowIso(), req.session!.uid]);
    await ctx.ledger.audit({ orgId: mine.org_id, branchId: mine.branch_id, actor: req.session!.uid, action: 'wall.post_removed', entity: 'group_post', entityId: p.id, summary: `${own ? 'Deleted their own post' : 'Removed a post'} in ${mine.name}`, links: { groupId: p.group_id } });
    return { ok: true };
  });

  app.post('/me/groups/:id/wall/:pid/comments/:cid/remove', auth, async (req) => {
    const mine = await memberOf(req);
    const p = await postOf(req, mine);
    const c = (await ctx.db.query<any>(`SELECT * FROM group_comments WHERE id=$1 AND post_id=$2 AND deleted_at IS NULL`, [(req.params as any).cid, p.id]))[0];
    if (!c) throw new HttpError(404, 'comment not found', 'not_found');
    const own = c.author_id === req.session!.uid;
    if (!own && mine.role !== 'leader') throw new HttpError(403, 'Only the author or a leader can remove a comment', 'forbidden');
    await ctx.db.query(`UPDATE group_comments SET deleted_at=$2, deleted_by=$3 WHERE id=$1`, [c.id, nowIso(), req.session!.uid]);
    await ctx.ledger.audit({ orgId: mine.org_id, branchId: mine.branch_id, actor: req.session!.uid, action: 'wall.comment_removed', entity: 'group_comment', entityId: c.id, summary: `${own ? 'Deleted their own comment' : 'Removed a comment'} in ${mine.name}`, links: { groupId: p.group_id } });
    return { ok: true };
  });

  // ======================= joining groups (L137) =======================

  app.get('/me/groups/discover', auth, async (req) => {
    const uid = req.session!.uid;
    const rows = await ctx.db.query<any>(
      `SELECT g.id, g.name, g.description, o.name AS church, b.name AS branch, (SELECT COUNT(*) FROM group_members x WHERE x.group_id=g.id)::int AS member_count,
              (SELECT status FROM group_join_requests r WHERE r.group_id=g.id AND r.user_id=$1) AS my_request
         FROM groups g JOIN organisations o ON o.id=g.org_id LEFT JOIN branches b ON b.id=g.branch_id
        WHERE g.join_policy='request' AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=$1 AND m.status='active' AND m.org_id=g.org_id)
          AND NOT EXISTS (SELECT 1 FROM group_members gm JOIN memberships m2 ON m2.id=gm.membership_id WHERE gm.group_id=g.id AND m2.user_id=$1 AND m2.status='active')
        ORDER BY g.name`,
      [uid],
    );
    return rows.map((g) => ({ id: g.id, name: g.name, description: g.description, church: g.church, branch: g.branch, memberCount: g.member_count, myRequest: g.my_request === 'pending' ? 'pending' : null }));
  });

  app.post('/me/groups/:id/join-request', auth, async (req) => {
    const uid = req.session!.uid;
    const g = (await ctx.db.query<any>(`SELECT * FROM groups WHERE id=$1`, [(req.params as any).id]))[0];
    const m = g ? (await ctx.db.query<any>(`SELECT id, full_name FROM memberships WHERE user_id=$1 AND org_id=$2 AND status='active' ORDER BY joined_at LIMIT 1`, [uid, g.org_id]))[0] : null;
    if (!g || !m) throw new HttpError(404, 'group not found', 'not_found');
    if (g.join_policy !== 'request') throw new HttpError(409, 'This group is by invitation only', 'invite_only');
    if (await myRole(uid, g.id)) throw new HttpError(409, 'You are already in this group', 'already_member');
    const now = nowIso();
    await ctx.db.query(
      `INSERT INTO group_join_requests (group_id, user_id, org_id, membership_id, name, status, created_at) VALUES ($1,$2,$3,$4,$5,'pending',$6)
       ON CONFLICT (group_id, user_id) DO UPDATE SET status='pending', decided_by=NULL, decided_at=NULL, created_at=$6, membership_id=$4, name=$5`,
      [g.id, uid, g.org_id, m.id, m.full_name, now],
    );
    await ctx.ledger.audit({ orgId: g.org_id, branchId: g.branch_id, actor: req.session!.uid, action: 'group.join_request', category: 'member', entity: 'group', entityId: g.id, summary: `Asked to join ${g.name}` });
    const leaders = (await ctx.db.query<any>(`SELECT DISTINCT m.user_id FROM group_members gm JOIN memberships m ON m.id=gm.membership_id WHERE gm.group_id=$1 AND gm.role='leader' AND m.user_id IS NOT NULL`, [g.id])).map((r) => r.user_id);
    await notify(g.org_id, leaders, `Someone wants to join ${g.name}`, `${m.full_name} asked to join. Open the group to decide.`, 'member:groups');
    return { status: 'pending' };
  });

  app.post('/me/groups/:id/join-request/withdraw', auth, async (req) => {
    const r = await ctx.db.query<any>(`UPDATE group_join_requests SET status='withdrawn', decided_at=$3 WHERE group_id=$1 AND user_id=$2 AND status='pending' RETURNING group_id`, [(req.params as any).id, req.session!.uid, nowIso()]);
    if (r.length === 0) throw new HttpError(404, 'You have no waiting request for this group', 'not_found');
    return { status: 'withdrawn' };
  });

  app.get('/me/groups/:id/requests', auth, async (req) => {
    const mine = await memberOf(req);
    if (mine.role !== 'leader') throw new HttpError(403, 'Only a leader can see join requests', 'forbidden');
    const rows = await ctx.db.query<any>(`SELECT user_id, name, created_at FROM group_join_requests WHERE group_id=$1 AND status='pending' ORDER BY created_at`, [(req.params as any).id]);
    return rows.map((r) => ({ userId: r.user_id, name: r.name, requestedAt: r.created_at }));
  });

  app.post('/me/groups/:id/requests/:uid/decide', auth, async (req) => {
    const mine = await memberOf(req);
    if (mine.role !== 'leader') throw new HttpError(403, 'Only a leader can decide join requests', 'forbidden');
    const gid = (req.params as any).id;
    const approve = (req.body as any)?.approve !== false;
    const r = (await ctx.db.query<any>(`SELECT * FROM group_join_requests WHERE group_id=$1 AND user_id=$2 AND status='pending'`, [gid, (req.params as any).uid]))[0];
    if (!r) throw new HttpError(404, 'That request is not waiting', 'not_found');
    const now = nowIso();
    await ctx.db.tx(async (q) => {
      if (approve) await q.query(`INSERT INTO group_members (group_id, membership_id, org_id, role, added_at) VALUES ($1,$2,$3,'member',$4) ON CONFLICT DO NOTHING`, [gid, r.membership_id, r.org_id, now]);
      await q.query(`UPDATE group_join_requests SET status=$3, decided_by=$4, decided_at=$5 WHERE group_id=$1 AND user_id=$2`, [gid, r.user_id, approve ? 'approved' : 'declined', req.session!.uid, now]);
    });
    await ctx.ledger.audit({ orgId: r.org_id, branchId: mine.branch_id, actor: req.session!.uid, action: approve ? 'group.join_approved' : 'group.join_declined', category: 'member', entity: 'group', entityId: gid, summary: `${approve ? 'Approved' : 'Declined'} a request to join ${mine.name}` });
    await notify(r.org_id, [r.user_id], approve ? `You are now in ${mine.name}` : `Your request to join ${mine.name} was not accepted`, approve ? 'Open Groups to see the wall.' : 'You can ask a leader of the group about it.', 'member:groups');
    return { status: approve ? 'approved' : 'declined' };
  });
}

/**
 * Alerts that are due: notices that asked to alert members once they go live, and a reminder 24 hours before an event for everyone who said they are going.
 * Run by the scheduler and after the development clock moves (L133, L135).
 */
export async function runCommunityJobs(ctx: Ctx): Promise<{ notices: number; reminders: number }> {
  const now = ctx.clock.now().toISOString();
  let notices = 0;
  let reminders = 0;
  const send = async (orgId: string, userIds: string[], title: string, body: string, link?: string) => {
    for (const u of [...new Set(userIds)]) await addNotification(ctx, { orgId, userId: u, kind: 'announcement', title, body, link });
  };
  const due = await ctx.db.query<any>(`UPDATE notices SET notified=true WHERE notify AND NOT notified AND status='published' AND publish_at <= $1 AND (expires_at IS NULL OR expires_at > $1) RETURNING *`, [now]);
  for (const n of due) {
    await send(n.org_id, await audienceUserIds(ctx, n.org_id, n.audience), n.title, n.body.length > 140 ? `${n.body.slice(0, 137)}...` : n.body, 'member:notices');
    notices++;
  }
  const soon = await ctx.db.query<any>(
    `UPDATE events SET reminder_sent=true WHERE status='scheduled' AND rsvp AND NOT reminder_sent AND starts_at > $1 AND starts_at <= $2 RETURNING *`,
    [now, new Date(ctx.clock.now().getTime() + 24 * 3600_000).toISOString()],
  );
  for (const e of soon) {
    const going = (await ctx.db.query<any>(`SELECT user_id FROM event_rsvps WHERE event_id=$1 AND response='going'`, [e.id])).map((r) => r.user_id);
    await send(e.org_id, going, `Coming up: ${e.title}`, `${new Date(e.starts_at).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${e.location ? ` at ${e.location}` : ''}. We look forward to seeing you.`, 'member:events');
    reminders++;
  }
  return { notices, reminders };
}
