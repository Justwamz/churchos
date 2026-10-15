import { ROLE_TEMPLATES } from './auth';
import type { Ctx } from './ctx';
import { todayEat } from './members';
import { ensureWallets } from './wallets';
import { startOfDayEat } from './ctx';
import { gradientPng } from './artwork';

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
  // ---------- messaging: wallets, integrations, consent, groups, a scheduled message (L111 to L122) ----------
  // Grace runs each branch as its own cost centre. Hope Chapel shares one wallet. New Hope has not set anything up yet.
  // Tariffs (L124): the default is flat KES 1.00 per SMS and KES 3.00 per WhatsApp message. "Volume bands" is the example from the brief
  // (first 3,500 SMS at 0.95, up to 15,000 at 0.85, above that 0.70) and is assigned to New Hope Fellowship.
  await db.query(`INSERT INTO tariffs (id, name, is_default, created_at) VALUES ('tar_standard','Standard',true,$1), ('tar_volume','Volume bands',false,$1) ON CONFLICT DO NOTHING`, [now]);
  await db.query(
    `INSERT INTO tariff_versions (id, tariff_id, version, effective_from, bands, note, created_by, created_at) VALUES
       ('tvr_standard_1','tar_standard',1,'1970-01-01T00:00:00.000Z',$1,'Launch prices','u_pa1',$3),
       ('tvr_volume_1','tar_volume',1,'1970-01-01T00:00:00.000Z',$2,'Volume example','u_pa1',$3) ON CONFLICT DO NOTHING`,
    [
      JSON.stringify({ sms: [{ upTo: null, price: 100 }], whatsapp: [{ upTo: null, price: 300 }] }),
      JSON.stringify({ sms: [{ upTo: 3500, price: 95 }, { upTo: 15000, price: 85 }, { upTo: null, price: 70 }], whatsapp: [{ upTo: 2000, price: 300 }, { upTo: 10000, price: 270 }, { upTo: null, price: 240 }] }),
      now,
    ],
  );
  await db.query(`INSERT INTO org_tariffs (org_id, tariff_id) VALUES ('org_newhope','tar_volume') ON CONFLICT DO NOTHING`);
  await db.query(
    `INSERT INTO integration_settings (org_id, wallet_mode, sms_sender_id, whatsapp_display_name, whatsapp_number, alert_emails) VALUES
       ('org_grace','per_branch','GRACECHURCH','Grace Community Church','254700123456','["finance@grace.example"]'),
       ('org_hope','shared',NULL,NULL,NULL,'[]'), ('org_newhope','shared',NULL,NULL,NULL,'[]') ON CONFLICT DO NOTHING`,
  );
  for (const org of ['org_grace', 'org_hope', 'org_newhope']) await ensureWallets(ctx, org);
  // Staff emails, so low-balance alerts reach people by email as well as in the app (L115).
  for (const [id, email] of [['u_owner', 'daniel@grace.example'], ['u_admin', 'samuel@grace.example'], ['u_treas', 'esther@grace.example'], ['u_hope', 'grace@hope.example']]) {
    await db.query('UPDATE users SET email=$2, email_verified=true WHERE id=$1', [id, email]);
  }
  // Opening balances go through the real top-up path. GRC002 and Hope start empty, to show the empty-wallet behaviour.
  await give('SMS#GRACE', 50000, '254700000001');
  await give('WA#GRACE', 30000, '254700000001');
  await give('SMS#GRC001', 20000, '254700000002');
  await give('WA#GRC001', 10000, '254700000002');
  // Choices about church messages: Jane and Peter agreed to WhatsApp, David opted out of SMS.
  await db.query(`INSERT INTO contact_prefs (phone, whatsapp_opt_in, sms_opt_out, source, updated_at, updated_by) VALUES
     ('254711000001', true, false, 'member', $1, 'u_jane'), ('254711000002', true, false, 'member', $1, 'u_peter'), ('254711000004', false, true, 'member', $1, 'u_david') ON CONFLICT DO NOTHING`, [now]);
  // Two groups. Peter leads the youth fellowship, so he can message it from the member app (L122).
  await db.query(`INSERT INTO groups (id, org_id, branch_id, name, description, created_by, created_at) VALUES
     ('grp_youth','org_grace','br_grc001','Youth Fellowship','Teens and young adults, Fridays at 6pm','u_admin',$1),
     ('grp_mothers','org_grace','br_grc001','Mothers Union','Monthly prayer and support','u_admin',$1) ON CONFLICT DO NOTHING`, [now]);
  await db.query(`INSERT INTO group_members (group_id, membership_id, org_id, role, added_at) VALUES
     ('grp_youth','m_peter','org_grace','leader',$1), ('grp_youth','m_ruth','org_grace','member',$1), ('grp_youth','m_brian','org_grace','member',$1), ('grp_youth','m_amina','org_grace','member',$1),
     ('grp_mothers','m_jane','org_grace','leader',$1), ('grp_mothers','m_amina','org_grace','member',$1) ON CONFLICT DO NOTHING`, [now]);
  // A message waiting to go out in two days.
  await db.query(
    `INSERT INTO messages (id, org_id, branch_id, sender_id, sender_name, source, audience, channels, title, body, status, scheduled_at, summary, created_at)
     VALUES ('msg_demo','org_grace',NULL,'u_owner','Daniel Mwangi','staff',$1,'["inapp","sms"]','Sunday service reminder','Hello {name}, we meet this Sunday at 9am. Bring a friend. God bless you.','scheduled',$2,'{"estimated":4}',$3) ON CONFLICT DO NOTHING`,
    [JSON.stringify({ scope: { type: 'org' }, who: 'all', allowedBranchIds: ['br_grc001', 'br_grc002'] }), new Date(ctx.clock.now().getTime() + 48 * 3600_000).toISOString(), now],
  );

  // Notice board, events and group walls (L133 to L139). Dates are relative to the clock so the demo always has something coming up.
  // Days ahead at a given East Africa Time hour, so demo events start at sensible times.
  const at = (days: number, hour = 0) => new Date(Date.parse(startOfDayEat(ctx.clock.now())) + days * 86400_000 + hour * 3600_000).toISOString();
  await db.query(`INSERT INTO groups (id, org_id, branch_id, name, description, created_by, created_at, join_policy, posting) VALUES ('grp_prayer','org_grace','br_grc001','Prayer Warriors','Wednesday prayer, open to everyone who wants to join','u_admin',$1,'request','members') ON CONFLICT DO NOTHING`, [now]);
  await db.query(`INSERT INTO group_members (group_id, membership_id, org_id, role, added_at) VALUES ('grp_prayer','m_jane','org_grace','leader',$1), ('grp_prayer','m_david','org_grace','member',$1) ON CONFLICT DO NOTHING`, [now]);
  await db.query(
    `INSERT INTO notices (id, org_id, branch_id, title, body, audience, pinned, publish_at, expires_at, notify, notified, created_by, created_at, updated_at) VALUES
      ('ntc_welcome','org_grace',NULL,'Welcome to Grace Community Church','We are glad you are here. Services are at 8am and 10am every Sunday. Tea and fellowship follow the second service.','{"type":"org"}',true,$1,NULL,false,false,'u_owner',$1,$1),
      ('ntc_harvest','org_grace',NULL,'Harvest Sunday is coming','Bring your first fruits to the second service on the last Sunday of the month. Every gift goes to the roof project.','{"type":"org"}',false,$1,$2,false,false,'u_owner',$1,$1),
      ('ntc_nbo','org_grace','br_grc001','Parking at Nairobi','Please use the side gate on Kiambu Road while the main car park is repaired.','{"type":"branch","id":"br_grc001"}',false,$1,$2,false,false,'u_admin',$1,$1) ON CONFLICT DO NOTHING`,
    [now, at(21)],
  );
  await db.query(
    `INSERT INTO events (id, org_id, branch_id, title, description, location, starts_at, ends_at, audience, rsvp, capacity, created_by, created_at, updated_at) VALUES
      ('evt_carols','org_grace',NULL,'Christmas Carols Night','An evening of carols, a children''s choir and tea. Bring your family.','Main sanctuary, Nairobi',$2,$3,'{"type":"org"}',true,150,'u_owner',$1,$1),
      ('evt_movie','org_grace','br_grc001','Youth Movie Night','Popcorn and a film for the youth.','Parish hall',$4,$5,'{"type":"group","id":"grp_youth"}',true,30,'u_admin',$1,$1),
      ('evt_prayer','org_grace',NULL,'Day of prayer and fasting','Join us at any time between 6am and 6pm.','Main sanctuary, Nairobi',$6,$7,'{"type":"org"}',false,NULL,'u_owner',$1,$1) ON CONFLICT DO NOTHING`,
    [now, at(9, 17), at(9, 20), at(3, 18), at(3, 21), at(5, 6), at(5, 18)],
  );
  await db.query(`INSERT INTO event_rsvps (event_id, user_id, org_id, name, response, guests, updated_at) VALUES ('evt_carols','u_david','org_grace','David Wanjiku','going',2,$1) ON CONFLICT DO NOTHING`, [now]);
  await db.query(
    `INSERT INTO group_posts (id, org_id, group_id, author_id, author_name, kind, body, pinned, created_at) VALUES
      ('gpo_1','org_grace','grp_youth','u_peter','Peter Otieno','announcement','Welcome to Youth Fellowship. We meet Fridays at 6pm. Be kind to each other and be on time.',true,$1),
      ('gpo_2','org_grace','grp_youth','u_amina','Amina Hassan','post','Who is bringing the speakers for the movie night?',false,$1) ON CONFLICT DO NOTHING`,
    [now],
  );
  await db.query(`INSERT INTO group_comments (id, org_id, group_id, post_id, author_id, author_name, body, created_at) VALUES ('gco_1','org_grace','grp_youth','gpo_2','u_peter','Peter Otieno','I will. The hall has a projector as well.',$1) ON CONFLICT DO NOTHING`, [now]);

  // Things members can book (L140): a pastor's diary, a hall that costs money, a sound system that needs no approval, and the Mombasa grounds.
  const week = (ranges: string[][], days = ['mon', 'tue', 'wed', 'thu', 'fri']) => Object.fromEntries(days.map((d) => [d, ranges]));
  await db.query(
    `INSERT INTO resources (id, org_id, branch_id, kind, name, description, capacity, owner_user_id, slot_minutes, max_minutes, hours, min_notice_hours, max_advance_days, approval, price, price_per, created_by, created_at, updated_at) VALUES
      ('res_pastor','org_grace','br_grc001','person','Pastor Daniel','Talk to the pastor, pray together or plan a visit. Sessions are 30 minutes.',NULL,'u_owner',30,60,$1,12,60,'manual',NULL,'booking','u_owner',$5,$5),
      ('res_hall','org_grace','br_grc001','place','Main hall, Nairobi','Seats 200. Chairs, tables and a kitchen are included.',200,NULL,60,480,$2,24,180,'manual',150000,'hour','u_owner',$5,$5),
      ('res_sound','org_grace','br_grc001','thing','Sound system','Speakers, two microphones and a mixer.',NULL,NULL,60,240,$3,24,90,'auto',NULL,'booking','u_owner',$5,$5),
      ('res_grounds','org_grace','br_grc002','place','Church grounds, Mombasa','Open grounds for weddings and picnics.',500,NULL,60,480,$4,48,180,'auto',NULL,'booking','u_owner',$5,$5) ON CONFLICT DO NOTHING`,
    [
      JSON.stringify(week([['09:00', '12:00'], ['14:00', '17:00']])),
      JSON.stringify(week([['08:00', '21:00']], ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])),
      JSON.stringify(week([['08:00', '18:00']], ['sat', 'sun'])),
      JSON.stringify(week([['07:00', '19:00']], ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])),
      now,
    ],
  );

  // The church shop at Nairobi (L155 to L163): items with stock, and a few cash sales from the last days so the reports have something to show.
  const shopItems: [string, string, string, string, number, number, number, number][] = [
    ['itm_bible_kjv', 'BIB-KJV', 'Bible, KJV hardcover', 'Bibles', 180000, 120000, 5, 24],
    ['itm_bible_sw', 'BIB-SW', 'Bible, Swahili', 'Bibles', 150000, 100000, 5, 12],
    ['itm_rosary_wood', 'ROS-WD', 'Rosary, wooden', 'Rosaries', 25000, 12000, 10, 60],
    ['itm_rosary_crystal', 'ROS-CR', 'Rosary, crystal', 'Rosaries', 60000, 35000, 5, 18],
    ['itm_prayerbook', 'BOK-PRY', 'Prayer book', 'Books', 40000, 22000, 5, 4],
    ['itm_candles', 'CND-12', 'Candles, pack of 12', 'Candles', 15000, 8000, 10, 40],
    ['itm_tshirt', 'TSH-GCC', 'Church T-shirt', 'Clothing', 100000, 55000, 5, 0],
  ];
  for (const [id, code, name, category, price, cost, low, stock] of shopItems) {
    await db.query(`INSERT INTO shop_items (id, org_id, branch_id, code, name, category, price, cost, low_stock, created_by, created_at, updated_at) VALUES ($1,'org_grace','br_grc001',$2,$3,$4,$5,$6,$7,'u_owner',$8,$8) ON CONFLICT DO NOTHING`, [id, code, name, category, price, cost, low, now]);
    if (stock > 0) await db.query(`INSERT INTO shop_movements (id, org_id, branch_id, item_id, kind, qty, unit_cost, reason, created_by, created_at) VALUES ($1,'org_grace','br_grc001',$2,'received',$3,$4,'Opening stock','u_owner',$5)`, ['mov_open_' + id, id, stock + 0, cost, new Date(ctx.clock.now().getTime() - 6 * 86400_000).toISOString()]);
  }
  const pastSale = async (n: number, daysAgo: number, method: string, lines: [string, number][], buyer: string | null) => {
    const at = new Date(ctx.clock.now().getTime() - daysAgo * 86400_000).toISOString();
    const total = lines.reduce((s, [id, q]) => s + q * (shopItems.find((i) => i[0] === id)![4]), 0);
    const sid = 'sal_demo_' + n;
    await db.query(`INSERT INTO shop_sales (id, code, receipt_no, org_id, branch_id, buyer_name, method, status, total, sold_by, created_at, completed_at) VALUES ($1,$2,$3,'org_grace','br_grc001',$4,$5,'completed',$6,'u_treas',$7,$7) ON CONFLICT DO NOTHING`, [sid, 'DEMO0' + n, 'GRC001-0000' + n, buyer, method, total, at]);
    for (const [iid, q] of lines) {
      const it = shopItems.find((i) => i[0] === iid)!;
      await db.query(`INSERT INTO shop_sale_lines (sale_id, item_id, name, qty, unit_price, unit_cost) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [sid, iid, it[2], q, it[4], it[5]]);
      await db.query(`INSERT INTO shop_movements (id, org_id, branch_id, item_id, kind, qty, sale_id, created_by, created_at) VALUES ($1,'org_grace','br_grc001',$2,'sold',$3,$4,'u_treas',$5) ON CONFLICT DO NOTHING`, [`mov_${sid}_${iid}`, iid, -q, sid, at]);
    }
  };
  await pastSale(1, 3, 'cash', [['itm_bible_kjv', 2], ['itm_rosary_wood', 3]], 'Walk-in');
  await pastSale(2, 2, 'mpesa', [['itm_prayerbook', 1], ['itm_candles', 4]], 'Jane Wanjiku');
  await pastSale(3, 1, 'cash', [['itm_rosary_crystal', 2], ['itm_bible_sw', 1]], null);

  // Adverts for the member app's home slider (L130 to L132). Daniel approves what Samuel creates. Artwork is generated so the slider has something to show.
  const art = (a: [number, number, number], b: [number, number, number]) => gradientPng(1280, 720, a, b);
  const inTwoWeeks = new Date(ctx.clock.now().getTime() + 14 * 86400_000).toISOString();
  await db.query(
    `INSERT INTO adverts (id, code, org_id, branch_id, title, body, link_url, image_mime, image_data, width, height, audience, starts_at, ends_at, advertiser_name, advertiser_contact, price, status, created_by, submitted_by, decided_by, decided_at, created_at, updated_at) VALUES
      ('adv_carols','CAROLS','org_grace',NULL,'Christmas Carols Night','Saturday 5pm at the main sanctuary. Bring the whole family.',NULL,'image/png',$1,1280,720,'{"type":"org"}',$5,NULL,NULL,NULL,NULL,'approved','u_admin','u_admin','u_owner',$5,$5,$5),
      ('adv_movie','MOVIE1','org_grace','br_grc001','Youth Movie Night','Friday 7pm in the hall. Popcorn is on us.',NULL,'image/png',$2,1280,720,'{"type":"group","id":"grp_youth"}',$5,$6,NULL,NULL,NULL,'approved','u_admin','u_admin','u_owner',$5,$5,$5),
      ('adv_wedding','WED001','org_grace',NULL,'Mary and John are getting married','Join us on 14 February. Congratulations from all of us.',NULL,'image/png',$3,1280,720,'{"type":"org"}',$5,NULL,'Mary and John Kamau','0712 000 111',500000,'awaiting_payment','u_admin','u_admin','u_owner',$5,$5,$5),
      ('adv_bake','BAKE01','org_grace','br_grc001','Mothers Union Bake Sale','After the second service this Sunday.',NULL,'image/png',$4,1280,720,'{"type":"branch","id":"br_grc001"}',$5,$6,NULL,NULL,NULL,'pending','u_admin','u_admin',NULL,NULL,$5,$5) ON CONFLICT DO NOTHING`,
    [art([14, 90, 82], [8, 40, 52]), art([76, 29, 149], [30, 27, 75]), art([190, 24, 93], [76, 5, 25]), art([194, 120, 3], [120, 53, 15]), now, inTwoWeeks],
  );

  await give('GRC001#TITHE', 250000, '254711000001');
  await give('GRC001#OFFERING', 50000, '254711000002');
  await give('GRC001#PROJ-ROOF', 1000000, '254711000001');
  await give('GRC002#TITHE', 150000, '254711000003', 'airtel');
  await give('HPC001#TITHE', 300000, '254722000111');
  await give('GRC01#TITHE', 120000, '254733000222'); // mistyped code, lands in suspense
}
