import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { seedKidsDemo } from './seed-kids';
import { addDays, dueAt, eatToday, isoWeekday, lastDayOfMonth, lastDayOfYear, weekStartOf } from './eat';
import { runAttendanceJobs } from './routes/attendance';

let app: Awaited<ReturnType<typeof buildApp>>['app'];
let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
const tokens: Record<string, string> = {};
async function login(phone: string) {
  if (tokens[phone]) return tokens[phone];
  const r = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: '123456' } });
  tokens[phone] = r.json().token;
  return tokens[phone];
}
const call = async (phone: string | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: any) =>
  app.inject({ method, url, payload, headers: phone ? { authorization: `Bearer ${await login(phone)}` } : {} });

const OWNER = '0700000001', ADMIN = '0700000003', LUCY = '0700000008', HOPE = '0700000005', PA1 = '0700000099';
const USHER = '0700000556';
const JANE = '0711000001', PETER = '0711000002', AMINA = '0711000003';
const MIN = 60_000, HOUR = 3600_000, DAY = 24 * HOUR;
const now = () => ctx.clock.now().getTime();
const smsTo = (phone: string) => ctx.messaging.sent.filter((m) => m.channel === 'sms' && m.to === phone);
const geoAt = { lat: -1.2865, lng: 36.8173, acc: 20 };
const geoFar = { lat: -1.2, lng: 36.9, acc: 20 };
const BR = 'br_grc001';

/** A one-off service that starts `startsInMin` minutes from now, so its check-in window is where the test needs it. */
async function special(name: string, startsInMin: number, extra: any = {}) {
  const r = await call(OWNER, 'POST', '/attendance/services', { branchId: BR, name, startsAt: new Date(now() + startsInMin * MIN).toISOString(), durationMin: 90, ...extra });
  expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
  return r.json().id as string;
}
const list = async (who = OWNER, q = '') => (await call(who, 'GET', `/attendance/services${q}`)).json().services as any[];
const svc = async (id: string, who = OWNER) => (await list(who, '?from=2020-01-01&to=2099-01-01')).find((s) => s.id === id);

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
  await seedKidsDemo(ctx);
  const t = ctx.clock.now().toISOString();
  await ctx.db.query(`INSERT INTO users (id, phone, name, created_at) VALUES ('u_usher','254700000556','Usher Peter',$1)`, [t]);
  await ctx.db.query(`INSERT INTO role_assignments (id, org_id, user_id, role_id, scope_type, scope_id) VALUES ('ra_usher','org_grace','u_usher','org_grace:Usher','branch','br_grc001')`);
}, 60000);

describe('the weekly schedule (L204)', () => {
  const today = () => eatToday(ctx.clock.now());
  const expected = (weekday: number, to: string, time: string, duration = 90) => {
    let n = 0;
    for (let d = today(); d <= to; d = addDays(d, 1)) if (isoWeekday(d) === weekday && Date.parse(dueAt(d, time)) + duration * MIN >= now()) n++;
    return n;
  };
  const create = (extra: any) => call(OWNER, 'POST', '/attendance/schedules', { branchId: BR, name: 'Sunday Service', weekdays: [7], startTime: '10:00', durationMin: 90, range: 'month', ...extra });

  it('is for people who manage services, in their own branches', async () => {
    expect((await call(LUCY, 'POST', '/attendance/schedules', { branchId: BR })).statusCode).toBe(403);
    expect((await call(USHER, 'POST', '/attendance/schedules', { branchId: BR })).statusCode).toBe(403);
    expect((await call(ADMIN, 'POST', '/attendance/schedules', { branchId: 'br_grc002', name: 'x', weekdays: [7], startTime: '10:00', range: 'week' })).statusCode).toBe(404);
    expect((await call(HOPE, 'GET', '/attendance/schedules')).json().schedules).toEqual([]);
  });

  it('refuses mistakes', async () => {
    expect((await create({ name: '' })).json().code).toBe('bad_content');
    expect((await create({ startTime: '25:00' })).json().code).toBe('bad_time');
    expect((await create({ weekdays: [] })).json().code).toBe('bad_day');
    expect((await create({ weekdays: [8] })).json().code).toBe('bad_day');
    expect((await create({ range: 'decade' })).json().code).toBe('bad_range');
    expect((await create({ range: 'until', until: '2001-01-01' })).json().code).toBe('bad_date');
    expect((await create({ streamUrl: 'http://youtube.com/x' })).json().code).toBe('bad_stream');
    expect((await create({ durationMin: 5 })).json().code).toBe('bad_duration');
    expect((await create({ opensBeforeMin: 999 })).json().code).toBe('bad_window');
  });

  it('creates the services for a week, a month or the rest of the year', async () => {
    const wk = await create({ name: 'Weekly check', weekdays: [isoWeekday(addDays(today(), 0))], startTime: '23:45', durationMin: 15, range: 'week' });
    expect(wk.json().generated).toBe(expected(isoWeekday(today()), addDays(weekStartOf(today()), 6), '23:45', 15));
    const mo = await create({ name: 'Monthly check', weekdays: [3], startTime: '18:00', range: 'month' });
    expect(mo.json().generated).toBe(expected(3, lastDayOfMonth(today()), '18:00'));
    const yr = await create({ name: 'Yearly check', weekdays: [5], startTime: '19:00', range: 'year' });
    expect(yr.json().generated).toBe(expected(5, lastDayOfYear(today()), '19:00'));
    const until = await create({ name: 'Until check', weekdays: [1, 2], startTime: '06:30', range: 'until', until: addDays(today(), 20) });
    expect(until.json().generated).toBe(expected(1, addDays(today(), 20), '06:30') + expected(2, addDays(today(), 20), '06:30'));
    expect(until.json().ids).toHaveLength(2);
  });

  it('sets up the real Sunday schedule, with the check-in window and a live link', async () => {
    const r = await create({ name: 'Sunday Service 10:30', startTime: '10:30', durationMin: 120, streamUrl: 'https://www.youtube.com/@gracechurch/live', opensBeforeMin: 20, closesAfterMin: 150 });
    expect(r.statusCode).toBe(200);
    const rows = (await list(OWNER, '?from=2020-01-01&to=2099-01-01')).filter((s) => s.name === 'Sunday Service 10:30');
    expect(rows.length).toBe(r.json().generated);
    if (rows.length) {
      const s = rows[0];
      expect(Date.parse(s.startsAt) - Date.parse(s.opensAt)).toBe(20 * MIN);
      expect(Date.parse(s.closesAt) - Date.parse(s.startsAt)).toBe(150 * MIN);
      expect(Date.parse(s.endsAt) - Date.parse(s.startsAt)).toBe(120 * MIN);
      expect(s.liveLink).toMatch(/\/live\/[A-Z0-9]{6}$/);
      expect(s.code).toMatch(/^[A-Z0-9]{6}$/);
    }
  });

  it('changes the time of every coming service, extends, and stops', async () => {
    const sch = (await call(OWNER, 'GET', '/attendance/schedules')).json().schedules.find((s: any) => s.name === 'Monthly check');
    const before = (await list(OWNER, '?from=2020-01-01&to=2099-01-01')).filter((s) => s.scheduleId === sch.id);
    const r = await call(OWNER, 'PATCH', `/attendance/schedules/${sch.id}`, { startTime: '17:15', applyToFuture: true });
    expect(r.json().updated).toBe(before.length);
    const after = (await list(OWNER, '?from=2020-01-01&to=2099-01-01')).filter((s) => s.scheduleId === sch.id);
    for (const s of after) expect(new Date(Date.parse(s.startsAt) + 3 * HOUR).toISOString().slice(11, 16)).toBe('17:15');
    expect((await call(OWNER, 'PATCH', `/attendance/schedules/${sch.id}`, { startTime: 'late' })).json().code).toBe('bad_time');
    const ext = await call(OWNER, 'POST', `/attendance/schedules/${sch.id}/extend`, { range: 'year' });
    expect(ext.statusCode).toBe(200);
    expect((await call(OWNER, 'POST', `/attendance/schedules/${sch.id}/extend`, { range: 'year' })).json().generated).toBe(0);
    const stop = await call(OWNER, 'POST', `/attendance/schedules/${sch.id}/stop`);
    expect(stop.json().cancelled).toBeGreaterThan(0);
    expect((await call(OWNER, 'POST', `/attendance/schedules/${sch.id}/extend`, { range: 'year' })).json().code).toBe('wrong_state');
    const gone = (await list(OWNER, '?from=2020-01-01&to=2099-01-01')).filter((s) => s.scheduleId === sch.id && s.status === 'scheduled');
    expect(gone).toHaveLength(0);
  });

  it('adds a special service, moves it, cancels it and brings it back', async () => {
    const id = await special('Easter vigil', 60 * 24 * 3);
    expect((await call(OWNER, 'PATCH', `/attendance/services/${id}`, { startsAt: new Date(now() + 4 * DAY).toISOString() })).statusCode).toBe(200);
    const moved = await svc(id);
    expect(Date.parse(moved.startsAt)).toBeCloseTo(now() + 4 * DAY, -4);
    expect(Date.parse(moved.startsAt) - Date.parse(moved.opensAt)).toBe(20 * MIN);
    expect((await call(OWNER, 'PATCH', `/attendance/services/${id}`, { status: 'cancelled' })).statusCode).toBe(200);
    expect((await svc(id)).status).toBe('cancelled');
    expect((await call(OWNER, 'PATCH', `/attendance/services/${id}`, { status: 'scheduled' })).statusCode).toBe(200);
    expect((await call(LUCY, 'PATCH', `/attendance/services/${id}`, { name: 'x' })).statusCode).toBe(404);
  });
});

describe('the reading and notices of the day (L211)', () => {
  it('lets anyone with the right enter it, and holds it back from members until the chosen time', async () => {
    const later = await special('Reading later', 60 * 24 * 3);
    const put = (id: string, release: string) => call(OWNER, 'PUT', `/attendance/services/${id}/reading`, { title: 'The Good Shepherd', ref: 'John 10:1-18', body: 'Notices: choir practice on Friday.', release });
    expect((await call(LUCY, 'PUT', `/attendance/services/${later}/reading`, { title: 'x' })).statusCode).toBe(404);
    expect((await put(later, 'whenever')).json().code).toBe('bad_release');
    expect((await call(OWNER, 'PUT', `/attendance/services/${later}/reading`, { release: 'now' })).json().code).toBe('bad_content');
    const r = await put(later, 'day_before');
    expect(Date.parse(r.json().publishAt)).toBeCloseTo(now() + 2 * DAY, -4);
    const mine = (await call(JANE, 'GET', '/me/services')).json().services.find((s: any) => s.id === later);
    expect(mine.reading).toMatchObject({ published: false, release: 'day_before' });
    expect(JSON.stringify(mine.reading)).not.toContain('Good Shepherd');
    expect((await svc(later)).reading).toMatchObject({ title: 'The Good Shepherd', published: false });

    const soon = await special('Reading soon', 60 * 5);
    await put(soon, 'minutes_20');
    expect((await call(JANE, 'GET', '/me/services')).json().services.find((s: any) => s.id === soon).reading.published).toBe(false);
    ctx.clock.advance(5 * HOUR - 19 * MIN);
    const seen = (await call(JANE, 'GET', '/me/services')).json().services.find((s: any) => s.id === soon).reading;
    expect(seen).toMatchObject({ published: true, title: 'The Good Shepherd', ref: 'John 10:1-18' });
    const now2 = await special('Reading now', 60 * 24 * 2);
    await put(now2, 'now');
    expect((await call(JANE, 'GET', '/me/services')).json().services.find((s: any) => s.id === now2).reading.published).toBe(true);
  });
});

describe('a member checks in (L206)', () => {
  let id = '';
  beforeAll(async () => { id = await special('Check-in service', 10); });

  it('is not open before the window and not for other churches', async () => {
    const far = await special('Far service', 60 * 5);
    expect((await call(JANE, 'POST', `/me/services/${far}/check-in`, {})).json().code).toBe('not_open');
    expect((await call(HOPE, 'POST', `/me/services/${id}/check-in`, {})).statusCode).toBe(404);
    expect((await call(null, 'POST', `/me/services/${id}/check-in`, {})).statusCode).toBe(401);
  });

  it('checks in once, and shows the reading after', async () => {
    await call(OWNER, 'PUT', `/attendance/services/${id}/reading`, { title: 'Psalm 23', release: 'minutes_20' });
    const r = await call(JANE, 'POST', `/me/services/${id}/check-in`, {});
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, already: false, mode: 'in_person', reading: { title: 'Psalm 23' } });
    expect((await call(JANE, 'POST', `/me/services/${id}/check-in`, {})).json().already).toBe(true);
    expect((await call(JANE, 'GET', '/me/services')).json().services.find((s: any) => s.id === id).mine.inPerson).toBe(true);
    expect((await svc(id)).counts).toMatchObject({ members: 1, visitors: 0, online: 0 });
  });

  it('must be at the church when the branch has a location, or watch online', async () => {
    expect((await call(OWNER, 'PUT', '/kids/branches/br_grc001/location', { lat: -1.2864, lng: 36.8172, radiusM: 300 })).statusCode).toBe(200);
    const far = (await call(PETER, 'POST', `/me/services/${id}/check-in`, { geo: geoFar })).json();
    expect(far.code).toBe('away_from_branch');
    expect(far.error).toMatch(/km from Grace Nairobi/);
    expect((await call(PETER, 'POST', `/me/services/${id}/check-in`, {})).json().code).toBe('location_needed');
    expect((await call(PETER, 'POST', `/me/services/${id}/check-in`, { mode: 'online' })).json()).toMatchObject({ ok: true, mode: 'online' });
    expect((await call(PETER, 'POST', `/me/services/${id}/check-in`, { geo: geoAt })).json()).toMatchObject({ ok: true, mode: 'in_person' });
    expect((await svc(id)).counts).toMatchObject({ members: 2, online: 1 });
    await call(OWNER, 'PUT', '/kids/branches/br_grc001/location', { clear: true });
  });

  it('keeps the window closed afterwards', async () => {
    const past = await special('Past service', -60 * 5);
    expect((await call(JANE, 'POST', `/me/services/${past}/check-in`, {})).json().code).toBe('closed');
    const cancelled = await special('Cancelled service', 5);
    await call(OWNER, 'PATCH', `/attendance/services/${cancelled}`, { status: 'cancelled' });
    expect((await call(JANE, 'POST', `/me/services/${cancelled}/check-in`, {})).json().code).toBe('cancelled');
  });
});

describe('ushers at the door (L207)', () => {
  let id = '';
  beforeAll(async () => { id = await special('Usher service', 15); });
  const code = async (who: string) => (await call(who, 'POST', '/me/attendance/qr', {})).json();

  it('scans a member code, once', async () => {
    const q = await code(AMINA);
    expect(q.token.startsWith('A1.')).toBe(true);
    expect(q.qrSvg).toContain('<svg');
    // Amina belongs to the other branch, but the same church: she is welcome at any service.
    const r = await call(USHER, 'POST', `/attendance/services/${id}/scan`, { token: q.token });
    expect(r.json()).toMatchObject({ result: 'ok', name: 'Amina Hassan' });
    expect((await call(USHER, 'POST', `/attendance/services/${id}/scan`, { token: (await code(AMINA)).token })).json().result).toBe('already');
    expect((await call(USHER, 'POST', `/attendance/services/${id}/scan`, { token: 'hello' })).json().result).toBe('invalid');
    const t = (await code(PETER)).token;
    expect((await call(USHER, 'POST', `/attendance/services/${id}/scan`, { token: t.slice(0, -3) + 'zzz' })).json().result).toBe('invalid');
    ctx.clock.advance(MIN);
    expect((await call(USHER, 'POST', `/attendance/services/${id}/scan`, { token: t })).json().result).toBe('expired');
  });

  it('is only for people with the usher right', async () => {
    expect((await call(LUCY, 'GET', '/attendance/open')).statusCode).toBe(403);
    expect((await call(JANE, 'GET', '/attendance/open')).statusCode).toBe(403);
    expect((await call(LUCY, 'POST', `/attendance/services/${id}/scan`, { token: 'x' })).statusCode).toBe(404);
    const open = (await call(USHER, 'GET', '/attendance/open')).json().services;
    expect(open.map((s: any) => s.id)).toContain(id);
  });

  it('finds a member by name and marks them present', async () => {
    expect((await call(USHER, 'GET', `/attendance/services/${id}/members?q=J`)).json().members).toEqual([]);
    const found = (await call(USHER, 'GET', `/attendance/services/${id}/members?q=Wanjiku`)).json().members;
    expect(found.map((m: any) => m.name)).toContain('Jane Wanjiku');
    expect(found.every((m: any) => !m.name.includes('Ruth'))).toBe(true);
    const jane = found.find((m: any) => m.name === 'Jane Wanjiku');
    expect((await call(USHER, 'POST', `/attendance/services/${id}/mark`, { membershipId: jane.id })).json().result).toBe('ok');
    expect((await call(USHER, 'POST', `/attendance/services/${id}/mark`, { membershipId: jane.id })).json().result).toBe('already');
    expect((await call(USHER, 'POST', `/attendance/services/${id}/mark`, { membershipId: 'nobody' })).statusCode).toBe(404);
    expect((await call(USHER, 'GET', `/attendance/services/${id}/members?q=Wanjiku`)).json().members.find((m: any) => m.name === 'Jane Wanjiku').here).toBe(true);
  });

  it('types the headcount and the online peak', async () => {
    expect((await call(JANE, 'PUT', `/attendance/services/${id}/headcount`, { adults: 1 })).statusCode).toBe(404);
    expect((await call(USHER, 'PUT', `/attendance/services/${id}/headcount`, { adults: -1 })).json().code).toBe('bad_number');
    const r = await call(USHER, 'PUT', `/attendance/services/${id}/headcount`, { adults: 120, children: 40, visitors: 9 });
    expect(r.json().total).toBe(169);
    expect((await svc(id)).headcount).toMatchObject({ adults: 120, children: 40, visitors: 9, total: 169 });
    expect((await call(USHER, 'PUT', `/attendance/services/${id}/online`, { peak: 340 })).statusCode).toBe(200);
    expect((await svc(id)).onlinePeak).toBe(340);
    const live = (await call(USHER, 'GET', `/attendance/services/${id}/live`)).json();
    expect(live.service.counts.members).toBe(2);
    expect(live.recent).toHaveLength(2);
    expect((await svc(id)).coverage).toBe(Math.round((2 / 169) * 100));
  });
});

describe('visitors and the welcome SMS (L209, L210)', () => {
  let id = '';
  beforeAll(async () => { id = await special('Visitor service', 15); });
  const add = (body: any, who = USHER, sid = id) => call(who, 'POST', `/attendance/services/${sid}/visitor`, body);

  it('needs a name and a real phone number', async () => {
    expect((await add({ name: 'A', phone: '0712345678' })).json().code).toBe('bad_name');
    expect((await add({ name: 'Visitor One', phone: '12345' })).json().code).toBe('bad_phone');
  });

  it('records a first-time visitor and welcomes them by SMS, once', async () => {
    ctx.messaging.clear();
    const r = await add({ name: 'Mercy Achieng', phone: '0712 345 678' });
    expect(r.json()).toMatchObject({ kind: 'visitor', first: true, returning: false });
    expect(smsTo('254712345678')).toHaveLength(1);
    expect(smsTo('254712345678')[0].body).toMatch(/^Hello Mercy, welcome to Grace Community Church!.*Visitor service/);
    expect((await add({ name: 'Mercy Achieng', phone: '0712345678' })).json()).toMatchObject({ already: true });
    expect(smsTo('254712345678')).toHaveLength(1);
    const v = (await call(OWNER, 'GET', '/attendance/visitors')).json();
    expect(v.visitors.find((x: any) => x.name === 'Mercy Achieng')).toMatchObject({ status: 'new', visits: 1, welcome: 'sent', phone: '0712345678', branch: 'Grace Nairobi' });
    expect(v.summary.new).toBe(1);
  });

  it('counts a phone number that belongs to a member as that member', async () => {
    const r = await add({ name: 'Someone', phone: '0711000002' });
    expect(r.json()).toMatchObject({ kind: 'member', name: 'Peter Otieno', first: false });
    expect((await call(OWNER, 'GET', '/attendance/visitors')).json().visitors.some((x: any) => x.phone === '0711000002')).toBe(false);
  });

  it('is a returning visitor the next time, with no second welcome', async () => {
    const second = await special('Second visit', 15);
    ctx.messaging.clear();
    expect((await add({ name: 'Mercy Achieng', phone: '0712345678' }, USHER, second)).json()).toMatchObject({ first: false, returning: true });
    expect(smsTo('254712345678')).toHaveLength(0);
    const v = (await call(OWNER, 'GET', '/attendance/visitors')).json().visitors.find((x: any) => x.name === 'Mercy Achieng');
    expect(v).toMatchObject({ status: 'returning', visits: 2 });
  });

  it('uses the church template, and can be switched off', async () => {
    expect((await call(OWNER, 'PUT', '/attendance/settings', { welcomeEnabled: true, welcomeTemplate: 'short' })).json().code).toBe('bad_template');
    expect((await call(LUCY, 'PUT', '/attendance/settings', { welcomeEnabled: false })).statusCode).toBe(403);
    expect((await call(OWNER, 'PUT', '/attendance/settings', { welcomeEnabled: true, welcomeTemplate: 'Karibu {name} to {church}, {branch}! See you again at {service}.' })).statusCode).toBe(200);
    const s = (await call(OWNER, 'GET', '/attendance/settings')).json();
    expect(s.preview).toBe('Karibu Peter to Grace Community Church, Main branch! See you again at Sunday Service.');
    ctx.messaging.clear();
    await add({ name: 'Brian Koech', phone: '0733 111 222' });
    expect(smsTo('254733111222')[0].body).toBe('Karibu Brian to Grace Community Church, Grace Nairobi! See you again at Visitor service.');
    await call(OWNER, 'PUT', '/attendance/settings', { welcomeEnabled: false });
    ctx.messaging.clear();
    await add({ name: 'Cate Wairimu', phone: '0733 444 555' });
    expect(smsTo('254733444555')).toHaveLength(0);
    expect((await call(OWNER, 'GET', '/attendance/visitors?q=Cate')).json().visitors[0].welcome).toBe('off');
    await call(OWNER, 'PUT', '/attendance/settings', { welcomeEnabled: true, welcomeTemplate: s.defaultTemplate });
  });

  it('keeps a follow-up list the pastor can work through', async () => {
    const v = (await call(OWNER, 'GET', '/attendance/visitors?status=new')).json().visitors.find((x: any) => x.name === 'Brian Koech');
    expect((await call(LUCY, 'POST', `/attendance/visitors/${v.id}`, { status: 'contacted' })).statusCode).toBe(404);
    expect((await call(OWNER, 'POST', `/attendance/visitors/${v.id}`, { status: 'member' })).json().code).toBe('bad_status');
    expect((await call(OWNER, 'POST', `/attendance/visitors/${v.id}`, { status: 'contacted', note: 'Called, will come on Sunday' })).statusCode).toBe(200);
    const after = (await call(OWNER, 'GET', '/attendance/visitors?q=Koech')).json().visitors[0];
    expect(after).toMatchObject({ status: 'contacted', contactedBy: 'Daniel Mwangi', note: 'Called, will come on Sunday' });
    expect((await call(OWNER, 'GET', '/attendance/visitors?csv=1')).body).toContain('Welcome SMS');
    expect((await call(HOPE, 'GET', '/attendance/visitors')).json().visitors).toEqual([]);
    expect((await call(USHER, 'GET', '/attendance/visitors')).statusCode).toBe(403);
  });

  it('shows a visitor as a member once they join', async () => {
    await ctx.db.query(`INSERT INTO memberships (id, org_id, branch_id, user_id, full_name, phone, member_number, category, joined_at) VALUES ('m_mercy','org_grace','br_grc001',NULL,'Mercy Achieng','254712345678','M00777','adult',$1)`, [ctx.clock.now().toISOString()]);
    const v = (await call(OWNER, 'GET', '/attendance/visitors?q=Mercy')).json().visitors[0];
    expect(v.status).toBe('member');
  });
});

describe('the door code and the invitation (L208, L212)', () => {
  let id = '';
  beforeAll(async () => { id = await special('Door service', 15, { streamUrl: 'https://www.youtube.com/watch?v=abc123' }); });
  const doorToken = async () => ((await call(USHER, 'GET', `/attendance/services/${id}/door`)).json().url as string).split('/here/')[1];

  it('shows a door code that only ushers can ask for', async () => {
    expect((await call(JANE, 'GET', `/attendance/services/${id}/door`)).statusCode).toBe(404);
    const d = (await call(USHER, 'GET', `/attendance/services/${id}/door`)).json();
    expect(d.url).toContain('/here/D1.');
    expect(d.qrSvg).toContain('<svg');
    expect(d.refreshSeconds).toBe(45);
  });

  it('lets a visitor check in from the code, and counts a member who does the same', async () => {
    const t = await doorToken();
    const info = (await call(null, 'GET', `/public/here/${t}`)).json();
    expect(info).toMatchObject({ name: 'Door service', church: 'Grace Community Church', state: 'open', hasStream: true });
    expect((await call(null, 'POST', `/public/here/${t}`, { name: 'Z', phone: '0722000111' })).json().code).toBe('bad_name');
    expect((await call(null, 'POST', `/public/here/${t}`, { name: 'Zack Otieno', phone: '07' })).json().code).toBe('bad_phone');
    const r = await call(null, 'POST', `/public/here/${t}`, { name: 'Zack Otieno', phone: '0722 000 111' });
    expect(r.json()).toMatchObject({ status: 'recorded', kind: 'visitor', name: 'Zack', first: true });
    expect((await call(null, 'POST', `/public/here/${t}`, { name: 'Zack Otieno', phone: '0722000111' })).json().status).toBe('already');
    expect((await call(null, 'POST', `/public/here/${t}`, { name: 'Jane', phone: '0711000001' })).json()).toMatchObject({ kind: 'member', name: 'Jane' });
    expect((await svc(id)).counts).toMatchObject({ members: 1, visitors: 1 });
  });

  it('refuses an invalid or old code', async () => {
    expect((await call(null, 'GET', '/public/here/D1.nonsense')).statusCode).toBe(404);
    expect((await call(null, 'POST', '/public/here/hello', { name: 'Zack', phone: '0722000111' })).statusCode).toBe(404);
    const t = await doorToken();
    ctx.clock.advance(6 * MIN);
    const old = await call(null, 'POST', `/public/here/${t}`, { name: 'Late Larry', phone: '0722000222' });
    expect(old.statusCode).toBe(410);
    expect(old.json().code).toBe('expired');
  });

  it('is closed outside the window', async () => {
    const far = await special('Next week', 60 * 24 * 5);
    const t = ((await call(USHER, 'GET', `/attendance/services/${far}/door`)).json().url as string).split('/here/')[1];
    expect((await call(null, 'POST', `/public/here/${t}`, { name: 'Early Eric', phone: '0722000333' })).json().code).toBe('not_open');
  });

  it('records who invited a visitor', async () => {
    const inv = (await call(JANE, 'GET', `/me/services/${id}/invite`)).json();
    expect(inv.link).toContain('/here/I1.');
    expect(inv.liveLink).toContain('/live/');
    expect(inv.qrSvg).toContain('<svg');
    expect(inv.invited).toBe(0);
    const t = inv.link.split('/here/')[1];
    expect((await call(null, 'GET', `/public/here/${t}`)).json().invitedBy).toBe('Jane');
    const r = await call(null, 'POST', `/public/here/${t}`, { name: 'Faith Mutua', phone: '0744 123 456' });
    expect(r.json()).toMatchObject({ status: 'recorded', first: true });
    const v = (await call(OWNER, 'GET', '/attendance/visitors?q=Faith')).json().visitors[0];
    expect(v.invitedBy).toBe('Jane Wanjiku');
    expect((await call(JANE, 'GET', `/me/services/${id}/invite`)).json().invited).toBe(1);
    expect((await call(JANE, 'GET', '/me/attendance')).json().invited).toBe(1);
    expect((await call(HOPE, 'GET', `/me/services/${id}/invite`)).statusCode).toBe(404);
  });
});

describe('the live link (L213)', () => {
  let id = '';
  let code = '';
  beforeAll(async () => { id = await special('Live service', 10, { streamUrl: 'https://www.youtube.com/watch?v=live123' }); code = (await svc(id)).code; });

  it('shows the service and sends a named viewer to the stream, counting them online', async () => {
    const info = (await call(null, 'GET', `/public/live/${code}`)).json();
    expect(info).toMatchObject({ name: 'Live service', live: true, hasStream: true });
    expect((await call(null, 'POST', `/public/live/${code}`, { name: 'Viewer', phone: '1' })).json().code).toBe('bad_phone');
    const r = await call(null, 'POST', `/public/live/${code}`, { name: 'Wanjiru Kamau', phone: '0755 000 111' });
    expect(r.json()).toMatchObject({ url: 'https://www.youtube.com/watch?v=live123', counted: true, first: true, name: 'Wanjiru' });
    expect((await call(null, 'POST', `/public/live/${code}`, { name: 'Wanjiru Kamau', phone: '0755000111' })).json()).toMatchObject({ counted: false });
    const s = await svc(id);
    expect(s.counts.online).toBe(1);
    expect((await call(OWNER, 'GET', '/attendance/visitors?q=Wanjiru')).json().visitors[0]).toMatchObject({ welcome: 'sent' });
  });

  it('counts a member who opens it, and a signed-in member who taps Watch live', async () => {
    expect((await call(null, 'POST', `/public/live/${code}`, { name: 'Peter', phone: '0711000002' })).json().counted).toBe(true);
    const w = await call(JANE, 'POST', `/me/services/${id}/watch`, {});
    expect(w.json().url).toBe('https://www.youtube.com/watch?v=live123');
    const s = await svc(id);
    expect(s.counts.online).toBe(3);
    const mine = (await call(JANE, 'GET', '/me/services')).json().services.find((x: any) => x.id === id);
    expect(mine.mine.online).toBe(true);
    expect(mine.branchLiveLink).toContain('/live/b-GRC001');
  });

  it('credits the member who shared it', async () => {
    const inv = (await call(JANE, 'GET', `/me/services/${id}/invite`)).json();
    const ref = decodeURIComponent(inv.liveLink.split('ref=')[1]);
    const r = await call(null, 'POST', `/public/live/${code}`, { name: 'Esther Njoroge', phone: '0766 222 333', ref });
    expect(r.json().counted).toBe(true);
    expect((await call(OWNER, 'GET', '/attendance/visitors?q=Njoroge')).json().visitors[0].invitedBy).toBe('Jane Wanjiku');
  });

  it('has a link for the church that always finds the current or next service', async () => {
    const b = (await call(null, 'GET', '/public/live/b-GRC001')).json();
    expect(b.hasStream).toBe(true);
    expect((await call(null, 'GET', '/public/live/b-NOPE99')).statusCode).toBe(404);
    expect((await call(null, 'GET', '/public/live/ZZZZZZ')).statusCode).toBe(404);
  });

  it('still sends people to the stream outside the service, without counting them', async () => {
    const early = await special('Live later', 60 * 24 * 2, { streamUrl: 'https://www.youtube.com/watch?v=later' });
    const c = (await svc(early)).code;
    const r = await call(null, 'POST', `/public/live/${c}`, { name: 'Early Bird', phone: '0777 000 999' });
    expect(r.json()).toMatchObject({ url: 'https://www.youtube.com/watch?v=later', counted: false });
    expect((await svc(early)).counts.online).toBe(0);
    const none = await special('No stream', 10);
    expect((await call(null, 'POST', `/public/live/${(await svc(none)).code}`, { name: 'No Stream', phone: '0777 000 998' })).json().code).toBe('no_stream');
    expect((await call(JANE, 'POST', `/me/services/${none}/watch`, {})).json().code).toBe('no_stream');
  });
});

describe('who stopped coming, and the Monday report (L214, L215)', () => {
  const today = () => eatToday(ctx.clock.now());
  const thisMonday = () => weekStartOf(today());
  let weekSvc = '';

  beforeAll(async () => {
    const t = ctx.clock.now().toISOString();
    // A regular who came in four earlier weeks and not since, and one who is still coming.
    for (const [mid, name, num] of [['m_lapsed', 'Lapsed Larry', 'M00801'], ['m_steady', 'Steady Sue', 'M00802']]) {
      await ctx.db.query(`INSERT INTO memberships (id, org_id, branch_id, user_id, full_name, phone, member_number, category, joined_at) VALUES ($1,'org_grace','br_grc001',NULL,$2,NULL,$3,'adult',$4)`, [mid, name, num, t]);
    }
    let n = 0;
    const mk = async (weeksAgo: number, who: string[]) => {
      const date = addDays(thisMonday(), -7 * weeksAgo + 6);
      const startsAt = dueAt(date, '10:00');
      const id = `svc_hist_${weeksAgo}`;
      await ctx.db.query(`INSERT INTO services (id, org_id, branch_id, schedule_id, code, name, starts_at, ends_at, opens_at, closes_at, created_by, created_at, updated_at) VALUES ($1,'org_grace','br_grc001',NULL,$2,'Sunday Service',$3,$3,$3,$3,'u_owner',$4,$4)`, [id, `H${String(weeksAgo).padStart(5, '0')}`, startsAt, t]);
      for (const m of who) await ctx.db.query(`INSERT INTO attendance (id, org_id, branch_id, service_id, kind, membership_id, name, mode, via, at) VALUES ($1,'org_grace','br_grc001',$2,'member',$3,$3,'in_person','usher',$4)`, [`att_h_${++n}`, id, m, startsAt]);
      return id;
    };
    for (const w of [8, 7, 6, 5, 4, 3]) await mk(w, w >= 4 ? ['m_lapsed', 'm_steady'] : ['m_steady']);
    weekSvc = await mk(1, ['m_steady', 'm_jane']);
  });

  it('lists regular members who have not come for three weeks', async () => {
    const care = (await call(OWNER, 'GET', '/attendance/care')).json();
    expect(care.members.map((m: any) => m.name)).toEqual(['Lapsed Larry']);
    expect(care.members[0]).toMatchObject({ memberNumber: 'M00801', branch: 'Grace Nairobi' });
    expect((await call(USHER, 'GET', '/attendance/care')).statusCode).toBe(403);
    expect((await call(HOPE, 'GET', '/attendance/care')).json().members).toEqual([]);
  });

  it('adds up the weeks', async () => {
    const s = (await call(OWNER, 'GET', '/attendance/summary?weeks=8')).json();
    expect(s.weeks).toHaveLength(8);
    expect(s.weeks[s.weeks.length - 2]).toMatchObject({ weekStart: addDays(thisMonday(), -7) });
    expect(s.lastWeek.weekStart).toBe(addDays(thisMonday(), -7));
    expect(s.lastWeek.totals.members).toBe(2);
    expect(s.lastWeek.previous.members).toBe(0);
    expect((await call(OWNER, 'GET', '/attendance/summary?branchId=br_grc002')).json().lastWeek.totals.members).toBe(0);
    expect((await call(OWNER, 'GET', '/attendance/summary?branchId=br_hpc001')).statusCode).toBe(404);
  });

  it('emails the week that passed on Monday at 7:00, to the people who can see attendance', async () => {
    // The week that just passed is the current one, so put a service, a visitor and a headcount in it.
    const monday = thisMonday();
    const t = dueAt(addDays(monday, 2), '18:00');
    await ctx.db.query(`UPDATE services SET headcount_adults=3, headcount_children=0, headcount_visitors=0, online_peak=55 WHERE id=$1`, [weekSvc]);
    const mid = 'svc_this_week';
    await ctx.db.query(`INSERT INTO services (id, org_id, branch_id, schedule_id, code, name, starts_at, ends_at, opens_at, closes_at, created_by, created_at, updated_at) VALUES ($1,'org_grace','br_grc001',NULL,'THISWK',$2,$3,$3,$3,$3,'u_owner',$3,$3)`, [mid, 'Midweek Prayer', t]);
    await ctx.db.query(`INSERT INTO visitors (id, org_id, branch_id, name, phone, first_service_id, first_seen_at, last_seen_at, visits, created_at) VALUES ('vis_wk','org_grace','br_grc001','Grace Visitor','254799000111',$1,$2,$2,1,$2)`, [mid, t]);
    await ctx.db.query(`INSERT INTO attendance (id, org_id, branch_id, service_id, kind, visitor_id, name, mode, via, at) VALUES ('att_wk1','org_grace','br_grc001',$1,'visitor','vis_wk','Grace Visitor','in_person','door',$2)`, [mid, t]);
    await ctx.db.query(`INSERT INTO attendance (id, org_id, branch_id, service_id, kind, membership_id, name, mode, via, at) VALUES ('att_wk2','org_grace','br_grc001',$1,'member','m_steady','Steady Sue','in_person','usher',$2)`, [mid, t]);
    await ctx.db.query(`INSERT INTO events (id, org_id, branch_id, title, starts_at, audience, rsvp, status, created_by, created_at, updated_at) VALUES ('evt_wk','org_grace',NULL,'Choir social',$1,'{"type":"org"}',true,'scheduled','u_owner',$1,$1)`, [dueAt(addDays(monday, 4), '17:00')]);
    // Samuel switches the email off.
    expect((await call(ADMIN, 'PUT', '/attendance/prefs', { weeklyEmail: false })).json().weeklyEmail).toBe(false);
    expect((await call(LUCY, 'GET', '/attendance/prefs')).statusCode).toBe(403);

    ctx.clock.advance(Date.parse(dueAt(addDays(monday, 7), '06:30')) - now());
    ctx.email.sent.length = 0;
    expect((await runAttendanceJobs(ctx)).sent).toBe(0); // not yet 7:00 on Monday
    ctx.clock.advance(40 * MIN);
    const r = await runAttendanceJobs(ctx);
    expect(r.sent).toBe(1);
    const mail = ctx.email.sent.find((m) => m.to === 'daniel@gracechurch.org')!;
    expect(mail.subject).toMatch(/^Grace Community Church attendance, /);
    expect(mail.body).toContain('all branches');
    expect(mail.body).toMatch(/First-time visitors: \d+/);
    expect(mail.body).toContain('Mercy Achieng');
    expect(mail.body).toContain('Midweek Prayer');
    expect(mail.body).toContain('Grace Visitor');
    expect(mail.body).toContain('Choir social');
    expect(mail.body).toContain('By branch:');
    expect(mail.html).toContain('<table');
    expect(ctx.email.sent.some((m) => m.to === 'samuel@gracechurch.org')).toBe(false);
    expect((await runAttendanceJobs(ctx)).sent).toBe(0); // once a week
  });

  it('can be sent to yourself on request, and keeps the books balanced', async () => {
    expect((await call(OWNER, 'POST', '/attendance/report/send-now', {})).json().sent).toBe(true);
    expect((await call(PA1, 'GET', '/admin/reconcile')).json().ok).toBe(true);
  });
});
