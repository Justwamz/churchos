import { ROLE_TEMPLATES } from './auth';
import type { Ctx } from './ctx';

export const SEED_LOGINS = [
  { app: 'Staff dashboard', who: 'Grace Community owner (all branches, HQ view)', phone: '0700000001' },
  { app: 'Staff dashboard', who: 'Treasurer, Nairobi branch', phone: '0700000002' },
  { app: 'Staff dashboard', who: 'Branch admin, Nairobi (second signer for cash)', phone: '0700000003' },
  { app: 'Staff dashboard', who: 'Regional finance lead, Coast region (Mombasa only)', phone: '0700000004' },
  { app: 'Staff dashboard', who: 'Hope Chapel owner (a different church, for isolation tests)', phone: '0700000005' },
  { app: 'Platform admin', who: 'ChurchOS admin one', phone: '0700000099' },
  { app: 'Platform admin', who: 'ChurchOS admin two (second approver)', phone: '0700000098' },
  { app: 'Member app', who: 'Jane Wanjiku, Nairobi member with a household', phone: '0711000001' },
  { app: 'Member app', who: 'Peter Otieno, Nairobi member', phone: '0711000002' },
  { app: 'Member app', who: 'Amina Hassan, Mombasa member', phone: '0711000003' },
];
export const DEV_OTP = '123456';

/** Seeds a small but complete world so every app has something to show on first run. */
export async function seed(ctx: Ctx) {
  const { ledger, db } = ctx;
  const now = ctx.clock.now().toISOString();
  const dest = (bank: string, acct: string, name: string) => ({ type: 'bank' as const, bank, accountNumber: acct, accountName: name });

  await ledger.createOrg({ id: 'org_grace', name: 'Grace Community Church' });
  await ledger.createOrg({ id: 'org_hope', name: 'Hope Chapel' });
  await ledger.createBranch({ id: 'br_grc001', orgId: 'org_grace', code: 'GRC001', name: 'Grace Nairobi', region: 'Central', payoutDestination: dest('KCB', '1100234567', 'Grace Community Church Nairobi') });
  await ledger.createBranch({ id: 'br_grc002', orgId: 'org_grace', code: 'GRC002', name: 'Grace Mombasa', region: 'Coast', payoutDestination: dest('Equity', '0170199887', 'Grace Community Church Mombasa') });
  await ledger.createBranch({ id: 'br_hpc001', orgId: 'org_hope', code: 'HPC001', name: 'Hope Chapel Kisumu', region: 'Nyanza', payoutDestination: dest('Co-op', '0112233445', 'Hope Chapel Kisumu') });

  const users: [string, string, string, boolean][] = [
    ['u_owner', '254700000001', 'Daniel Mwangi', false],
    ['u_treas', '254700000002', 'Esther Njeri', false],
    ['u_admin', '254700000003', 'Samuel Kiptoo', false],
    ['u_coast', '254700000004', 'Fatuma Ali', false],
    ['u_hope', '254700000005', 'Grace Achieng', false],
    ['u_pa1', '254700000099', 'ChurchOS Admin One', true],
    ['u_pa2', '254700000098', 'ChurchOS Admin Two', true],
    ['u_jane', '254711000001', 'Jane Wanjiku', false],
    ['u_peter', '254711000002', 'Peter Otieno', false],
    ['u_amina', '254711000003', 'Amina Hassan', false],
  ];
  for (const [id, phone, name, admin] of users) {
    await db.query(`INSERT INTO users (id, phone, name, is_platform_admin, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [id, phone, name, admin, now]);
  }

  for (const org of ['org_grace', 'org_hope']) {
    for (const [name, perms] of Object.entries(ROLE_TEMPLATES)) {
      await db.query(`INSERT INTO roles (id, org_id, name, permissions) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [`${org}:${name}`, org, name, JSON.stringify(perms)]);
    }
  }
  const assign = async (user: string, org: string, role: string, scopeType: string, scopeId: string) =>
    db.query(`INSERT INTO role_assignments (id, org_id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [ctx.newId('ra'), org, user, `${org}:${role}`, scopeType, scopeId]);
  await assign('u_owner', 'org_grace', 'Organisation Owner', 'org', 'org_grace');
  await assign('u_treas', 'org_grace', 'Treasurer', 'branch', 'br_grc001');
  await assign('u_admin', 'org_grace', 'Branch Admin', 'branch', 'br_grc001');
  await assign('u_coast', 'org_grace', 'Treasurer', 'region', 'Coast');
  await assign('u_hope', 'org_hope', 'Organisation Owner', 'org', 'org_hope');

  const member = async (id: string, org: string, branch: string, user: string | null, name: string, phone: string | null, number: string, hh: string | null, rel: string | null, guardian: string | null = null) =>
    db.query(
      `INSERT INTO memberships (id, org_id, branch_id, user_id, full_name, phone, member_number, household_id, relationship, guardian_membership_id, joined_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
      [id, org, branch, user, name, phone, number, hh, rel, guardian, now],
    );
  await db.query(`INSERT INTO households (id, org_id, name) VALUES ('hh_wanjiku','org_grace','Wanjiku family') ON CONFLICT DO NOTHING`);
  await member('m_jane', 'org_grace', 'br_grc001', 'u_jane', 'Jane Wanjiku', '254711000001', 'M00001', 'hh_wanjiku', 'Head');
  await member('m_david', 'org_grace', 'br_grc001', null, 'David Wanjiku', null, 'M00002', 'hh_wanjiku', 'Spouse');
  await member('m_ruth', 'org_grace', 'br_grc001', null, 'Ruth Wanjiku', null, 'M00003', 'hh_wanjiku', 'Child', 'm_jane');
  await member('m_peter', 'org_grace', 'br_grc001', 'u_peter', 'Peter Otieno', '254711000002', 'M00004', null, null);
  await member('m_amina', 'org_grace', 'br_grc002', 'u_amina', 'Amina Hassan', '254711000003', 'M00005', null, null);

  await db.query(
    `INSERT INTO projects (id, org_id, branch_id, code, name, description, target, deadline, restricted, created_at)
     VALUES ('prj_roof','org_grace','br_grc001','ROOF','New Sanctuary Roof','Replacing the main sanctuary roof before the rains.',500000000,'2027-03-31',true,$1) ON CONFLICT DO NOTHING`,
    [now],
  );
  await db.query(`INSERT INTO pledges (id, org_id, project_id, membership_id, amount, created_at) VALUES ('plg_1','org_grace','prj_roof','m_jane',5000000,$1) ON CONFLICT DO NOTHING`, [now]);

  // A few gifts so dashboards are not empty. They go through the real intake path.
  const give = (ref: string, amount: number, phone: string, method: 'mpesa' | 'airtel' | 'card' = 'mpesa') =>
    ctx.provider.simulatePaybill({ phone, amount, reference: ref, method });
  await give('GRC001#TITHE', 250000, '254711000001');
  await give('GRC001#OFFERING', 50000, '254711000002');
  await give('GRC001#PROJ-ROOF', 1000000, '254711000001');
  await give('GRC002#TITHE', 150000, '254711000003', 'airtel');
  await give('HPC001#TITHE', 300000, '254722000111');
  await give('GRC01#TITHE', 120000, '254733000222'); // mistyped code, lands in suspense
}
