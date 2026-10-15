import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { runCommunityJobs } from './routes/community';

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
const HOUR = 3600_000, DAY = 24 * HOUR;
const at = (ms: number) => new Date(ctx.clock.now().getTime() + ms).toISOString();
const titles = async (who: string, path: string) => (await call(who, 'GET', path)).json().map((x: any) => x.title) as string[];
const inbox = async (who: string) => (await call(who, 'GET', '/me/notifications')).json().rows as any[];
const YOUTH = 'grp_youth';

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);

describe('notice board (L133)', () => {
  it('members see what is meant for them, pinned first', async () => {
    const jane = await titles(JANE, '/me/notices');
    expect(jane[0]).toBe('Welcome to Grace Community Church'); // pinned
    expect(jane).toEqual(expect.arrayContaining(['Harvest Sunday is coming', 'Parking at Nairobi']));
    expect(await titles(AMINA, '/me/notices')).not.toContain('Parking at Nairobi'); // Amina is in the Mombasa branch
    expect(await titles(HOPE, '/me/notices')).toEqual([]); // another church sees nothing
    expect((await call(null, 'GET', '/me/notices')).statusCode).toBe(401);
  });

  it('staff publish only to what they manage, and a branch admin cannot reach the whole church', async () => {
    const mk = (who: string, audience: any, extra: any = {}) => call(who, 'POST', '/notices', { title: 'Car wash', body: 'Saturday at the gate.', audience, ...extra });
    expect((await mk(ADMIN, { type: 'org' })).statusCode).toBe(403);
    expect((await mk(ADMIN, { type: 'branch', id: 'br_grc002' })).statusCode).toBe(403);
    expect((await mk(ADMIN, { type: 'branch', id: 'br_grc001' })).statusCode).toBe(200);
    expect((await mk(JANE, { type: 'org' })).statusCode).toBe(403); // a member has no notice permission
    expect((await mk(ADMIN, { type: 'branch', id: 'br_grc001' }, { title: '' })).statusCode).toBe(400);
    expect((await mk(ADMIN, { type: 'branch', id: 'br_grc001' }, { body: 'x'.repeat(2001) })).statusCode).toBe(400);
    expect(await titles(JANE, '/me/notices')).toContain('Car wash');
    expect(await titles(AMINA, '/me/notices')).not.toContain('Car wash');
  });

  it('a scheduled notice waits for its time, and an expired one disappears', async () => {
    const id = (await call(OWNER, 'POST', '/notices', { title: 'Easter breakfast', body: 'Bring a dish.', audience: { type: 'org' }, publishAt: at(2 * HOUR), expiresAt: at(30 * HOUR) })).json().id;
    expect(await titles(JANE, '/me/notices')).not.toContain('Easter breakfast');
    expect((await call(OWNER, 'GET', '/notices')).json().find((n: any) => n.id === id).state).toBe('scheduled');
    ctx.clock.advance(3 * HOUR);
    expect(await titles(JANE, '/me/notices')).toContain('Easter breakfast');
    ctx.clock.advance(30 * HOUR);
    expect(await titles(JANE, '/me/notices')).not.toContain('Easter breakfast');
    expect((await call(OWNER, 'GET', '/notices')).json().find((n: any) => n.id === id).state).toBe('expired');
  });

  it('alerts members when it goes live, once, and never by SMS', async () => {
    const smsBefore = ctx.messaging.sent.length;
    await call(OWNER, 'POST', '/notices', { title: 'Service moved', body: 'The 10am service starts at 10:30 today.', audience: { type: 'branch', id: 'br_grc002' }, notify: true });
    expect((await inbox(AMINA)).filter((n) => n.title === 'Service moved')).toHaveLength(1);
    expect((await inbox(JANE)).some((n) => n.title === 'Service moved')).toBe(false);
    await runCommunityJobs(ctx);
    expect((await inbox(AMINA)).filter((n) => n.title === 'Service moved')).toHaveLength(1); // not again
    expect(ctx.messaging.sent.length).toBe(smsBefore);
  });

  it('archiving removes it at once, another church cannot touch it, and it is audited', async () => {
    const id = (await call(ADMIN, 'POST', '/notices', { title: 'Lost keys', body: 'Found near the gate.', audience: { type: 'branch', id: 'br_grc001' } })).json().id;
    expect(await titles(JANE, '/me/notices')).toContain('Lost keys');
    expect((await call(HOPE, 'POST', `/notices/${id}/archive`)).statusCode).toBe(404); // out of their scope reads as missing
    expect((await call(HOPE, 'GET', '/notices')).json().map((n: any) => n.id)).not.toContain(id);
    expect((await call(ADMIN, 'POST', `/notices/${id}/archive`)).json().status).toBe('archived');
    expect(await titles(JANE, '/me/notices')).not.toContain('Lost keys');
    expect((await call(ADMIN, 'PUT', `/notices/${id}`, { title: 'again' })).statusCode).toBe(409);
    const actions = (await call(PA1, 'GET', '/admin/audit/events?action=notice')).json().events.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['notice.create', 'notice.archive']));
  });
});

describe('events and RSVP (L134, L135)', () => {
  it('members see upcoming events meant for them', async () => {
    expect(await titles(JANE, '/me/events')).toEqual(expect.arrayContaining(['Christmas Carols Night', 'Day of prayer and fasting']));
    expect(await titles(JANE, '/me/events')).not.toContain('Youth Movie Night'); // a group event
    expect(await titles(PETER, '/me/events')).toContain('Youth Movie Night');
    expect(await titles(HOPE, '/me/events')).toEqual([]);
    const e = (await call(JANE, 'GET', '/me/events')).json().find((x: any) => x.title === 'Christmas Carols Night');
    expect(e).toMatchObject({ rsvp: true, capacity: 150, peopleComing: 3, spotsLeft: 147, myResponse: null }); // David and his two guests
  });

  it('a member says going with guests, changes their mind, and counts follow', async () => {
    const e = (await call(JANE, 'GET', '/me/events')).json().find((x: any) => x.title === 'Christmas Carols Night');
    const r = await call(JANE, 'POST', `/me/events/${e.id}/rsvp`, { response: 'going', guests: 3 });
    expect(r.json()).toMatchObject({ response: 'going', guests: 3, peopleComing: 7 });
    expect((await call(JANE, 'POST', `/me/events/${e.id}/rsvp`, { response: 'going', guests: 11 })).json().code).toBe('bad_guests');
    expect((await call(JANE, 'POST', `/me/events/${e.id}/rsvp`, { response: 'maybe' })).json().code).toBe('bad_response');
    expect((await call(JANE, 'POST', `/me/events/${e.id}/rsvp`, { response: 'not_going' })).json()).toMatchObject({ peopleComing: 3, spotsLeft: 147 });
    expect((await call(JANE, 'GET', '/me/events')).json().find((x: any) => x.id === e.id).myResponse).toBe('not_going');
  });

  it('cannot reply to an event that is not for you or does not ask for replies', async () => {
    const movie = (await call(PETER, 'GET', '/me/events')).json().find((x: any) => x.title === 'Youth Movie Night');
    expect((await call(JANE, 'POST', `/me/events/${movie.id}/rsvp`, { response: 'going' })).statusCode).toBe(404);
    const prayer = (await call(JANE, 'GET', '/me/events')).json().find((x: any) => x.title === 'Day of prayer and fasting');
    expect((await call(JANE, 'POST', `/me/events/${prayer.id}/rsvp`, { response: 'going' })).json().code).toBe('no_rsvp');
  });

  it('a full event takes no more going replies, but anyone can still change to not going', async () => {
    const id = (await call(OWNER, 'POST', '/events', { title: 'Marriage seminar', audience: { type: 'org' }, startsAt: at(2 * DAY), rsvp: true, capacity: 4 })).json().id;
    expect((await call(JANE, 'POST', `/me/events/${id}/rsvp`, { response: 'going', guests: 2 })).json().spotsLeft).toBe(1);
    expect((await call(DAVID, 'POST', `/me/events/${id}/rsvp`, { response: 'going', guests: 1 })).json().code).toBe('event_full'); // would need 2, only 1 left
    expect((await call(DAVID, 'POST', `/me/events/${id}/rsvp`, { response: 'going', guests: 0 })).json().spotsLeft).toBe(0);
    expect((await call(PETER, 'POST', `/me/events/${id}/rsvp`, { response: 'going' })).json().code).toBe('event_full');
    expect((await call(JANE, 'GET', '/me/events')).json().find((x: any) => x.id === id).full).toBe(true);
    expect((await call(DAVID, 'POST', `/me/events/${id}/rsvp`, { response: 'not_going' })).statusCode).toBe(200);
    expect((await call(PETER, 'POST', `/me/events/${id}/rsvp`, { response: 'going' })).statusCode).toBe(200);
    // staff cannot shrink it below the people already coming
    expect((await call(OWNER, 'PUT', `/events/${id}`, { capacity: 3 })).json().code).toBe('capacity_too_low');
  });

  it('staff see names and counts, never phone numbers, and only for what they manage', async () => {
    const id = (await call(OWNER, 'GET', '/events')).json().find((e: any) => e.title === 'Christmas Carols Night').id;
    const r = (await call(OWNER, 'GET', `/events/${id}/rsvps`)).json();
    expect(r.going).toEqual([{ name: 'David Wanjiku', guests: 2 }]);
    expect(JSON.stringify(r)).not.toMatch(/\b254\d{9}\b|\b07\d{8}\b/);
    expect((await call(HOPE, 'GET', `/events/${id}/rsvps`)).statusCode).toBe(404);
    expect((await call(JANE, 'GET', `/events/${id}/rsvps`)).statusCode).toBe(404);
    expect((await call(ADMIN, 'POST', '/events', { title: 'x', audience: { type: 'org' }, startsAt: at(DAY) })).statusCode).toBe(403);
    expect((await call(OWNER, 'POST', '/events', { title: 'Past', audience: { type: 'org' }, startsAt: at(-3 * DAY) })).json().code).toBe('bad_date');
    expect((await call(OWNER, 'POST', '/events', { title: 'Backwards', audience: { type: 'org' }, startsAt: at(2 * DAY), endsAt: at(DAY) })).json().code).toBe('bad_date');
  });

  it('moving an event tells the people going, and cancelling tells them and closes replies', async () => {
    const id = (await call(OWNER, 'POST', '/events', { title: 'Choir practice', audience: { type: 'org' }, startsAt: at(4 * DAY), rsvp: true })).json().id;
    await call(JANE, 'POST', `/me/events/${id}/rsvp`, { response: 'going' });
    await call(AMINA, 'POST', `/me/events/${id}/rsvp`, { response: 'not_going' });
    await call(OWNER, 'PUT', `/events/${id}`, { startsAt: at(5 * DAY) });
    expect((await inbox(JANE)).some((n) => n.title === 'An event has moved')).toBe(true);
    expect((await inbox(AMINA)).some((n) => n.title === 'An event has moved')).toBe(false);
    const c = await call(OWNER, 'POST', `/events/${id}/cancel`, { reason: 'The choir master is unwell.' });
    expect(c.json()).toMatchObject({ status: 'cancelled', told: 1 });
    expect((await inbox(JANE)).find((n) => n.title === 'An event was cancelled').body).toMatch(/choir master/);
    expect((await call(JANE, 'POST', `/me/events/${id}/rsvp`, { response: 'going' })).json().code).toBe('cancelled');
    expect((await call(OWNER, 'POST', `/events/${id}/cancel`, {})).statusCode).toBe(409);
    const actions = (await call(PA1, 'GET', '/admin/audit/events?action=event')).json().events.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['event.create', 'event.update', 'event.cancel']));
  });

  it('reminds the people going the day before, once', async () => {
    const id = (await call(OWNER, 'POST', '/events', { title: 'Cell leaders lunch', audience: { type: 'org' }, startsAt: at(3 * DAY), rsvp: true })).json().id;
    await call(JANE, 'POST', `/me/events/${id}/rsvp`, { response: 'going' });
    await call(AMINA, 'POST', `/me/events/${id}/rsvp`, { response: 'not_going' });
    ctx.clock.advance(1 * DAY);
    await runCommunityJobs(ctx);
    expect((await inbox(JANE)).some((n) => n.title === 'Coming up: Cell leaders lunch')).toBe(false); // still 2 days away
    ctx.clock.advance(1.5 * DAY);
    await runCommunityJobs(ctx);
    await runCommunityJobs(ctx);
    expect((await inbox(JANE)).filter((n) => n.title === 'Coming up: Cell leaders lunch')).toHaveLength(1);
    expect((await inbox(AMINA)).some((n) => n.title === 'Coming up: Cell leaders lunch')).toBe(false);
  });
});

describe('group walls (L136)', () => {
  const wall = async (who: string, g = YOUTH) => (await call(who, 'GET', `/me/groups/${g}/wall`)).json();

  it('only members can read a wall; everyone else gets not found, including church admins', async () => {
    const w = await wall(PETER);
    expect(w.group).toMatchObject({ id: YOUTH, role: 'leader' });
    expect(w.posts[0]).toMatchObject({ kind: 'announcement', pinned: true }); // pinned first
    expect(w.posts.some((p: any) => p.body.includes('speakers') && p.comments.length === 1)).toBe(true);
    expect((await call(JANE, 'GET', `/me/groups/${YOUTH}/wall`)).statusCode).toBe(404);
    expect((await call(HOPE, 'GET', `/me/groups/${YOUTH}/wall`)).statusCode).toBe(404);
    expect((await call(OWNER, 'GET', `/me/groups/${YOUTH}/wall`)).statusCode).toBe(404); // the owner is not in this group
    expect((await call(JANE, 'POST', `/me/groups/${YOUTH}/wall`, { body: 'let me in' })).statusCode).toBe(404);
    expect((await call(null, 'GET', `/me/groups/${YOUTH}/wall`)).statusCode).toBe(401);
  });

  it('members post and comment, only leaders announce, and the audit log never holds the words', async () => {
    const p = await call(AMINA, 'POST', `/me/groups/${YOUTH}/wall`, { body: 'Secret plan: surprise cake for Brian!' });
    expect(p.statusCode).toBe(200);
    expect((await call(AMINA, 'POST', `/me/groups/${YOUTH}/wall`, { body: 'Big news', kind: 'announcement' })).statusCode).toBe(403);
    expect((await call(AMINA, 'POST', `/me/groups/${YOUTH}/wall`, { body: '   ' })).statusCode).toBe(400);
    expect((await call(AMINA, 'POST', `/me/groups/${YOUTH}/wall`, { body: 'x'.repeat(1001) })).statusCode).toBe(400);
    expect((await call(PETER, 'POST', `/me/groups/${YOUTH}/wall/${p.json().id}/comments`, { body: 'Count me in' })).statusCode).toBe(200);
    const mine = (await wall(AMINA)).posts.find((x: any) => x.id === p.json().id);
    expect(mine).toMatchObject({ mine: true, author: 'Amina Hassan' });
    expect(mine.comments[0]).toMatchObject({ body: 'Count me in', mine: false });
    const log = JSON.stringify((await call(PA1, 'GET', '/admin/audit/events?action=wall')).json());
    expect(log).toMatch(/wall\.post/);
    expect(log).not.toMatch(/surprise cake|Count me in/);
  });

  it('a leader can pin and remove anything, a member only their own', async () => {
    const a = (await call(AMINA, 'POST', `/me/groups/${YOUTH}/wall`, { body: 'Off topic post' })).json().id;
    const r = (await call(AMINA, 'POST', `/me/groups/${YOUTH}/wall`, { body: 'My second post' })).json().id;
    expect((await call(AMINA, 'POST', `/me/groups/${YOUTH}/wall/${a}/pin`, {})).statusCode).toBe(403);
    expect((await call(PETER, 'POST', `/me/groups/${YOUTH}/wall/${a}/pin`, {})).json().pinned).toBe(true);
    expect((await wall(PETER)).posts.slice(0, 3).map((p: any) => p.id)).toContain(a);
    const other = (await call(PETER, 'POST', `/me/groups/${YOUTH}/wall`, { body: 'Peter own post' })).json().id;
    expect((await call(AMINA, 'POST', `/me/groups/${YOUTH}/wall/${other}/remove`)).statusCode).toBe(403);
    expect((await call(AMINA, 'POST', `/me/groups/${YOUTH}/wall/${r}/remove`)).statusCode).toBe(200); // their own
    expect((await call(PETER, 'POST', `/me/groups/${YOUTH}/wall/${a}/remove`)).statusCode).toBe(200); // a leader removes
    const ids = (await wall(PETER)).posts.map((p: any) => p.id);
    expect(ids).not.toContain(a);
    expect(ids).not.toContain(r);
    const withComment = (await wall(PETER)).posts.find((p: any) => p.comments.length);
    const cid = withComment.comments[0].id;
    expect((await call(DAVID, 'POST', `/me/groups/${YOUTH}/wall/${withComment.id}/comments/${cid}/remove`)).statusCode).toBe(404); // David is not in this group
    expect((await call(PETER, 'POST', `/me/groups/${YOUTH}/wall/${withComment.id}/comments/${cid}/remove`)).statusCode).toBe(200);
  });

  it('a group can be set so only leaders post, and a leader announcement can alert the group', async () => {
    await call(OWNER, 'PUT', `/groups/${YOUTH}`, { posting: 'leaders' });
    expect((await call(AMINA, 'POST', `/me/groups/${YOUTH}/wall`, { body: 'Can I post?' })).statusCode).toBe(403);
    expect((await wall(AMINA)).canPost).toBe(false);
    const c = (await wall(PETER)).posts[0].id;
    expect((await call(AMINA, 'POST', `/me/groups/${YOUTH}/wall/${c}/comments`, { body: 'Comments still work' })).statusCode).toBe(200);
    expect((await call(PETER, 'POST', `/me/groups/${YOUTH}/wall`, { body: 'Camp dates are out.', kind: 'announcement', notify: true })).statusCode).toBe(200);
    expect((await inbox(AMINA)).some((n) => n.title === 'New announcement in Youth Fellowship')).toBe(true);
    expect((await inbox(PETER)).some((n) => n.title === 'New announcement in Youth Fellowship')).toBe(false); // not told about their own post
    expect((await inbox(JANE)).some((n) => n.title === 'New announcement in Youth Fellowship')).toBe(false); // not in the group
    await call(OWNER, 'PUT', `/groups/${YOUTH}`, { posting: 'members' });
  });
});

describe('joining groups (L137)', () => {
  const PRAYER = 'grp_prayer';

  it('an open group can be found and asked to join, an invitation-only group cannot', async () => {
    const found = (await call(PETER, 'GET', '/me/groups/discover')).json();
    expect(found.map((g: any) => g.id)).toEqual([PRAYER]);
    expect(found[0]).toMatchObject({ name: 'Prayer Warriors', memberCount: 2, myRequest: null });
    expect((await call(PETER, 'POST', `/me/groups/${YOUTH}/join-request`)).json().code).toBe('invite_only'); // Youth is by invitation
    expect((await call(JANE, 'POST', '/me/groups/grp_mothers/join-request')).json().code).toBe('invite_only');
    expect((await call(DAVID, 'POST', `/me/groups/${PRAYER}/join-request`)).json().code).toBe('already_member');
    expect((await call(PETER, 'POST', '/me/groups/grp_nope/join-request')).statusCode).toBe(404);
    expect((await call(HOPE, 'GET', '/me/groups/discover')).json()).toEqual([]); // another church
    expect((await call(HOPE, 'POST', `/me/groups/${PRAYER}/join-request`)).statusCode).toBe(404);
  });

  it('a leader approves, the member gets in and can read the wall; a decline keeps them out', async () => {
    expect((await call(PETER, 'POST', `/me/groups/${PRAYER}/join-request`)).json().status).toBe('pending');
    expect((await call(AMINA, 'POST', `/me/groups/${PRAYER}/join-request`)).json().status).toBe('pending');
    expect((await call(PETER, 'GET', '/me/groups/discover')).json()[0].myRequest).toBe('pending');
    expect((await inbox(JANE)).some((n) => n.title === 'Someone wants to join Prayer Warriors')).toBe(true);
    expect((await call(PETER, 'GET', `/me/groups/${PRAYER}/wall`)).statusCode).toBe(404); // not in yet
    expect((await call(PETER, 'GET', `/me/groups/${PRAYER}/requests`)).statusCode).toBe(404);
    expect((await call(DAVID, 'GET', `/me/groups/${PRAYER}/requests`)).statusCode).toBe(403); // a member, not a leader
    const reqs = (await call(JANE, 'GET', `/me/groups/${PRAYER}/requests`)).json();
    expect(reqs.map((r: any) => r.name).sort()).toEqual(['Amina Hassan', 'Peter Otieno']);
    expect((await call(DAVID, 'POST', `/me/groups/${PRAYER}/requests/u_peter/decide`, { approve: true })).statusCode).toBe(403);
    expect((await call(JANE, 'POST', `/me/groups/${PRAYER}/requests/u_peter/decide`, { approve: true })).json().status).toBe('approved');
    expect((await call(JANE, 'POST', `/me/groups/${PRAYER}/requests/u_amina/decide`, { approve: false })).json().status).toBe('declined');
    expect((await call(JANE, 'POST', `/me/groups/${PRAYER}/requests/u_peter/decide`, { approve: true })).statusCode).toBe(404); // already decided
    expect((await call(PETER, 'GET', `/me/groups/${PRAYER}/wall`)).statusCode).toBe(200);
    expect((await call(AMINA, 'GET', `/me/groups/${PRAYER}/wall`)).statusCode).toBe(404);
    expect((await inbox(PETER)).some((n) => n.title === 'You are now in Prayer Warriors')).toBe(true);
    expect((await inbox(AMINA)).some((n) => n.title === 'Your request to join Prayer Warriors was not accepted')).toBe(true);
  });

  it('a request can be withdrawn, and an invitation-only group refuses requests', async () => {
    await call(OWNER, 'PUT', `/groups/${PRAYER}`, { joinPolicy: 'invite' });
    expect((await call(AMINA, 'POST', `/me/groups/${PRAYER}/join-request`)).json().code).toBe('invite_only');
    expect((await call(AMINA, 'GET', '/me/groups/discover')).json()).toEqual([]);
    await call(OWNER, 'PUT', `/groups/${PRAYER}`, { joinPolicy: 'request' });
    expect((await call(AMINA, 'POST', `/me/groups/${PRAYER}/join-request`)).json().status).toBe('pending');
    expect((await call(AMINA, 'POST', `/me/groups/${PRAYER}/join-request/withdraw`)).json().status).toBe('withdrawn');
    expect((await call(AMINA, 'POST', `/me/groups/${PRAYER}/join-request/withdraw`)).statusCode).toBe(404);
    expect((await call(JANE, 'GET', `/me/groups/${PRAYER}/requests`)).json()).toEqual([]);
    const g = (await call(OWNER, 'GET', `/groups/${PRAYER}`)).json();
    expect(g).toMatchObject({ joinPolicy: 'request', posting: 'members' });
  });
});
