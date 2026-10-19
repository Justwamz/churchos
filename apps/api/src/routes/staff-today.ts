import type { FastifyInstance } from 'fastify';
import { branchesFor, type Permission } from '../auth';
import { requireSession, type Ctx } from '../ctx';

/**
 * "Today" for the staff app on a phone (Slice 24): one call that says what is waiting for this person, for the things they have the right to do,
 * and what is happening now. Nothing here is a new right: every number comes from a right the person already holds, in the branches they hold it.
 */
export function staffTodayRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/staff/today', { preHandler: requireSession }, async (req) => {
    const uid = req.session!.uid;
    const nowMs = ctx.clock.now().getTime();
    const scopes = new Map<Permission, { orgId: string; branches: string[] }[]>();
    const scope = async (p: Permission) => {
      if (!scopes.has(p)) {
        const rows = await branchesFor(ctx.db, uid, p);
        const by = new Map<string, string[]>();
        for (const r of rows) by.set(r.orgId, [...(by.get(r.orgId) ?? []), r.branchId]);
        scopes.set(p, [...by.entries()].map(([orgId, branches]) => ({ orgId, branches })));
      }
      return scopes.get(p)!;
    };
    const count = async (p: Permission, sql: (orgIds: string[], branchIds: string[]) => { text: string; params: unknown[] }) => {
      const s = await scope(p);
      if (!s.length) return null;
      const q = sql(s.map((x) => x.orgId), s.flatMap((x) => x.branches));
      return Number((await ctx.db.query<any>(q.text, q.params))[0]?.n ?? 0);
    };

    const cards: { key: string; title: string; count: number; hint: string; page: string }[] = [];
    const add = (key: string, title: string, n: number | null, hint: string, page: string) => { if (n !== null) cards.push({ key, title, count: n, hint, page }); };

    add('expenses', 'Expenses to approve', await count('expenses.approve', (o, b) => ({
      text: `SELECT count(*)::int AS n FROM expenses WHERE org_id = ANY($1::text[]) AND branch_id = ANY($2::text[]) AND status IN ('submitted','awaiting_second') AND recorded_by IS DISTINCT FROM $3 AND first_approver IS DISTINCT FROM $3`,
      params: [o, b, uid],
    })), 'Recorded by someone else and waiting for you', 'expenses');
    add('claims', 'Claims to pay', await count('expenses.record', (o, b) => ({
      text: `SELECT count(*)::int AS n FROM expenses WHERE org_id = ANY($1::text[]) AND branch_id = ANY($2::text[]) AND kind='claim' AND status='approved' AND paid_at IS NULL`,
      params: [o, b],
    })), 'Approved, and not yet marked as paid', 'expenses');
    add('refunds', 'Ticket refund requests', await count('events.manage', (o, b) => ({
      text: `SELECT count(*)::int AS n FROM ticket_refunds WHERE org_id = ANY($1::text[]) AND (branch_id IS NULL OR branch_id = ANY($2::text[])) AND status='pending'`,
      params: [o, b],
    })), 'Decide each one', 'events');
    add('cash', 'Cash counts to sign off', await count('cash.approve', (o, b) => ({
      text: `SELECT count(*)::int AS n FROM cash_entries WHERE org_id = ANY($1::text[]) AND branch_id = ANY($2::text[]) AND status='counted' AND counted_by <> $3`,
      params: [o, b, uid],
    })), 'Counted by someone else', 'cash');
    add('bookings', 'Booking requests', await count('bookings.manage', (o, b) => ({
      text: `SELECT count(DISTINCT i.booking_id)::int AS n FROM booking_items i JOIN bookings k ON k.id=i.booking_id WHERE k.org_id = ANY($1::text[]) AND (k.branch_id IS NULL OR k.branch_id = ANY($2::text[])) AND i.status='requested'`,
      params: [o, b],
    })), 'Approve or decline', 'bookings');
    add('suggestions', 'New suggestions', await count('suggestions.view', (o, b) => ({
      text: `SELECT count(*)::int AS n FROM suggestions WHERE org_id = ANY($1::text[]) AND (branch_id IS NULL OR branch_id = ANY($2::text[])) AND status='new'`,
      params: [o, b],
    })), 'Not yet looked at', 'suggestions');
    add('visitors', 'Visitors to follow up', await count('attendance.view', (o, b) => ({
      text: `SELECT count(*)::int AS n FROM visitors WHERE org_id = ANY($1::text[]) AND branch_id = ANY($2::text[]) AND status='new' AND first_seen_at > $3`,
      params: [o, b, new Date(nowMs - 21 * 86_400_000).toISOString()],
    })), 'Came in the last 3 weeks', 'attendance');

    // Services happening today (EAT) where the person can record attendance, with who is in so far.
    const services: any[] = [];
    const att = await scope('attendance.checkin');
    if (att.length) {
      const dayStart = new Date(Math.floor((nowMs + 3 * 3600_000) / 86_400_000) * 86_400_000 - 3 * 3600_000).toISOString();
      const dayEnd = new Date(Date.parse(dayStart) + 86_400_000).toISOString();
      const rows = await ctx.db.query<any>(
        `SELECT s.id, s.name, s.starts_at, s.opens_at, s.closes_at, b.name AS branch,
                (SELECT count(*)::int FROM attendance a WHERE a.service_id=s.id AND a.mode='in_person') AS in_person
           FROM services s JOIN branches b ON b.id=s.branch_id
          WHERE s.org_id = ANY($1::text[]) AND s.branch_id = ANY($2::text[]) AND s.status='scheduled' AND s.starts_at >= $3 AND s.starts_at < $4 ORDER BY s.starts_at`,
        [att.map((x) => x.orgId), att.flatMap((x) => x.branches), dayStart, dayEnd],
      );
      for (const r of rows) services.push({ id: r.id, name: r.name, branch: r.branch, startsAt: r.starts_at, state: nowMs < Date.parse(r.opens_at) ? 'before' : nowMs > Date.parse(r.closes_at) ? 'closed' : 'open', inPerson: r.in_person });
    }

    // Children's classes open right now, with how many are still in.
    const kids: any[] = [];
    const kscope = await scope('kids.checkin');
    if (kscope.length) {
      const rows = await ctx.db.query<any>(
        `SELECT s.id, s.class_name, b.name AS branch, (SELECT count(*)::int FROM kids_checkins c WHERE c.session_id=s.id AND c.status='in') AS present
           FROM kids_sessions s JOIN branches b ON b.id=s.branch_id WHERE s.org_id = ANY($1::text[]) AND s.branch_id = ANY($2::text[]) AND s.status='open' ORDER BY s.starts_at`,
        [kscope.map((x) => x.orgId), kscope.flatMap((x) => x.branches)],
      );
      for (const r of rows) kids.push({ id: r.id, className: r.class_name, branch: r.branch, present: r.present });
    }

    return { name: req.session!.name, cards, services, kids, total: cards.reduce((s, c) => s + c.count, 0), at: ctx.clock.now().toISOString() };
  });
}
