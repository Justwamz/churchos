import type { FastifyInstance } from 'fastify';
import { branchesFor, normalizePhone } from '../auth';
import { HttpError, inList, requireSession, staffScope, type Ctx } from '../ctx';
import {
  ageOn, cleanCustomNumber, daysToBirthday, decorate, getSettings, householdLabel, nextMemberNumber, parseDob, renderNumber,
  validatePattern, type Viewer,
} from '../members';

const BASE = `SELECT m.*, b.name AS branch_name FROM memberships m JOIN branches b ON b.id = m.branch_id`;

async function viewerFor(ctx: Ctx, uid: string): Promise<Viewer> {
  return { sensitiveBranches: new Set((await branchesFor(ctx.db, uid, 'members.sensitive')).map((r) => r.branchId)) };
}

export function memberRoutes2(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };

  // ---------- member number format (L90) ----------

  app.get('/members/settings', auth, async (req) => {
    const scope = await staffScope(ctx, req, 'members.view');
    const s = await getSettings(ctx.db, scope.orgId);
    const canEdit = (await branchesFor(ctx.db, req.session!.uid, 'members.settings')).some((r) => r.orgId === scope.orgId);
    const sample = (await ctx.db.query<any>(`SELECT code FROM branches WHERE id=$1`, [scope.branchIds[0]]))[0]?.code ?? 'BR001';
    return { ...s, preview: renderNumber(s.pattern, s.next, ctx.clock.now(), sample), canEdit, placeholders: ['{SEQ:4}', '{YYYY}', '{YY}', '{BRANCH}'] };
  });

  app.put('/members/settings', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const scope = await staffScope(ctx, req, 'members.settings');
    const pattern = validatePattern(b.pattern);
    const next = b.next === undefined || b.next === '' ? undefined : Number(b.next);
    if (next !== undefined && (!Number.isInteger(next) || next < 1 || next > 99_999_999)) throw new HttpError(400, 'The next number must be a whole number from 1', 'bad_next');
    const cur = await getSettings(ctx.db, scope.orgId);
    await ctx.db.query(`UPDATE org_settings SET member_number_pattern=$2, member_number_next=$3 WHERE org_id=$1`, [scope.orgId, pattern, next ?? cur.next]);
    await ctx.ledger.audit({ orgId: scope.orgId, actor: req.session!.uid, action: 'members.number_format', meta: { pattern, next } });
    const s = await getSettings(ctx.db, scope.orgId);
    return { ...s, preview: renderNumber(s.pattern, s.next, ctx.clock.now(), 'BR001') };
  });

  // ---------- listing: flat, and grouped by household (L93) ----------

  app.get('/members', auth, async (req) => {
    const q = req.query as any;
    const scope = await staffScope(ctx, req, 'members.view', q.branch);
    const params: unknown[] = [...scope.branchIds];
    let where = `m.branch_id IN (${inList(1, scope.branchIds.length)}) AND m.status='active'`;
    if (q.category === 'adult' || q.category === 'child') { params.push(q.category); where += ` AND m.category=$${params.length}`; }
    if (q.q) {
      params.push(`%${String(q.q).toLowerCase()}%`);
      where += ` AND (lower(m.full_name) LIKE $${params.length} OR lower(m.member_number) LIKE $${params.length} OR m.phone LIKE $${params.length})`;
    }
    const rows = await ctx.db.query<any>(`${BASE} WHERE ${where} ORDER BY m.full_name LIMIT 500`, params);
    return decorate(ctx, rows, await viewerFor(ctx, req.session!.uid));
  });

  app.get('/members/grouped', auth, async (req) => {
    const q = req.query as any;
    const scope = await staffScope(ctx, req, 'members.view', q.branch);
    const rows = await ctx.db.query<any>(`${BASE} WHERE m.branch_id IN (${inList(1, scope.branchIds.length)}) AND m.status='active' ORDER BY m.full_name LIMIT 3000`, scope.branchIds);
    const all = await decorate(ctx, rows, await viewerFor(ctx, req.session!.uid));
    const needle = String(q.q ?? '').trim().toLowerCase();
    const hit = (m: any) =>
      !needle || m.full_name.toLowerCase().includes(needle) || String(m.member_number).toLowerCase().includes(needle) || m.contact_phones.some((p: string) => p.includes(needle.replace(/^0/, '254')) || p.includes(needle));

    const byHousehold = new Map<string, any[]>();
    const individuals: any[] = [];
    for (const m of all) {
      if (m.household_id) (byHousehold.get(m.household_id) ?? byHousehold.set(m.household_id, []).get(m.household_id)!).push(m);
      else individuals.push(m);
    }
    const households = [...byHousehold.entries()]
      .map(([id, members]) => ({
        id,
        label: householdLabel(members),
        primary_contact_id: members.find((m) => m.is_primary_contact)?.id ?? null,
        // Searching for one person shows their whole household, so the family stays together.
        match: members.some(hit) || householdLabel(members).toLowerCase().includes(needle),
        members: members.sort((a, b) => (a.category === b.category ? a.full_name.localeCompare(b.full_name) : a.category === 'adult' ? -1 : 1)),
      }))
      .filter((h) => h.match)
      .map(({ match: _m, ...h }) => h)
      .sort((a, b) => a.label.localeCompare(b.label));
    const solo = individuals.filter(hit);
    return { households, individuals: solo, totals: { households: households.length, members: households.reduce((n, h) => n + h.members.length, 0) + solo.length } };
  });

  /** Birthdays, children about to become adults, and adults still missing their own phone. */
  app.get('/members/insights', auth, async (req) => {
    const scope = await staffScope(ctx, req, 'members.view', (req.query as any).branch);
    const rows = await ctx.db.query<any>(`${BASE} WHERE m.branch_id IN (${inList(1, scope.branchIds.length)}) AND m.status='active'`, scope.branchIds);
    const all = await decorate(ctx, rows, await viewerFor(ctx, req.session!.uid));
    const now = ctx.clock.now();
    const withDob = rows.filter((r) => r.dob);
    const dobOf = new Map(rows.map((r) => [r.id, r.dob as string | null]));
    const birthdays = all
      .filter((m) => dobOf.get(m.id))
      .map((m) => ({ id: m.id, full_name: m.full_name, branch_name: m.branch_name, birthday: m.birthday, days_away: daysToBirthday(dobOf.get(m.id)!, now), category: m.category, age: m.age }))
      .filter((b) => b.days_away <= 7)
      .sort((a, b) => a.days_away - b.days_away);
    const turningEighteen = withDob
      .filter((r) => r.category === 'child')
      .map((r) => {
        const [y, mo, d] = (r.dob as string).split('-').map(Number);
        const t18 = Date.UTC(y + 18, mo - 1, d);
        const t = new Date(now.getTime() + 3 * 3600_000);
        const days = Math.round((t18 - Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())) / 86400_000);
        return { id: r.id, full_name: r.full_name, branch_name: r.branch_name, days_until_18: days };
      })
      .filter((c) => c.days_until_18 <= 90)
      .sort((a, b) => a.days_until_18 - b.days_until_18);
    const needsOwnPhone = all.filter((m) => m.needs_own_phone).map((m) => ({ id: m.id, full_name: m.full_name, branch_name: m.branch_name, guardians: m.guardians }));
    return { birthdays, turningEighteen, needsOwnPhone };
  });

  // ---------- add and edit (L91, L94 to L96) ----------

  /** Validates guardians: existing, active, adult, same church organisation. */
  async function loadGuardians(orgId: string, ids: unknown, q: import('@churchos/ledger').Db = ctx.db): Promise<any[]> {
    const list = Array.isArray(ids) ? [...new Set(ids.map(String))] : [];
    if (list.length === 0) throw new HttpError(400, 'Choose at least one guardian for a child', 'guardian_required');
    const rows = await q.query<any>(`SELECT * FROM memberships WHERE id = ANY($1::text[]) AND org_id=$2 AND status='active' AND category='adult'`, [list, orgId]);
    if (rows.length !== list.length) throw new HttpError(400, 'Guardians must be existing adult members of this church', 'bad_guardian');
    return rows;
  }

  async function userForPhone(phone: string, name: string, q: import('@churchos/ledger').Db = ctx.db): Promise<string> {
    const u = (await q.query<any>(`SELECT id FROM users WHERE phone=$1`, [phone]))[0];
    if (u) return u.id;
    const id = ctx.newId('usr');
    await q.query(`INSERT INTO users (id, phone, name, created_at) VALUES ($1,$2,$3,$4)`, [id, phone, name, ctx.clock.now().toISOString()]);
    return id;
  }

  async function adultPhoneFree(orgId: string, phone: string, exceptId?: string) {
    const dupe = (await ctx.db.query<any>(`SELECT id, full_name, member_number FROM memberships WHERE org_id=$1 AND phone=$2 AND status='active' AND id <> $3`, [orgId, phone, exceptId ?? '']))[0];
    if (dupe) throw new HttpError(409, `That phone number already belongs to ${dupe.full_name} (${dupe.member_number}). Each adult needs their own number.`, 'phone_in_use');
  }

  app.post('/members', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    if (!b.branchId) throw new HttpError(400, 'Choose a branch', 'bad_branch');
    const scope = await staffScope(ctx, req, 'members.edit', b.branchId);
    const now = ctx.clock.now();
    const name = String(b.fullName ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < 2) throw new HttpError(400, 'Enter the member’s full name', 'bad_name');
    if (b.category !== 'adult' && b.category !== 'child') throw new HttpError(400, 'Choose adult or child', 'bad_category');
    if (b.consent !== true) throw new HttpError(400, b.category === 'child' ? 'Confirm that a guardian agreed to the church keeping these details' : 'Confirm that the member agreed to the church keeping these details', 'consent_required');
    if (b.sex && b.sex !== 'male' && b.sex !== 'female') throw new HttpError(400, 'Choose male or female, or leave it blank', 'bad_sex');

    let phone: string | null = null;
    let dob: string | null = b.dob ? parseDob(b.dob, now) : null;
    let guardians: any[] = [];
    if (b.category === 'adult') {
      phone = normalizePhone(String(b.phone ?? ''));
      if (!phone) throw new HttpError(400, 'An adult needs their own Kenyan phone number, for example 0712 345 678', 'phone_required');
      await adultPhoneFree(scope.orgId, phone);
      if (dob && ageOn(dob, now) < 18) throw new HttpError(400, 'This person is under 18. Register them as a child with a guardian.', 'age_mismatch');
    } else {
      if (!dob) throw new HttpError(400, 'A child needs a date of birth so they can become an adult at 18', 'dob_required');
      if (ageOn(dob, now) >= 18) throw new HttpError(400, 'This person is 18 or older. Register them as an adult.', 'age_mismatch');
      guardians = await loadGuardians(scope.orgId, b.guardianIds);
      if (!guardians.some((g) => g.phone)) throw new HttpError(400, 'A guardian needs a phone number so the child has a contact', 'guardian_phone');
    }

    const branch = (await ctx.db.query<any>(`SELECT code FROM branches WHERE id=$1`, [b.branchId]))[0];
    const id = ctx.newId('mem');
    const result = await ctx.db.tx(async (q) => {
      let number: string;
      if (b.memberNumber !== undefined && String(b.memberNumber).trim() !== '') {
        number = cleanCustomNumber(b.memberNumber);
        const taken = (await q.query<any>(`SELECT 1 FROM memberships WHERE org_id=$1 AND member_number=$2`, [scope.orgId, number]))[0];
        if (taken) throw new HttpError(409, 'That member number is already used by someone in your church', 'number_taken');
      } else {
        number = await nextMemberNumber(ctx, scope.orgId, q, branch.code);
      }

      // Household: one at a time (L92). A child defaults to their first guardian's household.
      let householdId: string | null = null;
      if (b.householdId === 'new') {
        householdId = ctx.newId('hh');
        await q.query(`INSERT INTO households (id, org_id) VALUES ($1,$2)`, [householdId, scope.orgId]);
      } else if (b.householdId) {
        const h = (await q.query<any>(`SELECT id FROM households WHERE id=$1 AND org_id=$2`, [b.householdId, scope.orgId]))[0];
        if (!h) throw new HttpError(404, 'That household was not found', 'household_not_found');
        householdId = h.id;
      } else if (b.category === 'child') {
        householdId = guardians.find((g) => g.household_id)?.household_id ?? null;
      }

      const userId = phone ? await userForPhone(phone, name, q) : null;
      const hasPrimary = householdId ? !!(await q.query<any>(`SELECT 1 FROM memberships WHERE household_id=$1 AND is_primary_contact AND status='active'`, [householdId]))[0] : true;
      await q.query(
        `INSERT INTO memberships (id, org_id, branch_id, user_id, full_name, phone, member_number, household_id, is_primary_contact, category, dob, sex, consent_at, consent_by, joined_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$13)`,
        [id, scope.orgId, b.branchId, userId, name, phone, number, householdId, !!householdId && !hasPrimary && b.category === 'adult', b.category, dob, b.sex ?? null, now.toISOString(), req.session!.uid],
      );
      for (const g of guardians) await q.query(`INSERT INTO guardians (child_id, guardian_id, org_id) VALUES ($1,$2,$3)`, [id, g.id, scope.orgId]);
      return { memberNumber: number, householdId };
    });
    await ctx.ledger.audit({ orgId: scope.orgId, actor: req.session!.uid, action: 'member.create', entity: 'membership', entityId: id, meta: { category: b.category } });
    return { id, ...result };
  });

  app.put('/members/:id', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const m = (await ctx.db.query<any>(`SELECT * FROM memberships WHERE id=$1 AND status='active'`, [(req.params as any).id]))[0];
    if (!m) throw new HttpError(404, 'member not found', 'not_found');
    await staffScope(ctx, req, 'members.edit', m.branch_id);
    const now = ctx.clock.now();
    const name = b.fullName !== undefined ? String(b.fullName).trim().replace(/\s+/g, ' ') : m.full_name;
    if (name.length < 2) throw new HttpError(400, 'Enter the member’s full name', 'bad_name');
    if (b.sex && b.sex !== 'male' && b.sex !== 'female') throw new HttpError(400, 'Choose male or female, or leave it blank', 'bad_sex');
    const dob = b.dob !== undefined ? (b.dob ? parseDob(b.dob, now) : null) : m.dob;
    let phone = m.phone;
    if (m.category === 'adult') {
      if (b.phone !== undefined) {
        phone = normalizePhone(String(b.phone ?? ''));
        if (!phone) throw new HttpError(400, 'An adult needs their own Kenyan phone number', 'phone_required');
        await adultPhoneFree(m.org_id, phone, m.id);
      }
      if (dob && ageOn(dob, now) < 18) throw new HttpError(400, 'This person is under 18', 'age_mismatch');
    } else {
      if (!dob) throw new HttpError(400, 'A child needs a date of birth', 'dob_required');
      if (ageOn(dob, now) >= 18) throw new HttpError(400, 'This person is 18 or older. They become an adult automatically on their birthday.', 'age_mismatch');
    }
    await ctx.db.tx(async (q) => {
      let userId = m.user_id;
      if (phone && phone !== m.phone) userId = await userForPhone(phone, name, q);
      await q.query(`UPDATE memberships SET full_name=$2, dob=$3, sex=$4, phone=$5, user_id=$6 WHERE id=$1`, [m.id, name, dob, b.sex !== undefined ? b.sex || null : m.sex, phone, userId]);
      if (m.category === 'child' && b.guardianIds !== undefined) {
        const gs = await loadGuardians(m.org_id, b.guardianIds, q);
        await q.query(`DELETE FROM guardians WHERE child_id=$1`, [m.id]);
        for (const g of gs) await q.query(`INSERT INTO guardians (child_id, guardian_id, org_id) VALUES ($1,$2,$3)`, [m.id, g.id, m.org_id]);
      }
    });
    await ctx.ledger.audit({ orgId: m.org_id, actor: req.session!.uid, action: 'member.update', entity: 'membership', entityId: m.id });
    return { id: m.id, ok: true };
  });

  // ---------- households (L92) ----------

  async function afterLeave(orgId: string, householdId: string) {
    const left = await ctx.db.query<any>(`SELECT id, category, is_primary_contact FROM memberships WHERE household_id=$1 AND status='active' ORDER BY joined_at`, [householdId]);
    if (left.length === 0) {
      await ctx.db.query(`DELETE FROM households WHERE id=$1 AND org_id=$2`, [householdId, orgId]);
      return;
    }
    if (!left.some((x) => x.is_primary_contact)) {
      const next = left.find((x) => x.category === 'adult');
      if (next) await ctx.db.query(`UPDATE memberships SET is_primary_contact=true WHERE id=$1`, [next.id]);
    }
  }

  /** Moves someone into a household, a new one, or out of any household. A person is in one household at a time. */
  app.put('/members/:id/household', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const m = (await ctx.db.query<any>(`SELECT * FROM memberships WHERE id=$1 AND status='active'`, [(req.params as any).id]))[0];
    if (!m) throw new HttpError(404, 'member not found', 'not_found');
    await staffScope(ctx, req, 'members.edit', m.branch_id);
    const target: string | null = b.householdId === null || b.householdId === undefined ? null : String(b.householdId);
    if (target && target === m.household_id) return { ok: true, unchanged: true };

    if (target && target !== 'new') {
      const h = (await ctx.db.query<any>(`SELECT id FROM households WHERE id=$1 AND org_id=$2`, [target, m.org_id]))[0];
      if (!h) throw new HttpError(404, 'That household was not found', 'household_not_found');
    }
    if (m.household_id && target && b.move !== true) {
      const members = await ctx.db.query<any>(`SELECT full_name, is_primary_contact, category FROM memberships WHERE household_id=$1 AND status='active'`, [m.household_id]);
      throw new HttpError(409, `${m.full_name} already belongs to the ${householdLabel(members)}. A person can be in only one household. Move them instead?`, 'already_in_household');
    }
    const oldId: string | null = m.household_id;
    let newId: string | null = null;
    if (target === 'new') {
      newId = ctx.newId('hh');
      await ctx.db.query(`INSERT INTO households (id, org_id) VALUES ($1,$2)`, [newId, m.org_id]);
    } else newId = target;

    const hasPrimary = newId ? !!(await ctx.db.query<any>(`SELECT 1 FROM memberships WHERE household_id=$1 AND is_primary_contact AND status='active'`, [newId]))[0] : true;
    await ctx.db.query(`UPDATE memberships SET household_id=$2, is_primary_contact=$3 WHERE id=$1`, [m.id, newId, !!newId && !hasPrimary && m.category === 'adult']);
    await ctx.db.query(`INSERT INTO membership_history (org_id, membership_id, event, from_branch, to_branch, at) VALUES ($1,$2,'household_move',$3,$4,$5)`, [m.org_id, m.id, oldId, newId, ctx.clock.now().toISOString()]);
    if (oldId) await afterLeave(m.org_id, oldId);
    await ctx.ledger.audit({ orgId: m.org_id, actor: req.session!.uid, action: 'member.household_move', entity: 'membership', entityId: m.id });
    return { ok: true, householdId: newId };
  });

  app.put('/households/:id/primary-contact', auth, async (req) => {
    const memberId = (req.body as any)?.membershipId;
    const m = (await ctx.db.query<any>(`SELECT * FROM memberships WHERE id=$1 AND household_id=$2 AND status='active'`, [memberId, (req.params as any).id]))[0];
    if (!m) throw new HttpError(404, 'That person is not in this household', 'not_found');
    await staffScope(ctx, req, 'members.edit', m.branch_id);
    if (m.category !== 'adult') throw new HttpError(400, 'The primary contact must be an adult', 'not_adult');
    await ctx.db.query(`UPDATE memberships SET is_primary_contact = (id = $1) WHERE household_id=$2 AND status='active'`, [m.id, m.household_id]);
    return { ok: true };
  });
}
