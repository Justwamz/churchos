// TARGETED AUTHZ PROBES: privilege escalation, mass assignment, object-state abuse, data exposure, token handling.
//   node docs/security/probes/authz-targeted.mjs        (local stack on http://localhost:4000, demo data)
// PASS = the control held. FAIL = a weakness was demonstrated (see docs/security/findings-authz.md). INFO = observation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { loginAll, req, recorder, rid, iso, DAY, BASE } from './_lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { rows, check, info } = recorder();
const T = await loginAll();
const tag = rid();
const NBO = 'br_grc001', MBA = 'br_grc002';
const ids = {};

// ids we need
{
  const team = (await req(T.owner, 'GET', '/team')).j;
  ids.roles = Object.fromEntries(team.roles.map((r) => [r.name, r.id]));
  const owner = team.people.find((p) => p.userId === 'u_owner');
  ids.ownerAssignment = owner.assignments.find((a) => a.role === 'Organisation Owner')?.id;
  const treas = team.people.find((p) => p.userId === 'u_treas');
  ids.treasAssignment = treas.assignments[0].id;
}

// ============================ A. privilege escalation ============================
{
  const r1 = await req(T.admin, 'POST', '/team/members/u_admin/assignments', { roleId: ids.roles['Organisation Owner'], scope: { type: 'org' } });
  check('A01', 'Branch admin cannot give himself the Owner role (whole church)', r1.s === 403, `${r1.s} ${r1.j?.code}`);
  const r2 = await req(T.admin, 'POST', '/team/members/u_admin/assignments', { roleId: ids.roles['Organisation Owner'], scope: { type: 'branch', id: NBO } });
  check('A02', 'Branch admin cannot give himself the Owner role at his own branch (permissions he lacks)', r2.s === 403 && r2.j?.code === 'cannot_escalate', `${r2.s} ${r2.j?.code}`);
  const r3 = await req(T.admin, 'POST', '/team/members/u_vera/assignments', { roleId: ids.roles['Treasurer'], scope: { type: 'branch', id: MBA } });
  check('A03', 'Branch admin (Nairobi) cannot hand out roles for Mombasa', r3.s === 403, `${r3.s}`);
  const r4 = await req(T.admin, 'POST', '/team/roles', { name: 'Probe payout role ' + tag, permissions: ['payouts.manage'] });
  check('A04', 'Branch admin cannot create a role holding a permission he lacks (payouts.manage) or any church-wide role', r4.s === 403, `${r4.s} ${r4.j?.code}`);
  const r5 = await req(T.treas, 'POST', '/team/members', { phone: '0799000111', name: 'Probe Person', roleId: ids.roles['Volunteer'], scope: { type: 'branch', id: NBO } });
  check('A05', 'Treasurer (no team.manage) cannot add team members', r5.s === 403, `${r5.s}`);
  const r6 = await req(T.admin, 'POST', '/team/members', { phone: '0700000099', name: 'x', roleId: ids.roles['Volunteer'], scope: { type: 'branch', id: NBO } });
  check('A06', 'A church cannot give a platform administrator a church role', r6.s === 400, `${r6.s} ${r6.j?.error}`);
  const r8 = await req(T.admin, 'POST', `/team/assignments/${ids.ownerAssignment}/remove`);
  check('A08', 'Branch admin cannot remove the Owner assignment', r8.s === 403, `${r8.s}`);
  const r9 = await req(T.fatuma, 'POST', '/team/members/u_vera/assignments', { roleId: ids.roles['Treasurer'], scope: { type: 'branch', id: NBO } });
  check('A09', 'Coast-region treasurer cannot grant at Nairobi', r9.s === 403, `${r9.s}`);
  // other church's role / assignment ids
  const hopeTeam = (await req(T.hope, 'GET', '/team')).j;
  const hopeRole = hopeTeam.roles.find((r) => r.name === 'Treasurer')?.id;
  const r10 = await req(T.owner, 'POST', '/team/members/u_vera/assignments', { roleId: hopeRole, scope: { type: 'branch', id: NBO } });
  check('A10', "Grace owner cannot use Hope's role id", r10.s === 404, `${r10.s}`);
  const r11 = await req(T.hope, 'POST', `/team/assignments/${ids.treasAssignment}/remove`);
  check('A11', "Hope owner cannot remove a Grace assignment", r11.s === 404, `${r11.s}`);
  const r12 = await req(T.owner, 'POST', `/team/assignments/${ids.ownerAssignment}/remove`);
  check('A12', 'The last Owner assignment cannot be removed', r12.s === 409 && r12.j?.code === 'last_owner', `${r12.s} ${r12.j?.code}`);
  const r13 = await req(T.owner, 'PUT', `/team/roles/${ids.roles['Branch Admin']}`, { permissions: ['payouts.manage'] });
  check('A13', 'Built-in roles cannot be edited (not even by the owner)', r13.s === 409, `${r13.s}`);
  const r14 = await req(T.owner, 'POST', '/team/roles', { name: 'Probe bogus ' + tag, permissions: ['is_platform_admin'] });
  check('A14', 'A role cannot contain a permission that does not exist', r14.s === 400, `${r14.s}`);
  // self-grant by a holder of team.manage: giving yourself a role you already fully hold is allowed (no gain); anything above is refused
  const r16 = await req(T.admin, 'POST', '/team/members/u_admin/assignments', { roleId: ids.roles['Treasurer'], scope: { type: 'branch', id: NBO } });
  info('A16', 'Branch admin giving himself Treasurer at his branch (he holds all its permissions: no gain)', `${r16.s} ${r16.j?.code ?? ''}`);
  if (r16.s === 200) await req(T.owner, 'POST', `/team/assignments/${r16.j.id}/remove`); // clean up
  // mass assignment on team add
  const phone = '07990' + String(Math.floor(10000 + Math.random() * 89999));
  const r7 = await req(T.admin, 'POST', '/team/members', { phone, name: 'Probe Volunteer ' + tag, roleId: ids.roles['Volunteer'], scope: { type: 'branch', id: NBO }, is_platform_admin: true, isAdmin: true, role: 'admin' });
  check('A07', 'Creating a team member ignores extra fields such as is_platform_admin', r7.s === 200, `${r7.s} ${JSON.stringify(r7.j).slice(0, 80)}`);
  const nt = await req(null, 'POST', '/auth/otp/verify', { phone, code: '123456' });
  check('A07b', 'The new user is not a platform admin', nt.j?.user?.isAdmin === false, `isAdmin=${nt.j?.user?.isAdmin}`);
  ids.probeUser = { phone, token: nt.j?.token, id: r7.j?.userId, assignment: null };
  const t2 = (await req(T.owner, 'GET', '/team')).j;
  ids.probeUser.assignment = t2.people.find((p) => p.userId === r7.j?.userId)?.assignments?.[0]?.id;
}

// A17: can a church-wide team administrator who is NOT an owner remove an Owner? (removal never checks the removed role's permissions)
{
  const rnd = () => '07991' + String(Math.floor(10000 + Math.random() * 89999));
  const role = await req(T.owner, 'POST', '/team/roles', { name: 'Probe team admin ' + tag, permissions: ['team.view', 'team.manage'] });
  const phoneA = rnd(), phoneB = rnd();
  const a = await req(T.owner, 'POST', '/team/members', { phone: phoneA, name: 'Probe TeamAdmin ' + tag, roleId: role.j?.id, scope: { type: 'org' } });
  const b = await req(T.owner, 'POST', '/team/members', { phone: phoneB, name: 'Probe SecondOwner ' + tag, roleId: ids.roles['Organisation Owner'], scope: { type: 'org' } });
  const tokA = (await req(null, 'POST', '/auth/otp/verify', { phone: phoneA, code: '123456' })).j?.token;
  if (a.s === 200 && b.s === 200 && tokA) {
    const rm = await req(tokA, 'POST', `/team/assignments/${b.j.id}/remove`);
    check('A17', 'A church-wide team administrator who is not an owner cannot remove an Owner assignment', rm.s === 403, `${rm.s} ${rm.j?.code ?? rm.j?.error ?? ''} (200 = Team admin removed an Owner; team.manage alone is enough)`);
    const self = await req(tokA, 'POST', `/team/members/${a.j.userId}/assignments`, { roleId: ids.roles['Organisation Owner'], scope: { type: 'org' } });
    check('A18', 'A team administrator cannot give herself the Owner role', self.s === 403, `${self.s} ${self.j?.code ?? ''}`);
    if (rm.s !== 200) await req(T.owner, 'POST', `/team/assignments/${b.j.id}/remove`);
  } else info('A17', 'could not set up probe users', `${a.s} ${b.s}`);
  if (a.j?.id) await req(T.owner, 'POST', `/team/assignments/${a.j.id}/remove`);
  if (role.j?.id) await req(T.owner, 'POST', `/team/roles/${role.j.id}/delete`);
}

// ============================ B. mass assignment / foreign ids in bodies ============================
{
  const r1 = await req(T.owner, 'POST', '/members', { branchId: NBO, org_id: 'org_hope', branch_id: 'br_hpc001', user_id: 'u_owner', status: 'inactive', consent: true, fullName: 'Probe Mass ' + tag, category: 'adult', phone: '07123' + String(Math.floor(10000 + Math.random() * 89999)), dob: '1990-01-01' });
  const list = (await req(T.owner, 'GET', '/members?branch=' + NBO)).j;
  const mine = Array.isArray(list) ? list.find((m) => m.id === r1.j?.id) : null;
  check('B01', 'POST /members ignores org_id / branch_id / user_id / status in the body', r1.s === 200 && mine && mine.branch_id === NBO, `created in ${mine?.branch_id}`);
  const hopeSees = (await req(T.hope, 'GET', '/members')).j;
  check('B01b', 'The new member is not visible to the other church', !hopeSees.some((m) => m.id === r1.j?.id));
  if (r1.j?.id) {
    const r2 = await req(T.owner, 'PUT', `/members/${r1.j.id}`, { fullName: 'Probe Mass2 ' + tag, branch_id: MBA, org_id: 'org_hope', status: 'inactive', user_id: 'u_pa1', category: 'child' });
    const after = (await req(T.owner, 'GET', '/members?branch=' + NBO)).j.find((m) => m.id === r1.j.id);
    check('B02', 'PUT /members/:id ignores branch_id / org_id / status / user_id / category', r2.s === 200 && after && after.branch_id === NBO && after.category === 'adult', `${r2.s} branch=${after?.branch_id} cat=${after?.category}`);
  }
  const r3 = await req(T.jane, 'POST', '/me/suggestions', { category: 'worship', body: 'Probe suggestion that names another member id', membershipId: 'm_peter' });
  check('B03', "A member cannot file a suggestion as another membership id", r3.s === 403, `${r3.s}`);
  const r4 = await req(T.jane, 'POST', '/me/giving-plans', { membershipId: 'm_peter', amount: 1000, purpose: 'TITHE', frequency: 'weekly', weekday: 3, time: '10:00' });
  check('B04', "A member cannot set up a regular gift on another member's membership", r4.s === 404 || r4.s === 403, `${r4.s}`);
  const r5 = await req(T.peter, 'POST', '/me/statements', { orgId: 'org_hope', year: new Date().getUTCFullYear() });
  check('B05', 'A member cannot ask for a statement from a church she does not belong to', r5.s === 404, `${r5.s}`);
  const hopeEv = (await req(T.hope, 'GET', '/events')).j[0];
  const r6 = await req(T.peter, 'POST', '/me/tickets/orders', { eventId: hopeEv?.id, method: 'mpesa', phone: '0711000001', lines: [] });
  check('B06', "A Grace member cannot start a member ticket order on a Hope event", r6.s === 404, `${r6.s}`);
  const r7 = await req(T.peter, 'POST', '/me/give', { code: 'HPC001', amount: 100, method: 'mpesa', anonymous: true });
  check('B07', 'Anonymous giving is limited to members of that church', r7.s === 403, `${r7.s} ${r7.j?.code}`);
  const r8 = await req(T.newcomer, 'POST', '/me/link/instant', { code: 'GRC001' });
  check('B08', 'A person with no staff role cannot link herself to a church instantly', r8.s === 403, `${r8.s} ${r8.j?.code}`);
  // prayer request body fields
  const pr = await req(T.jane, 'POST', '/me/prayer', { body: 'Probe prayer ' + tag, audience: 'team', org_id: 'org_hope', branch_id: MBA, author_name: 'Pastor Daniel', status: 'answered', anonymous: false });
  const staffView = pr.j?.id ? (await req(T.pastor, 'GET', '/prayer')).j.requests.find((x) => x.id === pr.j.id) : null;
  if (!pr.j?.id) info('B09', 'prayer request not created (daily limit?)', `${pr.s} ${pr.j?.code}`);
  else check('B09', 'Prayer request ignores org_id / branch_id / author_name / status in the body', !!staffView && staffView.author === 'Jane Wanjiku' && staffView.status !== 'answered', `author=${staffView?.author} status=${staffView?.status} branch=${staffView?.branch}`);
  // expense status tampering
  const cats = (await req(T.treas, 'GET', '/expenses/setup')).j.categories;
  const ex = await req(T.treas, 'POST', '/expenses', { branchId: NBO, date: iso(0).slice(0, 10), amount: 9000, categoryId: cats[0].id, payee: 'Probe Mass ' + tag, method: 'mpesa', reference: 'MASS' + tag, files: [], noReceiptReason: 'probe', status: 'approved', auto_approved: true, recorded_by: 'u_owner', approver_name: 'Daniel Mwangi' });
  const exv = (await req(T.treas, 'GET', `/expenses/${ex.j?.id}`)).j;
  check('B10', 'Expense ignores status / auto_approved / recorded_by / approver_name in the body (above the auto-approval limit)', ex.s === 200 && exv.status === 'submitted' && exv.recordedBy === 'Esther Njeri', `status=${exv.status} by=${exv.recordedBy}`);
  const cash = await req(T.treas, 'POST', '/cash', { branchId: NBO, amount: 500, purpose: 'OFFERING', status: 'approved', approved_by: 'u_owner', counted_by: 'u_owner' });
  const so = await req(T.treas, 'POST', `/cash/${cash.j?.id}/signoff`, { approve: true });
  check('B11', 'Cash count ignores status / counted_by in the body, and the counter cannot sign it off', cash.s === 200 && so.s === 403, `count ${cash.s}, own signoff ${so.s} ${so.j?.code}`);
  // price / status tampering on a public ticket order
  const ev = await req(T.owner, 'POST', '/events', { title: 'Probe price ' + tag, audience: { type: 'org' }, startsAt: iso(30 * DAY) });
  const tk = await req(T.owner, 'PUT', `/events/${ev.j.id}/ticketing`, { ticketed: true, types: [{ name: 'Seat', price: 50000, quantity: 5 }] });
  const pub = (await req(null, 'GET', `/public/event/${tk.j.code}`)).j;
  const ord = await req(null, 'POST', '/public/tickets/orders', { code: tk.j.code, name: 'Probe Buyer', email: `probe.${tag}@acme.co.ke`, phone: '0711000098', method: 'mpesa', status: 'paid', total: 1, subtotal: 0, unit_price: 1, lines: [{ typeId: pub.types[0].id, qty: 1, price: 1, unitPrice: 1 }] });
  check('B12', 'Ticket order ignores client-sent price / total / status (KES 50,000 ticket priced server-side)', ord.s === 200 && ord.j.subtotal === 50000 * 100 && ord.j.status === 'awaiting_payment', `subtotal=${ord.j.subtotal} status=${ord.j.status}`);
  const neg = await req(null, 'POST', '/public/tickets/orders', { code: tk.j.code, name: 'Probe Buyer', email: `probe2.${tag}@acme.co.ke`, phone: '0711000097', method: 'mpesa', lines: [{ typeId: pub.types[0].id, qty: -3 }] });
  check('B13', 'A negative quantity is refused', neg.s >= 400, `${neg.s}`);
  // profile
  if (ids.probeUser?.token) {
    const pf = await req(ids.probeUser.token, 'PUT', '/me/profile', { name: 'Probe Renamed', email: `probe.${tag}@acme.co.ke`, is_platform_admin: true, isAdmin: true });
    const again = await req(null, 'POST', '/auth/otp/verify', { phone: ids.probeUser.phone, code: '123456' });
    check('B14', 'PUT /me/profile ignores is_platform_admin and the new login is not an admin', again.j?.user?.isAdmin === false, `${pf.s} isAdmin=${again.j?.user?.isAdmin}`);
  }
}

// ============================ C. object-state abuse ============================
{
  // self approval
  const cats = (await req(T.admin, 'GET', '/expenses/setup')).j.categories;
  const mk = await req(T.admin, 'POST', '/expenses', { branchId: NBO, date: iso(0).slice(0, 10), amount: 9000, categoryId: cats[0].id, payee: 'Probe self approve ' + tag, method: 'mpesa', reference: 'SELF' + tag, noReceiptReason: 'probe', files: [] });
  const self = await req(T.admin, 'POST', `/expenses/${mk.j?.id}/decide`, { approve: true });
  check('C01', 'Recording person cannot approve their own expense', self.s === 403 && self.j?.code === 'same_person', `${self.s} ${self.j?.code}`);
  const other = await req(T.fatuma, 'POST', `/expenses/${mk.j?.id}/decide`, { approve: true });
  check('C02', 'A treasurer of another branch (no approve right) cannot approve a Nairobi expense', other.s === 404 || other.s === 403, `${other.s}`);
  const ap = await req(T.owner, 'POST', `/expenses/${mk.j?.id}/decide`, { approve: true });
  const ap2 = await req(T.owner, 'POST', `/expenses/${mk.j?.id}/decide`, { approve: true });
  check('C03', 'A second decision on the same expense is refused', ap.s === 200 && ap2.s === 409, `${ap.s} then ${ap2.s}`);
  // concurrent decisions
  const mk2 = await req(T.admin, 'POST', '/expenses', { branchId: NBO, date: iso(0).slice(0, 10), amount: 9000, categoryId: cats[0].id, payee: 'Probe race ' + tag, method: 'mpesa', reference: 'RACE' + tag, noReceiptReason: 'probe', files: [] });
  const par = await Promise.all([1, 2, 3, 4].map(() => req(T.owner, 'POST', `/expenses/${mk2.j?.id}/decide`, { approve: true })));
  const okCount = par.filter((r) => r.s === 200).length;
  const evs = (await req(T.owner, 'GET', `/audit/events?entityId=${mk2.j?.id}&action=expense.approved`)).j.events.length;
  check('C04', 'Four parallel approvals of one expense are recorded once', okCount === 1 && evs === 1, `200s=${okCount}, approval audit rows=${evs}`);
  // cross-branch join request
  const st = (await req(T.newcomer, 'GET', '/me/link/status')).j;
  const pending = st.requests.find((r) => r.status === 'pending' && r.branch === 'Grace Nairobi');
  if (pending) await req(T.newcomer, 'POST', `/me/link/request/${pending.id}/cancel`);
  const jr = await req(T.newcomer, 'POST', '/me/link/request', { code: 'GRC002', consent: true, message: 'probe' });
  if (jr.j?.id) {
    const d1 = await req(T.admin, 'POST', `/members/join-requests/${jr.j.id}/decide`, { approve: false, note: 'probe' });
    check('C05', 'Nairobi branch admin cannot decide a Mombasa join request', d1.s === 404, `${d1.s}`);
    const d2 = await req(T.hope, 'POST', `/members/join-requests/${jr.j.id}/decide`, { approve: false, note: 'probe' });
    check('C06', 'Another church cannot decide a join request', d2.s === 404, `${d2.s}`);
    await req(T.newcomer, 'POST', `/me/link/request/${jr.j.id}/cancel`);
  } else info('C05', 'could not create a Mombasa join request', JSON.stringify(jr.j));
  // credit refund: can staff approve and pay their own refund? (needs a staff member who is also a member with credit)
  info('C07', 'Self-decision on event-credit refunds is tested in authz-selfdecide.mjs (changes demo data)');
}

// ============================ D. data exposure for staff ============================
{
  const aud = (await req(T.auditor, 'GET', '/members')).j;
  const jane = aud.find((m) => m.id === 'm_jane');
  check('D01', 'Staff without members.reveal see masked phone numbers in the member list', !!jane && /•/.test(jane.phone) && jane.phone_masked === true, `phone=${jane?.phone}`);
  // search oracle: the mask hides 3 middle digits, but the search runs on the real number
  const q = await req(T.auditor, 'GET', '/members?q=254711000001');
  const found = Array.isArray(q.j) && q.j.some((m) => m.id === 'm_jane');
  if (found) check('D02', 'Searching by a FULL phone number must not confirm it for staff who cannot reveal numbers', false, 'auditor (no members.reveal) confirmed Jane\'s full number 254711000001 with GET /members?q=; 1000 guesses recover the 3 masked digits of any member');
  else check('D02', 'Searching by a full phone number does not confirm it for staff who cannot reveal numbers', true);
  const noDob = aud.find((m) => 'dob' in m);
  check('D03', 'Staff without members.sensitive do not receive dates of birth', !noDob, noDob ? 'dob present' : '');
  const vis = (await req(T.pastor, 'GET', '/attendance/visitors')).j.visitors?.[0];
  info('D04', 'Visitor list (attendance.view) returns FULL phone numbers with no logged reveal, unlike the member list', `phone=${vis?.phone}`);
  const sug = (await req(T.pastor, 'GET', '/suggestions')).j.suggestions;
  const anon = sug.find((s) => s.anonymous);
  const keys = Object.keys(anon ?? {});
  check('D05', 'Staff view of an anonymous suggestion carries no author name, user id or membership id', !!anon && (anon.author == null || /^(a member|anonymous)$/i.test(anon.author)) && !keys.some((k) => /user|member|owner|phone/i.test(k)), `author=${anon?.author} keys=${keys.join(',')}`);
  const pr = (await req(T.pastor, 'GET', '/prayer')).j.requests;
  const apr = pr.find((p) => p.anonymous);
  check('D06', 'Staff view of an anonymous prayer request has no author name', !apr || apr.author == null || /^a member$/i.test(apr.author), `author=${apr?.author}`);
  const mon = (await req(T.treas, 'GET', '/collections')).j.rows?.[0];
  check('D07', 'Collections report masks payer phone numbers', !mon || /•/.test(String(mon.phone ?? '•')), `phone=${mon?.phone}`);
  const team = (await req(T.admin, 'GET', '/team')).j;
  info('D08', 'Team list returns each colleague\'s email address (and masked phone) to team.view holders', `email=${team.people?.[0]?.email}`);
  // another member's private data
  const peterLedger = (await req(T.jane, 'GET', '/me/giving/ledger')).j.lines.map((l) => l.id);
  const peterOwn = (await req(T.peter, 'GET', '/me/giving/ledger')).j.lines.map((l) => l.id);
  check('D09', "A member's giving ledger never contains another member's lines", !peterLedger.some((id) => peterOwn.includes(id)));
  // notifications belong to the user
  const jn = (await req(T.jane, 'GET', '/me/notifications')).j.rows;
  if (jn[0]) {
    const del = await req(T.peter, 'POST', '/me/notifications/delete', { ids: [jn[0].id] });
    check('D10', "Peter cannot delete Jane's notification by id", del.j?.deleted === 0, `deleted=${del.j?.deleted}`);
    const rd = await req(T.peter, 'POST', '/me/notifications/read', { ids: [jn[0].id] });
    const still = (await req(T.jane, 'GET', '/me/notifications')).j.rows.find((r) => r.id === jn[0].id);
    check('D11', "Peter cannot mark Jane's notification read", still && still.read === jn[0].read, `read ${jn[0].read} -> ${still?.read}`);
  }
  // household: David (same household) vs Jane's private objects
  const dPray = (await req(T.david, 'GET', '/me/prayer')).j.requests.map((r) => r.id);
  const jPray = (await req(T.jane, 'GET', '/me/prayer')).j.requests.filter((r) => r.mine && r.audience === 'team').map((r) => r.id);
  const leak = jPray.filter((id) => dPray.includes(id));
  check('D12', "A household member (David) does not see Jane's team-only prayer requests", leak.length === 0, leak.join(','));
  const dState = (await req(T.david, 'GET', '/me/statements')).j;
  const jState = (await req(T.jane, 'GET', '/me/statements')).j;
  const shared = (dState.issued ?? []).filter((s) => (jState.issued ?? []).some((j) => j.id === s.id));
  info('D13', "Statements: household members share statements only if they share a user id", `shared=${shared.length}`);
  // Mombasa member reads Nairobi member-app objects (church-wide member app): informational
  const svc = (await req(T.owner, 'GET', '/attendance/services')).j.services.find((s) => s.branchId === NBO);
  const ck = await req(T.amina, 'POST', `/me/services/${svc?.id}/check-in`, {});
  info('D14', 'A Mombasa member can check in to / read a Nairobi service (member app is church-wide, not branch-scoped)', `${ck.s}`);
}

// D15: an anonymous gift must not be traceable to the giver from anything staff can open
{
  const base = Math.max(0, ...((await req(T.owner, 'GET', '/audit/events?limit=5')).j.events ?? []).map((e) => e.seq));
  const g = await req(T.jane, 'POST', '/me/give', { code: 'GRC001', amount: 2345 + Math.floor(Math.random() * 100), method: 'mpesa', phone: '0711000001', anonymous: true, purpose: 'OFFERING' });
  await new Promise((r) => setTimeout(r, 3000));
  const needles = ['254711000001', '0711000001', '711000001', 'Jane Wanjiku', 'u_jane', 'm_jane'];
  const hits = [];
  for (const who of ['owner', 'treas', 'admin']) {
    const col = (await req(T[who], 'GET', '/collections')).j.rows ?? [];
    const anon = col.filter((x) => x.member == null && x.phone == null); // rows that carry no payer at all = anonymous gifts
    for (const n of needles) if (JSON.stringify(anon).includes(n)) hits.push(`${who} /collections: ${n}`);
    const ev = ((await req(T[who], 'GET', '/audit/events?limit=200')).j.events ?? []).filter((e) => e.seq > base);
    for (const n of needles) if (JSON.stringify(ev).includes(n)) hits.push(`${who} /audit/events (events written since the gift): ${n}`);
  }
  const mine = await req(T.jane, 'GET', '/me/giving/ledger');
  info('D15a', 'Anonymous gift started', `${g.s} ${g.j?.status ?? g.j?.code}; the giver sees ${mine.j?.anonymous?.length ?? 0} anonymous gifts in her own ledger`);
  check('D15', 'Nothing staff can open (collections, audit log) links an anonymous gift to the giver', hits.length === 0, hits.join(' | '));
}
// H01: reversal requests against payments that belong to nobody yet (suspense)
{
  const sus = (await req(T.pa1, 'GET', '/admin/suspense')).j;
  const target = Array.isArray(sus) ? sus[0] : null;
  if (target) {
    const r = await req(T.hope, 'POST', '/reversal-requests', { paymentId: target.id, reason: 'probe: not our payment' });
    check('H01', "Staff of one church cannot open a reversal request on another party's unclaimed (suspense) payment or read its transaction code and amount", r.s === 403, `${r.s} ${JSON.stringify(r.j).slice(0, 140)}`);
    if (r.j?.id) await req(T.pa1, 'POST', `/admin/reversal-requests/${r.j.id}/decide`, { approve: false, reason: 'probe cleanup' });
  } else info('H01', 'no suspense payment available');
}

// I01/I02: shared identity (phone number / user) across churches. A throw-away Grace member is the victim, so the demo people are untouched.
{
  const phone = '07128' + String(Math.floor(10000 + Math.random() * 89999));
  const vic = await req(T.owner, 'POST', '/members', { branchId: NBO, consent: true, fullName: 'Probe Victim ' + tag, category: 'adult', phone, dob: '1991-02-02' });
  const vTok = (await req(null, 'POST', '/auth/otp/verify', { phone, code: '123456' })).j?.token;
  const m = await req(T.hope, 'POST', '/members', { branchId: 'br_hpc001', consent: true, fullName: 'Probe Hope Copy ' + tag, category: 'adult', phone, dob: '1991-02-02' });
  const me = vTok ? (await req(vTok, 'GET', '/me')).j : {};
  const inHope = (me.memberships ?? []).some((x) => x.org_id === 'org_hope');
  check('I01', "A church cannot attach a person who belongs to another church (matched by phone number) to its own member list", !inHope, inHope ? 'Hope staff typed the phone of a Grace member; that person now has a Hope membership in her own app (the user is matched by phone, no consent step)' : `${vic.s} ${m.s}`);
  if (m.j?.id && vTok) {
    const before = (await req(vTok, 'GET', '/me/preferences')).j;
    const c = await req(T.hope, 'POST', `/members/${m.j.id}/consent`, { channel: 'sms', optIn: false, confirmed: true, source: 'in_person' });
    const after = (await req(vTok, 'GET', '/me/preferences')).j;
    check('I02', "One church cannot change a person's SMS / WhatsApp consent for every other church (contact_prefs is keyed by phone only)", after.smsOptOut === before.smsOptOut, `consent ${c.s}; the Grace member's global smsOptOut ${before.smsOptOut} -> ${after.smsOptOut} (source ${after.source})`);
  }
}

// ============================ E. tokens, sign-in and transport ============================
{
  // E01 forged token with the repo's default dev secret
  const fake = (secret) => {
    const payload = Buffer.from(JSON.stringify({ uid: 'u_pa1', phone: '254700000099', name: 'Forged', isAdmin: true, exp: Date.now() + 3600_000 })).toString('base64url');
    return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
  };
  const f = await req(fake('dev-only-secret-change-me'), 'GET', '/admin/tenants').catch(() => null);
  const forged = await fetch(BASE + '/admin/tenants', { headers: { authorization: 'Bearer ' + fake('dev-only-secret-change-me') } });
  check('E01', 'A token signed with the default development secret is rejected', forged.status === 401, `status ${forged.status} (200 means the stack runs on the public default secret CHURCHOS_AUTH_SECRET)`);
  const wrong = await fetch(BASE + '/admin/tenants', { headers: { authorization: 'Bearer ' + fake('some-other-secret') } });
  check('E02', 'A token signed with another secret is rejected', wrong.status === 401, `${wrong.status}`);
  // token in query string
  const qs = await fetch(BASE + '/me?token=' + T.jane);
  check('E03', 'Session tokens are NOT accepted in the URL query string (they end up in logs and referrers)', qs.status === 401, `status ${qs.status}`);
  // CORS
  const cors = await fetch(BASE + '/me', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
  const aco = cors.headers.get('access-control-allow-origin');
  check('E04', 'CORS does not reflect arbitrary origins (CORS_ORIGINS must be set outside development)', aco !== 'https://evil.example' && aco !== '*', `allow-origin=${aco}`);
  // fixed OTP and account probing
  const known = await req(null, 'POST', '/auth/otp/request', { phone: '0711000001' });
  const unknown = await req(null, 'POST', '/auth/otp/request', { phone: '0799123456' });
  check('E05', 'OTP request does not reveal whether a number is registered or the code', !('known' in known.j) && !('devCode' in known.j), `known=${known.j?.known} unknown=${unknown.j?.known} devCode=${known.j?.devCode}`);
  const badLogin = await req(null, 'POST', '/auth/otp/verify', { phone: '0711000001', code: '000000' });
  check('E06', 'Sign-in works only with the right code (the fixed dev code 123456 must be off outside development)', badLogin.s === 401, `${badLogin.s}`);
  // lockout is per phone and checked before the code: anyone can lock anyone out. Shown on the throw-away user created above.
  if (ids.probeUser?.phone) {
    for (let i = 0; i < 6; i++) await req(null, 'POST', '/auth/otp/verify', { phone: ids.probeUser.phone, code: '999999' });
    const locked = await req(null, 'POST', '/auth/otp/verify', { phone: ids.probeUser.phone, code: '123456' });
    check('E07', 'Wrong codes sent by a stranger cannot lock the real owner out of the account', locked.s !== 429, `owner with the right code gets ${locked.s} after 6 wrong codes from anyone (15 min lock)`);
  }
  // token lifetime / revocation: a removed role takes effect at once, a removed user does not log out
  if (ids.probeUser?.assignment && ids.probeUser?.token) {
    const before = await req(ids.probeUser.token, 'GET', '/me/claims/setup');
    await req(T.owner, 'POST', `/team/assignments/${ids.probeUser.assignment}/remove`);
    const after = await req(ids.probeUser.token, 'GET', '/me/claims/setup');
    check('E08', 'Removing a role takes effect immediately on live tokens (grants are read from the database)', before.j?.allowed === true && after.j?.allowed === false, `before allowed=${before.j?.allowed} after=${after.j?.allowed}`);
  }
}


// ============================ G. query-string overrides (branch= / org=) ============================
{
  const probes = [
    ['/collections', 'branch'], ['/dashboard', 'branch'], ['/members', 'branch'], ['/members/grouped', 'branch'], ['/projects', 'branch'], ['/settlements', 'branch'],
    ['/expenses', 'branchId'], ['/attendance/visitors', 'branchId'], ['/attendance/summary', 'branchId'], ['/members/insights', 'branch'],
  ];
  const personas = [['treas', 'br_grc002', /GRC002|br_grc002|Grace Mombasa|Amina/], ['admin', 'br_grc002', /GRC002|br_grc002|Grace Mombasa|Amina/], ['fatuma', 'br_grc001', /GRC001|br_grc001|Grace Nairobi|Jane Wanjiku|Peter Otieno/]];
  const bad = [];
  for (const [p, foreign, re] of personas) for (const [route, param] of probes) {
    const r = await req(T[p], 'GET', `${route}?${param}=${foreign}`);
    if (r.s >= 200 && r.s < 300 && re.test(r.text)) bad.push(`${p} ${route}?${param}=${foreign} -> ${r.s}`);
  }
  check('G01', 'A branch-scoped person cannot pull the other branch data with ?branch= / ?branchId= on list routes', bad.length === 0, bad.join(' | '));
  const orgBad = [];
  for (const route of ['/collections', '/dashboard', '/members', '/expenses', '/events', '/team', '/audit/events', '/wallets', '/messages']) {
    const r = await req(T.treas, 'GET', `${route}?org=org_hope`);
    if (r.s >= 200 && r.s < 300 && /org_hope|HPC001|Hope Chapel/.test(r.text)) orgBad.push(route);
  }
  check('G02', 'A Grace user cannot switch to Hope with ?org=org_hope', orgBad.length === 0, orgBad.join(','));
  const adminOrg = await req(T.owner, 'GET', '/audit/events?org=org_hope');
  check('G03', 'Church audit log ignores ?org= for church users (only platform admins may choose a church)', !/org_hope/.test(adminOrg.text), `${adminOrg.s}`);
}

// ============================ W. content pushed into other churches' staff inboxes ============================
{
  const st = (await req(T.newcomer, 'GET', '/me/link/status')).j;
  for (const q of st.requests.filter((x) => x.status === 'pending')) await req(T.newcomer, 'POST', `/me/link/request/${q.id}/cancel`);
  const phish = 'URGENT click http://probe.invalid/' + tag;
  const jr = await req(T.newcomer, 'POST', '/me/link/request', { code: 'HPC001', consent: true, name: phish, message: 'probe' });
  const inbox = (await req(T.hope, 'GET', '/me/notifications?app=staff')).j.rows ?? [];
  const hit = inbox.find((n) => (n.body ?? '').includes(phish));
  check('W01', 'A stranger with no church cannot place free text (name / link) into the staff inbox of any church', !hit, hit ? `join-request name appears verbatim in Hope staff notification: "${hit.body.slice(0, 90)}"` : `${jr.s}`);
  if (jr.j?.id) await req(T.newcomer, 'POST', `/me/link/request/${jr.j.id}/cancel`);
}

const BR = '';
// ============================ F. payment-provider webhook ============================
{
  // The simulated provider signs webhooks with a fixed secret. In 'live' mode this route is closed; in simulated mode it is open to anyone who knows the secret.
  const body = JSON.stringify({ providerTxId: 'PRB' + tag.toUpperCase(), method: 'mpesa', amount: 100, reference: 'NOSUCHCHURCH#TITHE', phone: '254711000001' });
  const sig = createHmac('sha256', 'dev-psp-secret').update(body).digest('hex');
  const r = await fetch(BASE + '/psp/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-psp-signature': sig }, body });
  const unsigned = await fetch(BASE + '/psp/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  check('F01', 'An unsigned webhook is rejected', unsigned.status === 401, `${unsigned.status}`);
  check('F02', 'A webhook signed with the default simulator secret is rejected (it would let anyone post money into a church ledger)', r.status === 401, `${r.status} ${await r.text()} (200 = the stack is in simulated PSP mode with the public secret 'dev-psp-secret')`);
}

if (process.env.AUTHZ_POST_PAYMENT === '1') {
  // Optional (changes demo data, KES 1): shows that a forged webhook with a real church reference is credited to that church.
  const body = JSON.stringify({ providerTxId: 'PRB1' + tag.toUpperCase(), method: 'mpesa', amount: 100, reference: 'GRC001#OFFERING', phone: '254711000001' });
  const sig = createHmac('sha256', 'dev-psp-secret').update(body).digest('hex');
  const r = await fetch(BASE + '/psp/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-psp-signature': sig }, body });
  check('F03', 'A forged webhook cannot credit a real church ledger', r.status === 401, `${r.status} ${await r.text()}`);
}

const summary = { base: BASE, run: new Date().toISOString(), pass: rows.filter((r) => r.pass === true).length, fail: rows.filter((r) => r.pass === false).length, info: rows.filter((r) => r.pass === null).length };
console.log('\nSUMMARY', JSON.stringify(summary));
fs.writeFileSync(path.join(here, 'authz-targeted.results.json'), JSON.stringify({ summary, rows }, null, 1));
process.exit(summary.fail ? 1 : 0);
