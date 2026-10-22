import { createHash } from 'node:crypto';
import { maskPhone } from '@churchos/shared';
import type { Db } from '@churchos/ledger';
import { branchesFor, type Session } from './auth';
import { HttpError, type Ctx } from './ctx';
import { addNotification } from './notifications';
import { revokeSession } from './sessions';

/**
 * Data protection (LG-16): a person's own data export, and closing an account with erasure.
 * Rules this file keeps:
 *  - The export holds only the signed-in person's own data. Other people appear only as names in the person's own household.
 *  - Erasure never updates or deletes the money tables (ledger, payments, postings, journal), the giving ledger or the audit log.
 *    Those are kept for the law (see KEPT_FOR_LAW) and the person's link to them is cut by anonymising the person, not the rows.
 */

/** What stays after an erasure and why. Shown to the person before they confirm and returned when it completes. */
export const KEPT_FOR_LAW: { what: string; why: string }[] = [
  { what: 'Gifts and payments: amounts, dates, methods, receipt numbers, and the phone number a payment came from', why: 'Financial records must be kept for 7 years (tax and accounting law). They cannot be changed.' },
  { what: 'The church giving ledger lines (amounts and dates only; your name is removed from the member record they point to)', why: 'The ledger is a chained, append-only financial record kept for 7 years.' },
  { what: 'The audit trail of actions, including actions you took while you had an account', why: 'Needed to prove the books are honest and to investigate fraud. Kept for 7 years.' },
  { what: 'Giving statements already issued', why: 'They are financial documents kept exactly as issued.' },
  { what: 'Baptism and marriage register entries', why: "A church register is the church's permanent record." },
  { what: "Safeguarding log of children's check-in and pick-up (names removed once no guardian account remains)", why: 'Child-safety records are kept (period to be confirmed with counsel).' },
];

const FORMER = 'Former member';

const phoneHash = (phone: string) => createHash('sha256').update(`churchos:phone:${phone}`).digest('hex');

/** Payments from this phone count as the account holder's only from this moment on (see the erased_phones table). */
export async function phoneSince(ctx: Pick<Ctx, 'db'>, phone: string): Promise<string> {
  const r = (await ctx.db.query<any>(`SELECT erased_at FROM erased_phones WHERE phone_hash=$1`, [phoneHash(phone)]))[0];
  return r ? new Date(r.erased_at).toISOString() : '1970-01-01T00:00:00.000Z';
}

async function myMembershipIds(q: Db, uid: string): Promise<string[]> {
  return (await q.query<any>(`SELECT id FROM memberships WHERE user_id=$1`, [uid])).map((r) => r.id as string);
}

// ======================================================================================================================
// Export
// ======================================================================================================================

export async function buildExport(ctx: Ctx, s: Session) {
  const uid = s.uid;
  const q = <T = any>(sql: string, p: unknown[] = []) => ctx.db.query<T>(sql, p);
  const num = (v: unknown) => Number(v);
  const user = (await q(`SELECT name, phone, email, email_verified, created_at FROM users WHERE id=$1`, [uid]))[0];
  const ms = await q(
    `SELECT m.id, m.member_number, m.full_name, m.category, m.status, m.dob, m.sex, m.joined_at, m.closed_at, m.consent_at, m.household_id, b.name AS branch, o.name AS church
       FROM memberships m JOIN branches b ON b.id=m.branch_id JOIN organisations o ON o.id=m.org_id WHERE m.user_id=$1 ORDER BY m.joined_at`,
    [uid],
  );
  const ids = ms.map((m) => m.id as string);
  const hh = [...new Set(ms.map((m) => m.household_id).filter(Boolean))] as string[];
  const roles = await q(
    `SELECT o.name AS church, r.name AS role, ra.scope_type FROM role_assignments ra JOIN roles r ON r.id=ra.role_id JOIN organisations o ON o.id=ra.org_id WHERE ra.user_id=$1`,
    [uid],
  );
  const ledger = ids.length
    ? await q(
        `SELECT g.at, g.kind, g.amount, g.method, g.purpose, p.name AS project, g.ref, o.name AS church
           FROM giving_ledger g LEFT JOIN projects p ON p.id=g.project_id JOIN organisations o ON o.id=g.org_id WHERE g.membership_id = ANY($1::text[]) ORDER BY g.seq`,
        [ids],
      )
    : [];
  const payments = await q(
    `SELECT p.received_at AS date, p.amount_paid AS amount, p.method, p.purpose, p.provider_tx_id AS reference, p.stage AS status, b.name AS church
       FROM payments p LEFT JOIN branches b ON b.id=p.branch_id
      WHERE (p.payer_phone=$1 AND p.received_at >= $3) OR p.id IN (SELECT payment_id FROM anonymous_gifts WHERE user_id=$2 AND payment_id IS NOT NULL) ORDER BY p.received_at`,
    [s.phone, uid, await phoneSince(ctx, s.phone)],
  );
  const pledges = ids.length
    ? await q(`SELECT pl.amount, pl.created_at, pr.name AS project FROM pledges pl JOIN projects pr ON pr.id=pl.project_id WHERE pl.membership_id = ANY($1::text[]) ORDER BY pl.created_at`, [ids])
    : [];
  const plans = await q(
    `SELECT p.amount, p.method, p.purpose, p.frequency, p.start_date, p.end_date, p.status, p.completed_count, p.missed_count, p.created_at, o.name AS church
       FROM giving_plans p JOIN organisations o ON o.id=p.org_id WHERE p.user_id=$1 ORDER BY p.created_at`,
    [uid],
  );
  const attendance = ids.length
    ? await q(`SELECT s.name AS service, s.starts_at, a.mode, a.via FROM attendance a JOIN services s ON s.id=a.service_id WHERE a.membership_id = ANY($1::text[]) ORDER BY s.starts_at`, [ids])
    : [];
  const rsvps = await q(`SELECT e.title AS event, r.response, r.guests, r.updated_at FROM event_rsvps r JOIN events e ON e.id=r.event_id WHERE r.user_id=$1`, [uid]);
  const orders = await q(
    `SELECT o.id, o.code, e.title AS event, o.status, o.subtotal, o.service_fee, o.total, o.method, o.created_at, o.paid_at FROM ticket_orders o JOIN events e ON e.id=o.event_id WHERE o.buyer_user_id=$1 ORDER BY o.created_at`,
    [uid],
  );
  const orderIds = orders.map((o) => o.id as string);
  const tickets = orderIds.length ? await q(`SELECT type_name, serial, holder_name, status, checked_in_at FROM tickets WHERE order_id = ANY($1::text[])`, [orderIds]) : [];
  const credits = await q(
    `SELECT o.name AS church, c.amount, c.balance, c.reason, c.created_at FROM event_credits c JOIN organisations o ON o.id=c.org_id WHERE c.user_id=$1 ORDER BY c.created_at`,
    [uid],
  );
  const creditUses = await q(
    `SELECT m.amount, m.undone, m.created_at FROM event_credit_moves m JOIN event_credits c ON c.id=m.credit_id WHERE c.user_id=$1 ORDER BY m.created_at`,
    [uid],
  );
  const creditRefunds = await q(`SELECT amount, status, reason, created_at, paid_at FROM credit_refunds WHERE user_id=$1 ORDER BY created_at`, [uid]);
  const creditTransfers = await q(`SELECT amount, CASE WHEN from_user=$1 THEN 'sent' ELSE 'received' END AS direction, created_at FROM credit_transfers WHERE from_user=$1 OR to_user=$1 ORDER BY created_at`, [uid]);
  const statements = ids.length
    ? await q(`SELECT number, year, total, gifts, generated_at, requested_by_role FROM giving_statements WHERE membership_id = ANY($1::text[]) ORDER BY generated_at`, [ids])
    : [];
  const prayers = await q(
    `SELECT r.body, r.audience, r.anonymous, r.status, r.created_at FROM prayer_requests r JOIN prayer_owners w ON w.prayer_id=r.id WHERE w.user_id=$1 AND r.body <> '[removed]' ORDER BY r.created_at`,
    [uid],
  );
  const suggestions = await q(
    `SELECT s.category, s.body, s.status, s.response, s.created_at FROM suggestions s JOIN suggestion_owners w ON w.suggestion_id=s.id WHERE w.user_id=$1 AND s.body <> '[removed]' ORDER BY s.created_at`,
    [uid],
  );
  const posts = await q(`SELECT p.body, g.name AS "group", p.created_at FROM group_posts p JOIN groups g ON g.id=p.group_id WHERE p.author_id=$1 AND p.deleted_at IS NULL ORDER BY p.created_at`, [uid]);
  const comments = await q(`SELECT c.body, g.name AS "group", c.created_at FROM group_comments c JOIN groups g ON g.id=c.group_id WHERE c.author_id=$1 AND c.deleted_at IS NULL ORDER BY c.created_at`, [uid]);
  const globalConsent = (await q(`SELECT whatsapp_opt_in, sms_opt_out, source, updated_at FROM contact_prefs WHERE phone=$1`, [s.phone]))[0] ?? null;
  const churchConsent = await q(`SELECT o.name AS church, c.whatsapp_opt_in, c.sms_opt_out, c.source, c.updated_at FROM contact_prefs_org c JOIN organisations o ON o.id=c.org_id WHERE c.phone=$1`, [s.phone]);
  const sessions = await q(`SELECT created_at, last_seen_at, user_agent, expires_at, revoked_at FROM sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`, [uid]);
  const offers = await q(`SELECT o.status, o.created_at, o.decided_at, org.name AS church FROM link_offers o JOIN organisations org ON org.id=o.org_id WHERE o.user_id=$1`, [uid]);
  const joins = await q(`SELECT j.status, j.created_at, j.decided_at, j.message, org.name AS church FROM join_requests j JOIN organisations org ON org.id=j.org_id WHERE j.user_id=$1`, [uid]);
  const household = hh.length
    ? await q(`SELECT full_name AS name, CASE WHEN category='child' THEN 'Child' ELSE 'Adult' END AS relationship FROM memberships WHERE household_id = ANY($1::text[]) AND (user_id IS NULL OR user_id <> $2) ORDER BY full_name`, [hh, uid])
    : [];
  const bookings = await q(`SELECT title, starts_at, ends_at, status, created_at FROM bookings WHERE requester_id=$1 ORDER BY created_at`, [uid]);
  const records = ids.length
    ? await q(`SELECT r.kind, r.event_date, r.place, r.serial, o.name AS church FROM sacramental_records r JOIN organisations o ON o.id=r.org_id WHERE r.membership_id = ANY($1::text[]) AND r.status='approved'`, [ids])
    : [];
  const lookedAt = ids.length
    ? await q(`SELECT a.at, a.action, a.staff_name AS who, o.name AS church FROM giving_ledger_access a JOIN organisations o ON o.id=a.org_id WHERE a.membership_id = ANY($1::text[]) ORDER BY a.at`, [ids])
    : [];
  const count = async (sql: string, p: unknown[]) => Number((await q<any>(sql, p))[0]?.n ?? 0);
  const children = hh.length ? (await q(`SELECT id FROM memberships WHERE household_id = ANY($1::text[]) AND category='child'`, [hh])).map((c) => c.id as string) : [];
  const staffOnly = [
    { category: 'Visitor follow-up notes kept by a church', count: ids.length ? await count(`SELECT count(*)::int AS n FROM visitors WHERE membership_id = ANY($1::text[])`, [ids]) : 0 },
    { category: "Children's check-in and pick-up log entries for children in your household", count: children.length ? await count(`SELECT count(*)::int AS n FROM kids_checkins WHERE child_id = ANY($1::text[])`, [children]) : 0 },
    { category: 'Pick-up people you registered (their details are held for you)', count: ids.length ? await count(`SELECT count(*)::int AS n FROM kids_pickup_people WHERE guardian_id = ANY($1::text[])`, [ids]) : 0 },
    { category: 'Transfer records between branches', count: ids.length ? await count(`SELECT count(*)::int AS n FROM transfers WHERE membership_id = ANY($1::text[])`, [ids]) : 0 },
    { category: 'Entries in the audit log that name you as the person acting', count: await count(`SELECT count(*)::int AS n FROM audit_events WHERE actor_id=$1`, [uid]) },
    { category: 'In-app messages in your inbox', count: await count(`SELECT count(*)::int AS n FROM notifications WHERE user_id=$1`, [uid]) },
  ];

  await ctx.ledger.audit({ actor: uid, action: 'data.export', category: 'access', entity: 'user', entityId: uid, summary: 'Downloaded a copy of their own data' });
  return {
    exportedAt: ctx.clock.now().toISOString(),
    about: "This is the information ChurchOS holds about you. It does not include other people's data, and it does not include notes that church staff keep for their own work (those are listed by category and count at the end).",
    profile: { name: user.name, phone: user.phone, email: user.email ?? null, emailVerified: !!user.email_verified, createdAt: user.created_at },
    memberships: ms.map(({ household_id: _h, ...m }) => m),
    teamRoles: roles,
    giving: {
      ledger: ledger.map((l) => ({ ...l, amount: num(l.amount) })),
      payments: payments.map((p) => ({ ...p, amount: num(p.amount) })),
      pledges: pledges.map((p) => ({ ...p, amount: num(p.amount) })),
      regularGiving: plans.map((p) => ({ ...p, amount: num(p.amount) })),
      statements: statements.map((x) => ({ ...x, total: num(x.total) })),
    },
    attendance: { services: attendance, rsvps },
    tickets: { orders: orders.map(({ id: _i, ...o }) => ({ ...o, subtotal: num(o.subtotal), service_fee: num(o.service_fee), total: num(o.total) })), tickets },
    credit: {
      credits: credits.map((c) => ({ ...c, amount: num(c.amount), balance: num(c.balance) })),
      uses: creditUses.map((u) => ({ ...u, amount: num(u.amount) })),
      refunds: creditRefunds.map((r) => ({ ...r, amount: num(r.amount) })),
      transfers: creditTransfers.map((t) => ({ ...t, amount: num(t.amount) })),
    },
    prayerRequests: prayers,
    suggestions,
    groupPosts: posts,
    groupComments: comments,
    bookings,
    consents: { messages: globalConsent, byChurch: churchConsent, dataConsentRecordedAt: ms.map((m) => ({ church: m.church, at: m.consent_at })).filter((x) => x.at) },
    sessions: sessions.map((x) => ({ signedInAt: x.created_at, lastSeenAt: x.last_seen_at, device: x.user_agent ?? 'Unknown device', expiresAt: x.expires_at, endedAt: x.revoked_at })),
    linkOffers: offers,
    joinRequests: joins,
    household,
    churchRecords: { baptismAndMarriage: records, whoLookedAtYourGivingRecord: lookedAt },
    heldByChurchesForTheirWork: staffOnly,
  };
}

// ======================================================================================================================
// Erasure
// ======================================================================================================================

export interface ErasurePreview {
  canRequest: boolean;
  blockers: string[];
  churches: { orgId: string; name: string }[];
  forfeitedCredit: { church: string; balance: number }[];
  activeGivingPlans: number;
  childrenInYourHousehold: number;
  approval: 'church' | 'platform' | 'none';
  approvalText: string;
  kept: typeof KEPT_FOR_LAW;
  removed: string[];
  open: { id: string; status: string; createdAt: string } | null;
}

const REMOVED = [
  'Your name, phone number and email on the account (the account becomes "Former member" and you are signed out everywhere)',
  'Your member records at each church (name, phone, date of birth, sex, consent)',
  'Your messages inbox, message choices and consents',
  'Prayer requests, suggestions, group posts and comments you wrote (the text is removed)',
  'Your regular giving plans are cancelled, and any event credit you hold is forfeited',
  'Pick-up people you registered, and your name on attendance, ticket and booking records',
];

export async function erasurePreview(ctx: Ctx, s: Session): Promise<ErasurePreview> {
  const uid = s.uid;
  const q = <T = any>(sql: string, p: unknown[] = []) => ctx.db.query<T>(sql, p);
  const blockers: string[] = [];
  const u = (await q(`SELECT is_platform_admin FROM users WHERE id=$1`, [uid]))[0];
  if (u?.is_platform_admin) blockers.push('Platform administrator accounts cannot be closed here. Ask another administrator to remove your admin access first.');
  const owned = await q(
    `SELECT DISTINCT ra.org_id, o.name FROM role_assignments ra JOIN roles r ON r.id=ra.role_id JOIN organisations o ON o.id=ra.org_id WHERE ra.user_id=$1 AND r.name='Organisation Owner'`,
    [uid],
  );
  for (const o of owned) {
    const others = Number((await q<any>(`SELECT count(DISTINCT ra.user_id)::int AS n FROM role_assignments ra JOIN roles r ON r.id=ra.role_id WHERE ra.org_id=$1 AND r.name='Organisation Owner' AND ra.user_id <> $2`, [o.org_id, uid]))[0].n);
    if (others === 0) blockers.push(`You are the only Organisation Owner of ${o.name}. Give someone else that role first.`);
  }
  const refunds = Number((await q<any>(`SELECT count(*)::int AS n FROM credit_refunds WHERE user_id=$1 AND status IN ('pending','approved')`, [uid]))[0].n);
  const tRefunds = Number((await q<any>(`SELECT count(*)::int AS n FROM ticket_refunds r JOIN ticket_orders o ON o.id=r.order_id WHERE o.buyer_user_id=$1 AND r.status IN ('pending','approved')`, [uid]))[0].n);
  if (refunds + tRefunds > 0) blockers.push('A refund to you is still being processed. Please wait until it is paid or declined, then ask again.');

  const churches = await q(`SELECT DISTINCT m.org_id AS "orgId", o.name FROM memberships m JOIN organisations o ON o.id=m.org_id WHERE m.user_id=$1 AND m.status='active' ORDER BY o.name`, [uid]);
  const credit = await q(`SELECT o.name AS church, SUM(c.balance)::bigint AS balance FROM event_credits c JOIN organisations o ON o.id=c.org_id WHERE c.user_id=$1 AND c.balance > 0 GROUP BY o.name`, [uid]);
  const plans = Number((await q<any>(`SELECT count(*)::int AS n FROM giving_plans WHERE user_id=$1 AND status IN ('active','paused')`, [uid]))[0].n);
  const ids = await myMembershipIds(ctx.db, uid);
  const kids = ids.length ? Number((await q<any>(`SELECT count(DISTINCT g.child_id)::int AS n FROM guardians g WHERE g.guardian_id = ANY($1::text[])`, [ids]))[0].n) : 0;
  const open = (await q(`SELECT id, status, created_at FROM erasure_requests WHERE user_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1`, [uid]))[0] ?? null;

  const credits = credit.reduce((t, c) => t + Number(c.balance), 0);
  let approval: ErasurePreview['approval'];
  let approvalText: string;
  if (churches.length === 0 && credits === 0) {
    approval = 'none';
    approvalText = 'You are not a member of any church and hold no credit, so your account is closed straight away.';
  } else if (churches.length === 1) {
    approval = 'church';
    approvalText = `${churches[0].name} must approve this request, because they hold records about you. You will be told their answer in the app.`;
  } else {
    approval = 'platform';
    approvalText = churches.length > 1 ? 'You belong to more than one church, so a ChurchOS administrator reviews this request.' : 'Because you hold event credit, a ChurchOS administrator reviews this request.';
  }
  return {
    canRequest: blockers.length === 0 && !open,
    blockers,
    churches,
    forfeitedCredit: credit.map((c) => ({ church: c.church, balance: Number(c.balance) })),
    activeGivingPlans: plans,
    childrenInYourHousehold: kids,
    approval,
    approvalText,
    kept: KEPT_FOR_LAW,
    removed: REMOVED,
    open: open ? { id: open.id, status: open.status, createdAt: open.created_at } : null,
  };
}

/** Everyone who may decide: owners (members.settings) of the one church, and platform administrators. */
async function tellDeciders(ctx: Ctx, orgIds: string[]) {
  const body = 'A member has asked to close their account and have their data erased. Open Data requests to approve or decline it.';
  const told = new Set<string>();
  if (orgIds.length === 1) {
    const ras = await ctx.db.query<any>(`SELECT DISTINCT user_id FROM role_assignments WHERE org_id=$1`, [orgIds[0]]);
    for (const r of ras) {
      if (!(await branchesFor(ctx.db, r.user_id, 'members.settings')).some((b) => b.orgId === orgIds[0])) continue;
      told.add(r.user_id);
      await addNotification(ctx, { orgId: orgIds[0], userId: r.user_id, kind: 'announcement', title: 'A data request needs a decision', body, link: 'staff:data-requests', audience: 'staff' });
    }
  }
  for (const a of await ctx.db.query<any>(`SELECT id FROM users WHERE is_platform_admin=true`)) {
    if (told.has(a.id)) continue;
    await addNotification(ctx, { orgId: null, userId: a.id, kind: 'announcement', title: 'A data request needs a decision', body, link: 'staff:data-requests', audience: 'staff' });
  }
}

export async function requestErasure(ctx: Ctx, s: Session, b: { reason?: unknown; confirm?: unknown }) {
  if (b.confirm !== true) throw new HttpError(400, 'Please confirm that you want to close your account and erase your data', 'confirm_required');
  const pv = await erasurePreview(ctx, s);
  if (pv.open) throw new HttpError(409, 'You already have a request waiting for a decision', 'already_requested');
  if (pv.blockers.length) throw new HttpError(409, pv.blockers[0], 'cannot_erase_yet');
  const reason = String(b.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 500) || null;
  const id = ctx.newId('ers');
  const orgIds = pv.churches.map((c) => c.orgId);
  await ctx.db.query(
    `INSERT INTO erasure_requests (id, user_id, status, reason, org_ids, subject_name, subject_phone, created_at) VALUES ($1,$2,'pending',$3,$4::jsonb,$5,$6,$7)`,
    [id, s.uid, reason, JSON.stringify(orgIds), s.name, maskPhone(s.phone), ctx.clock.now().toISOString()],
  );
  await ctx.ledger.audit({ actor: s.uid, action: 'data.erasure_requested', category: 'member', entity: 'erasure_request', entityId: id, summary: 'Asked to close their account and erase their data', meta: { churches: orgIds.length, approval: pv.approval } });
  if (pv.approval === 'none') {
    const result = await completeErasure(ctx, id, { decidedBy: null, note: 'Closed straight away: no church, no credit, no money in progress' });
    return { id, status: 'completed' as const, approval: pv.approval, message: 'Your account is closed.', kept: KEPT_FOR_LAW, result };
  }
  await tellDeciders(ctx, orgIds);
  return { id, status: 'pending' as const, approval: pv.approval, message: pv.approvalText, kept: KEPT_FOR_LAW };
}

/** Who may decide this request: a platform administrator, or the owner (members.settings) when exactly one church holds records. */
async function mayDecide(ctx: Ctx, s: Session, orgIds: string[]): Promise<boolean> {
  if (s.isAdmin) return true;
  if (orgIds.length !== 1) return false;
  return (await branchesFor(ctx.db, s.uid, 'members.settings')).some((b) => b.orgId === orgIds[0]);
}

async function requestView(ctx: Ctx, s: Session, r: any) {
  const orgIds = (r.org_ids ?? []) as string[];
  const names = orgIds.length ? (await ctx.db.query<any>(`SELECT name FROM organisations WHERE id = ANY($1::text[])`, [orgIds])).map((o) => o.name as string) : [];
  return {
    id: r.id, status: r.status, name: r.subject_name ?? FORMER, phone: r.subject_phone ?? null, reason: r.reason, churches: names,
    createdAt: r.created_at, decidedAt: r.decided_at, note: r.note, completedAt: r.completed_at,
    canDecide: r.status === 'pending' && r.user_id !== s.uid && (await mayDecide(ctx, s, orgIds)),
    needsPlatformAdmin: r.status === 'pending' && orgIds.length !== 1,
  };
}

export async function listErasureRequests(ctx: Ctx, s: Session) {
  let rows: any[];
  if (s.isAdmin) rows = await ctx.db.query<any>(`SELECT * FROM erasure_requests ORDER BY created_at DESC LIMIT 200`);
  else {
    const orgs = [...new Set((await branchesFor(ctx.db, s.uid, 'members.settings')).map((b) => b.orgId))];
    if (!orgs.length) throw new HttpError(403, 'missing permission members.settings', 'forbidden');
    rows = [];
    for (const o of orgs) rows.push(...(await ctx.db.query<any>(`SELECT * FROM erasure_requests WHERE org_ids @> $1::jsonb ORDER BY created_at DESC LIMIT 200`, [JSON.stringify([o])])));
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }
  const out = [];
  for (const r of rows) out.push(await requestView(ctx, s, r));
  return { requests: out };
}

export async function decideErasure(ctx: Ctx, s: Session, id: string, decision: unknown, noteRaw: unknown) {
  if (decision !== 'approve' && decision !== 'decline') throw new HttpError(400, 'Choose approve or decline', 'bad_decision');
  const r = (await ctx.db.query<any>(`SELECT * FROM erasure_requests WHERE id=$1`, [id]))[0];
  if (!r) throw new HttpError(404, 'not found', 'not_found');
  const orgIds = (r.org_ids ?? []) as string[];
  if (!(await mayDecide(ctx, s, orgIds))) throw new HttpError(403, orgIds.length !== 1 ? 'A ChurchOS administrator must decide this request' : 'You may not decide this request', 'forbidden');
  if (r.user_id === s.uid) throw new HttpError(403, 'You cannot decide your own request', 'own_request');
  if (r.status !== 'pending') throw new HttpError(409, 'This request has already been decided', 'already_decided');
  const note = String(noteRaw ?? '').replace(/\s+/g, ' ').trim().slice(0, 500) || null;
  if (decision === 'decline') {
    if (!note) throw new HttpError(400, 'Say why the request is declined', 'note_required');
    const done = await ctx.db.query<any>(`UPDATE erasure_requests SET status='declined', decided_by=$2, decided_at=$3, note=$4, subject_name=NULL, subject_phone=NULL WHERE id=$1 AND status='pending' RETURNING id`, [id, s.uid, ctx.clock.now().toISOString(), note]);
    if (!done.length) throw new HttpError(409, 'This request has already been decided', 'already_decided');
    await addNotification(ctx, { orgId: orgIds[0] ?? null, userId: r.user_id, kind: 'announcement', title: 'Your data request was not approved', body: note, link: 'member:me' });
    await ctx.ledger.audit({ actor: s.uid, action: 'data.erasure_declined', category: 'member', entity: 'erasure_request', entityId: id, orgId: orgIds[0] ?? null, summary: 'Declined a request to erase an account', reason: note });
    return { id, status: 'declined' as const };
  }
  const result = await completeErasure(ctx, id, { decidedBy: s.uid, note });
  return { id, status: 'completed' as const, kept: KEPT_FOR_LAW, result };
}

/**
 * Runs the anonymisation and marks the request completed in ONE transaction: if anything fails, nothing changes and the request stays pending.
 * Money tables, the giving ledger and the audit log are not touched (see the header of this file).
 */
async function completeErasure(ctx: Ctx, requestId: string, by: { decidedBy: string | null; note: string | null }) {
  const now = ctx.clock.now().toISOString();
  const uid = String((await ctx.db.query<any>(`SELECT user_id FROM erasure_requests WHERE id=$1`, [requestId]))[0].user_id);
  const counts = await ctx.db.tx(async (q) => {
    const claimed = await q.query<any>(`UPDATE erasure_requests SET status='completed', decided_by=$2, decided_at=$3, completed_at=$3, note=$4, subject_name=NULL, subject_phone=NULL WHERE id=$1 AND status='pending' RETURNING id`, [requestId, by.decidedBy, now, by.note]);
    if (!claimed.length) throw new HttpError(409, 'This request has already been decided', 'already_decided');
    const u = (await q.query<any>(`SELECT phone, is_platform_admin FROM users WHERE id=$1`, [uid]))[0];
    if (!u) throw new HttpError(404, 'account not found', 'not_found');
    if (u.is_platform_admin) throw new HttpError(409, 'Platform administrator accounts cannot be erased here', 'is_admin');
    const phone = String(u.phone);
    const mine = await myMembershipIds(q, uid);
    // Children whose only remaining guardians are being erased lose their personal details too.
    const kids = mine.length
      ? (await q.query<any>(
          `SELECT DISTINCT c.id FROM memberships c JOIN guardians g ON g.child_id=c.id
            WHERE g.guardian_id = ANY($1::text[]) AND c.category='child'
              AND NOT EXISTS (SELECT 1 FROM guardians g2 JOIN memberships ga ON ga.id=g2.guardian_id WHERE g2.child_id=c.id AND g2.guardian_id <> ALL($1::text[]) AND ga.status='active')`,
          [mine],
        )).map((c) => c.id as string)
      : [];
    const people = [...mine, ...kids];
    const n: Record<string, number> = {};
    const run = async (key: string, sql: string, p: unknown[]) => { n[key] = (await q.query<any>(`${sql} RETURNING 1 AS x`, p)).length; };

    await run('memberships', `UPDATE memberships SET full_name=$2, phone=NULL, dob=NULL, sex=NULL, consent_at=NULL, consent_by=NULL, user_id=NULL, status='closed', closed_at=COALESCE(closed_at,$3) WHERE id = ANY($1::text[])`, [people, FORMER, now]);
    await run('attendance', `UPDATE attendance SET name=$2 WHERE membership_id = ANY($1::text[])`, [people, FORMER]);
    await run('visitors', `UPDATE visitors SET name=$2, phone='erased-' || id, note=NULL, contacted_by_name=NULL WHERE membership_id = ANY($1::text[])`, [people, FORMER]);
    await run('kidsCheckins', `UPDATE kids_checkins SET child_name = CASE WHEN child_id = ANY($1::text[]) THEN $3 ELSE child_name END, dropper_name = CASE WHEN dropper_id = ANY($2::text[]) THEN $3 ELSE dropper_name END, collector_name = CASE WHEN collector_id = ANY($2::text[]) THEN $3 ELSE collector_name END WHERE child_id = ANY($1::text[]) OR dropper_id = ANY($2::text[]) OR collector_id = ANY($2::text[])`, [kids, mine, FORMER]);
    await run('kidsLog', `UPDATE kids_log SET subject_name=$2 WHERE subject_id = ANY($1::text[])`, [people, FORMER]);
    await run('pickupPeople', `UPDATE kids_pickup_people SET name='Former contact', phone='', id_number=NULL, id_hash=NULL, relation=NULL, active=false WHERE guardian_id = ANY($1::text[])`, [mine]);
    await run('groupMembers', `DELETE FROM group_members WHERE membership_id = ANY($1::text[])`, [mine]);
    await run('birthdayWishes', `DELETE FROM birthday_wishes WHERE membership_id = ANY($1::text[])`, [people]);
    await run('posts', `UPDATE group_posts SET author_name=$2, body='[removed]', deleted_at=COALESCE(deleted_at,$3), deleted_by=COALESCE(deleted_by,'erasure') WHERE author_id=$1`, [uid, FORMER, now]);
    await run('comments', `UPDATE group_comments SET author_name=$2, body='[removed]', deleted_at=COALESCE(deleted_at,$3), deleted_by=COALESCE(deleted_by,'erasure') WHERE author_id=$1`, [uid, FORMER, now]);
    await run('groupRequests', `UPDATE group_join_requests SET name=$2 WHERE user_id=$1`, [uid, FORMER]);
    await run('rsvps', `UPDATE event_rsvps SET name=$2 WHERE user_id=$1`, [uid, FORMER]);
    await run('prayer', `UPDATE prayer_requests SET body='[removed]', author_name=NULL, status='hidden', answered_note=NULL WHERE id IN (SELECT prayer_id FROM prayer_owners WHERE user_id=$1)`, [uid]);
    await q.query(`DELETE FROM prayer_owners WHERE user_id=$1`, [uid]);
    await q.query(`DELETE FROM prayer_prays WHERE user_id=$1`, [uid]);
    await run('suggestions', `UPDATE suggestions SET body='[removed]', author_name=NULL, membership_id=NULL WHERE id IN (SELECT suggestion_id FROM suggestion_owners WHERE user_id=$1)`, [uid]);
    await q.query(`DELETE FROM suggestion_owners WHERE user_id=$1`, [uid]);
    // Tickets first: they are found through the orders, and the orders lose their link to the person in the next statement.
    await run('tickets', `UPDATE tickets SET holder_name=$2 WHERE order_id IN (SELECT id FROM ticket_orders WHERE buyer_user_id=$1)`, [uid, FORMER]);
    await run('ticketOrders', `UPDATE ticket_orders SET buyer_name=$2, buyer_email=NULL, buyer_phone=NULL, buyer_user_id=NULL, buyer_membership_id=NULL WHERE buyer_user_id=$1`, [uid, FORMER]);
    const forfeit = Number((await q.query<any>(`SELECT COALESCE(SUM(balance),0)::bigint AS t FROM event_credits WHERE user_id=$1`, [uid]))[0].t);
    await run('credits', `UPDATE event_credits SET balance=0, user_id=NULL, email=NULL WHERE user_id=$1`, [uid]);
    await run('creditRefunds', `UPDATE credit_refunds SET member_name=$2, phone=NULL, reason=NULL WHERE user_id=$1`, [uid, FORMER]);
    await run('creditTransfers', `UPDATE credit_transfers SET from_name = CASE WHEN from_user=$1 THEN $2 ELSE from_name END, to_name = CASE WHEN to_user=$1 THEN $2 ELSE to_name END, note=NULL WHERE from_user=$1 OR to_user=$1`, [uid, FORMER]);
    await run('givingPlans', `UPDATE giving_plans SET status='cancelled', phone='', next_run_at=NULL WHERE user_id=$1`, [uid]);
    await run('anonymousGifts', `UPDATE anonymous_gifts SET phone='' WHERE user_id=$1`, [uid]);
    await run('bookings', `UPDATE bookings SET requester_name=$2, note=NULL WHERE requester_id=$1`, [uid, FORMER]);
    await run('smsLog', `UPDATE sms_messages SET to_phone='', body='[removed]' WHERE to_phone=$1`, [phone]);
    await run('joinRequests', `UPDATE join_requests SET name=$2, phone=NULL, message=NULL WHERE user_id=$1`, [uid, FORMER]);
    await run('linkOffers', `DELETE FROM link_offers WHERE user_id=$1 AND status='pending'`, [uid]);
    await run('notifications', `DELETE FROM notifications WHERE user_id=$1`, [uid]);
    await q.query(`DELETE FROM advert_seen WHERE user_id=$1`, [uid]);
    await q.query(`DELETE FROM attendance_prefs WHERE user_id=$1`, [uid]);
    await q.query(`DELETE FROM email_codes WHERE user_id=$1`, [uid]);
    await run('consents', `DELETE FROM contact_prefs WHERE phone=$1`, [phone]);
    await q.query(`DELETE FROM contact_prefs_org WHERE phone=$1`, [phone]);
    await q.query(`DELETE FROM otp_codes WHERE phone=$1`, [phone]);
    await run('roles', `DELETE FROM role_assignments WHERE user_id=$1`, [uid]);
    await q.query(`INSERT INTO erased_phones (phone_hash, erased_at) VALUES ($1,$2) ON CONFLICT (phone_hash) DO UPDATE SET erased_at=EXCLUDED.erased_at`, [phoneHash(phone), now]);
    await run('sessions', `UPDATE sessions SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL`, [uid, now]);
    const hash = createHash('sha256').update(`erased:${uid}`).digest('hex').slice(0, 16);
    await q.query(`UPDATE users SET name=$2, phone=$3, email=NULL, email_verified=false WHERE id=$1`, [uid, FORMER, `erased-${hash}`]);
    n.forfeitedCreditCents = forfeit;
    return n;
  });
  // Sessions are remembered for a few seconds by the server; this clears that memory at once.
  for (const x of await ctx.db.query<any>(`SELECT id FROM sessions WHERE user_id=$1`, [uid])) await revokeSession(ctx, x.id, uid);
  await ctx.ledger.audit({ actor: by.decidedBy ?? uid, action: 'data.erasure_completed', category: 'member', entity: 'user', entityId: uid, summary: 'Closed an account and erased the personal data held for it', reason: by.note, meta: { requestId, counts, kept: 'ledger, payments, postings, audit' } });
  await ctx.db.query(`UPDATE erasure_requests SET result=$2::jsonb WHERE id=$1`, [requestId, JSON.stringify(counts)]);
  return counts;
}
