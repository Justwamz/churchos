import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { runPrayerJobs } from './routes/prayer';

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

const OWNER = '0700000001', TREAS = '0700000002', ADMIN = '0700000003', COAST = '0700000004', HOPE = '0700000005', PA1 = '0700000099';
const PASTOR = '0700000557';
const JANE = '0711000001', PETER = '0711000002', AMINA = '0711000003', DAVID = '0711000004';
const MIN = 60_000, HOUR = 3600_000, DAY = 24 * HOUR, EAT = 3 * HOUR;
const inbox = async (who: string, app: 'member' | 'staff' = 'member') => (await call(who, 'GET', `/me/notifications?app=${app}`)).json().rows as any[];
const feed = async (who: string) => (await call(who, 'GET', '/me/prayer')).json().requests as any[];
const pray = (who: string, body: any) => call(who, 'POST', '/me/prayer', { body: 'Please pray for my family', ...body });

function when(dow: number, hhmm: string, minDays = 8): string {
  const base = new Date(ctx.clock.now().getTime() + EAT);
  let d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + minDays));
  while (d.getUTCDay() !== dow) d = new Date(d.getTime() + DAY);
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(d.getTime() + (h * 60 + m) * MIN - EAT).toISOString();
}

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
  const t = ctx.clock.now().toISOString();
  await ctx.db.query(`INSERT INTO users (id, phone, name, created_at) VALUES ('u_pastor','254700000557','Pastor Mary',$1)`, [t]);
  await ctx.db.query(`INSERT INTO role_assignments (id, org_id, user_id, role_id, scope_type, scope_id) VALUES ('ra_pastor','org_grace','u_pastor','org_grace:Pastor','branch','br_grc001')`);
}, 60000);

describe('prayer requests (L227, L228)', () => {
  let teamId = '';
  it('keeps a request for the prayer team to the author and the team', async () => {
    const r = await pray(JANE, { audience: 'team', body: 'My mother is very ill' });
    expect(r.statusCode).toBe(200);
    teamId = r.json().id;
    expect((await feed(JANE)).find((x) => x.id === teamId)).toMatchObject({ mine: true, audience: 'team', author: 'Jane Wanjiku', prayers: 0 });
    expect((await feed(PETER)).some((x) => x.id === teamId)).toBe(false);
    expect((await feed(DAVID)).some((x) => x.id === teamId)).toBe(false);
    const team = (await call(PASTOR, 'GET', '/prayer')).json().requests;
    expect(team.find((x: any) => x.id === teamId)).toMatchObject({ body: 'My mother is very ill', audience: 'team', author: 'Jane Wanjiku' });
    expect((await call(OWNER, 'GET', '/prayer')).statusCode).toBe(200);
    for (const who of [ADMIN, TREAS, JANE]) expect((await call(who, 'GET', '/prayer')).statusCode, who).toBeGreaterThanOrEqual(403);
    expect((await call(HOPE, 'GET', '/prayer')).json().requests).toEqual([]); // another church's team sees nothing of ours
    expect((await call(PETER, 'POST', `/me/prayer/${teamId}/pray`)).statusCode).toBe(404);
  });

  it('shares a request with a group, a branch or the whole church, and no further', async () => {
    const g = await pray(JANE, { audience: 'group', groupId: 'grp_prayer', body: 'For our prayer night' });
    const b = await pray(JANE, { audience: 'branch', body: 'Branch family: please pray for rain' });
    const c = await pray(JANE, { audience: 'church', body: 'For the whole church, our building plans' });
    expect([g, b, c].map((r) => r.statusCode)).toEqual([200, 200, 200]);
    const ids = { g: g.json().id, b: b.json().id, c: c.json().id };
    const seen = async (who: string) => (await feed(who)).map((x) => x.id);
    expect(await seen(DAVID)).toEqual(expect.arrayContaining([ids.g, ids.b, ids.c])); // same branch and group
    expect(await seen(PETER)).toEqual(expect.arrayContaining([ids.b, ids.c]));
    expect(await seen(PETER)).not.toContain(ids.g); // not in the group
    expect(await seen(AMINA)).toContain(ids.c); // another branch of the church
    expect(await seen(AMINA)).not.toContain(ids.b);
    expect(await seen(HOPE)).toEqual([]);
    expect((await feed(DAVID)).find((x) => x.id === ids.g).groupName).toBe('Prayer Warriors');
  });

  it('refuses mistakes', async () => {
    expect((await pray(JANE, { body: 'x' })).json().code).toBe('bad_content');
    expect((await pray(JANE, { audience: 'everyone' })).json().code).toBe('bad_audience');
    expect((await pray(JANE, { audience: 'group', groupId: 'nope' })).json().code).toBe('bad_group');
    expect((await pray(PETER, { audience: 'group', groupId: 'grp_prayer' })).json().code).toBe('bad_group'); // not one of Peter's groups
    expect((await pray(HOPE, {})).statusCode).toBe(403);
    expect((await call(null, 'POST', '/me/prayer', { body: 'hello there' })).statusCode).toBe(401);
  });

  it('can be sent without a name, and nobody else is ever shown it', async () => {
    const r = await pray(PETER, { audience: 'church', anonymous: true, body: 'I am struggling and need prayer' });
    const id = r.json().id;
    expect((await feed(DAVID)).find((x) => x.id === id)).toMatchObject({ author: 'A member', anonymous: true, mine: false });
    expect((await feed(PETER)).find((x) => x.id === id)).toMatchObject({ author: 'A member', mine: true });
    expect((await call(PASTOR, 'GET', '/prayer')).json().requests.find((x: any) => x.id === id)).toMatchObject({ author: 'A member', anonymous: true });
    const row = (await ctx.db.query<any>(`SELECT * FROM prayer_requests WHERE id=$1`, [id]))[0];
    expect(row.author_name).toBeNull();
    expect(JSON.stringify(row)).not.toContain('Peter');
  });

  it('lets people tap "I prayed" once, and counts them', async () => {
    const id = (await feed(DAVID)).find((x) => x.body.startsWith('For our prayer night')).id;
    expect((await call(DAVID, 'POST', `/me/prayer/${id}/pray`)).json()).toMatchObject({ prayers: 1, prayed: true });
    expect((await call(DAVID, 'POST', `/me/prayer/${id}/pray`)).json().prayers).toBe(1);
    expect((await call(JANE, 'POST', `/me/prayer/${id}/pray`)).json().prayers).toBe(2);
    expect((await feed(DAVID)).find((x) => x.id === id)).toMatchObject({ prayers: 2, prayed: true });
  });

  it('lets the author mark it answered or take it down, and no one else', async () => {
    const id = (await feed(JANE)).find((x) => x.id === teamId).id;
    expect((await call(PETER, 'POST', `/me/prayer/${id}/answered`)).statusCode).toBe(404);
    const c = (await feed(DAVID)).find((x) => x.body.startsWith('For the whole church'));
    expect((await call(DAVID, 'POST', `/me/prayer/${c.id}/answered`)).statusCode).toBe(403);
    expect((await call(DAVID, 'POST', `/me/prayer/${c.id}/withdraw`)).statusCode).toBe(403);
    expect((await call(JANE, 'POST', `/me/prayer/${id}/answered`, { note: 'She is recovering, thank you' })).statusCode).toBe(200);
    expect((await feed(JANE)).find((x) => x.id === id)).toMatchObject({ status: 'answered', answeredNote: 'She is recovering, thank you' });
    expect((await call(JANE, 'POST', `/me/prayer/${c.id}/withdraw`)).statusCode).toBe(200);
    expect((await feed(DAVID)).some((x) => x.id === c.id)).toBe(false);
    expect((await feed(JANE)).find((x) => x.id === c.id)).toMatchObject({ status: 'hidden', takenDownBy: 'you' });
  });

  it('lets the prayer team answer and hide a request, with a reason that is recorded and told to the author', async () => {
    const b = (await feed(DAVID)).find((x) => x.body.startsWith('Branch family'));
    expect((await call(PASTOR, 'POST', `/prayer/${b.id}/hide`, {})).json().code).toBe('bad_content');
    expect((await call(ADMIN, 'POST', `/prayer/${b.id}/hide`, { reason: 'x' })).statusCode).toBeGreaterThanOrEqual(403);
    expect((await call(PASTOR, 'POST', `/prayer/${b.id}/hide`, { reason: 'Please keep requests to prayer' })).statusCode).toBe(200);
    expect((await feed(DAVID)).some((x) => x.id === b.id)).toBe(false);
    expect((await feed(JANE)).find((x) => x.id === b.id)).toMatchObject({ status: 'hidden', takenDownBy: 'team' }); // the author still sees it, as hidden
    expect((await inbox(JANE)).some((n) => /taken off the shared list/.test(n.title) && /keep requests to prayer/.test(n.body))).toBe(true);
    expect((await call(PASTOR, 'POST', `/prayer/${b.id}/hide`, { restore: true })).statusCode).toBe(200);
    expect((await feed(DAVID)).some((x) => x.id === b.id)).toBe(true);
    expect((await call(PASTOR, 'POST', `/prayer/${b.id}/answer`, { note: 'Rain came' })).statusCode).toBe(200);
    const audit = (await call(PA1, 'GET', '/admin/audit/events?action=prayer.hidden')).json().events;
    expect(audit[0].reason).toBe('Please keep requests to prayer');
    expect(JSON.stringify(audit)).not.toContain('Branch family');
  });

  it('limits how many a person can send in a day', async () => {
    let last: any;
    for (let i = 0; i < 12; i++) last = await pray(AMINA, { audience: 'team', body: `Prayer number ${i} please` });
    expect(last.json().code).toBe('too_many');
  });

  it('shows a request for 60 days, 14 after it is answered, and removes the words after a year', async () => {
    const old = new Date(ctx.clock.now().getTime() - 70 * DAY).toISOString();
    await ctx.db.query(`INSERT INTO prayer_requests (id, org_id, branch_id, body, audience, anonymous, author_name, created_at, updated_at) VALUES ('pr_old','org_grace','br_grc001','An old request','church',false,'Jane Wanjiku',$1,$1)`, [old]);
    expect((await feed(DAVID)).some((x) => x.id === 'pr_old')).toBe(false);
    const ancient = new Date(ctx.clock.now().getTime() - 400 * DAY).toISOString();
    await ctx.db.query(`INSERT INTO prayer_requests (id, org_id, branch_id, body, audience, anonymous, author_name, created_at, updated_at) VALUES ('pr_ancient','org_grace','br_grc001','A very old request','church',false,'Jane Wanjiku',$1,$1)`, [ancient]);
    expect((await runPrayerJobs(ctx)).removed).toBeGreaterThanOrEqual(1);
    const rows = await ctx.db.query<any>(`SELECT id, body FROM prayer_requests WHERE id IN ('pr_old','pr_ancient')`);
    expect(rows.find((r) => r.id === 'pr_ancient').body).toBe('[removed]');
    expect(rows.find((r) => r.id === 'pr_old').body).toBe('An old request');
  });
});

describe('the notice and helplines (L229)', () => {
  it('shows members what is private, the limits, and where to get help', async () => {
    const info = (await call(JANE, 'GET', '/me/pastoral/info')).json();
    expect(info.notice).toMatch(/private/);
    expect(info.notice).toMatch(/at risk of serious harm/);
    expect(info.helplines.map((h: any) => h.phone)).toEqual(['999', '116', '1195', '1199']);
    expect(info.groups.map((g: any) => g.name)).toContain('Prayer Warriors');
  });

  it('lets people who manage every branch change the helplines, and nobody else', async () => {
    const mine = [{ name: 'Grace Counselling Line', phone: '0700 111 222', note: 'Weekdays 9 to 5' }, { name: 'Emergency', phone: '999', note: '' }];
    expect((await call(ADMIN, 'PUT', '/pastoral/settings', { helplines: mine })).statusCode).toBe(403); // one branch only
    expect((await call(JANE, 'PUT', '/pastoral/settings', { helplines: mine })).statusCode).toBe(403);
    expect((await call(OWNER, 'PUT', '/pastoral/settings', { helplines: [] })).json().code).toBe('bad_helplines');
    expect((await call(OWNER, 'PUT', '/pastoral/settings', { helplines: [{ name: 'Bad', phone: 'call me' }] })).json().code).toBe('bad_helplines');
    expect((await call(OWNER, 'GET', '/pastoral/settings')).json()).toMatchObject({ standard: true, canEdit: true });
    expect((await call(ADMIN, 'GET', '/pastoral/settings')).json().canEdit).toBe(false);
    expect((await call(OWNER, 'PUT', '/pastoral/settings', { helplines: mine })).statusCode).toBe(200);
    expect((await call(OWNER, 'GET', '/pastoral/settings')).json().standard).toBe(false);
    expect((await call(JANE, 'GET', '/me/pastoral/info')).json().helplines.map((h: any) => h.name)).toEqual(['Grace Counselling Line', 'Emergency']);
  });
});

describe('talking to a pastor is a booking, with a meeting link (L225)', () => {
  let id = '';
  const book = () => call(JANE, 'POST', '/me/bookings', { resourceIds: ['res_pastor'], startsAt: when(1, '10:00'), endsAt: new Date(Date.parse(when(1, '10:00')) + 30 * MIN).toISOString(), title: 'Counselling' });

  it('can be added once the pastor has said yes, and is seen only by the member and the people who look after it', async () => {
    const b = await book();
    expect(b.statusCode, JSON.stringify(b.json())).toBe(200);
    id = b.json().id;
    expect((await call(OWNER, 'POST', `/bookings/${id}/meeting-link`, { url: 'https://meet.example.org/abc' })).json().code).toBe('wrong_state'); // not approved yet
    expect((await call(OWNER, 'POST', `/bookings/${id}/items/res_pastor/decide`, { approve: true })).statusCode).toBe(200);
    expect((await call(JANE, 'POST', `/bookings/${id}/meeting-link`, { url: 'https://meet.example.org/abc' })).statusCode).toBe(404); // the member cannot set it
    expect((await call(TREAS, 'POST', `/bookings/${id}/meeting-link`, { url: 'https://meet.example.org/abc' })).statusCode).toBe(404);
    expect((await call(OWNER, 'POST', `/bookings/${id}/meeting-link`, { url: 'http://meet.example.org/abc' })).json().code).toBe('bad_link');
    expect((await call(OWNER, 'POST', `/bookings/${id}/meeting-link`, { url: 'https://meet.google.com/abc-defg-hij' })).json()).toMatchObject({ ok: true, meetingUrl: 'https://meet.google.com/abc-defg-hij' });
    const mine = (await call(JANE, 'GET', '/me/bookings')).json().find((x: any) => x.id === id);
    expect(mine.meetingUrl).toBe('https://meet.google.com/abc-defg-hij');
    expect((await inbox(JANE)).some((n) => /meeting link is ready/.test(n.title))).toBe(true);
    const staff = (await call(OWNER, 'GET', `/bookings/${id}`)).json();
    expect(staff.meetingUrl).toBe('https://meet.google.com/abc-defg-hij');
    expect((await call(ADMIN, 'GET', `/bookings/${id}`)).json().meetingUrl).toBe('https://meet.google.com/abc-defg-hij'); // a manager can see and change it
    expect((await call(PA1, 'GET', '/admin/audit/events?action=booking.meeting_link')).json().events.length).toBeGreaterThan(0);
  });

  it('can be changed or removed', async () => {
    expect((await call(ADMIN, 'POST', `/bookings/${id}/meeting-link`, { url: 'https://zoom.example.org/j/123' })).json().meetingUrl).toBe('https://zoom.example.org/j/123');
    expect((await call(OWNER, 'POST', `/bookings/${id}/meeting-link`, { url: null })).json().meetingUrl).toBeNull();
    expect((await call(JANE, 'GET', '/me/bookings')).json().find((x: any) => x.id === id).meetingUrl).toBeNull();
  });
});

describe('the suggestion box (L231)', () => {
  let named = '';
  let anon = '';
  const send = (who: string, body: any) => call(who, 'POST', '/me/suggestions', { category: 'worship', body: 'Could we start the service ten minutes later?', ...body });

  it('takes a named suggestion and an anonymous one from members only', async () => {
    expect((await send(JANE, { body: 'short' })).json().code).toBe('bad_content');
    expect((await send(JANE, { category: 'nonsense' })).json().code).toBe('bad_category');
    expect((await send(HOPE, {})).statusCode).toBe(403);
    expect((await call(null, 'POST', '/me/suggestions', {})).statusCode).toBe(401);
    named = (await send(JANE, {})).json().id;
    anon = (await send(PETER, { category: 'facilities', body: 'The side door is hard to open for wheelchairs', anonymous: true })).json().id;
    expect((await call(JANE, 'GET', '/me/suggestions/info')).json().categories.map((c: any) => c.key)).toEqual(['worship', 'facilities', 'children_youth', 'giving', 'communication', 'other']);
  });

  it('shows the church a named suggestion with a name and an anonymous one with nothing', async () => {
    const r = (await call(OWNER, 'GET', '/suggestions')).json();
    const n = r.suggestions.find((s: any) => s.id === named);
    const a = r.suggestions.find((s: any) => s.id === anon);
    expect(n).toMatchObject({ author: 'Jane Wanjiku', anonymous: false, status: 'new', categoryLabel: 'Worship and services' });
    expect(a).toMatchObject({ author: 'Anonymous', anonymous: true, branch: 'Grace Nairobi' });
    expect(JSON.stringify(a)).not.toMatch(/Peter|u_peter|254711000002/);
    const row = (await ctx.db.query<any>(`SELECT * FROM suggestions WHERE id=$1`, [anon]))[0];
    expect(row.membership_id).toBeNull();
    expect(row.author_name).toBeNull();
    expect(r.summary.new).toBeGreaterThanOrEqual(2);
    expect((await call(ADMIN, 'GET', '/suggestions')).statusCode).toBe(200); // branch admin: yes
    for (const who of [TREAS, COAST, JANE]) expect((await call(who, 'GET', '/suggestions')).statusCode, who).toBeGreaterThanOrEqual(403);
    expect((await call(HOPE, 'GET', '/suggestions')).json?.().suggestions ?? []).toEqual([]);
    expect((await inbox(OWNER, 'staff')).some((n) => n.title === 'New suggestion')).toBe(true);
  });

  it('lets each member see their own suggestions, anonymous ones included, and nobody else', async () => {
    expect((await call(PETER, 'GET', '/me/suggestions')).json().suggestions.map((s: any) => s.id)).toEqual([anon]);
    expect((await call(PETER, 'GET', '/me/suggestions')).json().suggestions[0].anonymous).toBe(true);
    expect((await call(JANE, 'GET', '/me/suggestions')).json().suggestions.map((s: any) => s.id)).toEqual([named]);
    expect((await call(DAVID, 'GET', '/me/suggestions')).json().suggestions).toEqual([]);
  });

  it('is answered with a status and a reply, which even an anonymous sender gets', async () => {
    expect((await call(OWNER, 'POST', `/suggestions/${anon}`, { status: 'done' })).json().code).toBe('reply_required');
    expect((await call(OWNER, 'POST', `/suggestions/${anon}`, { status: 'wrong' })).json().code).toBe('bad_status');
    expect((await call(OWNER, 'POST', `/suggestions/${anon}`, { publish: true })).json().code).toBe('reply_required');
    expect((await call(TREAS, 'POST', `/suggestions/${anon}`, { status: 'under_review' })).statusCode).toBeGreaterThanOrEqual(403);
    expect((await call(OWNER, 'POST', `/suggestions/${anon}`, { status: 'under_review' })).statusCode).toBe(200);
    expect((await call(ADMIN, 'POST', `/suggestions/${anon}`, { status: 'done', response: 'We have fitted an automatic door opener.' })).statusCode).toBe(200);
    const mine = (await call(PETER, 'GET', '/me/suggestions')).json().suggestions[0];
    expect(mine).toMatchObject({ status: 'done', statusLabel: 'Done', response: 'We have fitted an automatic door opener.' });
    expect((await inbox(PETER)).some((n) => n.title === 'Your suggestion has an answer' && /automatic door opener/.test(n.body))).toBe(true);
    const staff = (await call(OWNER, 'GET', '/suggestions?status=done')).json().suggestions;
    expect(staff.map((s: any) => s.id)).toEqual([anon]);
  });

  it('can be shared with the branch as "You said, we did", without the sender', async () => {
    expect((await call(OWNER, 'POST', `/suggestions/${anon}`, { publish: true })).statusCode).toBe(200);
    const pub = (await call(DAVID, 'GET', '/me/suggestions/published')).json().suggestions;
    expect(pub).toHaveLength(1);
    expect(pub[0]).toMatchObject({ body: 'The side door is hard to open for wheelchairs', response: 'We have fitted an automatic door opener.', statusLabel: 'Done' });
    expect(JSON.stringify(pub)).not.toMatch(/Peter|author/);
    expect((await call(AMINA, 'GET', '/me/suggestions/published')).json().suggestions).toEqual([]); // another branch
    expect((await call(HOPE, 'GET', '/me/suggestions/published')).json().suggestions).toEqual([]);
    expect((await call(OWNER, 'GET', '/suggestions?csv=1')).body).toContain('Suggestion');
    expect((await call(PA1, 'GET', '/admin/audit/events?action=suggestion.updated')).json().events.length).toBeGreaterThan(0);
  });

  it('limits how many a person can send in a day', async () => {
    let last: any;
    for (let i = 0; i < 6; i++) last = await send(DAVID, { body: `Suggestion number ${i}, please consider it` });
    expect(last.json().code).toBe('too_many');
  });

  it('keeps the books balanced', async () => {
    expect((await call(PA1, 'GET', '/admin/reconcile')).json().ok).toBe(true);
  });
});
