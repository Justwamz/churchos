import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { seedKidsDemo } from './seed-kids';
import { addDays, dueAt, eatToday, weekStartOf } from './eat';

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

const OWNER = '0700000001', USHER = '0700000556', JANE = '0711000001', PETER = '0711000002';
const MIN = 60_000;
const BR = 'br_grc001';
const now = () => ctx.clock.now().getTime();
const geoFar = { lat: -1.2, lng: 36.9, acc: 20 };

async function special(name: string, startsInMin: number, extra: any = {}) {
  const r = await call(OWNER, 'POST', '/attendance/services', { branchId: BR, name, startsAt: new Date(now() + startsInMin * MIN).toISOString(), durationMin: 90, ...extra });
  expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
  return r.json().id as string;
}
const setWord = async (one: string, many: string) => expect((await call(OWNER, 'PUT', '/church/words', { one, many })).statusCode).toBe(200);

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

const CANCELLED = ['cancelledMember', 'cancelledInvite', 'cancelledDoor', 'cancelledHeadcount', 'cancelledMark', 'cancelledVisitor', 'cancelledScan', 'publicLiveCancelled'];

/** Drives every server sentence that names a gathering and returns them by label. */
async function sentences() {
  const out: Record<string, string> = {};
  const err = (r: any) => String(r.json().error);
  const future = new Date(now() + 60 * MIN).toISOString();
  const far = await special('Far one', 60 * 5, { streamUrl: 'https://www.youtube.com/watch?v=abc123' });
  const open = await special('Open one', 10, { streamUrl: 'https://www.youtube.com/watch?v=abc123' });
  const past = await special('Past one', -60 * 5);
  const gone = await special('Gone one', 5);
  const nostream = await special('No stream one', 10);
  await call(OWNER, 'PATCH', `/attendance/services/${gone}`, { status: 'cancelled' });
  out.checkInNotOpen = err(await call(JANE, 'POST', `/me/services/${far}/check-in`, {}));
  out.checkInClosed = err(await call(JANE, 'POST', `/me/services/${past}/check-in`, {}));
  out.cancelledMember = err(await call(JANE, 'POST', `/me/services/${gone}/check-in`, {}));
  out.cancelledInvite = err(await call(JANE, 'GET', `/me/services/${gone}/invite`));
  out.cancelledDoor = err(await call(USHER, 'GET', `/attendance/services/${gone}/door`));
  out.cancelledHeadcount = err(await call(OWNER, 'PUT', `/attendance/services/${gone}/headcount`, { adults: 1 }));
  out.cancelledMark = err(await call(USHER, 'POST', `/attendance/services/${gone}/mark`, { membershipId: 'x' }));
  out.cancelledVisitor = err(await call(USHER, 'POST', `/attendance/services/${gone}/visitor`, { name: 'Zed Zed', phone: '0722000999' }));
  out.cancelledScan = err(await call(USHER, 'POST', `/attendance/services/${gone}/scan`, { token: 'x' }));
  out.noStream = err(await call(JANE, 'POST', `/me/services/${nostream}/watch`, {}));
  out.badName = err(await call(OWNER, 'POST', '/attendance/services', { branchId: BR, name: '', startsAt: future }));
  out.badNamePatch = err(await call(OWNER, 'PATCH', `/attendance/services/${open}`, { name: '' }));
  out.badDuration = err(await call(OWNER, 'POST', '/attendance/services', { branchId: BR, name: 'x', startsAt: future, durationMin: 5 }));
  out.badSchedName = err(await call(OWNER, 'POST', '/attendance/schedules', { branchId: BR, name: '', weekdays: [7], startTime: '10:00', range: 'week' }));
  out.badRange = err(await call(OWNER, 'POST', '/attendance/schedules', { branchId: BR, name: 'S', weekdays: [7], startTime: '10:00', range: 'decade' }));
  const door = ((await call(USHER, 'GET', `/attendance/services/${past}/door`)).json().url as string).split('/here/')[1];
  out.publicClosed = err(await call(null, 'POST', `/public/here/${door}`, { name: 'Late Larry', phone: '0722000222' }));
  const doorFar = ((await call(USHER, 'GET', `/attendance/services/${far}/door`)).json().url as string).split('/here/')[1];
  out.publicNotOpen = err(await call(null, 'POST', `/public/here/${doorFar}`, { name: 'Early Eric', phone: '0722000333' }));
  const code = (await call(OWNER, 'GET', '/attendance/services?from=2020-01-01&to=2099-01-01')).json().services.find((s: any) => s.id === gone).code;
  out.publicLiveCancelled = err(await call(null, 'POST', `/public/live/${code}`, { name: 'Zed Zed', phone: '0722000999' }));
  out.publicLiveNone = err(await call(null, 'GET', '/public/live/b-GRC002'));
  await call(OWNER, 'PUT', '/kids/branches/br_grc001/location', { lat: -1.2864, lng: 36.8172, radiusM: 300 });
  out.away = err(await call(PETER, 'POST', `/me/services/${open}/check-in`, { geo: geoFar }));
  await call(OWNER, 'PUT', '/kids/branches/br_grc001/location', { clear: true });
  const tok = (await call(JANE, 'POST', '/me/attendance/qr', {})).json().token;
  await call(USHER, 'POST', `/attendance/services/${open}/scan`, { token: tok });
  out.alreadyCounted = String((await call(USHER, 'POST', `/attendance/services/${open}/scan`, { token: tok })).json().message);
  out.invite = String((await call(JANE, 'GET', `/me/services/${open}/invite`)).json().message);
  // the Monday report, sent now, with a gathering in the last full week
  const ws = addDays(weekStartOf(eatToday(ctx.clock.now())), -7);
  await call(OWNER, 'POST', '/attendance/services', { branchId: BR, name: 'Last week one', startsAt: new Date(Date.parse(dueAt(addDays(ws, 2), '09:00'))).toISOString(), durationMin: 60 });
  ctx.email.sent.length = 0;
  expect((await call(OWNER, 'POST', '/attendance/report/send-now', {})).json().sent).toBe(true);
  const mail = ctx.email.sent[ctx.email.sent.length - 1];
  out.report = String(mail.body);
  out.reportHtml = String(mail.html);
  return out;
}

describe('the sentences the server writes use the church word for a gathering (Slice 30)', () => {
  it('say service while the church has not changed the word', async () => {
    const s = await sentences();
    expect(s.checkInNotOpen).toMatch(/^Check-in opens at /);
    expect(s.checkInClosed).toBe('Check-in for this service has closed');
    for (const k of CANCELLED) expect(s[k], k).toBe('This service was cancelled');
    expect(s.noStream).toBe('There is no live stream for this service');
    expect(s.badName).toBe('Enter a name for the service');
    expect(s.badNamePatch).toBe('Enter a name for the service');
    expect(s.badSchedName).toBe('Enter a name for the service');
    expect(s.badDuration).toBe('A service lasts from 15 minutes to 8 hours');
    expect(s.badRange).toBe('Choose how far ahead to create the services: this week, this month, this year, or until a date');
    expect(s.publicClosed).toBe('Check-in for this service has closed');
    expect(s.publicNotOpen).toMatch(/^Check-in opens at /);
    expect(s.publicLiveNone).toBe('There is no live service coming up for this church yet');
    expect(s.away).toMatch(/^You are about .* from Grace Nairobi\. Check in when you are there/);
    expect(s.alreadyCounted).toBe('Already counted for this service.');
    expect(s.invite).toMatch(/^Join us for Open one at /);
    expect(s.report).toContain('Each service:');
    expect(s.reportHtml).toContain('>Service</th>');
  });

  it('say Mass once the owner chooses Mass / Masses', async () => {
    await setWord('Mass', 'Masses');
    const s = await sentences();
    expect(s.checkInClosed).toBe('Check-in for this mass has closed');
    for (const k of CANCELLED) expect(s[k], k).toBe('This mass was cancelled');
    expect(s.noStream).toBe('There is no live stream for this mass');
    expect(s.badName).toBe('Enter a name for the mass');
    expect(s.badNamePatch).toBe('Enter a name for the mass');
    expect(s.badSchedName).toBe('Enter a name for the mass');
    expect(s.badDuration).toBe('A mass lasts from 15 minutes to 8 hours');
    expect(s.badRange).toBe('Choose how far ahead to create the masses: this week, this month, this year, or until a date');
    expect(s.publicClosed).toBe('Check-in for this mass has closed');
    expect(s.alreadyCounted).toBe('Already counted for this mass.');
    expect(s.publicLiveNone).toBe('There is no live mass coming up for this church yet');
    expect(s.report).toContain('Each mass:');
    expect(s.report).not.toMatch(/\bservices?\b/i);
    expect(s.reportHtml).toContain('>Mass</th>');
    expect(s.reportHtml).not.toMatch(/>Service</);
    for (const k of ['checkInNotOpen', 'checkInClosed', 'away', 'invite', 'alreadyCounted', 'publicNotOpen']) expect(s[k], k).not.toMatch(/\bservice\b/i);
    await setWord('Service', 'Services');
  });
});
