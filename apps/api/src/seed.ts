import { ROLE_TEMPLATES } from './auth';
import type { Ctx } from './ctx';
import { todayEat } from './members';

export const SEED_LOGINS = [
  { app: 'Staff dashboard', who: 'Grace Community owner (all branches, HQ view)', phone: '0700000001' },
  { app: 'Staff dashboard', who: 'Treasurer, Nairobi branch', phone: '0700000002' },
  { app: 'Staff dashboard', who: 'Branch admin, Nairobi (second signer for cash)', phone: '0700000003' },
  { app: 'Staff dashboard', who: 'Regional finance lead, Coast region (Mombasa only)', phone: '0700000004' },
  { app: 'Staff dashboard', who: 'Hope Chapel owner (a different church, for isolation tests)', phone: '0700000005' },
  { app: 'Staff dashboard', who: 'Grace auditor (read-only audit log, no other changes)', phone: '0700000007' },
  { app: 'Staff dashboard', who: 'New Hope Fellowship owner (unverified church, KYC onboarding)', phone: '0700000006' },
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

  await ledger.createOrg({ id: 'org_grace', name: 'Grace Community Church', smsCode: 'GRACE' });
  await ledger.createOrg({ id: 'org_hope', name: 'Hope Chapel', smsCode: 'HOPE' });
  await ledger.createBranch({ id: 'br_grc001', orgId: 'org_grace', code: 'GRC001', name: 'Grace Nairobi', region: 'Central', payoutVerified: true, payoutDestination: dest('KCB', '1100234567', 'Grace Community Church Nairobi') });
  await ledger.createBranch({ id: 'br_grc002', orgId: 'org_grace', code: 'GRC002', name: 'Grace Mombasa', region: 'Coast', payoutVerified: true, payoutDestination: dest('Equity', '0170199887', 'Grace Community Church Mombasa') });
  await ledger.createBranch({ id: 'br_hpc001', orgId: 'org_hope', code: 'HPC001', name: 'Hope Chapel Kisumu', region: 'Nyanza', payoutVerified: true, payoutDestination: dest('Co-op', '0112233445', 'Hope Chapel Kisumu') });

  // A brand-new church that has not been verified yet, to demonstrate onboarding (L81).
  await ledger.createOrg({ id: 'org_newhope', name: 'New Hope Fellowship', smsCode: 'NEWHOPE' });
  await ledger.createBranch({ id: 'br_nhf001', orgId: 'org_newhope', code: 'NHF001', name: 'New Hope Nakuru', region: 'Rift', payoutDestination: dest('Family Bank', '0550011223', 'New Hope Fellowship') });

  const users: [string, string, string, boolean][] = [
    ['u_newhope', '254700000006', 'Joseph Kamau', false],
    ['u_auditor', '254700000007', 'Aisha Auditor', false],
    ['u_owner', '254700000001', 'Daniel Mwangi', false],
    ['u_treas', '254700000002', 'Esther Njeri', false],
    ['u_admin', '254700000003', 'Samuel Kiptoo', false],
    ['u_coast', '254700000004', 'Fatuma Ali', false],
    ['u_hope', '254700000005', 'Grace Achieng', false],
    ['u_pa1', '254700000099', 'ChurchOS Admin One', true],
    ['u_pa2', '254700000098', 'ChurchOS Admin Two', true],
    ['u_jane', '254711000001', 'Jane Wanjiku', false],
    ['u_david', '254711000004', 'David Wanjiku', false],
    ['u_peter', '254711000002', 'Peter Otieno', false],
    ['u_amina', '254711000003', 'Amina Hassan', false],
  ];
  for (const [id, phone, name, admin] of users) {
    await db.query(`INSERT INTO users (id, phone, name, is_platform_admin, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [id, phone, name, admin, now]);
  }

  for (const org of ['org_grace', 'org_hope', 'org_newhope']) {
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
  await assign('u_auditor', 'org_grace', 'Auditor', 'org', 'org_grace');
  await assign('u_newhope', 'org_newhope', 'Organisation Owner', 'org', 'org_newhope');

  // Grace and Hope are already verified. New Hope has submitted only its registration certificate.
  const demoPdf = Buffer.from('%PDF-1.4\n% ChurchOS demo document\n').toString('base64');
  const doc = (id: string, org: string, branch: string | null, type: string, status: string) =>
    db.query(
      `INSERT INTO kyc_documents (id, org_id, branch_id, type, filename, mime, size, data, status, submitted_by, created_at) VALUES ($1,$2,$3,$4,$5,'application/pdf',$6,$7,$8,'u_owner',$9) ON CONFLICT DO NOTHING`,
      [id, org, branch, type, `${type}.pdf`, 35, demoPdf, status, now],
    );
  for (const [org, branches] of [['org_grace', ['br_grc001', 'br_grc002']], ['org_hope', ['br_hpc001']]] as const) {
    await doc(`kyc_${org}_reg`, org, null, 'registration_certificate', 'approved');
    await doc(`kyc_${org}_pin`, org, null, 'kra_pin', 'approved');
    await doc(`kyc_${org}_id`, org, null, 'signatory_id', 'approved');
    for (const b of branches) await doc(`kyc_${b}_proof`, org, b, 'payout_proof', 'approved');
  }
  await doc('kyc_org_newhope_reg', 'org_newhope', null, 'registration_certificate', 'submitted');

  // Members, households and guardians (L92 to L97). Dates are relative to today so birthdays and graduation can be demonstrated.
  const t = todayEat(ctx.clock.now());
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateOf = (yearsAgo: number, extraDays = 0) => {
    const d = new Date(Date.UTC(t.y - yearsAgo, t.m - 1, t.d + extraDays));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  };
  const member = async (m: { id: string; org: string; branch: string; user: string | null; name: string; phone: string | null; number: string; hh: string | null; primary?: boolean; category: 'adult' | 'child'; dob: string | null; sex: 'male' | 'female' | null }) =>
    db.query(
      `INSERT INTO memberships (id, org_id, branch_id, user_id, full_name, phone, member_number, household_id, is_primary_contact, category, dob, sex, consent_at, consent_by, joined_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'u_admin',$13) ON CONFLICT DO NOTHING`,
      [m.id, m.org, m.branch, m.user, m.name, m.phone, m.number, m.hh, !!m.primary, m.category, m.dob, m.sex, now],
    );
  const guardian = (child: string, g: string) => db.query(`INSERT INTO guardians (child_id, guardian_id, org_id) VALUES ($1,$2,'org_grace') ON CONFLICT DO NOTHING`, [child, g]);

  await db.query(`INSERT INTO households (id, org_id) VALUES ('hh_wanjiku','org_grace') ON CONFLICT DO NOTHING`);
  await member({ id: 'm_jane', org: 'org_grace', branch: 'br_grc001', user: 'u_jane', name: 'Jane Wanjiku', phone: '254711000001', number: 'M00001', hh: 'hh_wanjiku', primary: true, category: 'adult', dob: '1985-06-14', sex: 'female' });
  await member({ id: 'm_david', org: 'org_grace', branch: 'br_grc001', user: 'u_david', name: 'David Wanjiku', phone: '254711000004', number: 'M00002', hh: 'hh_wanjiku', category: 'adult', dob: '1983-02-02', sex: 'male' });
  await member({ id: 'm_ruth', org: 'org_grace', branch: 'br_grc001', user: null, name: 'Ruth Wanjiku', phone: null, number: 'M00003', hh: 'hh_wanjiku', category: 'child', dob: dateOf(12, 40), sex: 'female' });
  await guardian('m_ruth', 'm_jane');
  await guardian('m_ruth', 'm_david');
  // Peter's birthday is today, so a birthday wish is created on startup.
  await member({ id: 'm_peter', org: 'org_grace', branch: 'br_grc001', user: 'u_peter', name: 'Peter Otieno', phone: '254711000002', number: 'M00004', hh: null, category: 'adult', dob: dateOf(40), sex: 'male' });
  // Brian turns 18 in 20 days. Advance the clock in Test tools to watch him become an adult.
  await member({ id: 'm_brian', org: 'org_grace', branch: 'br_grc001', user: null, name: 'Brian Otieno', phone: null, number: 'M00006', hh: null, category: 'child', dob: dateOf(18, 20), sex: 'male' });
  await guardian('m_brian', 'm_peter');
  await member({ id: 'm_amina', org: 'org_grace', branch: 'br_grc002', user: 'u_amina', name: 'Amina Hassan', phone: '254711000003', number: 'M00005', hh: null, category: 'adult', dob: '1995-09-09', sex: 'female' });
  await db.query(`INSERT INTO org_settings (org_id, member_number_next) VALUES ('org_grace', 7) ON CONFLICT DO NOTHING`);

  // Certificate template, branch details and sacramental records (L98 to L103).
  const logoSvg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" fill="#0e5a52"/><rect x="44" y="20" width="12" height="60" rx="2" fill="#f8efdc"/><rect x="26" y="38" width="48" height="12" rx="2" fill="#f8efdc"/></svg>',
  ).toString('base64');
  await db.query(
    `INSERT INTO certificate_templates (org_id, config, logo_mime, logo_data, updated_by, updated_at) VALUES ('org_grace', $1, 'image/svg+xml', $2, 'u_owner', $3) ON CONFLICT DO NOTHING`,
    [
      JSON.stringify({
        churchName: 'Grace Community Church', tagline: 'Growing in grace together', baptismTitle: 'Certificate of Baptism',
        baptismBody: 'This is to certify that {name} was baptised on {date} at {place} by {officiant}, in the name of the Father, and of the Son, and of the Holy Spirit.',
        signatories: [{ name: 'Rev. Daniel Mwangi', title: 'Senior Pastor' }, { name: 'Samuel Kiptoo', title: 'Church Administrator' }],
        accent: '#0e5a52', footer: 'Keep this certificate safe. Scan the code to verify it.', showQr: true, copyPriceCents: 50000,
      }),
      logoSvg, now,
    ],
  );
  await db.query(`INSERT INTO branch_profiles (branch_id, org_id, address, town, phone, email) VALUES ('br_grc001','org_grace','Ngong Road, Kilimani','Nairobi','+254 700 000 111','nairobi@grace.example') ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO branch_profiles (branch_id, org_id, address, town, phone, email) VALUES ('br_grc002','org_grace','Nyali Road','Mombasa','+254 700 000 222','mombasa@grace.example') ON CONFLICT DO NOTHING`);
  const rec = (r: { id: string; kind: 'baptism' | 'marriage'; membership: string | null; name: string; date: string; place: string; officiant: string; details: object; status: string; serial: string | null; key: string | null; file?: boolean; by?: string }) =>
    db.query(
      `INSERT INTO sacramental_records (id, org_id, branch_id, kind, membership_id, subject_name, event_date, place, officiant, register_number, details, status, serial, verify_key, file_name, file_mime, file_data, created_by, last_edited_by, approved_by, approved_at, created_at, updated_at)
       VALUES ($1,'org_grace','br_grc001',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,$17,$18,$19,$19) ON CONFLICT DO NOTHING`,
      [r.id, r.kind, r.membership, r.name, r.date, r.place, r.officiant, r.serial ? r.serial.slice(-4) : null, JSON.stringify(r.details), r.status, r.serial, r.key,
       r.file ? 'marriage-certificate.pdf' : null, r.file ? 'application/pdf' : null, r.file ? demoPdf : null, r.by ?? 'u_admin', r.status === 'approved' ? 'u_owner' : null, r.status === 'approved' ? now : null, now],
    );
  await rec({ id: 'rec_ruth', kind: 'baptism', membership: 'm_ruth', name: 'Ruth Wanjiku', date: dateOf(0, -90), place: 'Grace Community Church, Nairobi', officiant: 'Rev. Daniel Mwangi',
    details: { dob: null, birthplace: 'Nairobi', father: 'David Wanjiku', mother: 'Jane Wanjiku', sponsors: ['Mary Achieng', 'John Kamau'] }, status: 'approved', serial: `GRC001-BAP-${t.y}-0001`, key: 'DEMOKEY1' });
  await rec({ id: 'rec_brian', kind: 'baptism', membership: 'm_brian', name: 'Brian Otieno', date: dateOf(0, -14), place: 'Grace Community Church, Nairobi', officiant: 'Rev. Daniel Mwangi',
    details: { father: 'Peter Otieno', sponsors: [] }, status: 'pending_approval', serial: null, key: null });
  await rec({ id: 'rec_marriage', kind: 'marriage', membership: 'm_jane', name: 'David Wanjiku & Jane Wanjiku', date: '2010-12-18', place: 'Grace Community Church, Nairobi', officiant: 'Rev. Peter Mutua',
    details: { parties: [{ name: 'David Wanjiku', membershipId: 'm_david' }, { name: 'Jane Wanjiku', membershipId: 'm_jane' }], certificateNumber: 'MC/2010/004512', issuingAuthority: 'Registrar of Marriages, Nairobi', witnesses: ['Samuel Kiptoo', 'Esther Njeri'] },
    status: 'approved', serial: `GRC001-MAR-${t.y}-0001`, key: 'DEMOKEY2', file: true });

  await db.query(
    `INSERT INTO projects (id, org_id, branch_id, code, name, description, target, deadline, restricted, created_at)
     VALUES ('prj_roof','org_grace','br_grc001','ROOF','New Sanctuary Roof','Replacing the main sanctuary roof before the rains.',500000000,'2027-03-31',true,$1) ON CONFLICT DO NOTHING`,
    [now],
  );
  await db.query(`INSERT INTO pledges (id, org_id, project_id, membership_id, amount, created_at) VALUES ('plg_1','org_grace','prj_roof','m_jane',5000000,$1) ON CONFLICT DO NOTHING`, [now]);

  // A few gifts so dashboards are not empty. They go through the real intake path.
  const give = (ref: string, amount: number, phone: string, method: 'mpesa' | 'airtel' | 'card' = 'mpesa') =>
    ctx.provider.simulatePaybill({ phone, amount, reference: ref, method });
  // Grace has SMS credit (KES 500) so receipts go out by SMS. Hope's wallet is empty, so it falls back to in-app only (L59).
  await give('SMS#GRACE', 50000, '254700000001');
  await give('GRC001#TITHE', 250000, '254711000001');
  await give('GRC001#OFFERING', 50000, '254711000002');
  await give('GRC001#PROJ-ROOF', 1000000, '254711000001');
  await give('GRC002#TITHE', 150000, '254711000003', 'airtel');
  await give('HPC001#TITHE', 300000, '254722000111');
  await give('GRC01#TITHE', 120000, '254733000222'); // mistyped code, lands in suspense
}
