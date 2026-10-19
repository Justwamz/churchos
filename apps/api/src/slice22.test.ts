import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { seedKidsDemo } from './seed-kids';
import { addDays, eatToday } from './eat';
import { labelReadings } from './routes/lectionary';

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

const OWNER = '0700000001', ADMIN = '0700000003', LUCY = '0700000008', HOPE = '0700000005', PA1 = '0700000099', AUDITOR = '0700000007';
const JANE = '0711000001', PETER = '0711000002', AMINA = '0711000003';
const MIN = 60_000, HOUR = 3600_000, DAY = 24 * HOUR;
const now = () => ctx.clock.now().getTime();
const geoAt = { lat: -1.2865, lng: 36.8173, acc: 20 };
const geoFar = { lat: -1.2, lng: 36.9, acc: 20 };
const BR = 'br_grc001';
const eatDay = (ms: number) => new Date(ms + 3 * HOUR).toISOString().slice(0, 10);

async function special(name: string, startsInMin: number, extra: any = {}) {
  const r = await call(OWNER, 'POST', '/attendance/services', { branchId: BR, name, startsAt: new Date(now() + startsInMin * MIN).toISOString(), durationMin: 90, ...extra });
  expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
  return { id: r.json().id as string, date: eatDay(now() + startsInMin * MIN) };
}

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
  await seedKidsDemo(ctx);
}, 60000);

describe('the lectionary, entered by the church (L250 to L252)', () => {
  it('labels references by what they are', () => {
    expect(labelReadings(['Isaiah 43:16-21', 'Psalm 126', 'Philippians 3:4b-14', 'John 12:1-8'])).toEqual([
      { label: 'First reading', ref: 'Isaiah 43:16-21' }, { label: 'Psalm', ref: 'Psalm 126' }, { label: 'Second reading', ref: 'Philippians 3:4b-14' }, { label: 'Gospel', ref: 'John 12:1-8' },
    ]);
    expect(labelReadings(['Luke 4:1-13']).map((r) => r.label)).toEqual(['Gospel']);
  });

  it('is for people who manage attendance', async () => {
    expect((await call(OWNER, 'GET', '/lectionary')).json().canManage).toBe(true);
    expect((await call(AUDITOR, 'GET', '/lectionary')).statusCode).toBe(403);
    expect((await call(LUCY, 'GET', '/lectionary')).statusCode).toBe(403);
    expect((await call(AUDITOR, 'PUT', '/lectionary/2026-11-29', { title: 'x', readings: ['John 1:1'] })).statusCode).toBe(403);
    expect((await call(JANE, 'GET', '/lectionary')).statusCode).toBe(403);
  });

  it('saves a day with references, and refuses what is not a reference', async () => {
    const put = (date: string, body: any) => call(OWNER, 'PUT', `/lectionary/${date}`, body);
    expect((await put('2026-13-40', { title: 'Bad day', readings: ['John 1:1'] })).json().code).toBe('bad_date');
    expect((await put('2026-11-29', { title: 'x', readings: ['John 1:1'] })).json().code).toBe('bad_content');
    expect((await put('2026-11-29', { title: 'First Sunday of Advent', readings: [] })).json().code).toBe('bad_content');
    expect((await put('2026-11-29', { title: 'First Sunday of Advent', readings: ['<script>alert(1)</script>'] })).json().code).toBe('bad_reference');
    expect((await put('2026-11-29', { title: 'First Sunday of Advent', readings: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => `Psalm ${x}1`) })).json().code).toBe('too_many_readings');
    expect((await put('2026-11-29', { title: 'First Sunday of Advent', cycle: 'D', readings: ['Isaiah 2:1-5'] })).json().code).toBe('bad_cycle');
    expect((await put('2026-11-29', { title: 'First Sunday of Advent', season: 'Summer', readings: ['Isaiah 2:1-5'] })).json().code).toBe('bad_season');
    const ok = await put('2026-11-29', { title: 'First Sunday of Advent', season: 'Advent', cycle: 'A', colour: 'purple', readings: ['Isaiah 2:1-5', 'Psalm 122', 'Romans 13:11-14', 'Matthew 24:36-44'], note: 'Light the first candle' });
    expect(ok.json().created).toBe(true);
    const day = (await call(OWNER, 'GET', '/lectionary?from=2026-11-01&to=2026-12-31')).json().days.find((d: any) => d.date === '2026-11-29');
    expect(day).toMatchObject({ title: 'First Sunday of Advent', cycle: 'A', season: 'Advent', colour: 'purple' });
    expect(day.readings.map((r: any) => r.label)).toEqual(['First reading', 'Psalm', 'Second reading', 'Gospel']);
    expect((await put('2026-11-29', { title: 'First Sunday of Advent (Year A)', readings: ['Isaiah 2:1-5'] })).json().created).toBe(false);
  });

  it('takes a pasted list, saves the good lines and reports the bad ones', async () => {
    const text = [
      '# Lent',
      '2027-02-14 | First Sunday of Lent | C | Deuteronomy 26:1-11; Psalm 91:1-2, 9-16; Romans 10:8b-13; Luke 4:1-13',
      '2027-02-21 | Second Sunday of Lent | C | Genesis 15:1-12, 17-18; Psalm 27; Philippians 3:17-4:1; Luke 13:31-35',
      '2027-02-28 | Third Sunday of Lent | Isaiah 55:1-9; Psalm 63:1-8; 1 Corinthians 10:1-13; Luke 13:1-9',
      'not a line',
      '2027-03-07 | | C | John 1:1',
      '2027-03-07 | Fourth Sunday of Lent | C | <b>bold</b>',
    ].join('\n');
    const r = (await call(OWNER, 'POST', '/lectionary/import', { text })).json();
    expect(r).toMatchObject({ added: 3, changed: 0 });
    expect(r.errors.map((e: any) => e.line)).toEqual([4, 5, 6]);
    const again = (await call(OWNER, 'POST', '/lectionary/import', { text: '2027-02-14 | First Sunday of Lent (Year C) | C | Deuteronomy 26:1-11; Luke 4:1-13' })).json();
    expect(again).toMatchObject({ added: 0, changed: 1, errors: [] });
    expect((await call(OWNER, 'POST', '/lectionary/import', { text: '   ' })).json().code).toBe('bad_content');
  });

  it('is private to the church and removable, with every change in the audit log', async () => {
    expect((await call(HOPE, 'GET', '/lectionary?from=2026-11-01&to=2027-03-31')).json().days).toEqual([]);
    expect((await call(OWNER, 'POST', '/lectionary/2027-02-28/remove', {})).statusCode).toBe(200);
    expect((await call(OWNER, 'POST', '/lectionary/2027-02-28/remove', {})).statusCode).toBe(404);
    expect((await call(OWNER, 'GET', '/lectionary?from=2027-02-01&to=2027-03-31')).json().days.map((d: any) => d.date)).toEqual(['2027-02-14', '2027-02-21']);
    for (const a of ['lectionary.set', 'lectionary.import', 'lectionary.removed']) expect((await call(PA1, 'GET', `/admin/audit/events?action=${a}`)).json().events.length, a).toBeGreaterThan(0);
  });
});

describe('a member opens the reading only by checking in (L253, L254)', () => {
  let svcId = '';
  let svcDate = '';
  beforeAll(async () => {
    const s = await special('Reading Sunday', 10);
    svcId = s.id;
    svcDate = s.date;
    await call(OWNER, 'PUT', `/lectionary/${svcDate}`, { title: 'Reading day', season: 'Ordinary Time', cycle: 'B', colour: 'green', readings: ['Isaiah 6:1-8', 'Psalm 138', 'John 3:1-17'] });
    await call(OWNER, 'PUT', `/attendance/services/${svcId}/reading`, { title: 'Born again', ref: 'John 3:1-17', body: 'Notices: youth camp next month.', release: 'now' });
  });

  it('shows that a reading is waiting, not what it is, before check-in', async () => {
    const s = (await call(JANE, 'GET', '/me/services')).json().services.find((x: any) => x.id === svcId);
    expect(s.reading).toMatchObject({ published: true, locked: true });
    expect(JSON.stringify(s.reading)).not.toMatch(/Isaiah|Born again|youth camp/);
    const r = await call(JANE, 'GET', `/me/services/${svcId}/reading`);
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('check_in_first');
    expect((await call(HOPE, 'GET', `/me/services/${svcId}/reading`)).statusCode).toBe(404);
    // staff see it all
    const staff = (await call(OWNER, 'GET', '/attendance/services?from=2020-01-01&to=2099-01-01')).json().services.find((x: any) => x.id === svcId);
    expect(staff.reading.lectionary).toMatchObject({ title: 'Reading day', cycle: 'B' });
    // the public door page is locked too
    const door = (await call(ADMIN, 'GET', `/attendance/services/${svcId}/door`)).json();
    const pub = (await call(null, 'GET', `/public/here/${door.url.split('/here/')[1]}`)).json();
    expect(pub.reading).toMatchObject({ locked: true });
    expect(JSON.stringify(pub.reading)).not.toMatch(/Isaiah|Born again/);
  });

  it('opens it on check-in, at the church or online, and shows it again from the reading screen', async () => {
    const r = (await call(JANE, 'POST', `/me/services/${svcId}/check-in`, {})).json();
    expect(r.reading).toMatchObject({ locked: false, title: 'Born again', ref: 'John 3:1-17' });
    expect(r.reading.lectionary.readings.map((x: any) => x.ref)).toEqual(['Isaiah 6:1-8', 'Psalm 138', 'John 3:1-17']);
    const again = (await call(JANE, 'GET', `/me/services/${svcId}/reading`)).json();
    expect(again.reading).toMatchObject({ title: 'Born again', lectionary: { title: 'Reading day', colour: 'green' } });
    expect((await call(JANE, 'GET', '/me/services')).json().services.find((x: any) => x.id === svcId).reading).toMatchObject({ locked: false, title: 'Born again' });
    // Peter watches online and is let in too
    expect((await call(PETER, 'POST', `/me/services/${svcId}/check-in`, { mode: 'online' })).json().reading).toMatchObject({ locked: false });
    // Amina has not checked in: still shut
    expect((await call(AMINA, 'GET', `/me/services/${svcId}/reading`)).json().code).toBe('check_in_first');
  });

  it('opens it for a visitor only after the visitor checks in', async () => {
    const door = (await call(ADMIN, 'GET', `/attendance/services/${svcId}/door`)).json();
    const token = door.url.split('/here/')[1];
    const r = (await call(null, 'POST', `/public/here/${token}`, { name: 'Visitor Wanjala', phone: '0712 555 111' })).json();
    expect(r.reading).toMatchObject({ locked: false, title: 'Born again' });
  });

  it('counts readings opened and weeks in a row', async () => {
    const r = (await call(JANE, 'GET', '/me/readings')).json();
    expect(r.opened).toBeGreaterThanOrEqual(1);
    expect(r.streak).toBe(1);
    expect(r.recent[0]).toMatchObject({ title: 'Born again', mode: 'in_person' });
    expect((await call(AMINA, 'GET', '/me/readings')).json()).toMatchObject({ opened: 0, streak: 0 });
    // the next Sunday, and the one after, keep the streak going; a missed week ends it
    const next = await special('Reading Sunday 2', 7 * 24 * 60 + 10);
    ctx.clock.advance(7 * DAY);
    expect((await call(JANE, 'POST', `/me/services/${next.id}/check-in`, {})).statusCode).toBe(200);
    expect((await call(JANE, 'GET', '/me/readings')).json().streak).toBe(2);
    ctx.clock.advance(21 * DAY);
    expect((await call(JANE, 'GET', '/me/readings')).json().streak).toBe(0);
  });
});

describe('the boundary of a service (L255, L256)', () => {
  const loc = (extra: any) => call(OWNER, 'PUT', '/attendance/branches/br_grc001/location', extra);

  it('is set by people who manage attendance, in their own branches', async () => {
    expect((await loc({ lat: -1.2864, lng: 36.8172, radiusM: 5 })).json().code).toBe('bad_radius');
    expect((await loc({ lat: 100, lng: 36.8172, radiusM: 200 })).json().code).toBe('bad_location');
    expect((await call(AUDITOR, 'PUT', '/attendance/branches/br_grc001/location', { lat: -1.2864, lng: 36.8172, radiusM: 200 })).statusCode).toBe(403);
    expect((await call(HOPE, 'PUT', '/attendance/branches/br_grc001/location', { lat: -1.2864, lng: 36.8172, radiusM: 200 })).statusCode).toBeGreaterThanOrEqual(403);
    expect((await call(ADMIN, 'PUT', '/attendance/branches/br_grc002/location', { lat: -1.2864, lng: 36.8172, radiusM: 200 })).statusCode).toBe(404);
    expect((await loc({ lat: -1.2864, lng: 36.8172, radiusM: 200 })).json().location).toMatchObject({ radiusM: 200 });
  });

  it('keeps members away from check-in when they are not there, and says what happened', async () => {
    const s = await special('Boundary service', 10);
    const far = await call(AMINA, 'POST', `/me/services/${s.id}/check-in`, { geo: geoFar });
    expect(far.json().code).toBe('away_from_branch');
    expect(far.json().error).toMatch(/from Grace Nairobi/);
    expect((await call(AMINA, 'POST', `/me/services/${s.id}/check-in`, {})).json().code).toBe('location_needed');
    expect((await call(AMINA, 'POST', `/me/services/${s.id}/check-in`, { geo: { ...geoAt, acc: 5000 } })).json().code).toBe('location_needed');
    const ok = await call(AMINA, 'POST', `/me/services/${s.id}/check-in`, { geo: geoAt });
    expect(ok.statusCode).toBe(200);
    const row = (await ctx.db.query<any>(`SELECT location, distance_m, accuracy_m, via FROM attendance WHERE service_id=$1 AND membership_id='m_amina'`, [s.id]))[0];
    expect(row).toMatchObject({ location: 'ok', accuracy_m: 20, via: 'app' });
    expect(row.distance_m).toBeLessThan(200);
    const b = (await call(OWNER, 'GET', '/attendance/boundaries')).json();
    const grace = b.branches.find((x: any) => x.id === BR);
    expect(grace.location).toMatchObject({ radiusM: 200 });
    expect(grace.stats).toMatchObject({ verified: 1, blocked: 3 });
    expect(b.blocked.map((x: any) => x.status).sort()).toEqual(['away', 'unknown', 'unknown']);
    expect(b.blocked.some((x: any) => x.name && x.distanceM > 1000)).toBe(true);
    expect((await call(AUDITOR, 'GET', '/attendance/boundaries')).statusCode).toBe(403);
    expect((await call(LUCY, 'GET', '/attendance/boundaries')).statusCode).toBe(403);
    expect((await call(HOPE, 'GET', '/attendance/boundaries')).json().branches.some((x: any) => x.id === BR)).toBe(false);
  });

  it('lets one service have its own place, like a crusade ground, instead of the branch', async () => {
    const s = await special('Crusade ground', 10);
    const place = { lat: -1.3, lng: 36.9, radiusM: 500, name: 'Uhuru Gardens' };
    expect((await call(AUDITOR, 'PUT', `/attendance/services/${s.id}/place`, place)).statusCode).toBeGreaterThanOrEqual(403);
    expect((await call(HOPE, 'PUT', `/attendance/services/${s.id}/place`, place)).statusCode).toBe(404);
    expect((await call(OWNER, 'PUT', `/attendance/services/${s.id}/place`, { ...place, radiusM: 10 })).json().code).toBe('bad_radius');
    expect((await call(OWNER, 'PUT', `/attendance/services/${s.id}/place`, place)).json().place).toMatchObject({ name: 'Uhuru Gardens', radiusM: 500 });
    // the branch is no longer the place for this service
    const atBranch = await call(JANE, 'POST', `/me/services/${s.id}/check-in`, { geo: geoAt });
    expect(atBranch.json().code).toBe('away_from_branch');
    expect(atBranch.json().error).toMatch(/from Uhuru Gardens/);
    expect((await call(JANE, 'POST', `/me/services/${s.id}/check-in`, { geo: { lat: -1.3002, lng: 36.9001, acc: 30 } })).statusCode).toBe(200);
    // clearing puts the branch back
    await call(OWNER, 'PUT', `/attendance/services/${s.id}/place`, { clear: true });
    expect((await call(PETER, 'POST', `/me/services/${s.id}/check-in`, { geo: geoAt })).statusCode).toBe(200);
  });

  it('does not check anyone when no place is set, and removing the branch location lifts the boundary', async () => {
    expect((await loc({ clear: true })).json().location).toBeNull();
    const s = await special('No boundary', 10);
    const r = await call(AMINA, 'POST', `/me/services/${s.id}/check-in`, {});
    expect(r.statusCode).toBe(200);
    expect((await ctx.db.query<any>(`SELECT location FROM attendance WHERE service_id=$1 AND membership_id='m_amina'`, [s.id]))[0].location).toBe('unchecked');
    const b = (await call(OWNER, 'GET', '/attendance/boundaries')).json();
    expect(b.branches.find((x: any) => x.id === BR).stats.unchecked).toBeGreaterThanOrEqual(1);
  });

  it('leaves the changes in the audit log and the books balanced', async () => {
    for (const a of ['attendance.branch_location_set', 'attendance.branch_location_cleared', 'attendance.service_place_set', 'attendance.service_place_cleared']) {
      expect((await call(PA1, 'GET', `/admin/audit/events?action=${a}`)).json().events.length, a).toBeGreaterThan(0);
    }
    expect((await call(PA1, 'GET', '/admin/reconcile')).json().ok).toBe(true);
    void addDays; void eatToday;
  });
});
