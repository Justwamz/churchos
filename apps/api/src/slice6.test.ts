import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { allocate, costOf, recordUnits } from './pricing';
import { gradientPng } from './artwork';

let app: Awaited<ReturnType<typeof buildApp>>['app'];
let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
const tokens: Record<string, string> = {};
async function login(phone: string) {
  if (tokens[phone]) return tokens[phone];
  const r = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: '123456' } });
  tokens[phone] = r.json().token;
  return tokens[phone];
}
const call = async (phone: string | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: any) =>
  app.inject({ method, url, payload, headers: phone ? { authorization: `Bearer ${await login(phone)}` } : {} });

const OWNER = '0700000001', ADMIN = '0700000003', HOPE = '0700000005', PA1 = '0700000099';
const JANE = '0711000001', PETER = '0711000002', AMINA = '0711000003';
const wait = async (fn: () => Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
const art = (w = 1280, h = 720) => ({ mime: 'image/png', data: gradientPng(w, h, [10, 80, 90], [5, 30, 50]) });
const mine = async (who: string) => (await call(who, 'GET', '/me/adverts')).json() as any[];
const titles = async (who: string) => (await mine(who)).map((a) => a.title);

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);

const VOLUME = [{ upTo: 3500, price: 95 }, { upTo: 15000, price: 85 }, { upTo: null, price: 70 }];

describe('tariffs: marginal monthly bands (L124, L125)', () => {
  it('prices each message in the band it falls in, so the whole month is never repriced', () => {
    expect(costOf(VOLUME, 0, 3500)).toBe(3500 * 95);
    expect(costOf(VOLUME, 3499, 2)).toBe(95 + 85); // the 3,500th and 3,501st
    expect(costOf(VOLUME, 3400, 200)).toBe(100 * 95 + 100 * 85);
    expect(costOf(VOLUME, 15000, 1)).toBe(70);
    expect(costOf(VOLUME, 14999, 3)).toBe(85 + 70 + 70);
    expect(costOf([{ upTo: null, price: 100 }], 0, 7)).toBe(700);
  });

  it('a wallet that runs short pays for as many as it can afford, across a band boundary', () => {
    const a = allocate(VOLUME, 3498, 95 + 95 + 85 + 10, 5, 1);
    expect(a.costs).toEqual([95, 95, 85]);
    expect(a.spent).toBe(275);
    expect(a.usedAfter).toBe(3501);
  });

  it('only a platform admin can see or change tariffs', async () => {
    expect((await call(OWNER, 'GET', '/admin/tariffs')).statusCode).toBe(403);
    expect((await call(OWNER, 'POST', '/admin/tariffs', { name: 'Mine', bands: { sms: [{ upTo: null, price: 50 }], whatsapp: [{ upTo: null, price: 150 }] } })).statusCode).toBe(403);
    const list = (await call(PA1, 'GET', '/admin/tariffs')).json();
    expect(list.map((t: any) => t.name)).toEqual(expect.arrayContaining(['Standard', 'Volume bands']));
    expect(list.find((t: any) => t.isDefault).name).toBe('Standard');
    expect(list.find((t: any) => t.name === 'Volume bands').churches.map((c: any) => c.name)).toEqual(['New Hope Fellowship']);
  });

  it('rejects bands that do not make sense', async () => {
    const bad = async (sms: any) => (await call(PA1, 'POST', '/admin/tariffs', { name: `Bad ${Math.random()}`, bands: { sms, whatsapp: [{ upTo: null, price: 300 }] } })).statusCode;
    expect(await bad([{ upTo: 3500, price: 95 }, { upTo: 1000, price: 85 }, { upTo: null, price: 70 }])).toBe(400); // not rising
    expect(await bad([{ upTo: 3500, price: 95 }])).toBe(400); // the last band must be open ended
    expect(await bad([{ upTo: null, price: 0 }])).toBe(400); // free messages are not a price
    expect(await bad([])).toBe(400);
  });

  it('creates a tariff, versions changes with a date, and never backdates', async () => {
    const made = await call(PA1, 'POST', '/admin/tariffs', { name: 'Growth', bands: { sms: [{ upTo: 1000, price: 90 }, { upTo: null, price: 80 }], whatsapp: [{ upTo: null, price: 250 }] } });
    expect(made.statusCode).toBe(200);
    const id = made.json().id;
    const past = new Date(ctx.clock.now().getTime() - 3 * 86400_000).toISOString();
    expect((await call(PA1, 'PUT', `/admin/tariffs/${id}`, { bands: { sms: [{ upTo: null, price: 60 }], whatsapp: [{ upTo: null, price: 250 }] }, effectiveFrom: past })).json().code).toBe('in_past');
    expect((await call(PA1, 'PUT', `/admin/tariffs/${id}`, { bands: { sms: [{ upTo: 1000, price: 90 }, { upTo: null, price: 80 }], whatsapp: [{ upTo: null, price: 250 }] } })).json().code).toBe('no_change');
    const later = new Date(ctx.clock.now().getTime() + 5 * 86400_000).toISOString();
    expect((await call(PA1, 'PUT', `/admin/tariffs/${id}`, { bands: { sms: [{ upTo: null, price: 60 }], whatsapp: [{ upTo: null, price: 250 }] }, effectiveFrom: later })).json().version).toBe(2);
    const t = (await call(PA1, 'GET', '/admin/tariffs')).json().find((x: any) => x.id === id);
    expect(t.current.version).toBe(1); // the new prices wait for their date
    expect(t.versions.find((v: any) => v.version === 2).scheduled).toBe(true);
    const events = (await call(PA1, 'GET', '/admin/audit/events?action=tariff')).json().events.map((e: any) => e.action);
    expect(events).toEqual(expect.arrayContaining(['tariff.create', 'tariff.update']));
  });

  it('a calculator shows what a send would cost across the bands', async () => {
    const q = (await call(PA1, 'POST', '/admin/tariffs/quote', { bands: VOLUME, used: 3400, count: 200 })).json();
    expect(q.total).toBe(18000);
    expect(q.breakdown).toEqual([{ from: 3401, to: 3500, price: 95, units: 100, cost: 9500 }, { from: 3501, to: 3600, price: 85, units: 100, cost: 8500 }]);
    expect((await call(PA1, 'POST', '/admin/tariffs/quote', { bands: VOLUME, count: 0 })).statusCode).toBe(400);
  });

  it('a church can be given its own tariff, and goes back to the default when it is removed', async () => {
    const made = (await call(PA1, 'POST', '/admin/tariffs', { name: 'Grace deal', bands: { sms: [{ upTo: null, price: 80 }], whatsapp: [{ upTo: null, price: 250 }] } })).json();
    expect((await call(PA1, 'PUT', '/admin/orgs/org_grace/tariff', { tariffId: made.id })).statusCode).toBe(200);
    expect((await call(OWNER, 'GET', '/wallets')).json().rates).toEqual({ sms: 80, whatsapp: 250 });
    expect((await call(OWNER, 'PUT', '/admin/orgs/org_grace/tariff', { tariffId: null })).statusCode).toBe(403);
    expect((await call(PA1, 'PUT', '/admin/orgs/org_grace/tariff', { tariffId: null })).statusCode).toBe(200);
    expect((await call(OWNER, 'GET', '/wallets')).json().rates).toEqual({ sms: 100, whatsapp: 300 });
  });

  it('the month decides the band, and a new month starts again at the first band', async () => {
    expect((await call(PA1, 'PUT', '/admin/orgs/org_grace/tariff', { tariffId: 'tar_volume' })).statusCode).toBe(200);
    const price = async () => (await call(OWNER, 'GET', '/wallets')).json().wallets.find((w: any) => w.id === 'wal:org_grace:sms').price;
    const used = (await price()).usedThisMonth; // earlier tests in this file have already sent a few
    expect(await price()).toMatchObject({ current: 95 });
    await recordUnits(ctx, 'org_grace', 'sms', 3500 - used);
    expect(await price()).toMatchObject({ current: 85, usedThisMonth: 3500 });
    await ctx.db.query(`UPDATE message_usage SET month='2000-01'`); // pretend that was an earlier month
    expect(await price()).toMatchObject({ current: 95, usedThisMonth: 0 });
    await call(PA1, 'PUT', '/admin/orgs/org_grace/tariff', { tariffId: null });
  });
});

describe('providers and sender names belong to the platform (L128)', () => {
  it('lists the providers for platform admins only, with credentials masked', async () => {
    expect((await call(OWNER, 'GET', '/admin/providers')).statusCode).toBe(403);
    const p = await call(PA1, 'GET', '/admin/providers');
    expect(p.statusCode).toBe(200);
    expect(JSON.stringify(p.json())).not.toMatch(/secret|password/i);
  });

  it('a church cannot read or decide sender requests', async () => {
    expect((await call(OWNER, 'GET', '/admin/sender-requests')).statusCode).toBe(403);
    expect((await call(OWNER, 'POST', '/admin/sender-requests/x/decide', { approve: true })).statusCode).toBe(403);
  });
});

describe('alert email (L123)', () => {
  it('rejects a wrong code, and keeps the email unconfirmed until the right one is used', async () => {
    const r = await call(ADMIN, 'PUT', '/me/profile', { email: 'samuel.new@gracechurch.org' });
    expect(r.statusCode).toBe(200);
    expect((await call(ADMIN, 'POST', '/me/profile/verify', { code: '000000' })).statusCode).toBe(400);
    expect((await call(ADMIN, 'GET', '/me/profile')).json().emailVerified).toBe(false);
    expect((await call(ADMIN, 'POST', '/me/profile/verify', { code: r.json().devCode })).statusCode).toBe(200);
    expect((await call(ADMIN, 'GET', '/me/profile')).json()).toMatchObject({ email: 'samuel.new@gracechurch.org', emailVerified: true });
  });

  it('a person who receives alerts cannot remove their email, while members are not forced to have one', async () => {
    expect((await call(OWNER, 'GET', '/me/profile')).json().emailRequired).toBe(true);
    expect((await call(OWNER, 'PUT', '/me/profile', { email: '' })).statusCode).toBe(400);
    expect((await call(JANE, 'GET', '/me/profile')).json().emailRequired).toBe(false);
    expect((await call(JANE, 'PUT', '/me/profile', { email: '' })).statusCode).toBe(200);
  });
});

describe('children (L125)', () => {
  it('reaches a child through their guardians, once each, with the child named, and never directly', async () => {
    const now = ctx.clock.now().toISOString();
    // A second child for Jane, to prove she gets one message and not two.
    await ctx.db.query(
      `INSERT INTO memberships (id, org_id, branch_id, user_id, full_name, phone, member_number, category, dob, sex, consent_at, consent_by, joined_at)
       VALUES ('m_sam','org_grace','br_grc001',NULL,'Sam Wanjiku',NULL,'M00099','child','2018-03-03','male',$1,'u_admin',$1)`,
      [now],
    );
    await ctx.db.query(`INSERT INTO guardians (child_id, guardian_id, org_id) VALUES ('m_sam','m_jane','org_grace')`);
    const before = ctx.messaging.sent.length;
    const r = await call(OWNER, 'POST', '/messages', { audience: { scope: { type: 'org' }, who: 'children' }, channels: ['inapp', 'sms'], title: 'Children’s day', body: 'Hello {name}, bring a snack on Saturday.' });
    expect(r.statusCode).toBe(200);
    const sent = ctx.messaging.sent.slice(before).filter((s) => s.channel === 'sms');
    const tos = sent.map((s) => s.to).sort();
    expect(new Set(tos).size).toBe(tos.length); // nobody twice
    const jane = sent.find((s) => s.to === '254711000001')!;
    expect(jane.body).toMatch(/^For Ruth and Sam: Hello Jane,/);
    expect(sent.find((s) => s.to === '254711000002')!.body).toMatch(/^For Brian: /);
    expect(sent.some((s) => s.to === '254711000004')).toBe(false); // David opted out of SMS
    const inbox = (await call(JANE, 'GET', '/me/notifications')).json().rows.filter((n: any) => n.title === 'Children’s day');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ for_name: 'Ruth, Sam', member_id: null });
    expect(inbox[0].body).toMatch(/^For Ruth and Sam:/);
    const peter = (await call(PETER, 'GET', '/me/notifications')).json().rows.find((n: any) => n.title === 'Children’s day');
    expect(peter).toMatchObject({ for_name: 'Brian', member_id: 'm_brian' });
  });

  it('a guardian who is also in the audience as an adult gets the message once, without the child prefix', async () => {
    const r = await call(OWNER, 'POST', '/messages', { audience: { scope: { type: 'org' }, who: 'all' }, channels: ['inapp'], title: 'Everyone', body: 'Hello {name}, all welcome.' });
    expect(r.statusCode).toBe(200);
    const mine = (await call(JANE, 'GET', '/me/notifications')).json().rows.filter((n: any) => n.title === 'Everyone');
    expect(mine).toHaveLength(1);
    expect(mine[0].body).toBe('Hello Jane, all welcome.');
  });

  it('a gift made from the member app is confirmed in the app', async () => {
    const g = await call(JANE, 'POST', '/public/give', { code: 'GRC001', phone: '0711000001', amount: 700, purpose: 'TITHE', method: 'mpesa' });
    expect(g.statusCode).toBe(200);
    expect(await wait(async () => (await call(JANE, 'GET', '/me/notifications')).json().rows.some((n: any) => n.kind === 'receipt' && /700/.test(n.body)))).toBe(true);
  });
});

describe('adverts: artwork rules (L131)', () => {
  const make = (image: any, extra: any = {}) => call(ADMIN, 'POST', '/adverts', { title: 'Test', audience: { type: 'branch', id: 'br_grc001' }, image, ...extra });

  it('accepts widescreen artwork and refuses what would look wrong', async () => {
    expect((await make(art())).statusCode).toBe(200);
    expect((await make(art(800, 800))).json().code).toBe('artwork_ratio');
    expect((await make(art(640, 360))).json().code).toBe('artwork_too_small');
    expect((await make({ mime: 'image/gif', data: art().data })).json().code).toBe('bad_artwork');
    expect((await make({ mime: 'image/jpeg', data: art().data })).json().code).toBe('bad_artwork'); // a PNG labelled as JPEG
    expect((await make({ mime: 'image/png', data: Buffer.alloc(1_200_000, 1).toString('base64') })).json().code).toBe('artwork_too_large');
    expect((await make(null)).statusCode).toBe(400);
  });

  it('checks the text, link and dates', async () => {
    expect((await make(art(), { title: '' })).statusCode).toBe(400);
    expect((await make(art(), { link: 'javascript:alert(1)' })).json().code).toBe('bad_link');
    expect((await make(art(), { startsAt: '2030-01-02', endsAt: '2030-01-01' })).json().code).toBe('bad_date');
    expect((await make(art(), { advertiser: { name: 'Acme' } })).json().code).toBe('bad_amount'); // a third-party advert needs a price
  });

  it('only people who manage the audience can advertise to it', async () => {
    expect((await call(ADMIN, 'POST', '/adverts', { title: 'Whole church', audience: { type: 'org' }, image: art() })).statusCode).toBe(403); // Samuel runs one branch
    expect((await call(OWNER, 'POST', '/adverts', { title: 'Whole church', audience: { type: 'org' }, image: art() })).statusCode).toBe(200);
    expect((await call(ADMIN, 'POST', '/adverts', { title: 'Other branch', audience: { type: 'branch', id: 'br_grc002' }, image: art() })).statusCode).toBe(403);
    expect((await call(JANE, 'POST', '/adverts', { title: 'Nope', audience: { type: 'org' }, image: art() })).statusCode).toBe(403);
  });
});

describe('adverts: approval, audience and the member slider (L131, L132)', () => {
  let id = '';

  it('seeded adverts reach the right people', async () => {
    expect(await titles(JANE)).toEqual(expect.arrayContaining(['Christmas Carols Night']));
    expect(await titles(JANE)).not.toContain('Youth Movie Night'); // Jane is not in the youth group
    expect(await titles(PETER)).toContain('Youth Movie Night');
    expect(await titles(AMINA)).toContain('Youth Movie Night');
    expect(await titles(JANE)).not.toContain('Mothers Union Bake Sale'); // still waiting for approval
    expect(await titles(JANE)).not.toContain('Mary and John are getting married'); // waiting for payment
    expect(await titles(HOPE)).toEqual([]); // another church's members see nothing of it
  });

  it('a new advert stays hidden until a different person approves it', async () => {
    const made = await call(ADMIN, 'POST', '/adverts', { title: 'Harvest Sunday', body: 'Bring your first fruits.', audience: { type: 'branch', id: 'br_grc001' }, image: art(), link: 'https://example.org/harvest' });
    id = made.json().id;
    expect(await titles(JANE)).not.toContain('Harvest Sunday');
    expect((await call(ADMIN, 'POST', `/adverts/${id}/decide`, { approve: true })).statusCode).toBe(409); // not submitted yet
    expect((await call(ADMIN, 'POST', `/adverts/${id}/submit`)).statusCode).toBe(200);
    const own = await call(ADMIN, 'POST', `/adverts/${id}/decide`, { approve: true });
    expect(own.statusCode).toBe(403);
    expect(own.json().code).toBe('same_person');
    expect((await call(ADMIN, 'GET', `/adverts/${id}`)).json().canApprove).toBe(false);
    expect((await call(OWNER, 'GET', `/adverts/${id}`)).json().canApprove).toBe(true);
    expect((await call(OWNER, 'POST', `/adverts/${id}/decide`, { approve: false })).json().code).toBe('reason_required');
    expect((await call(OWNER, 'POST', `/adverts/${id}/decide`, { approve: true })).json().status).toBe('approved');
    expect((await call(OWNER, 'POST', `/adverts/${id}/decide`, { approve: true })).statusCode).toBe(409);
    expect(await titles(JANE)).toContain('Harvest Sunday');
    expect(await titles(AMINA)).not.toContain('Harvest Sunday'); // Amina belongs to the other branch
    const note = (await call(ADMIN, 'GET', '/me/notifications?app=staff')).json().rows.map((n: any) => n.title);
    expect(note).toContain('Your advert is approved');
  });

  it('the artwork is served only to people who may see the advert', async () => {
    const ok = await call(JANE, 'GET', `/me/adverts/${id}/image`);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/png');
    expect((await call(AMINA, 'GET', `/me/adverts/${id}/image`)).statusCode).toBe(404);
    expect((await call(HOPE, 'GET', `/me/adverts/${id}/image`)).statusCode).toBe(404);
    expect((await call(null, 'GET', `/me/adverts/${id}/image`)).statusCode).toBe(401);
  });

  it('another church cannot read or touch the advert', async () => {
    expect((await call(HOPE, 'GET', `/adverts/${id}`)).statusCode).toBe(404);
    expect((await call(HOPE, 'GET', `/adverts/${id}/image`)).statusCode).toBe(404);
    expect((await call(HOPE, 'POST', `/adverts/${id}/pause`)).statusCode).toBe(404);
    expect((await call(HOPE, 'GET', '/adverts')).json().map((a: any) => a.id)).not.toContain(id);
    expect((await call(ADMIN, 'GET', '/adverts')).json().map((a: any) => a.id)).toContain(id);
  });

  it('counts a member once a day however often they open the app', async () => {
    for (let i = 0; i < 3; i++) await call(JANE, 'POST', `/me/adverts/${id}/view`);
    await call(JANE, 'POST', `/me/adverts/${id}/tap`);
    await call(JANE, 'POST', `/me/adverts/${id}/tap`);
    expect((await call(AMINA, 'POST', `/me/adverts/${id}/view`)).statusCode).toBe(404); // cannot see it, cannot inflate it
    expect((await call(ADMIN, 'GET', `/adverts/${id}`)).json().stats).toMatchObject({ views: 1, taps: 1, viewers: 1, orders: 0 });
    ctx.clock.advance(26 * 3600_000);
    await call(JANE, 'POST', `/me/adverts/${id}/view`);
    expect((await call(ADMIN, 'GET', `/adverts/${id}`)).json().stats).toMatchObject({ views: 2, viewers: 1 });
  });

  it('pausing hides it at once, and changing an approved advert needs approval again', async () => {
    expect((await call(ADMIN, 'POST', `/adverts/${id}/pause`)).json().status).toBe('paused');
    expect(await titles(JANE)).not.toContain('Harvest Sunday');
    expect((await call(ADMIN, 'POST', `/adverts/${id}/resume`)).json().status).toBe('approved');
    expect(await titles(JANE)).toContain('Harvest Sunday');
    expect((await call(ADMIN, 'PUT', `/adverts/${id}`, { title: 'Harvest Sunday 2' })).json().status).toBe('draft');
    expect(await titles(JANE)).not.toContain('Harvest Sunday 2');
    await call(ADMIN, 'POST', `/adverts/${id}/submit`);
    await call(OWNER, 'POST', `/adverts/${id}/decide`, { approve: true });
    expect(await titles(JANE)).toContain('Harvest Sunday 2');
  });

  it('a platform admin can take an advert down, with a reason the church sees', async () => {
    expect((await call(OWNER, 'POST', `/admin/adverts/${id}/takedown`, { reason: 'x' })).statusCode).toBe(403);
    expect((await call(PA1, 'POST', `/admin/adverts/${id}/takedown`, {})).statusCode).toBe(400);
    expect((await call(PA1, 'POST', `/admin/adverts/${id}/takedown`, { reason: 'The artwork uses a logo we cannot verify' })).json().status).toBe('taken_down');
    expect(await titles(JANE)).not.toContain('Harvest Sunday 2');
    expect((await call(ADMIN, 'POST', `/adverts/${id}/resume`)).statusCode).toBe(409);
    expect((await call(ADMIN, 'PUT', `/adverts/${id}`, { title: 'Again' })).statusCode).toBe(409);
    const note = (await call(ADMIN, 'GET', '/me/notifications?app=staff')).json().rows.find((n: any) => n.title === 'An advert was taken down');
    expect(note.body).toMatch(/logo we cannot verify/);
    expect((await call(PA1, 'GET', '/admin/adverts?status=taken_down')).json().map((a: any) => a.id)).toContain(id);
  });

  it('every step is in the audit log and the advert keeps its history', async () => {
    const events = (await call(PA1, 'GET', `/admin/audit/events?action=advert`)).json().events.map((e: any) => e.action);
    expect(events).toEqual(expect.arrayContaining(['advert.create', 'advert.submit', 'advert.approve', 'advert.pause', 'advert.resume', 'advert.update', 'advert.takedown']));
    const versions = await ctx.db.query<any>(`SELECT count(*)::int AS n FROM entity_versions WHERE entity='advert' AND entity_id=$1`, [id]);
    expect(versions[0].n).toBeGreaterThanOrEqual(6);
  });
});

describe('adverts: a third party pays to be on the slider (L131)', () => {
  it('shows the advertiser what they owe, and refuses any other amount', async () => {
    const info = await call(null, 'GET', '/public/ad/WED001');
    expect(info.json()).toMatchObject({ price: 500000, purpose: 'AD-WED001', churchCode: 'GRC001', advertiser: 'Mary and John Kamau' });
    expect((await call(null, 'GET', '/public/ad/BAKE01')).statusCode).toBe(404); // not awaiting payment
    const wrong = await call(null, 'POST', '/public/give', { code: 'GRC001', phone: '0712000111', amount: 4000, purpose: 'AD-WED001', method: 'mpesa' });
    expect(wrong.json().code).toBe('amount_must_be_exact');
    expect((await call(null, 'POST', '/public/give', { code: 'GRC001', phone: '0712000111', amount: 5000, purpose: 'AD-NOPE00', method: 'mpesa' })).json().code).toBe('unknown_purpose');
    expect((await call(null, 'POST', '/public/give', { code: 'HPC001', phone: '0712000111', amount: 5000, purpose: 'AD-WED001', method: 'mpesa' })).json().code).toBe('unknown_purpose'); // another church's code
  });

  it('goes live once paid, through the normal giving flow, so the platform fee applies', async () => {
    expect(await titles(JANE)).not.toContain('Mary and John are getting married');
    const paid = await call(null, 'POST', '/public/give', { code: 'GRC001', phone: '0712000111', amount: 5000, purpose: 'AD-WED001', method: 'mpesa' });
    expect(paid.statusCode).toBe(200);
    expect(await wait(async () => (await titles(JANE)).includes('Mary and John are getting married'))).toBe(true);
    const row = (await ctx.db.query<any>(`SELECT amount_paid, net, stage FROM payments WHERE purpose='AD-WED001'`))[0];
    expect(Number(row.net)).toBeLessThan(Number(row.amount_paid));
    expect((await call(null, 'GET', '/public/ad/WED001')).statusCode).toBe(404); // cannot be paid twice
    const slide = (await mine(JANE)).find((a) => a.title === 'Mary and John are getting married');
    expect(slide.sponsor).toBe('Mary and John Kamau');
    const events = (await call(PA1, 'GET', '/admin/audit/events?action=advert.paid')).json().events;
    expect(events).toHaveLength(1);
    const note = (await call(ADMIN, 'GET', '/me/notifications?app=staff')).json().rows.map((n: any) => n.title);
    expect(note).toContain('Advert paid and live');
  });

  it('a priced advert is approved first and only then asks for payment', async () => {
    const made = (await call(ADMIN, 'POST', '/adverts', { title: 'Piano lessons', audience: { type: 'branch', id: 'br_grc001' }, image: art(), advertiser: { name: 'Keys Academy', contact: 'keys@example.com', price: 2500 } })).json();
    await call(ADMIN, 'POST', `/adverts/${made.id}/submit`);
    const approved = (await call(OWNER, 'POST', `/adverts/${made.id}/decide`, { approve: true })).json();
    expect(approved.status).toBe('awaiting_payment');
    expect(approved.payUrl).toMatch(/\?ad=[A-F0-9]{12}$/);
    expect(await titles(JANE)).not.toContain('Piano lessons');
    const detail = (await call(ADMIN, 'GET', `/adverts/${made.id}`)).json();
    expect(detail).toMatchObject({ state: 'awaiting_payment', paid: false });
    expect(detail.advertiser).toMatchObject({ name: 'Keys Academy', price: 250000 });
  });
});

describe('adverts: dates (L131)', () => {
  it('runs indefinitely or for a period, and a future start waits for its day', async () => {
    const day = 86400_000;
    const at = (d: number) => new Date(ctx.clock.now().getTime() + d * day).toISOString();
    // Samuel runs one branch, so he cannot see an advert for the whole church, and its creator cannot approve it.
    const whole = (await call(OWNER, 'POST', '/adverts', { title: 'Easter week', audience: { type: 'org' }, image: art(), startsAt: at(3), endsAt: at(6) })).json().id;
    await call(OWNER, 'POST', `/adverts/${whole}/submit`);
    expect((await call(ADMIN, 'GET', `/adverts/${whole}`)).statusCode).toBe(404);
    expect((await call(OWNER, 'POST', `/adverts/${whole}/decide`, { approve: true })).statusCode).toBe(403);
    const base = (await call(ADMIN, 'POST', '/adverts', { title: 'Easter branch', audience: { type: 'branch', id: 'br_grc001' }, image: art(), startsAt: at(3), endsAt: at(6) })).json().id;
    await call(ADMIN, 'POST', `/adverts/${base}/submit`);
    await call(OWNER, 'POST', `/adverts/${base}/decide`, { approve: true });
    expect(await titles(JANE)).not.toContain('Easter branch');
    expect((await call(ADMIN, 'GET', `/adverts/${base}`)).json().state).toBe('scheduled');
    ctx.clock.advance(4 * day);
    expect(await titles(JANE)).toContain('Easter branch');
    expect((await call(ADMIN, 'GET', `/adverts/${base}`)).json().state).toBe('live');
    ctx.clock.advance(3 * day);
    expect(await titles(JANE)).not.toContain('Easter branch');
    expect((await call(ADMIN, 'GET', `/adverts/${base}`)).json().state).toBe('expired');
    expect(await titles(JANE)).toContain('Christmas Carols Night'); // no end date: still running
  });
});

describe('giving by card and by the right mobile network', () => {
  const gift = (extra: any = {}) => call(null, 'POST', '/public/give', { code: 'GRC001', phone: '0711000001', amount: 800, purpose: 'OFFERING', method: 'card', ...extra });
  const txOf = (url: string) => new URL(url).pathname.split('/').pop()!;

  it('a card gift goes to the hosted card page and completes into the normal giving flow', async () => {
    const g = (await gift()).json();
    expect(g).toMatchObject({ status: 'initiated', method: 'card' });
    expect(g.checkoutUrl).toMatch(/\/checkout\/CARD[A-Z0-9]+\?gift=int_/);
    const info = (await call(null, 'GET', `/public/checkout/${txOf(g.checkoutUrl)}`)).json();
    expect(info).toMatchObject({ amount: 80000, merchant: 'Giving to Grace Nairobi' });
    expect((await call(null, 'GET', `/public/give/${g.intentId}`)).json().status).toBe('initiated'); // nothing is counted before the card is paid
    expect((await call(null, 'POST', `/public/checkout/${txOf(g.checkoutUrl)}/pay`, { number: '4242 4242 4242 4242', expiry: '12/30', cvc: '123' })).json().status).toBe('paid');
    expect(await wait(async () => (await call(null, 'GET', `/public/give/${g.intentId}`)).json().status === 'completed')).toBe(true);
    const p = (await ctx.db.query<any>(`SELECT method, amount_paid, platform_fee, psp_cost, stage FROM payments WHERE provider_tx_id=$1`, [txOf(g.checkoutUrl)]))[0];
    expect(p.method).toBe('card');
    expect(Number(p.amount_paid)).toBe(80000);
    expect(Number(p.platform_fee) + Number(p.psp_cost)).toBeGreaterThan(0);
    expect(await wait(async () => (await call(JANE, 'GET', '/me/notifications')).json().rows.some((n: any) => n.kind === 'receipt' && /800/.test(n.body)))).toBe(true);
    expect((await call(null, 'POST', `/public/checkout/${txOf(g.checkoutUrl)}/pay`, { number: '4242 4242 4242 4242', expiry: '12/30', cvc: '123' })).statusCode).toBe(404); // a link works once
  });

  it('a declined card takes nothing and the gift stays unpaid', async () => {
    const g = (await gift({ amount: 900 })).json();
    expect((await call(null, 'POST', `/public/checkout/${txOf(g.checkoutUrl)}/pay`, { number: '4000 0000 0000 0002', expiry: '12/30', cvc: '123' })).statusCode).toBe(402);
    expect((await call(null, 'GET', `/public/give/${g.intentId}`)).json().status).not.toBe('completed');
    expect((await ctx.db.query<any>(`SELECT 1 FROM payments WHERE provider_tx_id=$1`, [txOf(g.checkoutUrl)])).length).toBe(0);
  });

  it('card still follows the amount limits and who bears the fee', async () => {
    expect((await gift({ amount: 5 })).json().code).toBe('amount_too_small');
    expect((await call(null, 'GET', '/public/fee?code=GRC001&amount=1000&method=card')).statusCode).toBe(200);
  });

  it('a mobile money method needs a number on that network', async () => {
    expect((await gift({ method: 'airtel', phone: '0711000001' })).json().code).toBe('wrong_network'); // Safaricom number
    expect((await gift({ method: 'mpesa', phone: '0733000001' })).json().code).toBe('wrong_network'); // Airtel number
    expect((await gift({ method: 'tkash', phone: '0711000001' })).json().code).toBe('wrong_network');
    expect((await gift({ method: 'airtel', phone: '0733000001' })).statusCode).toBe(200);
    expect((await gift({ method: 'mpesa', phone: '0112000001' })).statusCode).toBe(200); // a range we are not sure about is accepted
    expect((await gift({ method: 'card', phone: '0733000001' })).statusCode).toBe(200); // a card can use any phone
  });
});

describe('the messaging plan of each church (L124)', () => {
  it('the tenant list says which plan every church is on', async () => {
    const t = (await call(PA1, 'GET', '/admin/tenants')).json();
    expect(t.find((o: any) => o.id === 'org_newhope').messagingPlan).toMatchObject({ name: 'Volume bands', tiered: true, assigned: true });
    expect(t.find((o: any) => o.id === 'org_grace').messagingPlan).toMatchObject({ name: 'Standard', tiered: false, assigned: false, isDefault: true });
    expect((await call(OWNER, 'GET', '/admin/tenants')).statusCode).toBe(403);
  });
});
