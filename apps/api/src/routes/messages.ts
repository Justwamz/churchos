import type { FastifyInstance, FastifyRequest } from 'fastify';
import { branchesFor } from '../auth';
import { diff } from '../audit';
import { HttpError, inList, requireSession, staffScope, type Ctx } from '../ctx';
import { todayEat } from '../members';
import { estimate, runScheduledMessages, SEND_CHANNELS, sendMessage, validateAudience, type AudienceSpec, type SendChannel } from '../messages';

const DAILY_LEADER_CAP = 1000;

export function messageRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };

  // ---------- helpers ----------

  const parseChannels = (raw: unknown): SendChannel[] => {
    const list = (Array.isArray(raw) ? raw : []).map(String) as SendChannel[];
    for (const c of list) if (!SEND_CHANNELS.includes(c)) throw new HttpError(400, 'Choose in-app, SMS or WhatsApp', 'bad_channel');
    return [...new Set<SendChannel>(['inapp', ...list])]; // in-app is always included (L118)
  };

  const parseContent = (b: any) => {
    const title = String(b.title ?? '').trim().replace(/\s+/g, ' ');
    const body = String(b.body ?? '').trim();
    if (!title) throw new HttpError(400, 'Give the message a short title', 'bad_title');
    if (title.length > 80) throw new HttpError(400, 'The title can be up to 80 characters', 'bad_title');
    if (!body) throw new HttpError(400, 'Write the message', 'bad_body');
    if (body.length > 1000) throw new HttpError(400, 'A message can be up to 1,000 characters', 'bad_body');
    return { title, body };
  };

  const parseSchedule = (raw: unknown): string | null => {
    if (raw === undefined || raw === null || raw === '') return null;
    const t = Date.parse(String(raw));
    if (Number.isNaN(t)) throw new HttpError(400, 'Choose a valid date and time to send', 'bad_schedule');
    const now = ctx.clock.now().getTime();
    if (t < now - 60_000) throw new HttpError(400, 'That time has already passed. Choose a time in the future, or send now.', 'in_past');
    if (t > now + 365 * 86400_000) throw new HttpError(400, 'You can schedule up to a year ahead', 'too_far');
    return new Date(Math.max(t, now)).toISOString();
  };

  /** The branches the sender may message, from their messages.send roles. */
  async function senderScope(req: FastifyRequest) {
    const s = await staffScope(ctx, req, 'messages.send');
    const all = (await ctx.db.query<any>(`SELECT id FROM branches WHERE org_id=$1`, [s.orgId])).map((b) => b.id);
    return { orgId: s.orgId, branchIds: s.branchIds, orgWide: all.length > 0 && all.every((b) => s.branchIds.includes(b)) };
  }

  /** Checks the audience is inside what the sender may reach, and fixes the allowed branches into it. */
  async function scopedAudience(raw: unknown, sc: { orgId: string; branchIds: string[]; orgWide: boolean }): Promise<AudienceSpec> {
    const spec = validateAudience(raw);
    spec.allowedBranchIds = sc.branchIds;
    const s = spec.scope;
    if (s.type === 'branch' && !sc.branchIds.includes(s.id)) throw new HttpError(403, 'You cannot send to that branch', 'forbidden');
    if (s.type === 'region') {
      const inRegion = await ctx.db.query<any>(`SELECT id FROM branches WHERE org_id=$1 AND region=$2`, [sc.orgId, s.id]);
      if (!inRegion.some((b) => sc.branchIds.includes(b.id))) throw new HttpError(403, 'You cannot send to that region', 'forbidden');
    }
    if (s.type === 'group') {
      const g = (await ctx.db.query<any>(`SELECT id, branch_id FROM groups WHERE id=$1 AND org_id=$2`, [s.id, sc.orgId]))[0];
      if (!g) throw new HttpError(404, 'That group was not found', 'not_found');
      if (g.branch_id ? !sc.branchIds.includes(g.branch_id) : !sc.orgWide) throw new HttpError(403, 'You cannot send to that group', 'forbidden');
      spec.allowedBranchIds = (await ctx.db.query<any>(`SELECT id FROM branches WHERE org_id=$1`, [sc.orgId])).map((b) => b.id);
    }
    return spec;
  }

  async function createAndSend(a: { orgId: string; branchId: string | null; senderId: string; senderName: string; source: 'staff' | 'group_leader'; groupId?: string | null; spec: AudienceSpec; channels: SendChannel[]; title: string; body: string; scheduleAt: string | null }) {
    const est = await estimate(ctx, a.orgId, a.spec, a.channels, a.body);
    if (est.people === 0) throw new HttpError(400, 'No one matches that audience. Check who you chose and try again.', 'nobody');
    const id = ctx.newId('msg');
    const now = ctx.clock.now().toISOString();
    await ctx.db.query(
      `INSERT INTO messages (id, org_id, branch_id, sender_id, sender_name, source, group_id, audience, channels, title, body, status, scheduled_at, summary, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'scheduled',$12,$13,$14)`,
      [id, a.orgId, a.branchId, a.senderId, a.senderName, a.source, a.groupId ?? null, JSON.stringify(a.spec), JSON.stringify(a.channels), a.title, a.body, a.scheduleAt ?? now, JSON.stringify({ estimated: est.people }), now],
    );
    if (a.scheduleAt && new Date(a.scheduleAt).getTime() > ctx.clock.now().getTime() + 30_000) {
      await ctx.ledger.audit({ orgId: a.orgId, branchId: a.branchId, actor: a.senderId, action: 'message.schedule', entity: 'message', entityId: id, summary: `Scheduled "${a.title}" for ${a.scheduleAt}`, links: { messageId: id }, meta: { people: est.people } });
      return { id, status: 'scheduled', scheduledAt: a.scheduleAt, estimate: est };
    }
    const summary = await sendMessage(ctx, id);
    return { id, status: 'sent', summary, estimate: est };
  }

  const view = (m: any) => ({
    id: m.id, title: m.title, body: m.body, status: m.status, channels: m.channels, source: m.source, sender_name: m.sender_name, group_id: m.group_id, group_name: m.group_name ?? null,
    scheduled_at: m.scheduled_at, sent_at: m.sent_at, cancelled_at: m.cancelled_at, created_at: m.created_at, summary: m.summary, audience: describeAudience(m.audience),
  });
  const describeAudience = (a: AudienceSpec) => ({ scope: a.scope, who: a.who ?? 'all', ageBands: a.ageBands ?? null, sex: a.sex ?? null });

  // ---------- staff: estimate, send, schedule, cancel (L118) ----------

  app.post('/messages/estimate', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const sc = await senderScope(req);
    const spec = await scopedAudience(b.audience, sc);
    return estimate(ctx, sc.orgId, spec, parseChannels(b.channels), String(b.body ?? ''));
  });

  app.post('/messages', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const sc = await senderScope(req);
    const spec = await scopedAudience(b.audience, sc);
    const { title, body } = parseContent(b);
    return createAndSend({
      orgId: sc.orgId, branchId: sc.branchIds.length === 1 ? sc.branchIds[0] : null, senderId: req.session!.uid, senderName: req.session!.name, source: 'staff',
      spec, channels: parseChannels(b.channels), title, body, scheduleAt: parseSchedule(b.scheduleAt),
    });
  });

  app.get('/messages', auth, async (req) => {
    const rows = [...(await branchesFor(ctx.db, req.session!.uid, 'messages.view')), ...(await branchesFor(ctx.db, req.session!.uid, 'messages.send'))];
    if (rows.length === 0) throw new HttpError(403, 'missing permission messages.view', 'forbidden');
    const q = req.query as any;
    const orgId = q.org && rows.some((r) => r.orgId === q.org) ? q.org : rows[0].orgId;
    const branchIds = [...new Set(rows.filter((r) => r.orgId === orgId).map((r) => r.branchId))];
    const params: unknown[] = [orgId, branchIds];
    let where = `m.org_id=$1 AND (m.branch_id IS NULL OR m.branch_id = ANY($2::text[]))`;
    if (q.status) { params.push(String(q.status)); where += ` AND m.status=$${params.length}`; }
    const list = await ctx.db.query<any>(
      `SELECT m.*, g.name AS group_name FROM messages m LEFT JOIN groups g ON g.id=m.group_id WHERE ${where} ORDER BY COALESCE(m.sent_at, m.scheduled_at) DESC LIMIT 100`,
      params,
    );
    return list.map(view);
  });

  app.get('/messages/:id', auth, async (req) => {
    const rows = [...(await branchesFor(ctx.db, req.session!.uid, 'messages.view')), ...(await branchesFor(ctx.db, req.session!.uid, 'messages.send'))];
    const m = (await ctx.db.query<any>(`SELECT m.*, g.name AS group_name FROM messages m LEFT JOIN groups g ON g.id=m.group_id WHERE m.id=$1`, [(req.params as any).id]))[0];
    if (!m || !rows.some((r) => r.orgId === m.org_id && (!m.branch_id || r.branchId === m.branch_id))) throw new HttpError(404, 'message not found', 'not_found');
    const counts = await ctx.db.query<any>(`SELECT channel, status, COUNT(*) AS n, COALESCE(SUM(cost),0) AS cost FROM message_recipients WHERE message_id=$1 GROUP BY channel, status ORDER BY channel, status`, [m.id]);
    return { ...view(m), delivery: counts.map((c) => ({ channel: c.channel, status: c.status, people: Number(c.n), cost: Number(c.cost) })) };
  });

  app.post('/messages/:id/cancel', auth, async (req) => {
    const sc = await senderScope(req);
    const m = (await ctx.db.query<any>(`SELECT * FROM messages WHERE id=$1`, [(req.params as any).id]))[0];
    if (!m || m.org_id !== sc.orgId || (m.branch_id && !sc.branchIds.includes(m.branch_id))) throw new HttpError(404, 'message not found', 'not_found');
    const r = await ctx.db.query<any>(`UPDATE messages SET status='cancelled', cancelled_at=$2 WHERE id=$1 AND status='scheduled' RETURNING id`, [m.id, ctx.clock.now().toISOString()]);
    if (r.length === 0) throw new HttpError(409, m.status === 'sent' ? 'This message has already been sent and cannot be cancelled' : 'This message can no longer be cancelled', 'not_cancellable');
    await ctx.ledger.audit({ orgId: m.org_id, branchId: m.branch_id, actor: req.session!.uid, action: 'message.cancel', entity: 'message', entityId: m.id, summary: `Cancelled the scheduled message "${m.title}"`, links: { messageId: m.id } });
    return { id: m.id, status: 'cancelled' };
  });

  // ---------- consent (L119) ----------

  /** Staff records that a person agreed (or declined) in person or on a form. The source is kept, and the change is logged. */
  app.post('/members/:id/consent', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const m = (await ctx.db.query<any>(`SELECT * FROM memberships WHERE id=$1 AND status='active'`, [(req.params as any).id]))[0];
    if (!m) throw new HttpError(404, 'member not found', 'not_found');
    const rows = await branchesFor(ctx.db, req.session!.uid, 'members.edit');
    if (rows.length === 0) throw new HttpError(403, 'missing permission members.edit', 'forbidden');
    if (!rows.some((r) => r.branchId === m.branch_id && r.orgId === m.org_id)) throw new HttpError(404, 'member not found', 'not_found');
    if (m.category !== 'adult' || !m.phone) throw new HttpError(400, 'Consent is recorded for an adult with their own phone number. Children are reached through their guardians.', 'not_adult');
    if (b.channel !== 'whatsapp' && b.channel !== 'sms') throw new HttpError(400, 'Choose WhatsApp or SMS', 'bad_channel');
    if (b.confirmed !== true) throw new HttpError(400, 'Confirm that the person gave this choice themselves', 'confirmation_required');
    if (!['in_person', 'form', 'phone_call'].includes(b.source)) throw new HttpError(400, 'Say how the person told you: in person, on a form or by phone', 'bad_source');
    const before = (await ctx.db.query<any>(`SELECT whatsapp_opt_in, sms_opt_out FROM contact_prefs WHERE phone=$1`, [m.phone]))[0] ?? { whatsapp_opt_in: false, sms_opt_out: false };
    const next = { whatsapp_opt_in: b.channel === 'whatsapp' ? !!b.optIn : before.whatsapp_opt_in, sms_opt_out: b.channel === 'sms' ? !b.optIn : before.sms_opt_out };
    await ctx.db.query(
      `INSERT INTO contact_prefs (phone, whatsapp_opt_in, sms_opt_out, source, updated_at, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (phone) DO UPDATE SET whatsapp_opt_in=$2, sms_opt_out=$3, source=$4, updated_at=$5, updated_by=$6`,
      [m.phone, next.whatsapp_opt_in, next.sms_opt_out, `staff:${b.source}`, ctx.clock.now().toISOString(), req.session!.uid],
    );
    await ctx.ledger.audit({
      orgId: m.org_id, branchId: m.branch_id, actor: req.session!.uid, action: 'member.consent', category: 'member', entity: 'membership', entityId: m.id,
      summary: `Recorded that ${m.full_name} ${b.optIn ? 'agreed to' : 'declined'} ${b.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'} messages (${b.source.replace('_', ' ')})`,
      changes: diff([{ field: 'whatsapp_opt_in', label: 'WhatsApp messages' }, { field: 'sms_opt_out', label: 'SMS opt-out' }], before, next), meta: { source: b.source },
    });
    return { ok: true, whatsappOptIn: next.whatsapp_opt_in, smsOptOut: next.sms_opt_out };
  });

  // ---------- a member's own choices (L119, L121) ----------

  app.get('/me/preferences', auth, async (req) => {
    const p = (await ctx.db.query<any>(`SELECT whatsapp_opt_in, sms_opt_out, source FROM contact_prefs WHERE phone=$1`, [req.session!.phone]))[0];
    return { whatsappOptIn: !!p?.whatsapp_opt_in, smsOptOut: !!p?.sms_opt_out, source: p?.source ?? null };
  });

  app.put('/me/preferences', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const phone = req.session!.phone;
    const before = (await ctx.db.query<any>(`SELECT whatsapp_opt_in, sms_opt_out FROM contact_prefs WHERE phone=$1`, [phone]))[0] ?? { whatsapp_opt_in: false, sms_opt_out: false };
    const next = { whatsapp_opt_in: b.whatsappOptIn === undefined ? before.whatsapp_opt_in : !!b.whatsappOptIn, sms_opt_out: b.smsOptOut === undefined ? before.sms_opt_out : !!b.smsOptOut };
    await ctx.db.query(
      `INSERT INTO contact_prefs (phone, whatsapp_opt_in, sms_opt_out, source, updated_at, updated_by) VALUES ($1,$2,$3,'member',$4,$5)
       ON CONFLICT (phone) DO UPDATE SET whatsapp_opt_in=$2, sms_opt_out=$3, source='member', updated_at=$4, updated_by=$5`,
      [phone, next.whatsapp_opt_in, next.sms_opt_out, ctx.clock.now().toISOString(), req.session!.uid],
    );
    const changes = diff([{ field: 'whatsapp_opt_in', label: 'WhatsApp messages' }, { field: 'sms_opt_out', label: 'SMS opt-out' }], before, next);
    if (changes.length) await ctx.ledger.audit({ actor: req.session!.uid, action: 'member.preferences', category: 'member', entity: 'user', entityId: req.session!.uid, summary: 'Changed their message preferences', changes });
    return { ok: true, whatsappOptIn: next.whatsapp_opt_in, smsOptOut: next.sms_opt_out };
  });

  // ---------- groups, staff side (L122) ----------

  async function groupScope(req: FastifyRequest, perm: 'members.view' | 'groups.manage') {
    const s = await staffScope(ctx, req, perm);
    const all = (await ctx.db.query<any>(`SELECT id FROM branches WHERE org_id=$1`, [s.orgId])).map((b) => b.id);
    return { orgId: s.orgId, branchIds: s.branchIds, orgWide: all.length > 0 && all.every((b) => s.branchIds.includes(b)) };
  }
  async function loadGroup(req: FastifyRequest, perm: 'members.view' | 'groups.manage') {
    const sc = await groupScope(req, perm);
    const g = (await ctx.db.query<any>(`SELECT * FROM groups WHERE id=$1`, [(req.params as any).id]))[0];
    if (!g || g.org_id !== sc.orgId || (g.branch_id ? !sc.branchIds.includes(g.branch_id) : false)) throw new HttpError(404, 'group not found', 'not_found');
    return { g, sc };
  }

  app.get('/groups', auth, async (req) => {
    const sc = await groupScope(req, 'members.view');
    const rows = await ctx.db.query<any>(
      `SELECT g.id, g.name, g.description, g.branch_id, g.join_policy, g.posting, b.name AS branch_name, g.created_at,
              (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id=g.id) AS member_count,
              (SELECT string_agg(m.full_name, ', ' ORDER BY m.full_name) FROM group_members gm JOIN memberships m ON m.id=gm.membership_id WHERE gm.group_id=g.id AND gm.role='leader') AS leaders
         FROM groups g LEFT JOIN branches b ON b.id=g.branch_id WHERE g.org_id=$1 AND (g.branch_id IS NULL OR g.branch_id = ANY($2::text[])) ORDER BY g.name`,
      [sc.orgId, sc.branchIds],
    );
    return rows.map((r) => ({ ...r, member_count: Number(r.member_count) }));
  });

  app.post('/groups', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const sc = await groupScope(req, 'groups.manage');
    const name = String(b.name ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 80) throw new HttpError(400, 'Give the group a name of 2 to 80 characters', 'bad_name');
    const branchId = b.branchId ? String(b.branchId) : null;
    if (branchId ? !sc.branchIds.includes(branchId) : !sc.orgWide) throw new HttpError(403, branchId ? 'You cannot create a group for that branch' : 'Only someone who manages the whole church can create a church-wide group', 'forbidden');
    const dupe = (await ctx.db.query<any>(`SELECT 1 FROM groups WHERE org_id=$1 AND lower(name)=lower($2) AND COALESCE(branch_id,'')=$3`, [sc.orgId, name, branchId ?? '']))[0];
    if (dupe) throw new HttpError(409, 'A group with that name already exists', 'duplicate');
    const id = ctx.newId('grp');
    const joinPolicy = b.joinPolicy === 'request' ? 'request' : 'invite';
    const posting = b.posting === 'leaders' ? 'leaders' : 'members';
    await ctx.db.query(`INSERT INTO groups (id, org_id, branch_id, name, description, created_by, created_at, join_policy, posting) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, sc.orgId, branchId, name, String(b.description ?? '').trim().slice(0, 300) || null, req.session!.uid, ctx.clock.now().toISOString(), joinPolicy, posting]);
    await ctx.ledger.audit({ orgId: sc.orgId, branchId, actor: req.session!.uid, action: 'group.create', category: 'member', entity: 'group', entityId: id, summary: `Created the group ${name}`, changes: [{ field: 'name', label: 'Name', before: null, after: name }] });
    return { id };
  });

  app.put('/groups/:id', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const { g, sc } = await loadGroup(req, 'groups.manage');
    const name = b.name !== undefined ? String(b.name).trim().replace(/\s+/g, ' ') : g.name;
    if (name.length < 2 || name.length > 80) throw new HttpError(400, 'Give the group a name of 2 to 80 characters', 'bad_name');
    const description = b.description !== undefined ? String(b.description).trim().slice(0, 300) || null : g.description;
    const joinPolicy = b.joinPolicy === 'request' || b.joinPolicy === 'invite' ? b.joinPolicy : g.join_policy;
    const posting = b.posting === 'leaders' || b.posting === 'members' ? b.posting : g.posting;
    await ctx.db.query(`UPDATE groups SET name=$2, description=$3, join_policy=$4, posting=$5 WHERE id=$1`, [g.id, name, description, joinPolicy, posting]);
    const changes = diff([{ field: 'name', label: 'Name' }, { field: 'description', label: 'Description' }, { field: 'join_policy', label: 'How people join' }, { field: 'posting', label: 'Who can post on the wall' }], g, { name, description, join_policy: joinPolicy, posting });
    if (changes.length) await ctx.ledger.audit({ orgId: sc.orgId, branchId: g.branch_id, actor: req.session!.uid, action: 'group.update', category: 'member', entity: 'group', entityId: g.id, summary: `Updated the group ${name}`, changes });
    return { ok: true };
  });

  app.get('/groups/:id', auth, async (req) => {
    const { g } = await loadGroup(req, 'members.view');
    const rows = await ctx.db.query<any>(
      `SELECT gm.membership_id, gm.role, m.full_name, m.member_number, m.category, m.phone, b.name AS branch_name
         FROM group_members gm JOIN memberships m ON m.id=gm.membership_id JOIN branches b ON b.id=m.branch_id WHERE gm.group_id=$1 ORDER BY (gm.role='leader') DESC, m.full_name`,
      [g.id],
    );
    const prefs = new Map<string, any>();
    const phones = rows.map((r) => r.phone).filter(Boolean);
    if (phones.length) for (const p of await ctx.db.query<any>(`SELECT phone, whatsapp_opt_in, sms_opt_out FROM contact_prefs WHERE phone = ANY($1::text[])`, [phones])) prefs.set(p.phone, p);
    return {
      id: g.id, name: g.name, description: g.description, branch_id: g.branch_id, joinPolicy: g.join_policy, posting: g.posting,
      members: rows.map((r) => ({
        membershipId: r.membership_id, name: r.full_name, memberNumber: r.member_number, category: r.category, role: r.role, branch: r.branch_name,
        // What each person can receive. Never the number itself.
        reach: { inApp: r.category === 'adult', sms: !!r.phone && !prefs.get(r.phone)?.sms_opt_out, whatsapp: !!r.phone && !!prefs.get(r.phone)?.whatsapp_opt_in },
      })),
    };
  });

  app.post('/groups/:id/members', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const { g, sc } = await loadGroup(req, 'groups.manage');
    const ids = [...new Set((Array.isArray(b.membershipIds) ? b.membershipIds : []).map(String))];
    if (ids.length === 0) throw new HttpError(400, 'Choose at least one person', 'bad_members');
    const role = b.role === 'leader' ? 'leader' : 'member';
    const people = await ctx.db.query<any>(`SELECT id, full_name, category, branch_id FROM memberships WHERE id = ANY($1::text[]) AND org_id=$2 AND status='active'`, [ids, sc.orgId]);
    if (people.length !== ids.length) throw new HttpError(400, 'One of those people is not an active member of this church', 'bad_members');
    if (role === 'leader' && people.some((p) => p.category !== 'adult')) throw new HttpError(400, 'A leader must be an adult member', 'bad_leader');
    const now = ctx.clock.now().toISOString();
    for (const p of people) {
      await ctx.db.query(`INSERT INTO group_members (group_id, membership_id, org_id, role, added_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (group_id, membership_id) DO UPDATE SET role=$4`, [g.id, p.id, sc.orgId, role, now]);
    }
    await ctx.ledger.audit({ orgId: sc.orgId, branchId: g.branch_id, actor: req.session!.uid, action: 'group.members', category: 'member', entity: 'group', entityId: g.id, summary: `Added ${people.length} ${people.length === 1 ? 'person' : 'people'} to ${g.name}${role === 'leader' ? ' as leader' : ''}`, meta: { count: people.length, role } });
    return { ok: true, added: people.length };
  });

  app.post('/groups/:id/members/:mid/remove', auth, async (req) => {
    const { g, sc } = await loadGroup(req, 'groups.manage');
    const r = await ctx.db.query<any>(`DELETE FROM group_members WHERE group_id=$1 AND membership_id=$2 RETURNING membership_id`, [g.id, (req.params as any).mid]);
    if (r.length === 0) throw new HttpError(404, 'That person is not in this group', 'not_found');
    await ctx.ledger.audit({ orgId: sc.orgId, branchId: g.branch_id, actor: req.session!.uid, action: 'group.members', category: 'member', entity: 'group', entityId: g.id, summary: `Removed a person from ${g.name}`, meta: { count: -1 } });
    return { ok: true };
  });

  app.post('/groups/:id/members/:mid/role', auth, async (req) => {
    const { g, sc } = await loadGroup(req, 'groups.manage');
    const role = (req.body as any)?.role === 'leader' ? 'leader' : 'member';
    const p = (await ctx.db.query<any>(`SELECT category FROM memberships WHERE id=$1`, [(req.params as any).mid]))[0];
    if (role === 'leader' && p?.category !== 'adult') throw new HttpError(400, 'A leader must be an adult member', 'bad_leader');
    const r = await ctx.db.query<any>(`UPDATE group_members SET role=$3 WHERE group_id=$1 AND membership_id=$2 RETURNING membership_id`, [g.id, (req.params as any).mid, role]);
    if (r.length === 0) throw new HttpError(404, 'That person is not in this group', 'not_found');
    await ctx.ledger.audit({ orgId: sc.orgId, branchId: g.branch_id, actor: req.session!.uid, action: 'group.members', category: 'member', entity: 'group', entityId: g.id, summary: `Made someone ${role === 'leader' ? 'a leader of' : 'an ordinary member of'} ${g.name}` });
    return { ok: true, role };
  });

  // ---------- groups, member side: leaders message their own group (L117, L122) ----------

  async function myGroupRole(uid: string, groupId: string) {
    return (await ctx.db.query<any>(
      `SELECT gm.role, gm.membership_id, m.org_id FROM group_members gm JOIN memberships m ON m.id=gm.membership_id WHERE gm.group_id=$1 AND m.user_id=$2 AND m.status='active' ORDER BY (gm.role='leader') DESC LIMIT 1`,
      [groupId, uid],
    ))[0] as { role: 'leader' | 'member'; membership_id: string; org_id: string } | undefined;
  }

  app.get('/me/groups', auth, async (req) => {
    const rows = await ctx.db.query<any>(
      `SELECT g.id, g.name, g.description, gm.role, o.name AS org_name, b.name AS branch_name,
              (SELECT COUNT(*) FROM group_members x WHERE x.group_id=g.id) AS member_count
         FROM group_members gm JOIN groups g ON g.id=gm.group_id JOIN memberships m ON m.id=gm.membership_id JOIN organisations o ON o.id=g.org_id LEFT JOIN branches b ON b.id=g.branch_id
        WHERE m.user_id=$1 AND m.status='active' ORDER BY (gm.role='leader') DESC, g.name`,
      [req.session!.uid],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, role: r.role, church: r.org_name, branch: r.branch_name, memberCount: Number(r.member_count), canMessage: r.role === 'leader' }));
  });

  app.get('/me/groups/:id', auth, async (req) => {
    const id = (req.params as any).id;
    const mine = await myGroupRole(req.session!.uid, id);
    if (!mine) throw new HttpError(404, 'group not found', 'not_found');
    const g = (await ctx.db.query<any>(`SELECT id, name, description FROM groups WHERE id=$1`, [id]))[0];
    const members = mine.role === 'leader'
      ? await ctx.db.query<any>(`SELECT gm.membership_id AS id, m.full_name AS name, gm.role, m.category FROM group_members gm JOIN memberships m ON m.id=gm.membership_id WHERE gm.group_id=$1 ORDER BY (gm.role='leader') DESC, m.full_name`, [id])
      : [];
    return { ...g, role: mine.role, canMessage: mine.role === 'leader', members };
  });

  async function leaderAudience(req: FastifyRequest) {
    const id = (req.params as any).id;
    const mine = await myGroupRole(req.session!.uid, id);
    if (!mine) throw new HttpError(404, 'group not found', 'not_found');
    if (mine.role !== 'leader') throw new HttpError(403, 'Only a leader of this group can message it', 'forbidden');
    const g = (await ctx.db.query<any>(`SELECT * FROM groups WHERE id=$1`, [id]))[0];
    const b = (req.body ?? {}) as any;
    const inGroup = new Set((await ctx.db.query<any>(`SELECT membership_id FROM group_members WHERE group_id=$1`, [id])).map((r) => r.membership_id));
    let only: string[] | undefined;
    if (Array.isArray(b.recipientIds) && b.recipientIds.length) {
      only = [...new Set<string>(b.recipientIds.map(String))];
      if (only.some((x) => !inGroup.has(x))) throw new HttpError(403, 'You can only message people who are in this group', 'forbidden');
    }
    const allBranches = (await ctx.db.query<any>(`SELECT id FROM branches WHERE org_id=$1`, [g.org_id])).map((x) => x.id);
    // Children in the group are reached through their guardians. The group's own wallet pays (L122).
    const spec: AudienceSpec = { scope: { type: 'group', id }, who: 'all', onlyMembershipIds: only, allowedBranchIds: allBranches, chargeTo: { branchId: g.branch_id ?? null } };
    return { spec, g, mine, b };
  }

  app.post('/me/groups/:id/estimate', auth, async (req) => {
    const { spec, g, b } = await leaderAudience(req);
    const est = await estimate(ctx, g.org_id, spec, parseChannels(b.channels), String(b.body ?? ''));
    // Leaders see how many people and what it costs, not wallet balances (L116).
    return { people: est.people, inApp: est.inApp, sms: est.sms, whatsapp: est.whatsapp, totalCost: est.totalCost, anyShort: est.shortBranches.length > 0 };
  });

  app.post('/me/groups/:id/messages', auth, async (req) => {
    const { spec, g, b } = await leaderAudience(req);
    const { title, body } = parseContent(b);
    const est = await estimate(ctx, g.org_id, spec, parseChannels(b.channels), body);
    // A cap on how many people one leader can reach in a day, so an account cannot be used to spam (L117).
    const t = todayEat(ctx.clock.now());
    const dayStart = new Date(Date.UTC(t.y, t.m - 1, t.d) - 3 * 3600_000).toISOString();
    const used = (await ctx.db.query<any>(`SELECT COALESCE(SUM(COALESCE((summary->>'people')::int, (summary->>'estimated')::int, 0)),0) AS n FROM messages WHERE sender_id=$1 AND source='group_leader' AND created_at >= $2 AND status IN ('sent','scheduled','sending')`, [req.session!.uid, dayStart]))[0].n;
    if (Number(used) + est.people > DAILY_LEADER_CAP) throw new HttpError(429, `You can reach up to ${DAILY_LEADER_CAP} people a day from your groups. You have ${Math.max(0, DAILY_LEADER_CAP - Number(used))} left today.`, 'daily_cap');
    return createAndSend({ orgId: g.org_id, branchId: g.branch_id ?? null, senderId: req.session!.uid, senderName: req.session!.name, source: 'group_leader', groupId: g.id, spec, channels: parseChannels(b.channels), title, body, scheduleAt: parseSchedule(b.scheduleAt) });
  });

  void inList;
  void runScheduledMessages;
}
