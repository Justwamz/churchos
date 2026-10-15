import type { Ctx } from './ctx';
import { todayEat } from './members';

/**
 * Children's check-in demo data (L179 to L187), added on top of the normal demo for the development server and its own tests:
 * Lucy the Sunday school teacher, a class, Joy (five) and Tom (four), and Mary Kamau who has no app and is reached by SMS.
 * Kept apart from seed() so the other slices' counts stay as they were.
 */
export async function seedKidsDemo(ctx: Ctx) {
  const db = ctx.db;
  const now = ctx.clock.now().toISOString();
  const t = todayEat(ctx.clock.now());
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateOf = (yearsAgo: number, extraDays = 0) => {
    const d = new Date(Date.UTC(t.y - yearsAgo, t.m - 1, t.d + extraDays));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  };
  await db.query(`INSERT INTO users (id, phone, name, is_platform_admin, created_at) VALUES ('u_lucy','254700000008','Lucy Wairimu',false,$1) ON CONFLICT DO NOTHING`, [now]);
  await db.query(`INSERT INTO role_assignments (id, org_id, user_id, role_id, scope_type, scope_id) VALUES ('ra_lucy','org_grace','u_lucy',$1,'branch','br_grc001') ON CONFLICT DO NOTHING`, ["org_grace:Children's Teacher"]);
  const member = (m: { id: string; user: string | null; name: string; phone: string | null; number: string; hh: string; primary?: boolean; category: 'adult' | 'child'; dob: string; sex: 'male' | 'female' }) =>
    db.query(
      `INSERT INTO memberships (id, org_id, branch_id, user_id, full_name, phone, member_number, household_id, is_primary_contact, category, dob, sex, consent_at, consent_by, joined_at)
       VALUES ($1,'org_grace','br_grc001',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'u_admin',$11) ON CONFLICT DO NOTHING`,
      [m.id, m.user, m.name, m.phone, m.number, m.hh, !!m.primary, m.category, m.dob, m.sex, now],
    );
  const guardian = (child: string, g: string) => db.query(`INSERT INTO guardians (child_id, guardian_id, org_id) VALUES ($1,$2,'org_grace') ON CONFLICT DO NOTHING`, [child, g]);
  await member({ id: 'm_joy', user: null, name: 'Joy Wanjiku', phone: null, number: 'M00101', hh: 'hh_wanjiku', category: 'child', dob: dateOf(5, 60), sex: 'female' });
  await guardian('m_joy', 'm_jane');
  await guardian('m_joy', 'm_david');
  await db.query(`INSERT INTO households (id, org_id) VALUES ('hh_kamau','org_grace') ON CONFLICT DO NOTHING`);
  await member({ id: 'm_mary', user: null, name: 'Mary Kamau', phone: '254722000010', number: 'M00102', hh: 'hh_kamau', primary: true, category: 'adult', dob: '1990-04-04', sex: 'female' });
  await member({ id: 'm_tom', user: null, name: 'Tom Kamau', phone: null, number: 'M00103', hh: 'hh_kamau', category: 'child', dob: dateOf(4, 90), sex: 'male' });
  await guardian('m_tom', 'm_mary');
  await db.query(`INSERT INTO kids_classes (id, org_id, branch_id, name, room, teachers, created_at) VALUES ('kcl_sunday','org_grace','br_grc001','Sunday School','Hall B','["u_lucy","u_owner"]',$1) ON CONFLICT DO NOTHING`, [now]);
  await db.query(`INSERT INTO kids_pickup_people (id, org_id, guardian_id, name, phone, relation, id_number, created_by, created_at) VALUES ('kpp_grace','org_grace','m_jane','Grace Wanjiru','254733000011','Aunt','12345678','u_jane',$1) ON CONFLICT DO NOTHING`, [now]);
}
