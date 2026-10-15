import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { runBookingJobs } from './routes/bookings';

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

const OWNER = '0700000001', ADMIN = '0700000003', HOPE = '0700000005', PA1 = '0700000099';
const JANE = '0711000001', PETER = '0711000002', AMINA = '0711000003', DAVID = '0711000004';
const MIN = 60_000, HOUR = 3600_000, DAY = 24 * HOUR;
const EAT = 3 * HOUR;
const wait = async (fn: () => Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

/** The ISO time of HH:MM East Africa Time on the next given weekday (Mon=1 ... Sun=0), at least minDays ahead and `weeks` weeks later. */
function when(dow: number, hhmm: string, minDays = 8, weeks = 0): string {
  const base = new Date(ctx.clock.now().getTime() + EAT);
  let d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + minDays));
  while (d.getUTCDay() !== dow) d = new Date(d.getTime() + DAY);
  d = new Date(d.getTime() + weeks * 7 * DAY);
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(d.getTime() + (h * 60 + m) * MIN - EAT).toISOString();
}
const plus = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * MIN).toISOString();
const dateOf = (iso: string) => new Date(Date.parse(iso) + EAT).toISOString().slice(0, 10);
const inbox = async (who: string) => (await call(who, 'GET', '/me/notifications')).json().rows as any[];
const book = (who: string, resourceIds: string[], startsAt: string, minutes: number, extra: any = {}) =>
  call(who, 'POST', '/me/bookings', { resourceIds, startsAt, endsAt: plus(startsAt, minutes), title: 'A visit', ...extra });

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);

describe('resources (L140)', () => {
  it('members see what their church lets them book, and other churches see nothing', async () => {
    const names = (await call(JANE, 'GET', '/me/resources')).json().map((r: any) => r.name);
    expect(names).toEqual(expect.arrayContaining(['Pastor Daniel', 'Main hall, Nairobi', 'Sound system', 'Church grounds, Mombasa']));
    expect((await call(HOPE, 'GET', '/me/resources')).json()).toEqual([]);
    expect((await call(null, 'GET', '/me/resources')).statusCode).toBe(401);
    const hall = (await call(JANE, 'GET', '/me/resources')).json().find((r: any) => r.name === 'Main hall, Nairobi');
    expect(hall).toMatchObject({ kind: 'place', capacity: 200, price: 150000, pricePer: 'hour', approval: 'manual' });
  });

  it('staff set up resources within what they manage, with sensible rules', async () => {
    const hours = { mon: [['09:00', '17:00']] };
    const mk = (who: string, extra: any = {}) => call(who, 'POST', '/resources', { kind: 'place', name: 'Youth room', hours, ...extra });
    expect((await mk(ADMIN)).statusCode).toBe(403); // Samuel runs one branch, so a church-wide resource is not his to set up
    expect((await mk(ADMIN, { branchId: 'br_grc002' })).statusCode).toBe(403);
    expect((await mk(JANE, { branchId: 'br_grc001' })).statusCode).toBe(403);
    expect((await mk(ADMIN, { branchId: 'br_grc001', hours: {} })).json().code).toBe('bad_hours');
    expect((await mk(ADMIN, { branchId: 'br_grc001', hours: { mon: [['17:00', '09:00']] } })).json().code).toBe('bad_hours');
    expect((await mk(ADMIN, { branchId: 'br_grc001', hours: { mon: [['09:00', '12:00'], ['11:00', '13:00']] } })).json().code).toBe('bad_hours');
    expect((await mk(ADMIN, { branchId: 'br_grc001', name: '' })).statusCode).toBe(400);
    expect((await mk(ADMIN, { branchId: 'br_grc001', price: '3' })).json().code).toBe('bad_amount');
    expect((await mk(ADMIN, { branchId: 'br_grc001', ownerUserId: 'u_hope' })).json().code).toBe('bad_owner');
    const ok = await mk(ADMIN, { branchId: 'br_grc001', capacity: 30, price: 500, pricePer: 'hour', approval: 'auto' });
    expect(ok.statusCode).toBe(200);
    expect((await mk(ADMIN, { branchId: 'br_grc001' })).json().code).toBe('duplicate');
    expect((await call(OWNER, 'POST', '/resources', { kind: 'thing', name: 'Church bus', hours, slotMinutes: 60 })).statusCode).toBe(200); // the owner can do church-wide
    const list = (await call(ADMIN, 'GET', '/resources')).json().map((r: any) => r.name);
    expect(list).toEqual(expect.arrayContaining(['Youth room', 'Main hall, Nairobi']));
    expect(list).not.toContain('Church grounds, Mombasa'); // another branch
    expect((await call(HOPE, 'GET', '/resources')).json()).toEqual([]);
  });

  it('changes are audited, and switching one off hides it from members', async () => {
    const id = (await call(ADMIN, 'GET', '/resources')).json().find((r: any) => r.name === 'Youth room').id;
    expect((await call(ADMIN, 'PUT', `/resources/${id}`, { capacity: 40 })).statusCode).toBe(200);
    expect((await call(HOPE, 'PUT', `/resources/${id}`, { capacity: 5 })).statusCode).toBe(404);
    expect((await call(JANE, 'GET', '/me/resources')).json().map((r: any) => r.name)).toContain('Youth room');
    expect((await call(ADMIN, 'POST', `/resources/${id}/active`, { active: false })).json().active).toBe(false);
    expect((await call(JANE, 'GET', '/me/resources')).json().map((r: any) => r.name)).not.toContain('Youth room');
    expect((await book(JANE, [id], when(1, '10:00'), 60)).statusCode).toBe(404);
    const actions = (await call(PA1, 'GET', '/admin/audit/events?action=resource')).json().events.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['resource.create', 'resource.update']));
  });
});

describe('availability and the rules of a booking (L141)', () => {
  it('lists the free times of a day, and nothing on a closed day', async () => {
    const monday = dateOf(when(1, '10:00'));
    const sunday = dateOf(when(0, '10:00'));
    const slots = (await call(JANE, 'GET', `/me/resources/res_pastor/availability?date=${monday}`)).json();
    expect(slots.minutes).toBe(30);
    expect(slots.slots).toHaveLength(12); // 09:00 to 12:00 and 14:00 to 17:00, every 30 minutes
    expect(slots.slots[0].startsAt).toBe(when(1, '09:00'));
    expect((await call(JANE, 'GET', `/me/resources/res_pastor/availability?date=${sunday}`)).json().slots).toEqual([]);
    expect((await call(JANE, 'GET', '/me/resources/res_pastor/availability?date=nope')).statusCode).toBe(400);
    expect((await call(HOPE, 'GET', `/me/resources/res_pastor/availability?date=${monday}`)).statusCode).toBe(404);
    const hall = (await call(JANE, 'GET', `/me/resources/res_hall/availability?date=${monday}&minutes=120`)).json();
    expect(hall.price).toBe(300000); // two hours at KES 1,500
    expect(hall.slots[0].endsAt).toBe(plus(hall.slots[0].startsAt, 120));
  });

  it('refuses times outside the hours, off the grid, too soon, too far, too long or too crowded', async () => {
    const mon = (t: string) => when(1, t);
    expect((await book(JANE, ['res_pastor'], mon('07:00'), 30)).json().code).toBe('outside_hours');
    expect((await book(JANE, ['res_pastor'], mon('12:00'), 30)).json().code).toBe('outside_hours'); // lunch
    expect((await book(JANE, ['res_pastor'], mon('11:45'), 30)).json().code).toBe('bad_slot'); // not on the 30-minute grid
    expect((await book(JANE, ['res_pastor'], mon('16:30'), 60)).json().code).toBe('outside_hours'); // runs past closing
    expect((await book(JANE, ['res_pastor'], mon('10:00'), 90)).json().code).toBe('too_long'); // pastor sessions are at most an hour
    expect((await book(JANE, ['res_pastor'], when(1, '10:00', 300), 30)).json().code).toBe('too_far');
    expect((await book(JANE, ['res_pastor'], plus(new Date(ctx.clock.now()).toISOString(), 60), 30)).json().code).toMatch(/too_soon|outside_hours|bad_slot/);
    expect((await book(JANE, ['res_hall'], when(1, '20:00'), 120)).json().code).toBe('outside_hours'); // crosses 21:00 closing
    expect((await book(JANE, ['res_hall'], mon('10:00'), 60, { attendees: 500 })).json().code).toBe('over_capacity');
    expect((await book(JANE, ['res_pastor'], mon('10:00'), 30, { title: '' })).statusCode).toBe(400);
    expect((await call(JANE, 'POST', '/me/bookings', { resourceIds: [], startsAt: mon('10:00'), endsAt: mon('10:30'), title: 'x' })).json().code).toBe('bad_resources');
    expect((await call(JANE, 'POST', '/me/bookings', { resourceIds: ['res_pastor'], startsAt: mon('10:00'), endsAt: mon('09:00'), title: 'x' })).json().code).toBe('bad_time');
    expect((await book(HOPE, ['res_pastor'], mon('10:00'), 30)).statusCode).toBe(404); // not their church
    expect((await call(null, 'POST', '/me/bookings', {})).statusCode).toBe(401);
  });
});

describe('a free booking with a person (L141, L142)', () => {
  let id = '';
  let slot = '';
  beforeAll(() => { slot = when(1, '10:00'); });

  it('is requested, answered by the owner of the diary, and then confirmed', async () => {
    const r = await book(JANE, ['res_pastor'], slot, 30, { title: 'Pray together', note: 'About my mother, who is unwell.' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'requested', price: null });
    id = r.json().id;
    expect((await inbox(OWNER)).some((n) => n.title === 'New booking request')).toBe(true);
    expect((await call(JANE, 'POST', `/me/diary/${id}/decide`, { approve: true })).statusCode).toBe(404); // not her diary
    expect((await call(PETER, 'POST', `/me/diary/${id}/decide`, { approve: true })).statusCode).toBe(404);
    const diary = (await call(OWNER, 'GET', '/me/diary')).json();
    expect(diary.find((b: any) => b.id === id)).toMatchObject({ requester: 'Jane Wanjiku', note: 'About my mother, who is unwell.' });
    expect((await call(OWNER, 'POST', `/me/diary/${id}/decide`, { approve: false })).json().code).toBe('reason_required');
    expect((await call(OWNER, 'POST', `/me/diary/${id}/decide`, { approve: true })).json().status).toBe('confirmed');
    expect((await call(OWNER, 'POST', `/me/diary/${id}/decide`, { approve: true })).statusCode).toBe(404); // nothing left to answer
    expect((await inbox(JANE)).some((n) => n.title === 'Your booking is confirmed')).toBe(true);
  });

  it('cannot be double-booked, and the time comes back when it is cancelled', async () => {
    expect((await book(PETER, ['res_pastor'], slot, 30)).json().code).toBe('time_taken');
    const day = dateOf(slot);
    expect((await call(PETER, 'GET', `/me/resources/res_pastor/availability?date=${day}`)).json().slots.map((s: any) => s.startsAt)).not.toContain(slot);
    expect((await call(PETER, 'POST', `/me/bookings/${id}/cancel`)).statusCode).toBe(404); // not his booking
    expect((await call(JANE, 'POST', `/me/bookings/${id}/cancel`, { reason: 'Plans changed' })).json().status).toBe('cancelled');
    expect((await call(PETER, 'GET', `/me/resources/res_pastor/availability?date=${day}`)).json().slots.map((s: any) => s.startsAt)).toContain(slot);
    expect((await call(JANE, 'POST', `/me/bookings/${id}/cancel`)).statusCode).toBe(409);
    expect((await inbox(OWNER)).some((n) => n.title === 'A booking was cancelled')).toBe(true);
  });

  it('keeps the note private: only the member and the people who decide see it, and the log never holds it', async () => {
    const b = (await book(AMINA, ['res_pastor'], when(2, '10:00'), 30, { note: 'Private worry about my marriage' })).json();
    const seen = (await call(ADMIN, 'GET', '/bookings')).json().find((x: any) => x.id === b.id);
    expect(seen).toBeDefined();
    expect(seen.note).toBe('Private worry about my marriage'); // Samuel manages the branch the pastor belongs to, so he may decide it
    // Someone who can only view bookings sees that it exists but never the note.
    const now = ctx.clock.now().toISOString();
    await ctx.db.query(`INSERT INTO users (id, phone, name, created_at) VALUES ('u_viewer','254700000077','Vera Viewer',$1)`, [now]);
    await ctx.db.query(`INSERT INTO roles (id, org_id, name, permissions) VALUES ('org_grace:viewer','org_grace','viewer','["bookings.view"]')`);
    await ctx.db.query(`INSERT INTO role_assignments (id, org_id, user_id, role_id, scope_type, scope_id) VALUES ('ra_viewer','org_grace','u_viewer','org_grace:viewer','branch','br_grc001')`);
    const viewed = (await call('0700000077', 'GET', '/bookings')).json().find((x: any) => x.id === b.id);
    expect(viewed).toBeDefined();
    expect(viewed.note).toBeUndefined();
    expect(viewed.items[0].mine).toBe(false);
    expect((await call('0700000077', 'POST', `/bookings/${b.id}/items/res_pastor/decide`, { approve: true })).statusCode).toBe(404);
    expect((await call(OWNER, 'GET', `/bookings/${b.id}`)).json().note).toBe('Private worry about my marriage');
    expect((await call(AMINA, 'GET', '/me/bookings')).json().find((x: any) => x.id === b.id).note).toBe('Private worry about my marriage');
    const log = JSON.stringify((await call(PA1, 'GET', '/admin/audit/events?action=booking')).json());
    expect(log).toMatch(/booking\.request/);
    expect(log).not.toMatch(/marriage|worry/);
    expect((await call(HOPE, 'GET', '/bookings')).json()).toEqual([]);
    expect((await call(HOPE, 'GET', `/bookings/${b.id}`)).statusCode).toBe(404);
  });

  it('is approved at once for a resource that needs no approval', async () => {
    const r = await book(JANE, ['res_sound'], when(6, '10:00'), 120);
    expect(r.json().status).toBe('confirmed');
    expect((await book(PETER, ['res_sound'], when(6, '11:00'), 60)).json().code).toBe('time_taken');
    expect((await call(OWNER, 'POST', `/bookings/${r.json().id}/items/res_sound/decide`, { approve: true })).statusCode).toBe(409); // nothing waiting
  });
});

describe('a paid booking (L144)', () => {
  let id = '';
  let code = '';
  let slot = '';
  beforeAll(() => { slot = when(3, '14:00'); });

  it('is approved by the branch, then waits for payment with the time held', async () => {
    const r = await book(PETER, ['res_hall'], slot, 120, { title: 'Wedding rehearsal', attendees: 60 });
    expect(r.json()).toMatchObject({ status: 'requested', price: 300000 });
    id = r.json().id;
    expect((await call(PETER, 'POST', `/bookings/${id}/items/res_hall/decide`, { approve: true })).statusCode).toBe(403); // no staff permission
    expect((await call(HOPE, 'POST', `/bookings/${id}/items/res_hall/decide`, { approve: true })).statusCode).toBe(404);
    expect((await call(ADMIN, 'POST', `/bookings/${id}/items/res_hall/decide`, { approve: false })).json().code).toBe('reason_required');
    const ok = (await call(ADMIN, 'POST', `/bookings/${id}/items/res_hall/decide`, { approve: true })).json();
    expect(ok.status).toBe('awaiting_payment');
    const mine = (await call(PETER, 'GET', '/me/bookings')).json().find((b: any) => b.id === id);
    code = mine.code;
    expect(mine).toMatchObject({ status: 'awaiting_payment', price: 300000, paid: false });
    expect(mine.payUrl).toMatch(/\?booking=[A-F0-9]{6}$/);
    expect((await book(JANE, ['res_hall'], slot, 60)).json().code).toBe('time_taken'); // held while unpaid
  });

  it('shows what is owed and refuses any other amount, then confirms through the normal giving flow', async () => {
    expect((await call(null, 'GET', `/public/booking/${code}`)).json()).toMatchObject({ price: 300000, purpose: `BK-${code}`, churchCode: 'GRC001', resources: ['Main hall, Nairobi'] });
    const give = (amount: number, c = 'GRC001') => call(null, 'POST', '/public/give', { code: c, phone: '0712000222', amount, purpose: `BK-${code}`, method: 'mpesa' });
    expect((await give(2000)).json().code).toBe('amount_must_be_exact');
    expect((await give(3000, 'HPC001')).json().code).toBe('unknown_purpose');
    expect((await give(3000)).statusCode).toBe(200);
    expect(await wait(async () => (await call(PETER, 'GET', '/me/bookings')).json().find((b: any) => b.id === id).status === 'confirmed')).toBe(true);
    const p = (await ctx.db.query<any>(`SELECT amount_paid, platform_fee FROM payments WHERE purpose=$1`, [`BK-${code}`]))[0];
    expect(Number(p.amount_paid)).toBe(300000);
    expect(Number(p.platform_fee)).toBeGreaterThan(0); // the platform fee applies like any payment
    expect((await call(null, 'GET', `/public/booking/${code}`)).statusCode).toBe(404);
    expect((await inbox(PETER)).some((n) => n.title === 'Booking confirmed')).toBe(true);
    const actions = (await call(PA1, 'GET', '/admin/audit/events?action=booking.paid')).json().events;
    expect(actions).toHaveLength(1);
  });

  it('is released when the hold runs out, and the time can be booked again', async () => {
    const t = when(4, '14:00');
    const r = (await book(JANE, ['res_hall'], t, 60)).json();
    await call(ADMIN, 'POST', `/bookings/${r.id}/items/res_hall/decide`, { approve: true });
    expect((await call(JANE, 'GET', '/me/bookings')).json().find((b: any) => b.id === r.id).status).toBe('awaiting_payment');
    ctx.clock.advance(25 * HOUR);
    const out = await runBookingJobs(ctx);
    expect(out.lapsed).toBe(1);
    expect((await call(JANE, 'GET', '/me/bookings')).json().find((b: any) => b.id === r.id)).toMatchObject({ status: 'lapsed', payUrl: null });
    expect((await call(null, 'GET', `/public/booking/${(await ctx.db.query<any>(`SELECT code FROM bookings WHERE id=$1`, [r.id]))[0].code}`)).statusCode).toBe(404);
    expect((await inbox(JANE)).some((n) => n.title === 'Booking released')).toBe(true);
    expect((await book(PETER, ['res_hall'], t, 60)).statusCode).toBe(200);
  });
});

describe('several resources in one booking (L143)', () => {
  it('needs every resource to say yes, and any no declines the whole booking', async () => {
    const t = when(5, '10:00', 10);
    const r = (await book(JANE, ['res_pastor', 'res_hall'], t, 60, { title: 'Marriage day planning' })).json();
    expect(r.status).toBe('requested');
    expect(r.items.map((i: any) => i.name).sort()).toEqual(['Main hall, Nairobi', 'Pastor Daniel']);
    expect((await call(ADMIN, 'POST', `/bookings/${r.id}/items/res_hall/decide`, { approve: true })).json().status).toBe('requested'); // pastor still to answer
    expect((await book(PETER, ['res_hall'], t, 60)).statusCode).toBe(200); // requests that are still waiting do not hold the hall
    expect((await call(OWNER, 'POST', `/me/diary/${r.id}/decide`, { approve: true })).json().status).toBe('awaiting_payment'); // the hall costs money
    expect((await call(JANE, 'GET', '/me/bookings')).json().find((b: any) => b.id === r.id)).toMatchObject({ price: 150000 });

    const t2 = when(5, '14:00', 10);
    const d = (await book(AMINA, ['res_pastor', 'res_hall'], t2, 60, { title: 'Dedication' })).json();
    expect((await call(ADMIN, 'POST', `/bookings/${d.id}/items/res_hall/decide`, { approve: true })).json().status).toBe('requested');
    expect((await call(OWNER, 'POST', `/me/diary/${d.id}/decide`, { approve: false, reason: 'I am travelling that day' })).json().status).toBe('declined');
    const after = (await call(AMINA, 'GET', '/me/bookings')).json().find((b: any) => b.id === d.id);
    expect(after).toMatchObject({ status: 'declined', reason: 'I am travelling that day' });
    expect((await inbox(AMINA)).some((n) => n.title === 'Your booking was not accepted')).toBe(true);
  });

  it('refuses a booking when one of the resources is already taken', async () => {
    const t = when(6, '14:00', 10);
    expect((await book(JANE, ['res_sound'], t, 60)).json().status).toBe('confirmed');
    const r = await book(PETER, ['res_hall', 'res_sound'], t, 60);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('time_taken');
  });
});

describe('blocked times, staff cancelling and completing (L140, L145)', () => {
  it('blocks a time so nobody can book it, but not over an existing booking', async () => {
    const t = when(1, '10:00', 14);
    const none = await call(ADMIN, 'POST', '/resources/res_hall/blocks', { startsAt: t, endsAt: plus(t, 180), reason: 'Floor repairs' });
    expect(none.statusCode).toBe(200);
    expect((await book(JANE, ['res_hall'], plus(t, 60), 60)).json().code).toBe('blocked');
    expect((await call(JANE, 'GET', `/me/resources/res_hall/availability?date=${dateOf(t)}`)).json().slots.every((s: any) => s.startsAt < t || s.startsAt >= plus(t, 180))).toBe(true);
    expect((await call(HOPE, 'POST', '/resources/res_hall/blocks', { startsAt: t, endsAt: plus(t, 60) })).statusCode).toBe(404);
    const blocks = (await call(ADMIN, 'GET', '/resources/res_hall/blocks')).json();
    expect(blocks).toHaveLength(1);
    expect((await call(ADMIN, 'POST', `/resources/res_hall/blocks/${blocks[0].id}/remove`)).statusCode).toBe(200);
    expect((await book(JANE, ['res_hall'], plus(t, 60), 60)).statusCode).toBe(200);
    // the booking above is only requested, so approve it and then try to block over it
    const b = (await call(ADMIN, 'GET', '/bookings?status=requested')).json().find((x: any) => x.startsAt === plus(t, 60));
    await call(ADMIN, 'POST', `/bookings/${b.id}/items/res_hall/decide`, { approve: true });
    expect((await call(ADMIN, 'POST', '/resources/res_hall/blocks', { startsAt: t, endsAt: plus(t, 180) })).json().code).toBe('has_bookings');
  });

  it('staff can cancel with a reason and the member is told', async () => {
    const r = (await book(DAVID, ['res_pastor'], when(2, '10:00', 14), 30, { title: 'Counsel' })).json();
    await call(OWNER, 'POST', `/me/diary/${r.id}/decide`, { approve: true });
    expect((await call(ADMIN, 'POST', `/bookings/${r.id}/cancel`, {})).statusCode).toBe(400); // a reason is needed
    expect((await call(HOPE, 'POST', `/bookings/${r.id}/cancel`, { reason: 'x' })).statusCode).toBe(404);
    expect((await call(JANE, 'POST', `/bookings/${r.id}/cancel`, { reason: 'x' })).statusCode).toBe(403);
    expect((await call(ADMIN, 'POST', `/bookings/${r.id}/cancel`, { reason: 'The pastor is at a funeral' })).json().status).toBe('cancelled');
    expect((await inbox(DAVID)).find((n) => n.title === 'A booking was cancelled').body).toMatch(/funeral/);
  });

});

describe('calendar and reminders (L146, L147)', () => {
  it('one calendar of confirmed bookings and events, within what the person manages', async () => {
    const from = new Date(ctx.clock.now().getTime()).toISOString();
    const to = new Date(ctx.clock.now().getTime() + 60 * DAY).toISOString();
    const cal = (await call(OWNER, 'GET', `/calendar?from=${from}&to=${to}`)).json();
    expect(cal.some((c: any) => c.type === 'event' && c.title === 'Christmas Carols Night')).toBe(true);
    expect(cal.some((c: any) => c.type === 'booking' && c.title === 'Wedding rehearsal')).toBe(true);
    expect(cal.every((c: any, i: number) => i === 0 || cal[i - 1].startsAt <= c.startsAt)).toBe(true);
    expect((await call(HOPE, 'GET', `/calendar?from=${from}&to=${to}`)).json()).toEqual([]);
    const only = (await call(OWNER, 'GET', `/calendar?from=${from}&to=${to}&resource=res_hall`)).json();
    expect(only.every((c: any) => c.type === 'booking' && c.resources.includes('Main hall, Nairobi'))).toBe(true);
    expect((await call(JANE, 'GET', '/calendar')).statusCode).toBe(403);
  });

  it('reminds the member and the owner the day before, once', async () => {
    const t = when(4, '10:00', 6);
    const r = (await book(JANE, ['res_pastor'], t, 30, { title: 'Prayer session' })).json();
    await call(OWNER, 'POST', `/me/diary/${r.id}/decide`, { approve: true });
    ctx.clock.advance(Math.max(0, Date.parse(t) - ctx.clock.now().getTime() - 30 * HOUR));
    await runBookingJobs(ctx);
    expect((await inbox(JANE)).some((n) => n.title === 'Tomorrow: Prayer session')).toBe(false);
    ctx.clock.advance(8 * HOUR);
    await runBookingJobs(ctx);
    await runBookingJobs(ctx);
    expect((await inbox(JANE)).filter((n) => n.title === 'Tomorrow: Prayer session')).toHaveLength(1);
    expect((await inbox(OWNER)).filter((n) => n.title === 'Tomorrow: Prayer session')).toHaveLength(1);
    expect((await call(PETER, 'POST', `/me/bookings/${r.id}/cancel`)).statusCode).toBe(404);
    expect((await call(JANE, 'POST', `/me/bookings/${r.id}/cancel`)).json().code).toBe('too_late'); // inside 24 hours
    expect((await call(OWNER, 'POST', `/bookings/${r.id}/cancel`, { reason: 'The pastor is unwell' })).json().status).toBe('cancelled');
    expect((await inbox(JANE)).find((n) => n.title === 'A booking was cancelled').body).toMatch(/unwell/);
  });

  it('a past booking is marked done or a no-show, and only after it has started', async () => {
    const r = (await book(AMINA, ['res_sound'], when(0, '09:00', 12), 60, { title: 'Service' })).json();
    expect(r.status).toBe('confirmed');
    expect((await call(ADMIN, 'POST', `/bookings/${r.id}/complete`, {})).json().code).toBe('too_early');
    ctx.clock.advance(25 * DAY);
    expect((await call(ADMIN, 'POST', `/bookings/${r.id}/complete`, { outcome: 'no_show' })).json().status).toBe('no_show');
    expect((await call(ADMIN, 'POST', `/bookings/${r.id}/complete`, {})).statusCode).toBe(409);
  });
});

describe('searching bookings', () => {
  it('finds a booking by its code, the member or the reason, and treats wildcards as plain text', async () => {
    const t = when(3, '09:00', 20);
    const made = (await book(AMINA, ['res_pastor'], t, 30, { title: 'Zebra picnic planning' })).json();
    const all = (await call(OWNER, 'GET', '/bookings')).json();
    const mine = all.find((b: any) => b.id === made.id);
    const ids = async (q: string) => (await call(OWNER, 'GET', `/bookings?q=${encodeURIComponent(q)}`)).json().map((b: any) => b.id);
    expect(await ids(mine.code)).toEqual([made.id]);
    expect(await ids(mine.code.toLowerCase())).toEqual([made.id]); // not case sensitive
    expect(await ids('amina')).toContain(made.id);
    expect(await ids('Hassan')).toContain(made.id);
    expect(await ids('zebra picnic')).toEqual([made.id]);
    expect(await ids('nobody-by-this-name')).toEqual([]);
    expect(await ids('%')).toEqual([]); // a wildcard is not a match-everything
    expect(await ids('_')).toEqual([]);
    expect((await call(HOPE, 'GET', `/bookings?q=${encodeURIComponent('amina')}`)).json()).toEqual([]); // another church sees nothing
    const jane = (await call(OWNER, 'GET', '/bookings?q=Jane')).json();
    expect(jane.length).toBeGreaterThan(0);
    expect(jane.every((b: any) => /jane/i.test(b.requester) || /jane/i.test(b.title) || /jane/i.test(b.code))).toBe(true);
  });
});
