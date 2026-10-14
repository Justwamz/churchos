import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { ageBand, ageOn, daysToBirthday, parseDob, renderNumber, runMemberHousekeeping, validatePattern } from './members';

let app: Awaited<ReturnType<typeof buildApp>>['app'];
let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
const tokens: Record<string, string> = {};
async function login(phone: string) {
  if (tokens[phone]) return tokens[phone];
  const r = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: '123456' } });
  tokens[phone] = r.json().token;
  return tokens[phone];
}
const call = async (phone: string | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: any) =>
  app.inject({ method, url, payload, headers: phone ? { authorization: `Bearer ${await login(phone)}` } : {} });

const OWNER = '0700000001', ADMIN = '0700000003', TREAS = '0700000002', PA1 = '0700000099', JANE = '0711000001', PETER = '0711000002';
const B1 = 'br_grc001';
const add = (who: string, body: any) => call(who, 'POST', '/members', { branchId: B1, consent: true, ...body });
const find = async (name: string) => (await call(ADMIN, 'GET', `/members?q=${encodeURIComponent(name)}`)).json().find((m: any) => m.full_name === name);

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);

describe('pure helpers', () => {
  const at = (iso: string) => new Date(iso);
  it('computes age on the birthday boundary in East Africa Time', () => {
    expect(ageOn('2010-03-15', at('2028-03-14T12:00:00Z'))).toBe(17);
    expect(ageOn('2010-03-15', at('2028-03-15T12:00:00Z'))).toBe(18);
    // 22:00 UTC on the 14th is already the 15th in Nairobi.
    expect(ageOn('2010-03-15', at('2028-03-14T22:00:00Z'))).toBe(18);
  });
  it('handles 29 February birthdays', () => {
    expect(ageOn('2008-02-29', at('2026-02-28T12:00:00Z'))).toBe(17);
    expect(ageOn('2008-02-29', at('2026-03-01T12:00:00Z'))).toBe(18);
    expect(daysToBirthday('2008-02-29', at('2026-02-28T12:00:00Z'))).toBeGreaterThanOrEqual(0);
  });
  it('bands ages', () => {
    expect([0, 5, 6, 12, 13, 17, 18, 35, 36, 59, 60].map(ageBand)).toEqual(['0 to 5', '0 to 5', '6 to 12', '6 to 12', '13 to 17', '13 to 17', '18 to 35', '18 to 35', '36 to 59', '36 to 59', '60 and over']);
  });
  it('rejects impossible, future and absurd dates of birth', () => {
    const now = at('2026-10-14T09:00:00Z');
    for (const bad of ['', '14/10/2000', '2026-02-30', '2999-01-01', '1800-01-01', 'abc']) expect(() => parseDob(bad, now)).toThrow();
    expect(parseDob('2000-02-29', now)).toBe('2000-02-29');
  });
  it('renders and validates member number patterns', () => {
    const now = at('2026-10-14T09:00:00Z');
    expect(renderNumber('GRC/{YYYY}/{SEQ:4}', 7, now, 'GRC001')).toBe('GRC/2026/0007');
    expect(renderNumber('{BRANCH}-{YY}-{SEQ:3}', 12, now, 'GRC001')).toBe('GRC001-26-012');
    expect(() => validatePattern('NOSEQ')).toThrow();
    expect(() => validatePattern('{SEQ}{SEQ}')).toThrow();
    expect(() => validatePattern('A{FOO}{SEQ}')).toThrow();
    expect(() => validatePattern('<b>{SEQ}')).toThrow();
    expect(validatePattern('GRC {SEQ:5}')).toBe('GRC {SEQ:5}');
  });
});

describe('adding members (L91, L94 to L96)', () => {
  it('an adult must have their own phone, a name, consent and a valid date of birth', async () => {
    expect((await add(ADMIN, { fullName: 'No Phone', category: 'adult' })).json().code).toBe('phone_required');
    expect((await add(ADMIN, { fullName: 'Bad Phone', category: 'adult', phone: '123' })).json().code).toBe('phone_required');
    expect((await add(ADMIN, { fullName: 'X', category: 'adult', phone: '0712000001' })).json().code).toBe('bad_name');
    expect((await add(ADMIN, { fullName: 'No Consent', category: 'adult', phone: '0712000001', consent: false })).json().code).toBe('consent_required');
    expect((await add(ADMIN, { fullName: 'Bad Dob', category: 'adult', phone: '0712000001', dob: '2030-01-01' })).json().code).toBe('bad_dob');
    expect((await add(ADMIN, { fullName: 'Too Young', category: 'adult', phone: '0712000001', dob: '2020-01-01' })).json().code).toBe('age_mismatch');
    expect((await add(ADMIN, { fullName: 'Weird', category: 'person', phone: '0712000001' })).json().code).toBe('bad_category');
  });

  it('adds an adult, issues a number in the church format, and refuses a second adult on the same phone', async () => {
    const r = await add(ADMIN, { fullName: 'Mary Achieng', category: 'adult', phone: '0712 000 111', dob: '1990-05-05', sex: 'female', householdId: 'new' });
    expect(r.statusCode).toBe(200);
    expect(r.json().memberNumber).toBe('M00007'); // seeded numbers are skipped, the counter continues
    const dupe = await add(ADMIN, { fullName: 'Another Person', category: 'adult', phone: '0712000111' });
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().code).toBe('phone_in_use');
    expect(dupe.json().error).toMatch(/Mary Achieng/);
  });

  it('a child needs a date of birth under 18 and at least one adult guardian who has a phone', async () => {
    const mary = await find('Mary Achieng');
    const child = (extra: any) => add(ADMIN, { fullName: 'Little One', category: 'child', ...extra });
    expect((await child({ guardianIds: [mary.id] })).json().code).toBe('dob_required');
    expect((await child({ dob: '2000-01-01', guardianIds: [mary.id] })).json().code).toBe('age_mismatch');
    expect((await child({ dob: '2018-01-01' })).json().code).toBe('guardian_required');
    expect((await child({ dob: '2018-01-01', guardianIds: ['m_nobody'] })).json().code).toBe('bad_guardian');
    const ruth = await find('Ruth Wanjiku');
    expect((await child({ dob: '2018-01-01', guardianIds: [ruth.id] })).json().code).toBe('bad_guardian'); // a child cannot be a guardian
    expect((await add(ADMIN, { fullName: 'Little One', category: 'child', dob: '2018-01-01', guardianIds: [mary.id], phone: '0799999999' })).statusCode).toBe(200);
    const kid = await find('Little One');
    expect(kid.phone).toBeNull(); // children never get an own phone
    expect(kid.contact_phones).toEqual(['254712000111']);
    expect(kid.household_id).toBe(mary.household_id); // defaults to the guardian's household
  });

  it('shows every guardian phone for a child with two parents', async () => {
    const ruth = await find('Ruth Wanjiku');
    expect(ruth.guardians.map((g: any) => g.full_name).sort()).toEqual(['David Wanjiku', 'Jane Wanjiku']);
    expect(ruth.contact_phones.sort()).toEqual(['254711000001', '254711000004']);
    expect(ruth.category).toBe('child');
  });

  it('a payment from a guardian is never matched to a child', async () => {
    await call(PA1, 'POST', '/admin/simulate/paybill', { phone: '0711000001', amount: 100, reference: 'GRC001#TITHE' });
    const p = (await ctx.db.query<any>(`SELECT member_id FROM payments WHERE payer_phone='254711000001' ORDER BY received_at DESC LIMIT 1`))[0];
    expect(p.member_id).toBe('m_jane');
  });
});

describe('households: one at a time, grouped and searchable (L92, L93)', () => {
  it('groups members under a household with a derived label, and lists individuals separately', async () => {
    const g = (await call(ADMIN, 'GET', '/members/grouped')).json();
    const wanjiku = g.households.find((h: any) => h.label === 'Wanjiku household');
    expect(wanjiku.members.map((m: any) => m.full_name)).toEqual(['David Wanjiku', 'Jane Wanjiku', 'Ruth Wanjiku']); // adults first
    expect(wanjiku.primary_contact_id).toBe('m_jane');
    expect(g.individuals.some((m: any) => m.full_name === 'Peter Otieno')).toBe(true);
    expect(g.households.every((h: any) => !('name' in h))).toBe(true);
  });

  it('searching for one person shows their whole household; searching a phone or number also works', async () => {
    const byName = (await call(ADMIN, 'GET', '/members/grouped?q=ruth')).json();
    expect(byName.households).toHaveLength(1);
    expect(byName.households[0].members).toHaveLength(3);
    expect((await call(ADMIN, 'GET', '/members/grouped?q=0711000004')).json().households).toHaveLength(1);
    expect((await call(ADMIN, 'GET', '/members/grouped?q=M00004')).json().individuals).toHaveLength(1);
    expect((await call(ADMIN, 'GET', '/members/grouped?q=zzzz')).json().totals.members).toBe(0);
  });

  it('refuses to put someone in a second household, and moves them only when asked', async () => {
    const peter = await find('Peter Otieno');
    const jane = await find('Jane Wanjiku');
    expect((await call(ADMIN, 'PUT', `/members/${peter.id}/household`, { householdId: jane.household_id })).statusCode).toBe(200);
    const mary = await find('Mary Achieng');
    const refused = await call(ADMIN, 'PUT', `/members/${peter.id}/household`, { householdId: mary.household_id });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('already_in_household');
    expect(refused.json().error).toMatch(/Wanjiku household/);
    const moved = await call(ADMIN, 'PUT', `/members/${peter.id}/household`, { householdId: mary.household_id, move: true });
    expect(moved.statusCode).toBe(200);
    expect((await find('Peter Otieno')).household_id).toBe(mary.household_id);
    expect(((await call(ADMIN, 'GET', '/members/grouped')).json().households as any[]).filter((h) => h.members.some((m: any) => m.full_name === 'Peter Otieno'))).toHaveLength(1);
  });

  it('a child who starts their own family moves out, and their guardian links are kept', async () => {
    const ruth = await find('Ruth Wanjiku');
    const r = await call(ADMIN, 'PUT', `/members/${ruth.id}/household`, { householdId: 'new', move: true });
    expect(r.statusCode).toBe(200);
    const after = await find('Ruth Wanjiku');
    expect(after.household_id).not.toBe(ruth.household_id);
    expect(after.guardians).toHaveLength(2);
    expect(after.contact_phones).toHaveLength(2);
  });

  it('when the primary contact leaves, another adult takes over, and an empty household disappears', async () => {
    const jane = await find('Jane Wanjiku');
    const david = await find('David Wanjiku');
    await call(ADMIN, 'PUT', `/members/${jane.id}/household`, { householdId: 'new', move: true });
    const g = (await call(ADMIN, 'GET', '/members/grouped')).json();
    const davidHh = g.households.find((h: any) => h.members.some((m: any) => m.id === david.id));
    expect(davidHh.primary_contact_id).toBe(david.id);
    await call(ADMIN, 'PUT', `/members/${david.id}/household`, { householdId: null });
    const g2 = (await call(ADMIN, 'GET', '/members/grouped')).json();
    expect(g2.households.some((h: any) => h.id === david.household_id)).toBe(false);
    expect(g2.individuals.some((m: any) => m.id === david.id)).toBe(true);
  });

  it('only an adult can be the primary contact', async () => {
    const mary = await find('Mary Achieng');
    const kid = await find('Little One');
    expect((await call(ADMIN, 'PUT', `/households/${mary.household_id}/primary-contact`, { membershipId: kid.id })).json().code).toBe('not_adult');
  });
});

describe('member number format (L90)', () => {
  it('only the owner can change it, and a bad format is refused', async () => {
    expect((await call(ADMIN, 'PUT', '/members/settings', { pattern: 'GRC-{SEQ:4}' })).statusCode).toBe(403);
    expect((await call(OWNER, 'PUT', '/members/settings', { pattern: 'GRC-NOCOUNTER' })).json().code).toBe('bad_pattern');
    expect((await call(OWNER, 'PUT', '/members/settings', { pattern: 'GRC-{SEQ:4}', next: 0 })).json().code).toBe('bad_next');
    expect((await call(ADMIN, 'GET', '/members/settings')).json().canEdit).toBe(false);
    expect((await call(OWNER, 'GET', '/members/settings')).json().canEdit).toBe(true);
  });

  it('a new format applies to new members only, and issued numbers never change', async () => {
    const before = (await find('Mary Achieng')).member_number;
    const r = await call(OWNER, 'PUT', '/members/settings', { pattern: 'GRC/{YYYY}/{SEQ:4}', next: 120 });
    expect(r.statusCode).toBe(200);
    expect(r.json().preview).toMatch(/^GRC\/\d{4}\/0120$/);
    const added = await add(ADMIN, { fullName: 'Grace Newman', category: 'adult', phone: '0712000222' });
    expect(added.json().memberNumber).toMatch(/^GRC\/\d{4}\/0120$/);
    expect((await find('Mary Achieng')).member_number).toBe(before);
  });

  it('a church can type an existing number, which must be unique and well-formed', async () => {
    const ok = await add(ADMIN, { fullName: 'Old Member', category: 'adult', phone: '0712000333', memberNumber: 'CH-1987-0042' });
    expect(ok.json().memberNumber).toBe('CH-1987-0042');
    const dupe = await add(ADMIN, { fullName: 'Other Old', category: 'adult', phone: '0712000444', memberNumber: 'ch-1987-0042 ' });
    expect(dupe.statusCode).toBe(200); // different case is a different number
    expect((await add(ADMIN, { fullName: 'Third Old', category: 'adult', phone: '0712000555', memberNumber: 'CH-1987-0042' })).json().code).toBe('number_taken');
    expect((await add(ADMIN, { fullName: 'Fourth Old', category: 'adult', phone: '0712000666', memberNumber: '<script>' })).json().code).toBe('bad_number');
  });

  it('numbers are never reused, even after the counter is wound back', async () => {
    await call(OWNER, 'PUT', '/members/settings', { pattern: 'GRC/{YYYY}/{SEQ:4}', next: 120 });
    const r = await add(ADMIN, { fullName: 'Counter Test', category: 'adult', phone: '0712000777' });
    expect(r.json().memberNumber).toMatch(/\/0121$/); // 0120 was already issued
  });
});

describe('what staff can see (L96)', () => {
  it('shows the age band and birthday to everyone who can view members, and the date of birth only with permission', async () => {
    const withPerm = await find('Mary Achieng');
    expect(withPerm.dob).toBe('1990-05-05');
    expect(typeof withPerm.age).toBe('number');
    // A role that can view members but not exact dates of birth.
    await ctx.db.query(`INSERT INTO roles (id, org_id, name, permissions) VALUES ('org_grace:Viewer','org_grace','Viewer','["members.view"]')`);
    await ctx.db.query(`INSERT INTO role_assignments (id, org_id, user_id, role_id, scope_type, scope_id) VALUES ('ra_viewer','org_grace','u_treas','org_grace:Viewer','branch','br_grc001')`);
    const list = (await call(TREAS, 'GET', '/members?q=Mary')).json();
    expect(list[0].age_band).toBe('36 to 59');
    expect(list[0].birthday).toBe('05-05');
    expect(list[0]).not.toHaveProperty('dob');
    expect(list[0]).not.toHaveProperty('age');
  });
});

describe('birthdays and graduation at 18 (L97)', () => {
  it('sends a birthday wish once, on the birthday', async () => {
    const r = await runMemberHousekeeping(ctx);
    expect(r.birthdays).toBeGreaterThanOrEqual(1); // Peter's birthday is today in the seed
    const n = (await call(PETER, 'GET', '/me/notifications')).json();
    expect(n.rows.filter((x: any) => x.title === 'Happy birthday!')).toHaveLength(1);
    await runMemberHousekeeping(ctx);
    expect((await call(PETER, 'GET', '/me/notifications')).json().rows.filter((x: any) => x.title === 'Happy birthday!')).toHaveLength(1);
  });

  it('lists children turning 18 soon and upcoming birthdays', async () => {
    const i = (await call(ADMIN, 'GET', '/members/insights')).json();
    expect(i.turningEighteen.find((c: any) => c.full_name === 'Brian Otieno').days_until_18).toBe(20);
    expect(i.birthdays.some((b: any) => b.full_name === 'Peter Otieno' && b.days_away === 0)).toBe(true);
  });

  it('a child becomes an adult on their 18th birthday, guardians are told, and staff see the missing phone', async () => {
    expect((await find('Brian Otieno')).category).toBe('child');
    await call(PA1, 'POST', '/admin/clock/advance', { hours: 24 * 21 });
    const brian = await find('Brian Otieno');
    expect(brian.category).toBe('adult');
    expect(brian.needs_own_phone).toBe(true);
    const n = (await call(PETER, 'GET', '/me/notifications')).json();
    expect(n.rows.some((x: any) => /Brian Otieno is now an adult/.test(x.title))).toBe(true);
    const i = (await call(ADMIN, 'GET', '/members/insights')).json();
    expect(i.needsOwnPhone.some((m: any) => m.full_name === 'Brian Otieno')).toBe(true);
    // The guardian link is kept for history, and Brian can now be given his own phone.
    const upd = await call(ADMIN, 'PUT', `/members/${brian.id}`, { phone: '0712000888' });
    expect(upd.statusCode).toBe(200);
    expect((await find('Brian Otieno')).needs_own_phone).toBe(false);
  });

  it('graduation runs only once', async () => {
    const r = await runMemberHousekeeping(ctx);
    expect(r.graduated).toBe(0);
  });
});

describe('permissions and editing', () => {
  it('members cannot use staff member screens, and treasurers cannot add members', async () => {
    expect((await call(JANE, 'GET', '/members')).statusCode).toBe(403);
    expect((await add(TREAS, { fullName: 'Not Allowed', category: 'adult', phone: '0712999999' })).statusCode).toBe(403);
    expect((await call(JANE, 'GET', '/members/settings')).statusCode).toBe(403);
  });

  it('editing validates the same rules and the books are untouched', async () => {
    const mary = await find('Mary Achieng');
    expect((await call(ADMIN, 'PUT', `/members/${mary.id}`, { phone: '0711000001' })).json().code).toBe('phone_in_use');
    expect((await call(ADMIN, 'PUT', `/members/${mary.id}`, { fullName: 'M' })).json().code).toBe('bad_name');
    expect((await call(ADMIN, 'PUT', `/members/${mary.id}`, { sex: 'other' })).json().code).toBe('bad_sex');
    expect((await call(ADMIN, 'PUT', `/members/${mary.id}`, { fullName: 'Mary A. Achieng', sex: 'female' })).statusCode).toBe(200);
    expect((await call(ADMIN, 'PUT', '/members/nobody', { fullName: 'Ghost Person' })).statusCode).toBe(404);
  });

  it('the member app still sees a household with Adult and Child labels', async () => {
    const me = (await call(JANE, 'GET', '/me')).json();
    expect(me.memberships[0]).not.toHaveProperty('relationship');
    for (const h of me.household) expect(['Adult', 'Child']).toContain(h.relationship);
  });
});
