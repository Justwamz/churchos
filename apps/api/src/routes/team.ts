import type { FastifyInstance, FastifyRequest } from 'fastify';
import { maskPhone } from '@churchos/shared';
import { branchesFor, normalizePhone, PERMISSIONS, PERMISSION_INFO, ROLE_TEMPLATES, type Permission } from '../auth';
import { HttpError, requireSession, type Ctx } from '../ctx';
import { addNotification } from '../notifications';
import { grantsFor } from '../scope';

const OWNER_ROLE = 'Organisation Owner';
const BUILT_IN = new Set(Object.keys(ROLE_TEMPLATES));

type Scope = { type: 'org' | 'region' | 'branch'; id: string };

/** The team: who has access to what, and the roles that say what that means (L32 to L35). */
export function teamRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };

  async function branchesOf(orgId: string, scope: Scope): Promise<{ ids: string[]; label: string }> {
    if (scope.type === 'org') {
      const ids = (await ctx.db.query<any>(`SELECT id FROM branches WHERE org_id=$1`, [orgId])).map((b) => b.id);
      return { ids, label: 'Whole church' };
    }
    if (scope.type === 'region') {
      const ids = (await ctx.db.query<any>(`SELECT id FROM branches WHERE org_id=$1 AND region=$2`, [orgId, scope.id])).map((b) => b.id);
      if (!ids.length) throw new HttpError(404, 'That region was not found', 'not_found');
      return { ids, label: `${scope.id} region` };
    }
    const b = (await ctx.db.query<any>(`SELECT id, name FROM branches WHERE id=$1 AND org_id=$2`, [scope.id, orgId]))[0];
    if (!b) throw new HttpError(404, 'That branch was not found', 'not_found');
    return { ids: [b.id], label: b.name };
  }

  /** Whether the user holds a permission over every one of these branches. Nobody can give away more than they have. */
  async function holds(uid: string, perm: Permission, orgId: string, branchIds: string[]) {
    const mine = new Set((await branchesFor(ctx.db, uid, perm)).filter((r) => r.orgId === orgId).map((r) => r.branchId));
    return branchIds.length > 0 && branchIds.every((b) => mine.has(b));
  }

  const parseScope = (raw: any): Scope => {
    const type = raw?.type;
    if (type === 'org') return { type, id: '' };
    if ((type === 'region' || type === 'branch') && raw?.id) return { type, id: String(raw.id) };
    throw new HttpError(400, 'Choose where this applies: the whole church, a region or a branch', 'bad_scope');
  };

  async function scopeName(orgId: string, a: { scope_type: string; scope_id: string }) {
    if (a.scope_type === 'org') return 'Whole church';
    if (a.scope_type === 'region') return `${a.scope_id} region`;
    return (await ctx.db.query<any>(`SELECT name FROM branches WHERE id=$1`, [a.scope_id]))[0]?.name ?? 'A branch';
  }

  const roleOf = async (orgId: string, id: string) => {
    const r = (await ctx.db.query<any>(`SELECT * FROM roles WHERE id=$1 AND org_id=$2`, [id, orgId]))[0];
    if (!r) throw new HttpError(404, 'That role was not found', 'not_found');
    return r;
  };

  app.get('/team/permissions', auth, async () => PERMISSIONS.map((k) => ({ key: k, ...PERMISSION_INFO[k] })));

  app.get('/team', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'team.view');
    const uid = req.session!.uid;
    const manageBranches = (await branchesFor(ctx.db, uid, 'team.manage')).filter((r) => r.orgId === g.orgId).map((r) => r.branchId);
    const allBranches = await ctx.db.query<any>(`SELECT id, name, region FROM branches WHERE org_id=$1 ORDER BY name`, [g.orgId]);
    const wholeOrgManage = manageBranches.length === allBranches.length && allBranches.length > 0;
    const rows = await ctx.db.query<any>(
      `SELECT ra.id, ra.user_id, ra.role_id, ra.scope_type, ra.scope_id, r.name AS role_name, r.permissions, u.name, u.phone, u.email
         FROM role_assignments ra JOIN roles r ON r.id=ra.role_id JOIN users u ON u.id=ra.user_id WHERE ra.org_id=$1 ORDER BY u.name, r.name`,
      [g.orgId],
    );
    const owners = rows.filter((r) => r.role_name === OWNER_ROLE && r.scope_type === 'org').length;
    const people = new Map<string, any>();
    // Same rule as the remove route (AZ-05): to take a role away you must hold every permission in it over that place yourself.
    const mineByPerm = new Map<string, Set<string>>();
    const holdsAll = async (perms: string[], ids: string[]) => {
      for (const perm of perms) {
        if (!mineByPerm.has(perm)) mineByPerm.set(perm, new Set((await branchesFor(ctx.db, uid, perm as Permission)).filter((r) => r.orgId === g.orgId).map((r) => r.branchId)));
        const mine = mineByPerm.get(perm)!;
        if (!ids.length || !ids.every((b) => mine.has(b))) return false;
      }
      return true;
    };
    for (const a of rows) {
      const { ids } = await branchesOf(g.orgId, { type: a.scope_type, id: a.scope_id });
      if (!ids.some((b) => g.branchIds.includes(b))) continue; // only people who touch the branches you may see
      const p = people.get(a.user_id) ?? { userId: a.user_id, name: a.name, phone: maskPhone(a.phone), email: a.email, you: a.user_id === uid, assignments: [] };
      p.assignments.push({
        id: a.id, roleId: a.role_id, role: a.role_name, builtIn: BUILT_IN.has(a.role_name), scopeType: a.scope_type, scopeId: a.scope_id, scope: await scopeName(g.orgId, a),
        permissionCount: (a.permissions as string[]).length,
        lastOwner: a.role_name === OWNER_ROLE && a.scope_type === 'org' && owners <= 1,
        canRemove: ids.every((b) => manageBranches.includes(b)) && (await holdsAll(a.permissions as string[], ids)) && !(a.role_name === OWNER_ROLE && a.scope_type === 'org' && owners <= 1),
      });
      people.set(a.user_id, p);
    }
    const roles = await ctx.db.query<any>(`SELECT id, name, permissions FROM roles WHERE org_id=$1 ORDER BY name`, [g.orgId]);
    const counts = new Map<string, number>();
    for (const a of rows) counts.set(a.role_id, (counts.get(a.role_id) ?? 0) + 1);
    return {
      canManage: manageBranches.length > 0,
      canManageRoles: wholeOrgManage,
      people: [...people.values()],
      roles: roles.map((r) => ({ id: r.id, name: r.name, builtIn: BUILT_IN.has(r.name), permissions: r.permissions as string[], assigned: counts.get(r.id) ?? 0 })),
      branches: allBranches.filter((b) => manageBranches.includes(b.id)),
      regions: [...new Set(allBranches.filter((b) => manageBranches.includes(b.id) && b.region).map((b) => b.region as string))],
      wholeChurch: wholeOrgManage,
    };
  });

  /** Gives a role to someone for a place. Checks that the person giving it manages that place and holds everything the role contains. */
  async function giveRole(req: FastifyRequest, orgId: string, userId: string, roleId: string, scopeRaw: any) {
    const uid = req.session!.uid;
    const scope = parseScope(scopeRaw);
    const role = await roleOf(orgId, roleId);
    const { ids, label } = await branchesOf(orgId, scope);
    if (!(await holds(uid, 'team.manage', orgId, ids))) throw new HttpError(403, `You cannot give access for ${label}. You can only manage the places you look after.`, 'forbidden');
    for (const p of role.permissions as Permission[]) {
      if (!(await holds(uid, p, orgId, ids))) throw new HttpError(403, `You cannot give the role ${role.name} for ${label} because it includes "${PERMISSION_INFO[p]?.label ?? p}", which you do not have there yourself.`, 'cannot_escalate');
    }
    const dupe = (await ctx.db.query<any>(`SELECT 1 FROM role_assignments WHERE org_id=$1 AND user_id=$2 AND role_id=$3 AND scope_type=$4 AND scope_id=$5`, [orgId, userId, roleId, scope.type, scope.type === 'org' ? orgId : scope.id]))[0];
    if (dupe) throw new HttpError(409, 'They already have that role there', 'duplicate');
    const id = ctx.newId('ra');
    await ctx.db.query(`INSERT INTO role_assignments (id, org_id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,$4,$5,$6)`, [id, orgId, userId, roleId, scope.type, scope.type === 'org' ? orgId : scope.id]);
    const who = (await ctx.db.query<any>(`SELECT name FROM users WHERE id=$1`, [userId]))[0]?.name ?? 'someone';
    await ctx.ledger.audit({ orgId, actor: uid, action: 'team.assign', entity: 'team', entityId: userId, summary: `Gave ${who} the role ${role.name} for ${label}`, changes: [{ field: 'role', label: 'Role', before: null, after: `${role.name}, ${label}` }], links: { assignmentId: id } });
    await addNotification(ctx, { orgId, userId, kind: 'announcement', title: `You now have the role ${role.name}`, body: `Your access applies to ${label}. Sign in to the staff app to start.`, link: 'staff:today', audience: 'staff' });
    const needsEmail = (role.permissions as string[]).includes('wallets.view');
    return { id, roleName: role.name, scope: label, needsEmail };
  }

  app.post('/team/members', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const g = await grantsFor(ctx, req, 'team.manage');
    const phone = normalizePhone(String(b.phone ?? ''));
    if (!phone) throw new HttpError(400, 'Enter a valid Kenyan phone number, for example 0712 345 678', 'bad_phone');
    const name = String(b.name ?? '').trim().replace(/\s+/g, ' ');
    let user = (await ctx.db.query<any>(`SELECT id, name, is_platform_admin FROM users WHERE phone=$1`, [phone]))[0];
    if (user?.is_platform_admin) throw new HttpError(400, 'That number belongs to a ChurchOS administrator and cannot be given church access', 'bad_phone');
    if (!user && (name.length < 2 || name.length > 80)) throw new HttpError(400, 'Enter their full name', 'bad_name');
    const created = !user;
    // Check everything before creating the person, so a refused request leaves nothing behind.
    const scope = parseScope(b.scope);
    const role = await roleOf(g.orgId, String(b.roleId));
    const { ids, label } = await branchesOf(g.orgId, scope);
    if (!(await holds(req.session!.uid, 'team.manage', g.orgId, ids))) throw new HttpError(403, `You cannot give access for ${label}. You can only manage the places you look after.`, 'forbidden');
    for (const p of role.permissions as Permission[]) {
      if (!(await holds(req.session!.uid, p, g.orgId, ids))) throw new HttpError(403, `You cannot give the role ${role.name} for ${label} because it includes "${PERMISSION_INFO[p]?.label ?? p}", which you do not have there yourself.`, 'cannot_escalate');
    }
    if (created) {
      const id = ctx.newId('u');
      await ctx.db.query(`INSERT INTO users (id, phone, name, created_at) VALUES ($1,$2,$3,$4)`, [id, phone, name, ctx.clock.now().toISOString()]);
      user = { id, name };
      await ctx.ledger.audit({ orgId: g.orgId, actor: req.session!.uid, action: 'team.add', entity: 'team', entityId: id, summary: `Added ${name} to the team` });
    }
    const r = await giveRole(req, g.orgId, user.id, role.id, b.scope);
    return { userId: user.id, created, ...r };
  });

  app.post('/team/members/:userId/assignments', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'team.manage');
    const b = (req.body ?? {}) as any;
    const known = (await ctx.db.query<any>(`SELECT 1 FROM role_assignments WHERE org_id=$1 AND user_id=$2 LIMIT 1`, [g.orgId, (req.params as any).userId]))[0];
    if (!known) throw new HttpError(404, 'That person is not on your team', 'not_found');
    return giveRole(req, g.orgId, (req.params as any).userId, String(b.roleId), b.scope);
  });

  app.post('/team/assignments/:id/remove', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'team.manage');
    const a = (await ctx.db.query<any>(`SELECT ra.*, r.name AS role_name, u.name AS user_name FROM role_assignments ra JOIN roles r ON r.id=ra.role_id JOIN users u ON u.id=ra.user_id WHERE ra.id=$1 AND ra.org_id=$2`, [(req.params as any).id, g.orgId]))[0];
    if (!a) throw new HttpError(404, 'That access was not found', 'not_found');
    const { ids, label } = await branchesOf(g.orgId, { type: a.scope_type, id: a.scope_id });
    if (!(await holds(req.session!.uid, 'team.manage', g.orgId, ids))) throw new HttpError(403, `You cannot change access for ${label}`, 'forbidden');
    // Taking a role away needs the same standing as giving it (AZ-05): you must hold every permission in it over that place yourself.
    const roleRow = await roleOf(g.orgId, a.role_id);
    for (const perm of roleRow.permissions as Permission[]) {
      if (!(await holds(req.session!.uid, perm, g.orgId, ids))) throw new HttpError(403, `You cannot take away the role ${a.role_name} for ${label} because it includes "${PERMISSION_INFO[perm]?.label ?? perm}", which you do not have there yourself.`, 'cannot_escalate');
    }
    if (a.role_name === OWNER_ROLE && a.scope_type === 'org') {
      const owners = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM role_assignments ra JOIN roles r ON r.id=ra.role_id WHERE ra.org_id=$1 AND r.name=$2 AND ra.scope_type='org'`, [g.orgId, OWNER_ROLE]))[0].n);
      if (owners <= 1) throw new HttpError(409, 'A church must always have an Organisation Owner. Give someone else that role first.', 'last_owner');
    }
    await ctx.db.query(`DELETE FROM role_assignments WHERE id=$1`, [a.id]);
    if (a.role_name === OWNER_ROLE) await ctx.ledger.audit({ orgId: g.orgId, actor: req.session!.uid, action: 'security.owner_removed', category: 'security', entity: 'team', entityId: a.user_id, summary: `The Organisation Owner role was taken away from ${a.user_name} for ${label}`, meta: { scope: a.scope_type } });
    await ctx.ledger.audit({ orgId: g.orgId, actor: req.session!.uid, action: 'team.unassign', entity: 'team', entityId: a.user_id, summary: `Took the role ${a.role_name} for ${label} away from ${a.user_name}`, changes: [{ field: 'role', label: 'Role', before: `${a.role_name}, ${label}`, after: null }] });
    return { ok: true };
  });

  // ======================= roles =======================

  async function rolePermissions(req: FastifyRequest, orgId: string, raw: unknown): Promise<Permission[]> {
    const list = [...new Set(Array.isArray(raw) ? raw.map(String) : [])];
    if (list.length === 0) throw new HttpError(400, 'Choose at least one thing this role can do', 'bad_permissions');
    const bad = list.find((p) => !(PERMISSIONS as readonly string[]).includes(p));
    if (bad) throw new HttpError(400, `"${bad}" is not something a role can do`, 'bad_permissions');
    const all = (await ctx.db.query<any>(`SELECT id FROM branches WHERE org_id=$1`, [orgId])).map((b) => b.id);
    for (const p of list as Permission[]) {
      if (!(await holds(req.session!.uid, p, orgId, all))) throw new HttpError(403, `You cannot put "${PERMISSION_INFO[p].label}" in a role because you do not have it yourself`, 'cannot_escalate');
    }
    return list as Permission[];
  }

  const roleName = async (orgId: string, raw: unknown, exceptId = '') => {
    const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 40) throw new HttpError(400, 'Give the role a name of 2 to 40 characters', 'bad_name');
    const dupe = (await ctx.db.query<any>(`SELECT 1 FROM roles WHERE org_id=$1 AND lower(name)=lower($2) AND id<>$3`, [orgId, name, exceptId]))[0];
    if (dupe) throw new HttpError(409, 'There is already a role with that name', 'duplicate');
    return name;
  };

  async function wholeOrgManager(req: FastifyRequest) {
    const g = await grantsFor(ctx, req, 'team.manage');
    if (!g.wholeOrg) throw new HttpError(403, 'Roles apply to the whole church, so only someone who manages every branch can change them', 'forbidden');
    return g;
  }

  app.post('/team/roles', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const g = await wholeOrgManager(req);
    const name = await roleName(g.orgId, b.name);
    const perms = await rolePermissions(req, g.orgId, b.permissions);
    const id = ctx.newId('role');
    await ctx.db.query(`INSERT INTO roles (id, org_id, name, permissions) VALUES ($1,$2,$3,$4)`, [id, g.orgId, name, JSON.stringify(perms)]);
    await ctx.ledger.audit({ orgId: g.orgId, actor: req.session!.uid, action: 'role.create', entity: 'role', entityId: id, summary: `Created the role ${name} with ${perms.length} permissions`, changes: [{ field: 'permissions', label: 'Can do', before: null, after: perms.map((p) => PERMISSION_INFO[p].label).join('; ') }] });
    return { id };
  });

  app.put('/team/roles/:id', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const g = await wholeOrgManager(req);
    const old = await roleOf(g.orgId, (req.params as any).id);
    if (BUILT_IN.has(old.name)) throw new HttpError(409, 'The built-in roles cannot be changed. Create your own role instead.', 'built_in');
    const name = 'name' in b ? await roleName(g.orgId, b.name, old.id) : old.name;
    const perms = 'permissions' in b ? await rolePermissions(req, g.orgId, b.permissions) : (old.permissions as Permission[]);
    await ctx.db.query(`UPDATE roles SET name=$2, permissions=$3 WHERE id=$1`, [old.id, name, JSON.stringify(perms)]);
    const before = (old.permissions as Permission[]).map((p) => PERMISSION_INFO[p]?.label ?? p).sort().join('; ');
    const after = perms.map((p) => PERMISSION_INFO[p].label).sort().join('; ');
    const changes = [
      ...(name !== old.name ? [{ field: 'name', label: 'Name', before: old.name, after: name }] : []),
      ...(before !== after ? [{ field: 'permissions', label: 'Can do', before, after }] : []),
    ];
    if (changes.length) await ctx.ledger.audit({ orgId: g.orgId, actor: req.session!.uid, action: 'role.update', entity: 'role', entityId: old.id, summary: `Changed the role ${name}`, changes });
    return { id: old.id };
  });

  app.post('/team/roles/:id/delete', auth, async (req) => {
    const g = await wholeOrgManager(req);
    const old = await roleOf(g.orgId, (req.params as any).id);
    if (BUILT_IN.has(old.name)) throw new HttpError(409, 'The built-in roles cannot be deleted', 'built_in');
    const n = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM role_assignments WHERE role_id=$1`, [old.id]))[0].n);
    if (n > 0) throw new HttpError(409, `${n} ${n === 1 ? 'person has' : 'people have'} this role. Take it away from them first.`, 'in_use');
    await ctx.db.query(`DELETE FROM roles WHERE id=$1`, [old.id]);
    await ctx.ledger.audit({ orgId: g.orgId, actor: req.session!.uid, action: 'role.delete', entity: 'role', entityId: old.id, summary: `Deleted the role ${old.name}` });
    return { ok: true };
  });
}
