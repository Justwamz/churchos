import type { FastifyInstance, FastifyRequest } from 'fastify';
import { buildReference, computeFee, networkMismatch, toCents } from '@churchos/shared';
import { normalizePhone } from '../auth';
import { HttpError, requireSession, type Ctx } from '../ctx';
import { grantsFor } from '../scope';
import { notify } from '../sms';
import { csv, normalizeMethod } from './helpers';

/**
 * Regular giving (L197 to L203). A member sets up a plan; on each due date ChurchOS sends the phone prompt, the member types
 * their PIN, and the gift is recorded like any other. Nobody is ever charged without doing something.
 */

const MIN_CENTS = 1000;
const MAX_CENTS = 15_000_000;
const MAX_ACTIVE_PLANS = 5;
const EAT = 3 * 3600_000;
const DAY = 86_400_000;
/** The first prompt, then retries 3 hours, 1 day and 2 days after the due time, and "missed" 3 hours after the last one (L199). */
const ATTEMPT_OFFSETS_MS = [0, 3 * 3600_000, DAY, 2 * DAY];
const MISSED_AFTER_MS = 2 * DAY + 3 * 3600_000;
const STALE_MS = 3 * DAY;
const DEFAULT_TIME = '10:00';
const METHODS = ['mpesa', 'airtel', 'tkash'];
const FREQ_LABEL: Record<string, string> = { weekly: 'weekly', fortnightly: 'every two weeks', monthly: 'monthly' };
const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const HOOKS = new WeakMap<Ctx, { jobs: () => Promise<{ created: number; prompted: number; missed: number }>; paid: (runId: string, paymentId: string | null) => Promise<void> }>();

const pad = (n: number) => String(n).padStart(2, '0');
const dateStr = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parseDate = (s: string) => new Date(`${s}T00:00:00Z`);
const addDays = (s: string, n: number) => dateStr(new Date(parseDate(s).getTime() + n * DAY));
const eatToday = (now: Date) => dateStr(new Date(now.getTime() + EAT));
const dueAt = (date: string, time: string) => new Date(Date.parse(`${date}T${time}:00Z`) - EAT).toISOString();
const eatDateOf = (iso: string) => dateStr(new Date(Date.parse(iso) + EAT));
const isoWeekday = (s: string) => ((parseDate(s).getUTCDay() + 6) % 7) + 1;
const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const kes = (c: number) => `KES ${(c / 100).toLocaleString('en-KE')}`;
const cap = (v: unknown, n: number) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, n);

interface Shape { frequency: string; weekday: number | null; month_day: number | null; anchor_date: string | null }

/** The first due date on or after `min`. */
export function nextOccurrence(p: Shape, min: string): string {
  if (p.frequency === 'weekly' || (p.frequency === 'fortnightly' && !p.anchor_date)) {
    let d = min;
    for (let i = 0; i < 7 && isoWeekday(d) !== p.weekday; i++) d = addDays(d, 1);
    return d;
  }
  if (p.frequency === 'fortnightly') {
    const diff = Math.round((parseDate(min).getTime() - parseDate(p.anchor_date!).getTime()) / DAY);
    return diff <= 0 ? p.anchor_date! : addDays(p.anchor_date!, Math.ceil(diff / 14) * 14);
  }
  let y = parseDate(min).getUTCFullYear();
  let m = parseDate(min).getUTCMonth() + 1;
  for (let i = 0; i < 26; i++) {
    const day = p.month_day === 0 ? lastDayOf(y, m) : Math.min(p.month_day!, lastDayOf(y, m));
    const cand = `${y}-${pad(m)}-${pad(day)}`;
    if (cand >= min) return cand;
    m++;
    if (m > 12) { m = 1; y++; }
  }
  throw new Error('no occurrence');
}

const timeOk = (t: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t) && t >= '06:00' && t <= '21:00';

export function givingPlanRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };
  const nowIso = () => ctx.clock.now().toISOString();

  async function myMembership(uid: string, id: unknown) {
    const m = (await ctx.db.query<any>(
      `SELECT m.id, m.org_id, m.branch_id, m.full_name, m.phone, b.code AS branch_code, b.name AS branch_name, o.name AS org_name, o.fee_bearer, o.fee_schedule
         FROM memberships m JOIN branches b ON b.id=m.branch_id JOIN organisations o ON o.id=m.org_id WHERE m.id=$1 AND m.user_id=$2 AND m.status='active' AND m.category='adult'`,
      [String(id ?? ''), uid],
    ))[0];
    if (!m) throw new HttpError(404, 'You need to be a member of this church to give regularly', 'not_a_member');
    return m;
  }

  const purposeLabel = (p: any) => (p.purpose === 'TITHE' ? 'tithe' : p.purpose === 'OFFERING' ? 'offering' : p.project_name ? p.project_name : 'gift');

  async function planView(p: any) {
    const org = (await ctx.db.query<any>(`SELECT fee_bearer, fee_schedule FROM organisations WHERE id=$1`, [p.org_id]))[0];
    const fee = computeFee(org.fee_schedule, normalizeMethod(p.method) as any, Number(p.amount), org.fee_bearer);
    const runs = await ctx.db.query<any>(`SELECT * FROM giving_plan_runs WHERE plan_id=$1 ORDER BY scheduled_for DESC LIMIT 6`, [p.id]);
    const sums = (await ctx.db.query<any>(`SELECT COALESCE(SUM(amount) FILTER (WHERE status='completed'),0) AS given FROM giving_plan_runs WHERE plan_id=$1`, [p.id]))[0];
    return {
      id: p.id, church: p.org_name ?? undefined, branch: p.branch_name ?? undefined, branchCode: p.branch_code ?? undefined, membershipId: p.membership_id,
      amount: Number(p.amount), youPay: fee.amountPaid, purpose: p.purpose, purposeLabel: purposeLabel(p), projectId: p.project_id,
      anonymous: !!p.anonymous, frequency: p.frequency, frequencyLabel: FREQ_LABEL[p.frequency], weekday: p.weekday, monthDay: p.month_day, time: p.time_of_day,
      startDate: p.start_date, endDate: p.end_date, method: p.method, phone: p.phone ? `0${String(p.phone).slice(3, 6)} *** ${String(p.phone).slice(-3)}` : null,
      status: p.status, skipNext: p.skip_next, nextRunAt: p.next_run_at, completed: p.completed_count, missed: p.missed_count, totalGiven: Number(sums.given),
      runs: runs.map((r) => ({ id: r.id, dueDate: r.due_date, scheduledFor: r.scheduled_for, status: r.status, attempt: r.attempt, amount: Number(r.amount), kind: r.kind, note: r.note, completedAt: r.completed_at })),
    };
  }

  const SELECT_PLAN = `SELECT p.*, b.name AS branch_name, b.code AS branch_code, o.name AS org_name, pr.name AS project_name
      FROM giving_plans p JOIN branches b ON b.id=p.branch_id JOIN organisations o ON o.id=p.org_id LEFT JOIN projects pr ON pr.id=p.project_id`;

  app.get('/me/giving-plans', auth, async (req) => {
    const rows = await ctx.db.query<any>(`${SELECT_PLAN} WHERE p.user_id=$1 AND p.status <> 'cancelled' ORDER BY p.created_at DESC`, [req.session!.uid]);
    const plans = [];
    for (const r of rows) plans.push(await planView(r));
    return { plans };
  });

  async function loadMine(req: FastifyRequest, id: string) {
    const p = (await ctx.db.query<any>(`${SELECT_PLAN} WHERE p.id=$1 AND p.user_id=$2`, [id, req.session!.uid]))[0];
    if (!p) throw new HttpError(404, 'not found', 'not_found');
    return p;
  }

  async function tellMember(p: any, title: string, body: string, sms = false) {
    const account = (await ctx.db.query<any>(`SELECT phone FROM users WHERE id=$1`, [p.user_id]))[0]?.phone ?? p.phone;
    await notify(ctx, { orgId: p.org_id, branchId: p.branch_id, phone: account, kind: 'announcement', title, body, idemKey: `plan:${p.id}:${title}:${nowIso().slice(0, 16)}`, sms, link: 'member:give?sub=regular' });
  }

  /** Reads the form: amount, how often, when, and on what. Shared by setting up a plan and changing one. */
  async function parsePlan(b: any, m: any, existing?: any) {
    const get = (k: string, fallback: any) => (b[k] !== undefined ? b[k] : fallback);
    let amount: number;
    try { amount = toCents(get('amount', existing ? Number(existing.amount) / 100 : undefined)); } catch { throw new HttpError(400, 'Enter a valid amount', 'bad_amount'); }
    if (amount < MIN_CENTS) throw new HttpError(400, 'The minimum gift is KES 10', 'amount_too_small');
    if (amount > MAX_CENTS) throw new HttpError(400, 'The maximum for one gift is KES 150,000', 'amount_too_large');
    const method = String(normalizeMethod(get('method', existing?.method ?? 'mpesa')));
    if (method === 'card') throw new HttpError(400, "Cards cannot be charged automatically yet. Use M-Pesa, Airtel Money or T-Kash, and we will send a prompt to your phone.", 'card_not_supported');
    if (!METHODS.includes(method)) throw new HttpError(400, 'Choose M-Pesa, Airtel Money or T-Kash', 'bad_method');
    const phone = normalizePhone(String(get('phone', existing?.phone ?? m.phone ?? '')));
    if (!phone) throw new HttpError(400, 'Enter a valid Kenyan phone number, for example 0712 345 678', 'bad_phone');
    const mismatch = networkMismatch(method as any, phone);
    if (mismatch) throw new HttpError(400, mismatch, 'wrong_network');
    const time = String(get('time', existing?.time_of_day ?? DEFAULT_TIME));
    if (!timeOk(time)) throw new HttpError(400, 'Choose a time between 6:00 am and 9:00 pm', 'bad_time');
    const endDate = get('endDate', existing?.end_date ?? null) || null;
    if (endDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(endDate))) throw new HttpError(400, 'Choose a valid end date', 'bad_date');
    return { amount, method, phone, time, endDate: endDate as string | null };
  }

  async function purposeOf(b: any, m: any) {
    const purpose = String(b.purpose ?? 'TITHE').trim().toUpperCase();
    if (purpose === 'TITHE' || purpose === 'OFFERING') return { purpose, projectId: null as string | null };
    if (purpose.startsWith('PROJ-')) {
      const p = (await ctx.db.query<any>(`SELECT id FROM projects WHERE branch_id=$1 AND code=$2 AND status='open'`, [m.branch_id, purpose.slice(5)]))[0];
      if (!p) throw new HttpError(400, 'That project is not open for giving', 'unknown_purpose');
      return { purpose, projectId: p.id as string };
    }
    throw new HttpError(400, 'Choose tithe, offering or an open project', 'unknown_purpose');
  }

  app.post('/me/giving-plans', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const m = await myMembership(req.session!.uid, b.membershipId);
    const open = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM giving_plans WHERE user_id=$1 AND status IN ('active','paused')`, [req.session!.uid]))[0].n);
    if (open >= MAX_ACTIVE_PLANS) throw new HttpError(409, `You can have up to ${MAX_ACTIVE_PLANS} regular gifts. Cancel one first.`, 'too_many');
    const f = await parsePlan(b, m);
    const { purpose, projectId } = await purposeOf(b, m);
    const frequency = String(b.frequency ?? '');
    if (!FREQ_LABEL[frequency]) throw new HttpError(400, 'Choose weekly, every two weeks or monthly', 'bad_frequency');
    const now = ctx.clock.now();
    const today = eatToday(now);
    const startDate = b.startDate ? String(b.startDate) : today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || startDate < today || startDate > addDays(today, 366)) throw new HttpError(400, 'Choose a start date from today to a year ahead', 'bad_date');
    if (f.endDate && f.endDate <= startDate) throw new HttpError(400, 'The end date must be after the start date', 'bad_date');
    let weekday: number | null = null;
    let monthDay: number | null = null;
    if (frequency === 'monthly') {
      monthDay = b.monthDay === 'last' || Number(b.monthDay) === 0 ? 0 : Number(b.monthDay ?? Number(startDate.slice(8)));
      if (!Number.isInteger(monthDay) || monthDay < 0 || monthDay > 28) throw new HttpError(400, 'Choose a day from 1 to 28, or the last day of the month', 'bad_day');
    } else {
      weekday = b.weekday !== undefined && b.weekday !== null && b.weekday !== '' ? Number(b.weekday) : isoWeekday(startDate);
      if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) throw new HttpError(400, 'Choose a day of the week', 'bad_day');
    }
    const firstNow = !!b.firstNow;
    // The series starts at the first due date from the start date. If a gift is also given now, that date cannot be today.
    let minDate = firstNow && startDate === today ? addDays(today, 1) : startDate;
    const shape: Shape = { frequency, weekday, month_day: monthDay, anchor_date: null };
    let first = nextOccurrence(shape, minDate);
    if (dueAt(first, f.time) <= nowIso()) { minDate = addDays(first, 1); first = nextOccurrence(shape, minDate); }
    if (f.endDate && first > f.endDate) throw new HttpError(400, 'The end date comes before the first gift', 'bad_date');
    const id = ctx.newId('gpl');
    await ctx.db.query(
      `INSERT INTO giving_plans (id, org_id, branch_id, membership_id, user_id, phone, amount, method, purpose, project_id, frequency, weekday, month_day, anchor_date, time_of_day, start_date, end_date, next_run_at, created_at, updated_at, anonymous)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19,$20)`,
      [id, m.org_id, m.branch_id, m.id, req.session!.uid, f.phone, f.amount, f.method, purpose, projectId, frequency, weekday, monthDay, first, f.time, startDate, f.endDate, dueAt(first, f.time), nowIso(), !!b.anonymous],
    );
    const plan = (await ctx.db.query<any>(`${SELECT_PLAN} WHERE p.id=$1`, [id]))[0];
    await ctx.ledger.audit({ orgId: m.org_id, branchId: m.branch_id, actor: req.session!.uid, action: 'giving.plan_created', entity: 'giving_plan', entityId: id, summary: `${m.full_name} set up a ${FREQ_LABEL[frequency]} gift of ${kes(f.amount)} (${purposeLabel(plan)})` });
    await tellMember(plan, 'Your regular gift is set up', `${kes(f.amount)} ${FREQ_LABEL[frequency]} for ${purposeLabel(plan)}. The first prompt will come to your phone on ${new Date(dueAt(first, f.time)).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. You type your PIN each time, and you can pause, skip or stop whenever you like.`);
    let started: any = null;
    if (firstNow) {
      const run = await createRun(plan, today, nowIso(), 'first');
      await attemptRun(run.id);
      started = (await ctx.db.query<any>(`SELECT status, attempt FROM giving_plan_runs WHERE id=$1`, [run.id]))[0];
    }
    return { ...(await planView((await ctx.db.query<any>(`${SELECT_PLAN} WHERE p.id=$1`, [id]))[0])), firstGift: started ? { prompted: started.attempt > 0 } : null };
  });

  app.patch('/me/giving-plans/:id', auth, async (req) => {
    if ((req.body as any)?.anonymous !== undefined) await ctx.db.query(`UPDATE giving_plans SET anonymous=$2 WHERE id=$1 AND user_id=$3`, [(req.params as any).id, !!(req.body as any).anonymous, req.session!.uid]);
    const p = await loadMine(req, (req.params as any).id);
    if (p.status === 'cancelled' || p.status === 'ended') throw new HttpError(409, 'This regular gift has ended', 'wrong_state');
    const b = (req.body ?? {}) as any;
    const m = await myMembership(req.session!.uid, p.membership_id);
    const f = await parsePlan(b, m, p);
    if (f.endDate && p.next_run_at && f.endDate < eatDateOf(p.next_run_at)) throw new HttpError(400, 'The end date comes before the next gift', 'bad_date');
    // A new time starts with the next prompt. If that moment has already passed today it starts the cycle after.
    let nextRun = p.next_run_at as string | null;
    if (nextRun && f.time !== p.time_of_day) {
      const moved = dueAt(eatDateOf(nextRun), f.time);
      if (moved > nowIso()) nextRun = moved;
    }
    await ctx.db.query(`UPDATE giving_plans SET amount=$2, method=$3, phone=$4, time_of_day=$5, end_date=$6, next_run_at=$7, updated_at=$8 WHERE id=$1`, [p.id, f.amount, f.method, f.phone, f.time, f.endDate, nextRun, nowIso()]);
    const changes: string[] = [];
    if (f.amount !== Number(p.amount)) changes.push(`amount ${kes(Number(p.amount))} to ${kes(f.amount)}`);
    if (f.time !== p.time_of_day) changes.push(`time ${p.time_of_day} to ${f.time}`);
    if (f.method !== p.method) changes.push(`method ${p.method} to ${f.method}`);
    if (f.phone !== p.phone) changes.push('phone number');
    if ((f.endDate ?? null) !== (p.end_date ?? null)) changes.push('end date');
    if (changes.length) await ctx.ledger.audit({ orgId: p.org_id, branchId: p.branch_id, actor: req.session!.uid, action: 'giving.plan_updated', entity: 'giving_plan', entityId: p.id, summary: `${m.full_name} changed their regular gift: ${changes.join(', ')}` });
    return planView((await ctx.db.query<any>(`${SELECT_PLAN} WHERE p.id=$1`, [p.id]))[0]);
  });

  async function setStatus(req: FastifyRequest, id: string, to: 'paused' | 'active' | 'cancelled') {
    const p = await loadMine(req, id);
    if (p.status === 'cancelled' || p.status === 'ended') throw new HttpError(409, 'This regular gift has ended', 'wrong_state');
    if (p.status === to) return planView(p);
    let nextRun = p.next_run_at as string | null;
    if (to === 'active') {
      // Resuming picks up at the next due date from now, never a gift that was missed while paused.
      const today = eatToday(ctx.clock.now());
      let occ = nextOccurrence(p, today);
      if (dueAt(occ, p.time_of_day) <= nowIso()) occ = nextOccurrence(p, addDays(occ, 1));
      nextRun = p.end_date && occ > p.end_date ? null : dueAt(occ, p.time_of_day);
    }
    const status = to === 'active' && !nextRun ? 'ended' : to;
    await ctx.db.query(`UPDATE giving_plans SET status=$2, next_run_at=$3, updated_at=$4 WHERE id=$1`, [p.id, status, to === 'cancelled' ? null : nextRun, nowIso()]);
    if (to !== 'active') await ctx.db.query(`UPDATE giving_plan_runs SET status='skipped', note=$2 WHERE plan_id=$1 AND status='prompted'`, [p.id, to === 'paused' ? 'Paused' : 'Cancelled']);
    const verb = to === 'paused' ? 'paused' : to === 'active' ? 'resumed' : 'cancelled';
    await ctx.ledger.audit({ orgId: p.org_id, branchId: p.branch_id, actor: req.session!.uid, action: `giving.plan_${verb}`, entity: 'giving_plan', entityId: p.id, summary: `${req.session!.name} ${verb} their regular gift of ${kes(Number(p.amount))} (${purposeLabel(p)})` });
    await tellMember(p, `Your regular gift was ${verb}`, to === 'paused' ? 'No prompts will be sent until you resume it.' : to === 'cancelled' ? 'You will not be asked again. Thank you for giving.' : 'Prompts will start again from the next due date.');
    return planView((await ctx.db.query<any>(`${SELECT_PLAN} WHERE p.id=$1`, [p.id]))[0]);
  }
  app.post('/me/giving-plans/:id/pause', auth, async (req) => setStatus(req, (req.params as any).id, 'paused'));
  app.post('/me/giving-plans/:id/resume', auth, async (req) => setStatus(req, (req.params as any).id, 'active'));
  app.post('/me/giving-plans/:id/cancel', auth, async (req) => setStatus(req, (req.params as any).id, 'cancelled'));

  app.post('/me/giving-plans/:id/skip-next', auth, async (req) => {
    const p = await loadMine(req, (req.params as any).id);
    if (p.status !== 'active') throw new HttpError(409, 'Only an active regular gift can skip a gift', 'wrong_state');
    const skip = (req.body as any)?.skip !== false;
    await ctx.db.query(`UPDATE giving_plans SET skip_next=$2, updated_at=$3 WHERE id=$1`, [p.id, skip, nowIso()]);
    await ctx.ledger.audit({ orgId: p.org_id, branchId: p.branch_id, actor: req.session!.uid, action: 'giving.plan_updated', entity: 'giving_plan', entityId: p.id, summary: `${req.session!.name} ${skip ? 'skipped' : 'restored'} the next gift of their regular gift` });
    return planView((await ctx.db.query<any>(`${SELECT_PLAN} WHERE p.id=$1`, [p.id]))[0]);
  });

  app.get('/me/giving-plans/:id/runs', auth, async (req) => {
    const p = await loadMine(req, (req.params as any).id);
    const runs = await ctx.db.query<any>(`SELECT * FROM giving_plan_runs WHERE plan_id=$1 ORDER BY scheduled_for DESC LIMIT 100`, [p.id]);
    return { runs: runs.map((r) => ({ id: r.id, dueDate: r.due_date, scheduledFor: r.scheduled_for, status: r.status, attempt: r.attempt, amount: Number(r.amount), kind: r.kind, note: r.note, completedAt: r.completed_at })) };
  });

  // ======================= the prompts =======================

  async function createRun(p: any, dueDate: string, scheduledFor: string, kind: 'scheduled' | 'first') {
    const id = ctx.newId('gpr');
    await ctx.db.query(
      `INSERT INTO giving_plan_runs (id, plan_id, org_id, due_date, scheduled_for, kind, amount, status, attempt, next_attempt_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'prompted',0,$5,$8)`,
      [id, p.id, p.org_id, dueDate, scheduledFor, kind, p.amount, nowIso()],
    );
    return { id };
  }

  /** Sends one prompt for a run, or marks it missed when the last try has run out. */
  async function attemptRun(runId: string): Promise<'prompted' | 'missed' | 'skipped' | 'completed' | 'waiting'> {
    const r = (await ctx.db.query<any>(`SELECT * FROM giving_plan_runs WHERE id=$1`, [runId]))[0];
    if (!r || r.status !== 'prompted') return 'waiting';
    const p = (await ctx.db.query<any>(`${SELECT_PLAN} WHERE p.id=$1`, [r.plan_id]))[0];
    const now = ctx.clock.now().getTime();
    const skip = async (note: string) => { await ctx.db.query(`UPDATE giving_plan_runs SET status='skipped', note=$2 WHERE id=$1`, [r.id, note]); return 'skipped' as const; };
    if (p.status === 'paused' || p.status === 'cancelled') return skip(p.status === 'paused' ? 'Paused' : 'Cancelled');
    const last = r.intent_id ? (await ctx.db.query<any>(`SELECT status, payment_id FROM give_intents WHERE id=$1`, [r.intent_id]))[0] : null;
    if (last?.status === 'completed') { await runPaid(r.id, last.payment_id); return 'completed'; }
    const member = (await ctx.db.query<any>(`SELECT status FROM memberships WHERE id=$1`, [p.membership_id]))[0];
    if (!member || member.status !== 'active') {
      await ctx.db.query(`UPDATE giving_plans SET status='cancelled', next_run_at=NULL, updated_at=$2 WHERE id=$1`, [p.id, nowIso()]);
      return skip('No longer a member');
    }
    const t0 = Date.parse(r.scheduled_for);
    if (now - t0 > STALE_MS && r.attempt === 0) return missRun(p, r, 'ChurchOS was not running at the time');
    if (r.attempt >= ATTEMPT_OFFSETS_MS.length) return missRun(p, r, null);

    const org = (await ctx.db.query<any>(`SELECT fee_bearer, fee_schedule FROM organisations WHERE id=$1`, [p.org_id]))[0];
    const branch = (await ctx.db.query<any>(`SELECT code FROM branches WHERE id=$1`, [p.branch_id]))[0];
    const method = normalizeMethod(p.method) as any;
    const fee = computeFee(org.fee_schedule, method, Number(r.amount), org.fee_bearer);
    const reference = buildReference(branch.code, p.purpose);
    let intentId: string | null = null;
    try {
      const { providerTxId } = await ctx.provider.initiateStkPush({ phone: p.phone, amount: fee.amountPaid, reference, method });
      intentId = ctx.newId('int');
      await ctx.db.query(
        `INSERT INTO give_intents (id, provider_tx_id, org_id, branch_id, purpose, project_id, phone, method, base_amount, amount_paid, fee, created_at, plan_run_id, anonymous) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [intentId, providerTxId, p.org_id, p.branch_id, p.purpose, p.project_id, p.anonymous ? '' : p.phone, method, Number(r.amount), fee.amountPaid, JSON.stringify(fee), nowIso(), r.id, !!p.anonymous],
      );
      if (p.anonymous) await ctx.db.query(`INSERT INTO anonymous_gifts (intent_id, user_id, phone, created_at) VALUES ($1,$2,$3,$4)`, [intentId, p.user_id, p.phone, nowIso()]);
    } catch {
      intentId = null;
    }
    const attempt = r.attempt + 1;
    const nextAt = attempt < ATTEMPT_OFFSETS_MS.length ? t0 + ATTEMPT_OFFSETS_MS[attempt] : t0 + MISSED_AFTER_MS;
    await ctx.db.query(`UPDATE giving_plan_runs SET attempt=$2, intent_id=COALESCE($3, intent_id), prompted_at=$4, next_attempt_at=$5 WHERE id=$1`, [r.id, attempt, intentId, nowIso(), new Date(Math.max(nextAt, now + 60_000)).toISOString()]);
    if (intentId) await tellMember(p, `Time for your ${purposeLabel(p)} gift`, `We have sent a prompt for ${kes(Number(r.amount))} to your phone. Enter your PIN to give.${attempt > 1 ? ' (Reminder)' : ''}`);
    return 'prompted';
  }

  async function missRun(p: any, r: any, note: string | null) {
    const claimed = await ctx.db.query<any>(`UPDATE giving_plan_runs SET status='missed', note=$2 WHERE id=$1 AND status='prompted' RETURNING id`, [r.id, note]);
    if (!claimed[0]) return 'waiting' as const;
    await ctx.db.query(`UPDATE giving_plans SET missed_count=missed_count+1, updated_at=$2 WHERE id=$1`, [p.id, nowIso()]);
    await ctx.ledger.audit({ orgId: p.org_id, branchId: p.branch_id, actorType: 'system', action: 'giving.run_missed', entity: 'giving_plan', entityId: p.id, summary: `A regular gift of ${kes(Number(r.amount))} for ${r.due_date} was not completed`, meta: { run: r.id } });
    const next = p.next_run_at ? ` Your next prompt is on ${new Date(p.next_run_at).toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi', weekday: 'short', day: 'numeric', month: 'short' })}.` : '';
    await tellMember(p, `We could not collect your ${purposeLabel(p)} gift`, `We could not collect your ${purposeLabel(p)} gift of ${kes(Number(r.amount))}: the prompt was not completed.${next} You can give now from the Give tab.`, true);
    return 'missed' as const;
  }

  async function runPaid(runId: string, paymentId: string | null) {
    const r = await ctx.db.query<any>(`UPDATE giving_plan_runs SET status='completed', completed_at=$2, payment_id=$3 WHERE id=$1 AND status='prompted' RETURNING plan_id`, [runId, nowIso(), paymentId]);
    if (r[0]) await ctx.db.query(`UPDATE giving_plans SET completed_count=completed_count+1, last_run_at=$2, updated_at=$2 WHERE id=$1`, [r[0].plan_id, nowIso()]);
  }

  /** Plans that are due get a run; runs that are due get their prompt or retry (L198, L199). */
  async function jobs() {
    const now = nowIso();
    let created = 0, prompted = 0, missed = 0;
    const due = await ctx.db.query<any>(`${SELECT_PLAN} WHERE p.status='active' AND p.next_run_at <= $1 ORDER BY p.next_run_at LIMIT 500`, [now]);
    for (const p of due) {
      const dueDate = eatDateOf(p.next_run_at);
      const nextDate = nextOccurrence(p, addDays(dueDate, 1));
      const ended = !!p.end_date && nextDate > p.end_date;
      const claimed = await ctx.db.query<any>(
        `UPDATE giving_plans SET next_run_at=$3, status=CASE WHEN $4 THEN 'ended' ELSE status END, skip_next=false, updated_at=$5 WHERE id=$1 AND next_run_at=$2 RETURNING id`,
        [p.id, p.next_run_at, ended ? null : dueAt(nextDate, p.time_of_day), ended, now],
      );
      if (!claimed[0]) continue;
      if (p.skip_next) {
        await ctx.db.query(`INSERT INTO giving_plan_runs (id, plan_id, org_id, due_date, scheduled_for, kind, amount, status, attempt, note, created_at) VALUES ($1,$2,$3,$4,$5,'scheduled',$6,'skipped',0,'Skipped by you',$7)`, [ctx.newId('gpr'), p.id, p.org_id, dueDate, p.next_run_at, p.amount, now]);
        continue;
      }
      await createRun(p, dueDate, p.next_run_at, 'scheduled');
      created++;
    }
    const runs = await ctx.db.query<any>(`SELECT id FROM giving_plan_runs WHERE status='prompted' AND next_attempt_at <= $1 ORDER BY next_attempt_at LIMIT 500`, [now]);
    for (const r of runs) {
      const res = await attemptRun(r.id);
      if (res === 'prompted') prompted++;
      if (res === 'missed') missed++;
    }
    return { created, prompted, missed };
  }
  HOOKS.set(ctx, { jobs, paid: runPaid });

  // ======================= staff (L202) =======================

  app.get('/giving-plans', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'collections.view');
    const q = req.query as any;
    const where = [`p.org_id=$1`, `p.branch_id = ANY($2::text[])`];
    const params: unknown[] = [g.orgId, g.branchIds];
    if (q.status) { params.push(String(q.status)); where.push(`p.status=$${params.length}`); }
    if (q.branchId) { params.push(String(q.branchId)); where.push(`p.branch_id=$${params.length}`); }
    if (q.q) { params.push(`%${String(q.q).replace(/[%_]/g, '')}%`); where.push(`(m.full_name ILIKE $${params.length} OR m.member_number ILIKE $${params.length})`); }
    const rows = await ctx.db.query<any>(
      `SELECT p.*, b.name AS branch_name, pr.name AS project_name, m.full_name, m.member_number FROM giving_plans p JOIN branches b ON b.id=p.branch_id JOIN memberships m ON m.id=p.membership_id LEFT JOIN projects pr ON pr.id=p.project_id
        WHERE ${where.join(' AND ')} ORDER BY (p.status='active') DESC, p.next_run_at NULLS LAST, m.full_name LIMIT 500`,
      params,
    );
    const monthStart = `${eatToday(ctx.clock.now()).slice(0, 7)}-01`;
    const view = rows.map((p) => ({
      id: p.id, member: p.full_name, memberNumber: p.member_number, branch: p.branch_name, amount: Number(p.amount), purposeLabel: purposeLabel(p), frequency: FREQ_LABEL[p.frequency], status: p.status,
      nextRunAt: p.next_run_at, completed: p.completed_count, missed: p.missed_count, lastRunAt: p.last_run_at, startedAt: p.created_at,
      perMonth: Math.round(Number(p.amount) * (p.frequency === 'weekly' ? 52 / 12 : p.frequency === 'fortnightly' ? 26 / 12 : 1)),
    }));
    const active = view.filter((p) => p.status === 'active');
    const month = (await ctx.db.query<any>(
      `SELECT COALESCE(SUM(r.amount) FILTER (WHERE r.status='completed'),0) AS collected, count(*) FILTER (WHERE r.status='missed')::int AS missed, count(*) FILTER (WHERE r.status='completed')::int AS done
         FROM giving_plan_runs r JOIN giving_plans p ON p.id=r.plan_id WHERE p.org_id=$1 AND p.branch_id = ANY($2::text[]) AND r.due_date >= $3`,
      [g.orgId, g.branchIds, monthStart],
    ))[0];
    if (q.csv) return csv(view.map((p) => ({ Member: p.member, 'Member number': p.memberNumber, Branch: p.branch, Gift: p.purposeLabel, Amount: p.amount / 100, How: p.frequency, Status: p.status, 'Next prompt': p.nextRunAt ?? '', Completed: p.completed, Missed: p.missed })));
    return { plans: view, summary: { active: active.length, paused: view.filter((p) => p.status === 'paused').length, expectedPerMonth: active.reduce((s, p) => s + p.perMonth, 0), collectedThisMonth: Number(month.collected), completedThisMonth: month.done, missedThisMonth: month.missed } };
  });

  void DAY_NAMES;
}

/** Called by the scheduler and after the development clock moves. */
export async function runGivingJobs(ctx: Ctx): Promise<{ created: number; prompted: number; missed: number }> {
  const h = HOOKS.get(ctx);
  return h ? h.jobs() : { created: 0, prompted: 0, missed: 0 };
}

/** A gift that was prompted for a regular gift has been paid. */
export async function planRunPaid(ctx: Ctx, runId: string, paymentId: string | null): Promise<void> {
  await HOOKS.get(ctx)?.paid(runId, paymentId);
}
