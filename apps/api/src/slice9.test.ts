import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { PERMISSIONS } from './auth';

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

const OWNER = '0700000001', ADMIN = '0700000003', TREAS = '0700000002', HOPE = '0700000005', PA1 = '0700000099';
const JANE = '0711000001';
const NEW = '0722333444';
const team = async (who: string) => (await call(who, 'GET', '/team')).json();
const roleId = (t: any, name: string) => t.roles.find((r: any) => r.name === name).id as string;

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);

describe('seeing the team and what each permission means', () => {
  it('every permission has plain words and a group', async () => {
    const cat = (await call(OWNER, 'GET', '/team/permissions')).json();
    expect(cat.map((c: any) => c.key).sort()).toEqual([...PERMISSIONS].sort());
    expect(cat.every((c: any) => c.label && c.group)).toBe(true);
  });

  it('the owner sees everyone on the team with masked phone numbers, roles and where they apply', async () => {
    const t = await team(OWNER);
    expect(t).toMatchObject({ canManage: true, canManageRoles: true });
    const daniel = t.people.find((p: any) => p.name === 'Daniel Mwangi');
    expect(daniel.you).toBe(true);
    expect(daniel.assignments[0]).toMatchObject({ role: 'Organisation Owner', scope: 'Whole church', builtIn: true });
    expect(t.people.map((p: any) => p.name)).toEqual(expect.arrayContaining(['Samuel Kiptoo', 'Esther Njeri', 'Fatuma Ali', 'Aisha Auditor']));
    expect(JSON.stringify(t)).not.toMatch(/\b254\d{9}\b|\b07\d{8}\b/);
    expect(t.roles.map((r: any) => r.name)).toEqual(expect.arrayContaining(['Organisation Owner', 'Branch Admin', 'Treasurer', 'Pastor', 'Auditor', 'Secretary']));
    expect(t.regions).toEqual(expect.arrayContaining(['Coast', 'Central']));
  });

  it('another church sees only its own team, and people without the permission see nothing', async () => {
    const hope = await team(HOPE);
    expect(hope.people.map((p: any) => p.name)).toEqual(['Grace Achieng']);
    expect((await call(JANE, 'GET', '/team')).statusCode).toBe(403);
    expect((await call(TREAS, 'GET', '/team')).statusCode).toBe(403); // a treasurer does not manage people
    expect((await call(null, 'GET', '/team')).statusCode).toBe(401);
  });

  it('a branch admin sees only the people who work in their branch', async () => {
    const t = await team(ADMIN);
    const names = t.people.map((p: any) => p.name);
    expect(names).toEqual(expect.arrayContaining(['Samuel Kiptoo', 'Esther Njeri', 'Daniel Mwangi']));
    expect(names).not.toContain('Fatuma Ali'); // Coast region only
    expect(t.canManageRoles).toBe(false);
    expect(t.branches.map((b: any) => b.name)).toEqual(['Grace Nairobi']);
    const daniel = t.people.find((p: any) => p.name === 'Daniel Mwangi');
    expect(daniel.assignments[0].canRemove).toBe(false); // a whole-church role is not his to remove
  });
});

describe('adding people and giving access', () => {
  it('adds a new person with a role for a branch, who can then sign in and sees only that', async () => {
    const t = await team(OWNER);
    const r = await call(OWNER, 'POST', '/team/members', { name: 'Mary Wambui', phone: '0722 333 444', roleId: roleId(t, 'Secretary'), scope: { type: 'branch', id: 'br_grc002' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ created: true, roleName: 'Secretary', scope: 'Grace Mombasa', needsEmail: false });
    const me = (await call(NEW, 'GET', '/staff/me')).json();
    expect(me.user.name).toBe('Mary Wambui');
    expect(me.orgs[0].branches.map((b: any) => b.code)).toEqual(['GRC002']);
    expect(me.orgs[0].permissions).toEqual(expect.arrayContaining(['members.view', 'groups.manage']));
    expect(me.orgs[0].permissions).not.toContain('collections.view');
    expect((await call(NEW, 'GET', '/collections')).statusCode).toBeGreaterThanOrEqual(400);
    const note = (await call(NEW, 'GET', '/me/notifications')).json().rows.map((n: any) => n.title);
    expect(note).toContain('You now have the role Secretary');
  });

  it('adds a second role to the same person, and refuses duplicates, bad numbers and unknowns', async () => {
    const t = await team(OWNER);
    const userId = t.people.find((p: any) => p.name === 'Mary Wambui').userId;
    const add = (body: any) => call(OWNER, 'POST', `/team/members/${userId}/assignments`, body);
    expect((await add({ roleId: roleId(t, 'Treasurer'), scope: { type: 'branch', id: 'br_grc002' } })).statusCode).toBe(200);
    expect((await add({ roleId: roleId(t, 'Treasurer'), scope: { type: 'branch', id: 'br_grc002' } })).json().code).toBe('duplicate');
    expect((await add({ roleId: roleId(t, 'Treasurer'), scope: { type: 'branch', id: 'br_nope' } })).statusCode).toBe(404);
    expect((await add({ roleId: roleId(t, 'Treasurer'), scope: { type: 'region', id: 'Nowhere' } })).statusCode).toBe(404);
    expect((await add({ roleId: roleId(t, 'Treasurer') })).json().code).toBe('bad_scope');
    expect((await add({ roleId: 'org_grace:Nope', scope: { type: 'org' } })).statusCode).toBe(404);
    expect((await call(OWNER, 'POST', '/team/members/u_nobody/assignments', { roleId: roleId(t, 'Treasurer'), scope: { type: 'org' } })).statusCode).toBe(404);
    const body = (extra: any) => ({ name: 'Test Person', phone: '0722555666', roleId: roleId(t, 'Pastor'), scope: { type: 'org' }, ...extra });
    expect((await call(OWNER, 'POST', '/team/members', body({ phone: '123' }))).json().code).toBe('bad_phone');
    expect((await call(OWNER, 'POST', '/team/members', body({ name: '' }))).json().code).toBe('bad_name');
    expect((await call(OWNER, 'POST', '/team/members', body({ phone: '0700000099' }))).json().code).toBe('bad_phone'); // a platform admin
    expect((await ctx.db.query<any>(`SELECT 1 FROM users WHERE phone='254722555666'`)).length).toBe(0); // a refused request leaves nobody behind
    // Treasurers can see wallets, so they will be asked for a confirmed email
    expect((await call(OWNER, 'POST', '/team/members', body({ roleId: roleId(t, 'Treasurer') }))).json().needsEmail).toBe(true);
  });

  it('an existing member can be given staff access by their number, keeping their name', async () => {
    const t = await team(OWNER);
    const r = await call(OWNER, 'POST', '/team/members', { name: 'Ignored Name', phone: '0711000001', roleId: roleId(t, 'Pastor'), scope: { type: 'branch', id: 'br_grc001' } });
    expect(r.json().created).toBe(false);
    const me = (await call(JANE, 'GET', '/staff/me')).json();
    expect(me.user.name).toBe('Jane Wanjiku');
    expect(me.orgs[0].permissions).toContain('messages.send');
  });

  it('nobody can give more than they have, or for places they do not manage', async () => {
    const t = await team(ADMIN);
    const mk = (role: string, scope: any, phone = '0722777888') => call(ADMIN, 'POST', '/team/members', { name: 'Helper One', phone, roleId: roleId(t, role), scope });
    expect((await mk('Treasurer', { type: 'org' })).json().code).toBe('forbidden'); // a whole-church role
    expect((await mk('Treasurer', { type: 'branch', id: 'br_grc002' })).json().code).toBe('forbidden'); // another branch
    expect((await mk('Auditor', { type: 'branch', id: 'br_grc001' })).json().code).toBe('cannot_escalate'); // audit export is not his
    expect((await mk('Organisation Owner', { type: 'branch', id: 'br_grc001' })).json().code).toBe('cannot_escalate');
    expect((await mk('Treasurer', { type: 'branch', id: 'br_grc001' })).json().code).toBe('cannot_escalate'); // members' giving records are not his to hand out
    expect((await ctx.db.query<any>(`SELECT 1 FROM users WHERE phone='254722777888'`)).length).toBe(0);
    expect((await mk('Pastor', { type: 'branch', id: 'br_grc001' })).json().code).toBe('cannot_escalate'); // the prayer team's requests are not his to hand out
    const ok = await mk('Secretary', { type: 'branch', id: 'br_grc001' });
    expect(ok.statusCode).toBe(200);
    const added = (await team(ADMIN)).people.find((p: any) => p.name === 'Helper One');
    expect(added.assignments[0]).toMatchObject({ role: 'Secretary', scope: 'Grace Nairobi', canRemove: true });
    expect((await call(TREAS, 'POST', '/team/members', { name: 'X Y', phone: '0722999000', roleId: roleId(t, 'Pastor'), scope: { type: 'branch', id: 'br_grc001' } })).statusCode).toBe(403);
  });

  it('refuses to touch people in another church', async () => {
    const t = await team(OWNER);
    const hopeOwner = (await team(HOPE)).people[0];
    expect((await call(OWNER, 'POST', `/team/members/${hopeOwner.userId}/assignments`, { roleId: roleId(t, 'Pastor'), scope: { type: 'org' } })).statusCode).toBe(404);
    expect((await call(OWNER, 'POST', `/team/assignments/${hopeOwner.assignments[0].id}/remove`)).statusCode).toBe(404);
    expect((await call(HOPE, 'POST', '/team/members', { name: 'A B', phone: '0722000111', roleId: roleId(t, 'Pastor'), scope: { type: 'org' } })).statusCode).toBe(404); // Grace's role is not Hope's
  });
});

describe('taking access away', () => {
  it('removes a role and the person loses that access at once', async () => {
    const t = await team(OWNER);
    const mary = t.people.find((p: any) => p.name === 'Mary Wambui');
    const secretary = mary.assignments.find((a: any) => a.role === 'Secretary');
    expect((await call(ADMIN, 'POST', `/team/assignments/${secretary.id}/remove`)).statusCode).toBe(403); // Mombasa is not Samuel's branch
    expect((await call(OWNER, 'POST', `/team/assignments/${secretary.id}/remove`)).statusCode).toBe(200);
    const me = (await call(NEW, 'GET', '/staff/me')).json();
    expect(me.orgs[0].permissions).not.toContain('members.view');
    expect((await call(OWNER, 'POST', `/team/assignments/${secretary.id}/remove`)).statusCode).toBe(404);
  });

  it('a church always keeps an Organisation Owner', async () => {
    const t = await team(OWNER);
    const mine = t.people.find((p: any) => p.you).assignments.find((a: any) => a.role === 'Organisation Owner');
    expect(mine.canRemove).toBe(false);
    expect((await call(OWNER, 'POST', `/team/assignments/${mine.id}/remove`)).json().code).toBe('last_owner');
    const r = await call(OWNER, 'POST', '/team/members', { name: 'Second Owner', phone: '0722121212', roleId: roleId(t, 'Organisation Owner'), scope: { type: 'org' } });
    expect(r.statusCode).toBe(200);
    const again = (await team(OWNER)).people.find((p: any) => p.you).assignments.find((a: any) => a.role === 'Organisation Owner');
    expect(again.canRemove).toBe(true);
    // put things back so later tests still have their owner
    const second = (await team(OWNER)).people.find((p: any) => p.name === 'Second Owner').assignments[0];
    expect((await call(OWNER, 'POST', `/team/assignments/${second.id}/remove`)).statusCode).toBe(200);
  });
});

describe('building your own roles (L32)', () => {
  let id = '';

  it('creates a role from the permissions you have, with its own name', async () => {
    const mk = (extra: any = {}) => call(OWNER, 'POST', '/team/roles', { name: 'Welcome team', permissions: ['members.view', 'notices.view', 'events.view'], ...extra });
    const r = await mk();
    expect(r.statusCode).toBe(200);
    id = r.json().id;
    expect((await mk()).json().code).toBe('duplicate');
    expect((await mk({ name: 'treasurer' })).json().code).toBe('duplicate'); // not even in a different case
    expect((await mk({ name: 'A' })).json().code).toBe('bad_name');
    expect((await mk({ name: 'Empty', permissions: [] })).json().code).toBe('bad_permissions');
    expect((await mk({ name: 'Odd', permissions: ['members.view', 'rule.the.world'] })).json().code).toBe('bad_permissions');
    const t = await team(OWNER);
    expect(t.roles.find((x: any) => x.id === id)).toMatchObject({ name: 'Welcome team', builtIn: false, assigned: 0 });
  });

  it('only someone who manages the whole church can change roles, and nobody can put in what they lack', async () => {
    expect((await call(ADMIN, 'POST', '/team/roles', { name: 'Branch special', permissions: ['members.view'] })).statusCode).toBe(403);
    expect((await call(ADMIN, 'PUT', `/team/roles/${id}`, { permissions: ['members.view'] })).statusCode).toBe(403);
    expect((await call(JANE, 'POST', '/team/roles', { name: 'Jane role', permissions: ['members.view'] })).statusCode).toBe(403);
    // Daniel holds everything, so give a second owner-like person a narrower role and check they cannot widen it
    const t = await team(OWNER);
    await call(OWNER, 'POST', '/team/roles', { name: 'Team lead', permissions: ['team.view', 'team.manage', 'members.view'] });
    const leadId = (await team(OWNER)).roles.find((r: any) => r.name === 'Team lead').id;
    await call(OWNER, 'POST', '/team/members', { name: 'Lead Person', phone: '0722343434', roleId: leadId, scope: { type: 'org' } });
    const lead = '0722343434';
    expect((await call(lead, 'POST', '/team/roles', { name: 'Money people', permissions: ['collections.view'] })).json().code).toBe('cannot_escalate');
    expect((await call(lead, 'POST', '/team/roles', { name: 'Viewers', permissions: ['members.view'] })).statusCode).toBe(200);
    expect((await call(lead, 'POST', '/team/members', { name: 'New Treasurer', phone: '0722454545', roleId: roleId(t, 'Treasurer'), scope: { type: 'org' } })).json().code).toBe('cannot_escalate');
  });

  it('edits a custom role, refuses to touch the built-in ones, and cannot delete one in use', async () => {
    expect((await call(OWNER, 'PUT', `/team/roles/${id}`, { permissions: ['members.view', 'notices.view'] })).statusCode).toBe(200);
    expect((await team(OWNER)).roles.find((r: any) => r.id === id).permissions).toEqual(['members.view', 'notices.view']);
    const t = await team(OWNER);
    expect((await call(OWNER, 'PUT', `/team/roles/${roleId(t, 'Treasurer')}`, { permissions: ['members.view'] })).json().code).toBe('built_in');
    expect((await call(OWNER, 'POST', `/team/roles/${roleId(t, 'Treasurer')}/delete`)).json().code).toBe('built_in');
    await call(OWNER, 'POST', '/team/members', { name: 'Usher One', phone: '0722565656', roleId: id, scope: { type: 'branch', id: 'br_grc001' } });
    expect((await call(OWNER, 'POST', `/team/roles/${id}/delete`)).json().code).toBe('in_use');
    const usher = (await team(OWNER)).people.find((p: any) => p.name === 'Usher One').assignments[0];
    await call(OWNER, 'POST', `/team/assignments/${usher.id}/remove`);
    expect((await call(OWNER, 'POST', `/team/roles/${id}/delete`)).statusCode).toBe(200);
    expect((await team(OWNER)).roles.some((r: any) => r.id === id)).toBe(false);
  });

  it('everything is in the audit log, without phone numbers', async () => {
    const events = (await call(PA1, 'GET', '/admin/audit/events?action=team')).json().events;
    expect(events.map((e: any) => e.action)).toEqual(expect.arrayContaining(['team.add', 'team.assign', 'team.unassign']));
    const roles = (await call(PA1, 'GET', '/admin/audit/events?action=role')).json().events.map((e: any) => e.action);
    expect(roles).toEqual(expect.arrayContaining(['role.create', 'role.update', 'role.delete']));
    expect(JSON.stringify(events)).not.toMatch(/\b254\d{9}\b|\b07\d{8}\b/);
  });
});
