import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { seedKidsDemo } from './seed-kids';
import { runKidsJobs } from './routes/kids';

let app: Awaited<ReturnType<typeof buildApp>>['app'];
let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
const tokens: Record<string, string> = {};
async function login(phone: string) {
  if (tokens[phone]) return tokens[phone];
  const r = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: '123456' } });
  tokens[phone] = r.json().token;
  return tokens[phone];
}
const call = async (phone: string | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: any) =>
  app.inject({ method, url, payload, headers: phone ? { authorization: `Bearer ${await login(phone)}`, 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0 Safari/537.36' } : {} });

const OWNER = '0700000001', LUCY = '0700000008', TREAS = '0700000002', HOPE = '0700000005';
const JANE = '0711000001', DAVID = '0711000004', PETER = '0711000002';
const MIN = 60_000;
const inbox = async (who: string, app: 'member' | 'staff' = 'member') => (await call(who, 'GET', `/me/notifications?app=${app}`)).json().rows as any[];
const smsTo = (phone: string) => ctx.messaging.sent.filter((m) => m.channel === 'sms' && m.to === phone);
let maryCode = '';
const lastCode = (phone: string) => /(\d{6})/.exec(smsTo(phone).at(-1)!.body)![1];

const familyOf = async (who: string) => (await call(who, 'GET', '/me/family')).json().families[0];
const qr = async (who: string, device = 'Jane phone') => (await call(who, 'POST', '/me/family/qr', { membershipId: (await familyOf(who)).membershipId, device })).json();

let classId = '';
let sess = '';
const open = async (extra: any = {}) => {
  const r = await call(LUCY, 'POST', `/kids/classes/${classId}/sessions`, { minutes: 15, device: 'Lucy tablet', ...extra });
  expect(r.statusCode).toBe(200);
  sess = r.json().id;
  return sess;
};
const scan = async (who: string) => (await call(LUCY, 'POST', `/kids/sessions/${sess}/scan`, { token: (await qr(who)).token, device: 'Lucy tablet' })).json();
const room = async () => (await call(LUCY, 'GET', `/kids/sessions/${sess}`)).json();
const drop = async (who: string, names: string[]) => {
  const s = await scan(who);
  const ids = s.dropOff.filter((d: any) => names.includes(d.name)).map((d: any) => d.id);
  return call(LUCY, 'POST', `/kids/sessions/${sess}/checkin`, { proof: s.proof, childIds: ids, device: 'Lucy tablet' });
};
const take = async (who: string, name: string) => {
  const s = await scan(who);
  const ids = s.collect.filter((c: any) => c.name === name).map((c: any) => c.id);
  return call(LUCY, 'POST', `/kids/sessions/${sess}/checkout`, { proof: s.proof, checkinIds: ids, device: 'Lucy tablet' });
};

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
  await seedKidsDemo(ctx);
  classId = 'kcl_sunday';
}, 60000);

describe("a guardian's family and code (L180)", () => {
  it('shows the children and a code that changes', async () => {
    const f = await familyOf(JANE);
    expect(f.children.map((c: any) => c.name).sort()).toEqual(['Joy Wanjiku', 'Ruth Wanjiku']);
    expect(f.pickupPeople.map((p: any) => p.name)).toEqual(['Grace Wanjiru']);
    const a = await qr(JANE);
    expect(a.token.startsWith('K1.')).toBe(true);
    expect(a.qrSvg).toContain('<svg');
    ctx.clock.advance(1000);
    expect((await qr(JANE)).token).not.toBe(a.token);
  });
  it('is only for someone who has children', async () => {
    expect((await call(HOPE, 'GET', '/me/family')).json().families).toEqual([]);
    expect((await call(HOPE, 'POST', '/me/family/qr', { membershipId: (await familyOf(JANE)).membershipId })).statusCode).toBe(404);
  });
  it('lets a guardian list and remove approved pick-up people (L183)', async () => {
    const m = (await familyOf(JANE)).membershipId;
    expect((await call(JANE, 'POST', '/me/family/pickup-people', { membershipId: m, name: 'Bad', phone: '123' })).json().code).toBe('bad_phone');
    const r = await call(JANE, 'POST', '/me/family/pickup-people', { membershipId: m, name: 'Samuel Mwangi', phone: '0722 111 222', relation: 'Driver', idNumber: '2233' });
    expect(r.statusCode).toBe(200);
    expect((await familyOf(JANE)).pickupPeople).toHaveLength(2);
    expect((await call(DAVID, 'POST', `/me/family/pickup-people/${r.json().id}/remove`)).statusCode).toBe(404);
    expect((await call(JANE, 'POST', `/me/family/pickup-people/${r.json().id}/remove`)).statusCode).toBe(200);
    expect((await familyOf(JANE)).pickupPeople).toHaveLength(1);
  });
});

describe('classes and sessions (L179)', () => {
  it('shows a teacher only their own class, and others nothing', async () => {
    const mine = (await call(LUCY, 'GET', '/kids/classes')).json();
    expect(mine.classes.map((c: any) => c.name)).toEqual(['Sunday School']);
    expect(mine.canManage).toBe(false);
    expect((await call(PETER, 'GET', '/kids/classes')).statusCode).toBe(403);
    expect((await call(HOPE, 'GET', '/kids/classes')).json().classes).toEqual([]);
  });
  it('sets up a class for managers, with teachers who can check in', async () => {
    const bad = await call(OWNER, 'POST', '/kids/classes', { branchId: 'br_grc001', name: 'Nursery', teachers: ['u_jane'] });
    expect(bad.json().code).toBe('bad_teacher');
    const ok = await call(OWNER, 'POST', '/kids/classes', { branchId: 'br_grc001', name: 'Nursery', room: 'Room 1', teachers: ['u_owner'] });
    expect(ok.statusCode).toBe(200);
    expect((await call(OWNER, 'POST', '/kids/classes', { branchId: 'br_grc001', name: 'nursery' })).json().code).toBe('duplicate');
    expect((await call(LUCY, 'POST', '/kids/classes', { branchId: 'br_grc001', name: 'Hack' })).statusCode).toBe(403);
    // Lucy does not teach the Nursery, so she cannot open it.
    expect((await call(LUCY, 'POST', `/kids/classes/${ok.json().id}/sessions`, {})).statusCode).toBe(404);
    expect((await call(OWNER, 'GET', '/kids/teachers?branchId=br_grc001')).json().teachers.map((t: any) => t.name)).toContain('Lucy Wairimu');
  });
  it('opens one session at a time', async () => {
    await open();
    expect((await call(LUCY, 'POST', `/kids/classes/${classId}/sessions`, {})).json().code).toBe('already_open');
    const list = (await call(LUCY, 'GET', '/kids/classes')).json();
    expect(list.classes[0].session.stillIn).toBe(0);
  });
});

describe('drop-off (L181)', () => {
  it('refuses a code that is not from the app, is tampered with, or has expired', async () => {
    const bad = await call(LUCY, 'POST', `/kids/sessions/${sess}/scan`, { token: 'hello' });
    expect(bad.json().result).toBe('invalid');
    const t = (await qr(JANE)).token;
    const tampered = t.slice(0, -3) + (t.endsWith('aaa') ? 'bbb' : 'aaa');
    expect((await call(LUCY, 'POST', `/kids/sessions/${sess}/scan`, { token: tampered })).json().result).toBe('invalid');
    ctx.clock.advance(2 * MIN);
    const old = await call(LUCY, 'POST', `/kids/sessions/${sess}/scan`, { token: t });
    expect(old.json().result).toBe('expired');
  });
  it('shows the children linked to the guardian, and checks them in with a tag', async () => {
    const s = await scan(JANE);
    expect(s.result).toBe('ok');
    expect(s.guardian.name).toBe('Jane Wanjiku');
    expect(s.dropOff.map((d: any) => d.name).sort()).toEqual(['Joy Wanjiku', 'Ruth Wanjiku']);
    const r = await drop(JANE, ['Joy Wanjiku']);
    expect(r.statusCode).toBe(200);
    expect(r.json().tag).toBe('01');
    expect(r.json().smsSent).toBe(false);
    const rm = await room();
    expect(rm.children).toHaveLength(1);
    expect(rm.children[0]).toMatchObject({ name: 'Joy Wanjiku', tag: '01', status: 'in', dropper: 'Jane Wanjiku' });
  });
  it('tells both guardians in the app', async () => {
    expect((await inbox(JANE)).some((n) => /Joy Wanjiku checked in/.test(n.title))).toBe(true);
    expect((await inbox(DAVID)).some((n) => /dropped off Joy/.test(n.body))).toBe(true);
  });
  it('will not check the same child in twice, or a child who is not theirs', async () => {
    const again = await drop(JANE, ['Joy Wanjiku']);
    expect(again.json().code).toBe('already_in');
    const s = await scan(JANE);
    const fake = await call(LUCY, 'POST', `/kids/sessions/${sess}/checkin`, { proof: s.proof, childIds: ['m_brian'] });
    expect(fake.json().code).toBe('not_linked');
    expect((await call(LUCY, 'POST', `/kids/sessions/${sess}/checkin`, { proof: s.proof, childIds: [] })).json().code).toBe('no_children');
    expect((await call(LUCY, 'POST', `/kids/sessions/${sess}/checkin`, { proof: 'nope', childIds: ['m_ruth'] })).json().code).toBe('bad_proof');
  });
  it('lets a guardian with no app be found by name and sends an SMS with the tag and a code', async () => {
    const f = (await call(LUCY, 'GET', `/kids/sessions/${sess}/guardians?q=Kamau`)).json().guardians;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ name: 'Mary Kamau', hasApp: false });
    expect(f[0].phone).not.toContain('722000010');
    const found = (await call(LUCY, 'POST', `/kids/sessions/${sess}/find`, { guardianId: f[0].id, device: 'Lucy tablet' })).json();
    const r = await call(LUCY, 'POST', `/kids/sessions/${sess}/checkin`, { proof: found.proof, childIds: ['m_tom'], device: 'Lucy tablet' });
    expect(r.json()).toMatchObject({ tag: '02', smsSent: true, codeSent: true });
    maryCode = lastCode('254722000010');
    expect(smsTo('254722000010').at(-1)!.body).toMatch(/Tom Kamau checked in to Sunday School.*tag 02.*pick-up code \d{6}/);
  });
});

describe('pick-up (L182, L183)', () => {
  it('refuses a person who is not a guardian of the child', async () => {
    const s = await scan(PETER);
    expect(s.collect).toEqual([]);
    const ids = (await room()).children.filter((c: any) => c.name === 'Joy Wanjiku').map((c: any) => c.id);
    const r = await call(LUCY, 'POST', `/kids/sessions/${sess}/checkout`, { proof: s.proof, checkinIds: ids });
    expect(r.json().done).toEqual([]);
    expect(r.json().refused[0].reason).toMatch(/not allowed/);
    expect((await room()).children.find((c: any) => c.name === 'Joy Wanjiku').status).toBe('in');
  });
  it('lets the other guardian collect, says so, and tells the person who dropped off', async () => {
    const s = await scan(DAVID);
    expect(s.collect[0]).toMatchObject({ name: 'Joy Wanjiku', byDifferentPerson: true, dropper: 'Jane Wanjiku' });
    ctx.messaging.clear();
    const r = await take(DAVID, 'Joy Wanjiku');
    expect(r.json().done).toHaveLength(1);
    expect((await room()).children.find((c: any) => c.name === 'Joy Wanjiku')).toMatchObject({ status: 'out', collector: 'David Wanjiku' });
    expect((await inbox(JANE)).some((n) => /collected/.test(n.title) && /by David Wanjiku/.test(n.body))).toBe(true);
    expect(smsTo('254711000001').some((m) => /by David Wanjiku/.test(m.body))).toBe(true);
    expect(smsTo('254711000004')).toHaveLength(0);
  });
  it('lets a guardian with no app collect with the code from the SMS, once', async () => {
    const wrong = await call(LUCY, 'POST', `/kids/sessions/${sess}/lookup`, { code: '000000' });
    expect(wrong.json().result).toBe('bad_code');
    const code = maryCode;
    const l = (await call(LUCY, 'POST', `/kids/sessions/${sess}/lookup`, { code })).json();
    expect(l).toMatchObject({ result: 'ok', holder: 'Mary Kamau' });
    expect(l.children.map((c: any) => c.name)).toEqual(['Tom Kamau']);
    const r = await call(LUCY, 'POST', `/kids/sessions/${sess}/checkout`, { proof: l.proof, checkinIds: l.children.map((c: any) => c.id) });
    expect(r.json().done).toHaveLength(1);
    expect((await call(LUCY, 'POST', `/kids/sessions/${sess}/lookup`, { code })).json().result).toBe('bad_code');
  });
  it('lets an approved person collect with an SMS code sent to their own phone', async () => {
    expect((await drop(JANE, ['Ruth Wanjiku'])).statusCode).toBe(200);
    const ruth = (await room()).children.find((c: any) => c.name === 'Ruth Wanjiku' && c.status === 'in');
    const who = (await call(LUCY, 'GET', `/kids/checkins/${ruth.id}/collectors`)).json();
    expect(who.guardians.map((g: any) => g.name).sort()).toEqual(['David Wanjiku', 'Jane Wanjiku']);
    expect(who.people[0]).toMatchObject({ name: 'Grace Wanjiru', phone: '0733 *** 011' });
    expect(JSON.stringify(who)).not.toContain('254733000011');
    const sent = await call(LUCY, 'POST', `/kids/checkins/${ruth.id}/send-code`, { kind: 'approved', id: who.people[0].id, device: 'Lucy tablet' });
    expect(sent.statusCode).toBe(200);
    expect(smsTo('254733000011').at(-1)!.body).toMatch(/Pick-up code for Ruth Wanjiku/);
    const l = (await call(LUCY, 'POST', `/kids/sessions/${sess}/lookup`, { code: lastCode('254733000011') })).json();
    expect(l).toMatchObject({ result: 'ok', holder: 'Grace Wanjiru', kind: 'approved' });
    expect(l.children[0].byDifferentPerson).toBe(true);
    const r = await call(LUCY, 'POST', `/kids/sessions/${sess}/checkout`, { proof: l.proof, checkinIds: [ruth.id] });
    expect(r.json().done).toHaveLength(1);
    expect((await room()).children.find((c: any) => c.id === ruth.id)).toMatchObject({ status: 'out', collector: 'Grace Wanjiru' });
  });
  it('limits wrong codes, and codes for a person who is not listed', async () => {
    for (let i = 0; i < 8; i++) await call(LUCY, 'POST', `/kids/sessions/${sess}/lookup`, { code: '111111' });
    expect((await call(LUCY, 'POST', `/kids/sessions/${sess}/lookup`, { code: '222222' })).statusCode).toBe(429);
    ctx.clock.advance(11 * MIN);
    expect((await drop(JANE, ['Joy Wanjiku'])).statusCode).toBe(200);
    const joy = (await room()).children.find((c: any) => c.name === 'Joy Wanjiku' && c.status === 'in');
    expect((await call(LUCY, 'POST', `/kids/checkins/${joy.id}/send-code`, { kind: 'approved', id: 'kpp_nobody' })).statusCode).toBe(404);
    for (let i = 0; i < 3; i++) expect((await call(LUCY, 'POST', `/kids/checkins/${joy.id}/send-code`, { kind: 'guardian', id: 'm_jane' })).statusCode).toBe(200);
    expect((await call(LUCY, 'POST', `/kids/checkins/${joy.id}/send-code`, { kind: 'guardian', id: 'm_jane' })).json().code).toBe('too_many');
  });
});

describe('not collected (L184)', () => {
  it('cannot close a session while a child is still in', async () => {
    expect((await call(LUCY, 'POST', `/kids/sessions/${sess}/close`, {})).json().code).toBe('children_in');
  });
  it('tells every guardian after the grace period, with the phone numbers hidden until then', async () => {
    const joy = (await room()).children.find((c: any) => c.name === 'Joy Wanjiku' && c.status === 'in');
    expect((await call(LUCY, 'GET', `/kids/checkins/${joy.id}/contacts`)).json().code).toBe('not_yet');
    expect((await runKidsJobs(ctx)).alerted).toBe(0);
    ctx.clock.advance(20 * MIN);
    expect((await call(LUCY, 'GET', `/kids/checkins/${joy.id}/contacts`)).statusCode).toBe(200);
    ctx.clock.advance(1 * MIN);
    ctx.messaging.clear();
    const j = await runKidsJobs(ctx);
    expect(j.alerted).toBe(1);
    expect(smsTo('254711000001').some((m) => /Joy Wanjiku has not been collected from Sunday School/.test(m.body))).toBe(true);
    expect(smsTo('254711000004').some((m) => /not been collected/.test(m.body))).toBe(true);
    expect((await inbox(JANE)).some((n) => /waiting to be collected/.test(n.title))).toBe(true);
    expect((await runKidsJobs(ctx)).alerted).toBe(0);
    const state = (await room()).children.find((c: any) => c.id === joy.id).state;
    expect(['alerted', 'escalated']).toContain(state);
  });
  it('alerts staff after the longer wait', async () => {
    const before = (await inbox(OWNER, 'staff')).length;
    ctx.clock.advance(30 * MIN);
    const j = await runKidsJobs(ctx);
    expect(j.escalated).toBe(1);
    expect((await inbox(OWNER, 'staff')).length).toBeGreaterThan(before);
    expect((await inbox(OWNER, 'staff')).some((n) => /Child not collected: Joy Wanjiku/.test(n.title))).toBe(true);
    expect((await runKidsJobs(ctx)).escalated).toBe(0);
  });
  it('lets a teacher escalate by hand and call the guardians', async () => {
    expect((await take(JANE, 'Joy Wanjiku')).json().done).toHaveLength(1);
    expect((await drop(DAVID, ['Joy Wanjiku'])).statusCode).toBe(200);
    const joy = (await room()).children.find((c: any) => c.name === 'Joy Wanjiku' && c.status === 'in');
    const e = await call(LUCY, 'POST', `/kids/checkins/${joy.id}/escalate`, { note: 'Parents not answering' });
    expect(e.statusCode).toBe(200);
    expect((await call(LUCY, 'POST', `/kids/checkins/${joy.id}/escalate`, {})).json().code).toBe('already');
    const c = (await call(LUCY, 'GET', `/kids/checkins/${joy.id}/contacts`)).json();
    expect(c.guardians.map((g: any) => g.phone).sort()).toEqual(['0711000001', '0711000004']);
    expect((await take(DAVID, 'Joy Wanjiku')).json().done).toHaveLength(1);
    expect((await call(LUCY, 'POST', `/kids/sessions/${sess}/close`, {})).statusCode).toBe(200);
    expect((await call(LUCY, 'POST', `/kids/sessions/${sess}/scan`, { token: (await qr(JANE)).token })).statusCode).toBe(409);
  });
});

describe('the log and reports (L185)', () => {
  it('records who scanned, on what device, whose code, and every message', async () => {
    const log = (await call(OWNER, 'GET', '/kids/log')).json().log as any[];
    const ci = log.find((l) => l.action === 'check_in' && l.guardian === 'Jane Wanjiku');
    expect(ci).toMatchObject({ teacher: 'Lucy Wairimu', className: 'Sunday School', method: 'qr', result: 'ok' });
    expect(ci.teacherDevice).toContain('Lucy tablet');
    expect(ci.teacherDevice).toContain('Android, Chrome');
    expect(ci.guardianDevice).toContain('Jane phone');
    expect(log.some((l) => l.action === 'code_sent' && /0733 \*\*\* 011/.test(l.detail))).toBe(true);
    expect(log.some((l) => l.action === 'alert_sent' && /SMS sent/.test(l.detail))).toBe(true);
    expect(log.some((l) => l.action === 'escalated' && l.method === 'manual')).toBe(true);
    expect(log.some((l) => l.action === 'check_out' && l.result === 'refused')).toBe(true);
    expect(log.some((l) => l.action === 'scan' && l.result === 'expired')).toBe(true);
    expect(log.some((l) => l.action === 'contacts_shown')).toBe(true);
    const filtered = (await call(OWNER, 'GET', '/kids/log?action=check_in&q=Tom')).json().log;
    expect(filtered).toHaveLength(1);
    const csvText = (await call(OWNER, 'GET', '/kids/log?csv=1')).body;
    expect(csvText).toContain('Teacher device');
  });
  it('is not for teachers or other churches', async () => {
    expect((await call(LUCY, 'GET', '/kids/log')).statusCode).toBe(403);
    expect((await call(TREAS, 'GET', '/kids/log')).statusCode).toBe(403);
    expect((await call(HOPE, 'GET', '/kids/log')).json().log).toEqual([]);
  });
  it('also lands in the audit trail', async () => {
    const r = await ctx.db.query<any>(`SELECT action FROM audit_events WHERE action LIKE 'kids.%'`);
    const set = new Set(r.map((x) => x.action));
    for (const a of ['kids.check_in', 'kids.check_out', 'kids.escalated', 'kids.alert_sent', 'kids.code_sent']) expect(set.has(a)).toBe(true);
  });
  it('reports each session', async () => {
    const rep = (await call(OWNER, 'GET', '/kids/report')).json();
    expect(rep.sessions).toHaveLength(1);
    expect(rep.sessions[0]).toMatchObject({ className: 'Sunday School', stillIn: 0, status: 'closed' });
    expect(rep.sessions[0].checkedIn).toBe(5);
    expect(rep.sessions[0].late).toBeGreaterThanOrEqual(1);
    expect(rep.totals.escalated).toBeGreaterThanOrEqual(2);
    expect((await call(OWNER, 'GET', '/kids/report?csv=1')).body).toContain('Collected late');
  });
  it('keeps the books balanced', async () => {
    const rec = await call('0700000099', 'GET', '/admin/reconcile');
    expect(rec.json().ok).toBe(true);
  });
});

describe('the development SMS outbox', () => {
  it('shows pick-up codes with the number partly hidden', async () => {
    const rows = (await call('0700000099', 'GET', '/admin/sms-outbox')).json() as any[];
    const m = rows.find((r) => /Tom Kamau checked in/.test(r.body));
    expect(m.to_phone).toBe('0722 *** 010');
    expect(m.body).toMatch(/pick-up code \d{6}/);
    expect((await call(OWNER, 'GET', '/admin/sms-outbox')).statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('only at the branch (L188, L189)', () => {
  const AT = { lat: -1.2865, lng: 36.8173, acc: 20 };
  const FAR = { lat: -1.2, lng: 36.9, acc: 20 };
  let s2 = '';
  const guardianQr = async (who: string, geo?: any) => (await call(who, 'POST', '/me/family/qr', { membershipId: (await familyOf(who)).membershipId, device: 'Jane phone', geo })).json().token as string;
  const scanAt = async (token: string, geo?: any) => (await call(LUCY, 'POST', `/kids/sessions/${s2}/scan`, { token, device: 'Lucy tablet', geo })).json();
  const dropAt = (proof: string, ids: string[], geo?: any) => call(LUCY, 'POST', `/kids/sessions/${s2}/checkin`, { proof, childIds: ids, device: 'Lucy tablet', geo });
  const roomOf = async () => (await call(LUCY, 'GET', `/kids/sessions/${s2}`)).json();

  it('lets managers set where a branch is, and nobody else', async () => {
    expect((await call(LUCY, 'PUT', '/kids/branches/br_grc001/location', { lat: -1.2864, lng: 36.8172 })).statusCode).toBe(403);
    expect((await call(OWNER, 'PUT', '/kids/branches/br_grc001/location', { lat: 120, lng: 36 })).json().code).toBe('bad_location');
    expect((await call(OWNER, 'PUT', '/kids/branches/br_grc001/location', { lat: -1.2864, lng: 36.8172, radiusM: 10 })).json().code).toBe('bad_radius');
    expect((await call(HOPE, 'PUT', '/kids/branches/br_grc001/location', { lat: -1.2864, lng: 36.8172 })).statusCode).toBe(404);
    const ok = await call(OWNER, 'PUT', '/kids/branches/br_grc001/location', { lat: -1.2864, lng: 36.8172, radiusM: 300 });
    expect(ok.json().location).toEqual({ lat: -1.2864, lng: 36.8172, radiusM: 300 });
    const list = (await call(OWNER, 'GET', '/kids/classes')).json();
    expect(list.branches.find((b: any) => b.id === 'br_grc001').location.radiusM).toBe(300);
    s2 = (await call(LUCY, 'POST', `/kids/classes/${classId}/sessions`, { minutes: 60, device: 'Lucy tablet' })).json().id;
  });

  it('checks a child in when the teacher is at the branch', async () => {
    const sc = await scanAt(await guardianQr(JANE), AT);
    expect(sc.location).toMatchObject({ status: 'ok', source: 'teacher', branch: 'Grace Nairobi' });
    expect(JSON.stringify(sc.location)).not.toContain('36.81');
    expect((await dropAt(sc.proof, ['m_joy'], AT)).statusCode).toBe(200);
  });

  it('refuses when the teacher is away, and says how far', async () => {
    const sc = await scanAt(await guardianQr(JANE), FAR);
    expect(sc.location.status).toBe('away');
    expect(sc.location.message).toMatch(/km from Grace Nairobi\. Children can only be checked in at the branch/);
    const r = await dropAt(sc.proof, ['m_ruth'], FAR);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('away_from_branch');
    expect((await roomOf()).children.some((c: any) => c.name === 'Ruth Wanjiku')).toBe(false);
  });

  it('refuses when nobody can say where it is', async () => {
    const sc = await scanAt(await guardianQr(JANE));
    expect(sc.location.status).toBe('unknown');
    expect((await dropAt(sc.proof, ['m_ruth'])).json().code).toBe('location_needed');
    expect((await dropAt(sc.proof, ['m_ruth'], { ...AT, acc: 5000 })).json().code).toBe('location_needed');
  });

  it("uses the guardian's phone when the teacher's device gives no usable reading", async () => {
    const sc = await scanAt(await guardianQr(JANE, AT), { ...AT, acc: 5000 });
    expect(sc.location).toMatchObject({ status: 'ok', source: 'guardian' });
    expect((await dropAt(sc.proof, ['m_ruth'])).statusCode).toBe(200);
    const far = await scanAt(await guardianQr(DAVID, FAR));
    expect(far.location.status).toBe('away');
  });

  it('does not let a guardian reading override a teacher reading that is away', async () => {
    const sc = await scanAt(await guardianQr(JANE, AT), FAR);
    expect(sc.location.status).toBe('away');
  });

  it('tells the room screen where the device is', async () => {
    expect((await call(LUCY, 'POST', `/kids/sessions/${s2}/locate`, { geo: AT })).json().location.status).toBe('ok');
    expect((await call(LUCY, 'POST', `/kids/sessions/${s2}/locate`, { geo: { lat: 'x' } })).json().location.status).toBe('unknown');
    expect((await call(LUCY, 'POST', `/kids/sessions/${s2}/locate`, { geo: FAR })).json().location.status).toBe('away');
  });

  it('records a hand-over made away from the branch but never blocks it', async () => {
    const sc = await scanAt(await guardianQr(JANE), FAR);
    const r = await call(LUCY, 'POST', `/kids/sessions/${s2}/checkout`, { proof: sc.proof, checkinIds: sc.collect.map((c: any) => c.id), device: 'Lucy tablet', geo: FAR });
    expect(r.statusCode).toBe(200);
    expect(r.json().done).toHaveLength(2);
    expect(r.json().location.status).toBe('away');
  });

  it('puts the place in the log and keeps coordinates out of the audit trail', async () => {
    const log = (await call(OWNER, 'GET', `/kids/log?sessionId=${s2}`)).json().log as any[];
    const ok = log.find((l) => l.action === 'check_in' && l.result === 'ok' && l.locationSource === 'teacher');
    expect(ok).toMatchObject({ locationStatus: 'At the branch', locationSource: 'teacher' });
    expect(ok.teacherLocation).toBe('-1.2865, 36.8173 (within 20 m)');
    expect(log.find((l) => l.action === 'check_in' && l.result === 'refused' && /away/.test(l.detail))).toMatchObject({ locationStatus: 'Away from the branch' });
    expect(log.some((l) => l.action === 'check_in' && l.result === 'refused' && l.locationStatus === 'Location not shared')).toBe(true);
    expect(log.find((l) => l.action === 'check_in' && l.locationSource === 'guardian').guardianLocation).toBe('-1.2865, 36.8173 (within 20 m)');
    expect(log.find((l) => l.action === 'check_out')).toMatchObject({ locationStatus: 'Away from the branch' });
    expect((await call(OWNER, 'GET', '/kids/log?csv=1')).body).toContain('Metres from branch');
    const audit = await ctx.db.query<any>(`SELECT meta FROM audit_events WHERE action='kids.check_in'`);
    expect(audit.some((a) => a.meta?.location === 'away')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('36.8173');
  });

  it('stops checking once a manager removes the location', async () => {
    expect((await call(LUCY, 'POST', `/kids/sessions/${s2}/close`, {})).statusCode).toBe(200);
    expect((await call(OWNER, 'PUT', '/kids/branches/br_grc001/location', { clear: true })).json().location).toBeNull();
    s2 = (await call(LUCY, 'POST', `/kids/classes/${classId}/sessions`, { minutes: 60 })).json().id;
    const sc = await scanAt(await guardianQr(JANE));
    expect(sc.location.status).toBe('unchecked');
    expect((await dropAt(sc.proof, ['m_ruth'])).statusCode).toBe(200);
  });
});
