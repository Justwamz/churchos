import type { Db } from '@churchos/ledger';
import { maskPhone } from '@churchos/shared';
import { HttpError, type Ctx } from './ctx';
import { notify } from './sms';

// ---------- member number formats (L90) ----------

export const DEFAULT_PATTERN = 'M{SEQ:5}';
const PATTERN_CHARS = /^[A-Za-z0-9 \-/_.{}:]{1,40}$/;

/** A pattern needs exactly one {SEQ} or {SEQ:n} counter. {YYYY}, {YY} and {BRANCH} are optional. */
export function validatePattern(p: unknown): string {
  const pattern = String(p ?? '').trim();
  if (!PATTERN_CHARS.test(pattern)) throw new HttpError(400, 'Use letters, numbers and - / _ . only, up to 40 characters', 'bad_pattern');
  const seq = pattern.match(/\{SEQ(:\d{1,2})?\}/g) ?? [];
  if (seq.length !== 1) throw new HttpError(400, 'The format needs one counter, written {SEQ:4} for four digits', 'bad_pattern');
  const stripped = pattern.replace(/\{SEQ(:\d{1,2})?\}|\{YYYY\}|\{YY\}|\{BRANCH\}/g, '');
  if (/[{}]/.test(stripped)) throw new HttpError(400, 'Unknown placeholder. Use {SEQ:n}, {YYYY}, {YY} or {BRANCH}', 'bad_pattern');
  return pattern;
}

export function renderNumber(pattern: string, seq: number, now: Date, branchCode: string): string {
  const year = String(now.getUTCFullYear());
  return pattern
    .replace(/\{SEQ(?::(\d{1,2}))?\}/, (_m, n) => String(seq).padStart(n ? Number(n) : 1, '0'))
    .replace('{YYYY}', year)
    .replace('{YY}', year.slice(2))
    .replace('{BRANCH}', branchCode);
}

export async function getSettings(q: Db, orgId: string) {
  await q.query(`INSERT INTO org_settings (org_id) VALUES ($1) ON CONFLICT DO NOTHING`, [orgId]);
  const r = (await q.query<any>(`SELECT member_number_pattern AS pattern, member_number_next AS next FROM org_settings WHERE org_id=$1`, [orgId]))[0];
  return { pattern: r.pattern as string, next: Number(r.next) };
}

/** Issues the next unused number under the church's format. Numbers are never reused, even after a member leaves. */
export async function nextMemberNumber(ctx: Ctx, orgId: string, q: Db = ctx.db, branchCode = 'X'): Promise<string> {
  const s = await getSettings(q, orgId);
  let n = s.next;
  for (let i = 0; i < 100000; i++) {
    const candidate = renderNumber(s.pattern, n, ctx.clock.now(), branchCode);
    n++;
    const taken = (await q.query<any>(`SELECT 1 FROM memberships WHERE org_id=$1 AND member_number=$2`, [orgId, candidate]))[0];
    if (!taken) {
      await q.query(`UPDATE org_settings SET member_number_next=$2 WHERE org_id=$1`, [orgId, n]);
      return candidate;
    }
  }
  throw new HttpError(500, 'Could not find a free member number', 'number_exhausted');
}

/** A number the church typed in, for example one from its existing records. */
export function cleanCustomNumber(raw: unknown): string {
  const v = String(raw ?? '').trim();
  if (!/^[A-Za-z0-9 \-/_.]{1,40}$/.test(v)) throw new HttpError(400, 'A member number can use letters, numbers and - / _ . only, up to 40 characters', 'bad_number');
  return v;
}

// ---------- ages and birthdays (L96, L97) ----------

/** Today's date in East Africa Time, as year, month, day, from the (possibly advanced) platform clock. */
export function todayEat(now: Date) {
  const d = new Date(now.getTime() + 3 * 3600_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

export function parseDob(raw: unknown, now: Date): string {
  const s = String(raw ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new HttpError(400, 'Enter the date of birth as day, month and year', 'bad_dob');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) throw new HttpError(400, 'That date of birth does not exist', 'bad_dob');
  const t = todayEat(now);
  if (Date.UTC(y, mo - 1, d) > Date.UTC(t.y, t.m - 1, t.d)) throw new HttpError(400, 'The date of birth cannot be in the future', 'bad_dob');
  if (t.y - y > 120) throw new HttpError(400, 'Check the year of birth', 'bad_dob');
  return s;
}

export function ageOn(dob: string, now: Date): number {
  const [y, m, d] = dob.split('-').map(Number);
  const t = todayEat(now);
  let age = t.y - y;
  if (t.m < m || (t.m === m && t.d < d)) age--;
  return age;
}

export function ageBand(age: number): string {
  if (age < 6) return '0 to 5';
  if (age < 13) return '6 to 12';
  if (age < 18) return '13 to 17';
  if (age < 36) return '18 to 35';
  if (age < 60) return '36 to 59';
  return '60 and over';
}

/** Days until the next birthday (0 means today). */
export function daysToBirthday(dob: string, now: Date): number {
  const [, m, d] = dob.split('-').map(Number);
  const t = todayEat(now);
  const today = Date.UTC(t.y, t.m - 1, t.d);
  let next = Date.UTC(t.y, m - 1, d);
  if (next < today) next = Date.UTC(t.y + 1, m - 1, d);
  return Math.round((next - today) / 86400_000);
}

// ---------- reading members the way staff may see them ----------

export interface Viewer {
  /** Branch ids where the viewer may see exact dates of birth (members.sensitive). */
  sensitiveBranches: Set<string>;
}

/** Adds guardians, contact phones, age band and, only where permitted, the date of birth. */
export async function decorate(ctx: Ctx, rows: any[], viewer: Viewer, opts: { raw?: boolean } = {}): Promise<any[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const links = await ctx.db.query<any>(
    `SELECT g.child_id, g.guardian_id, m.full_name, m.phone, m.member_number FROM guardians g JOIN memberships m ON m.id=g.guardian_id WHERE g.child_id = ANY($1::text[])`,
    [ids],
  );
  const now = ctx.clock.now();
  return rows.map((r) => {
    const gs = links.filter((l) => l.child_id === r.id);
    const age = r.dob ? ageOn(r.dob, now) : null;
    const canSee = viewer.sensitiveBranches.has(r.branch_id);
    const contactPhones = r.category === 'child' ? [...new Set(gs.map((g) => g.phone).filter(Boolean))] : r.phone ? [r.phone] : [];
    return {
      id: r.id,
      full_name: r.full_name,
      member_number: r.member_number,
      category: r.category,
      sex: r.sex,
      branch_id: r.branch_id,
      branch_name: r.branch_name,
      household_id: r.household_id,
      is_primary_contact: r.is_primary_contact,
      // Phone numbers are masked for staff. Revealing one is a separate, logged action (L109).
      phone: maskPhone(r.phone),
      contact_phones: contactPhones.map((p: string) => maskPhone(p)),
      phone_masked: true,
      ...(opts.raw ? { _phones: contactPhones } : {}),
      guardians: gs.map((g) => ({ id: g.guardian_id, full_name: g.full_name, member_number: g.member_number })),
      age_band: age === null ? null : ageBand(age),
      birthday: r.dob ? r.dob.slice(5) : null,
      ...(canSee ? { dob: r.dob, age } : {}),
      needs_own_phone: r.category === 'adult' && !r.phone,
      joined_at: r.joined_at,
    };
  });
}

/** Household label, derived from members (L95). Shows the primary contact's name, then the others. */
export function householdLabel(members: { full_name: string; is_primary_contact: boolean; category: string }[]): string {
  const adults = members.filter((m) => m.category === 'adult');
  const primary = adults.find((m) => m.is_primary_contact) ?? adults[0] ?? members[0];
  if (!primary) return 'Household';
  const surname = primary.full_name.trim().split(/\s+/).slice(-1)[0];
  return `${surname} household`;
}

// ---------- daily housekeeping: graduation and birthdays (L97) ----------

export async function runMemberHousekeeping(ctx: Ctx): Promise<{ graduated: number; birthdays: number }> {
  const now = ctx.clock.now();
  const t = todayEat(now);
  let graduated = 0;
  let birthdays = 0;

  const children = await ctx.db.query<any>(`SELECT id, org_id, full_name, dob, branch_id FROM memberships WHERE status='active' AND category='child' AND dob IS NOT NULL`);
  for (const c of children) {
    if (ageOn(c.dob, now) < 18) continue;
    await ctx.db.query(`UPDATE memberships SET category='adult' WHERE id=$1`, [c.id]);
    await ctx.db.query(`INSERT INTO membership_history (org_id, membership_id, event, at) VALUES ($1,$2,'became_adult',$3)`, [c.org_id, c.id, now.toISOString()]);
    graduated++;
    const guardians = await ctx.db.query<any>(`SELECT m.phone FROM guardians g JOIN memberships m ON m.id=g.guardian_id WHERE g.child_id=$1 AND m.phone IS NOT NULL`, [c.id]);
    for (const g of guardians) {
      await notify(ctx, {
        orgId: c.org_id, phone: g.phone, kind: 'announcement', sms: false, idemKey: `grad:${c.id}:${g.phone}`,
        title: `${c.full_name} is now an adult member`,
        body: `${c.full_name} turned 18. Please ask them to add their own phone number so they can sign in to ChurchOS and give in their own name.`,
      });
    }
  }

  const members = await ctx.db.query<any>(`SELECT m.id, m.org_id, m.full_name, m.dob, m.phone, b.name AS church FROM memberships m JOIN branches b ON b.id=m.branch_id WHERE m.status='active' AND m.dob IS NOT NULL AND m.phone IS NOT NULL`);
  for (const m of members) {
    if (daysToBirthday(m.dob, now) !== 0) continue;
    const done = await ctx.db.query(`INSERT INTO birthday_wishes (membership_id, year) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING membership_id`, [m.id, t.y]);
    if (done.length === 0) continue;
    await notify(ctx, {
      orgId: m.org_id, phone: m.phone, kind: 'announcement', sms: false, idemKey: `bday:${m.id}:${t.y}`,
      title: 'Happy birthday!',
      body: `Happy birthday, ${m.full_name.split(' ')[0]}! Everyone at ${m.church} is thankful for you and wishes you a blessed year.`,
    });
    birthdays++;
  }
  return { graduated, birthdays };
}
