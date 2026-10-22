import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parseKes } from '../limits';
import { branchesFor, type Permission } from '../auth';
import { diff, maskedSnapshot, recordVersion, sha, type FieldSpec } from '../audit';
import { validateArtwork } from '../artwork';
import { HttpError, requireAdmin, requireSession, type Ctx } from '../ctx';
import { addNotification } from '../notifications';

const ADVERT_SPECS: FieldSpec[] = [
  { field: 'title', label: 'Headline' },
  { field: 'body', label: 'Text' },
  { field: 'link', label: 'Link' },
  { field: 'action', label: 'When tapped' },
  { field: 'artwork', label: 'Artwork' },
  { field: 'audience', label: 'Who sees it' },
  { field: 'startsAt', label: 'Starts' },
  { field: 'endsAt', label: 'Ends' },
  { field: 'advertiser', label: 'Advertiser' },
  { field: 'price', label: 'Price (cents)' },
  { field: 'status', label: 'Status' },
];

type Audience = { type: 'org' } | { type: 'branch'; id: string } | { type: 'group'; id: string };

/** What a member or church sees: approved adverts are live only inside their dates (L131). */
export function advertState(a: { status: string; starts_at: string; ends_at: string | null }, now: string): string {
  if (a.status !== 'approved') return a.status;
  if (a.starts_at > now) return 'scheduled';
  if (a.ends_at && a.ends_at <= now) return 'expired';
  return 'live';
}

const eatDay = (d: Date) => new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 10);

/**
 * Adverts on the member app's home slider (L130 to L132). Churches create them, a different person approves them, a third-party
 * advert goes live once the advertiser has paid, and a platform admin can take any of them down.
 */
export function advertRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };
  const adm = { preHandler: requireAdmin };
  // The people who make and approve adverts are staff, so these are staff-app messages.
  const notify = async (orgId: string, userId: string | null, title: string, body: string, link?: string) => {
    if (userId) await addNotification(ctx, { orgId, userId, kind: 'announcement', title, body, link, audience: 'staff' });
  };

  const text = (v: unknown, max: number, label: string, required = false) => {
    const s = String(v ?? '').trim().replace(/\s+/g, ' ');
    if (required && !s) throw new HttpError(400, `Enter the ${label}`, 'bad_advert');
    if (s.length > max) throw new HttpError(400, `The ${label} can be at most ${max} characters`, 'bad_advert');
    return s || null;
  };

  /** The org and branches where the user holds a permission, with whether that covers the whole organisation. */
  async function grants(req: FastifyRequest, permission: Permission, orgHint?: string) {
    const rows = await branchesFor(ctx.db, req.session!.uid, permission);
    if (rows.length === 0) throw new HttpError(403, `missing permission ${permission}`, 'forbidden');
    const wanted = orgHint ?? ((req.query as any)?.org as string | undefined);
    const orgId = wanted && rows.some((r) => r.orgId === wanted) ? wanted : rows[0].orgId;
    const branchIds = rows.filter((r) => r.orgId === orgId).map((r) => r.branchId);
    const all = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM branches WHERE org_id=$1`, [orgId]))[0].n);
    return { orgId, branchIds, wholeOrg: branchIds.length === all };
  }

  async function audienceOf(raw: any, g: { orgId: string; branchIds: string[]; wholeOrg: boolean }): Promise<{ audience: Audience; branchId: string | null; label: string }> {
    const t = raw?.type;
    if (t === 'org') {
      if (!g.wholeOrg) throw new HttpError(403, 'Only people who manage every branch can advertise to the whole church. Choose a branch or group.', 'forbidden');
      return { audience: { type: 'org' }, branchId: null, label: 'Whole church' };
    }
    if (t === 'branch') {
      const b = (await ctx.db.query<any>(`SELECT id, name FROM branches WHERE id=$1 AND org_id=$2`, [raw.id, g.orgId]))[0];
      if (!b) throw new HttpError(404, 'That branch was not found', 'not_found');
      if (!g.branchIds.includes(b.id)) throw new HttpError(403, 'You do not manage that branch', 'forbidden');
      return { audience: { type: 'branch', id: b.id }, branchId: b.id, label: b.name };
    }
    if (t === 'group') {
      const gr = (await ctx.db.query<any>(`SELECT id, name, branch_id FROM groups WHERE id=$1 AND org_id=$2`, [raw.id, g.orgId]))[0];
      if (!gr) throw new HttpError(404, 'That group was not found', 'not_found');
      if (gr.branch_id ? !g.branchIds.includes(gr.branch_id) : !g.wholeOrg) throw new HttpError(403, 'You do not manage that group', 'forbidden');
      return { audience: { type: 'group', id: gr.id }, branchId: gr.branch_id ?? null, label: gr.name };
    }
    throw new HttpError(400, 'Choose who should see the advert: the whole church, a branch or a group', 'bad_audience');
  }

  const audienceLabel = async (a: any): Promise<string> => {
    const au = a.audience as Audience;
    if (au.type === 'org') return 'Whole church';
    if (au.type === 'branch') return (await ctx.db.query<any>(`SELECT name FROM branches WHERE id=$1`, [au.id]))[0]?.name ?? 'A branch';
    return (await ctx.db.query<any>(`SELECT name FROM groups WHERE id=$1`, [au.id]))[0]?.name ?? 'A group';
  };

  function window(b: any, existing?: any) {
    const now = ctx.clock.now();
    const startsAt = b.startsAt ? new Date(b.startsAt) : existing ? new Date(existing.starts_at) : now;
    if (Number.isNaN(startsAt.getTime())) throw new HttpError(400, 'Choose a valid start date', 'bad_date');
    let endsAt: Date | null = null;
    const rawEnd = 'endsAt' in b ? b.endsAt : existing?.ends_at;
    if (rawEnd) {
      endsAt = new Date(rawEnd);
      if (Number.isNaN(endsAt.getTime())) throw new HttpError(400, 'Choose a valid end date', 'bad_date');
      if (endsAt <= startsAt) throw new HttpError(400, 'The end date must be after the start date', 'bad_date');
      if (endsAt <= now) throw new HttpError(400, 'The end date is already past', 'bad_date');
    }
    return { startsAt: startsAt.toISOString(), endsAt: endsAt ? endsAt.toISOString() : null };
  }

  function advertiser(b: any, existing?: any) {
    const name = 'advertiser' in b ? text(b.advertiser?.name, 80, 'advertiser name') : existing?.advertiser_name ?? null;
    const contact = 'advertiser' in b ? text(b.advertiser?.contact, 120, 'advertiser contact') : existing?.advertiser_contact ?? null;
    let price: number | null = existing?.price == null ? null : Number(existing.price);
    if ('advertiser' in b) {
      price = null;
      if (name) {
        price = parseKes(b.advertiser?.price, { min: 0, max: 1_000_000, label: 'the price the advertiser pays' });
        if (!(price >= 1000)) throw new HttpError(400, 'The price must be at least KES 10', 'bad_amount');
        if (price > 15_000_000) throw new HttpError(400, 'The price cannot be more than KES 150,000, the limit for one payment', 'bad_amount');
      }
    }
    return { name, contact, price: name ? price : null };
  }

  function link(v: unknown): string | null {
    const s = String(v ?? '').trim();
    if (!s) return null;
    if (s.length > 300 || !/^https?:\/\/[^\s]+$/i.test(s)) throw new HttpError(400, 'A link must start with http:// or https://', 'bad_link');
    return s;
  }

  /**
   * Where a tap leads besides a link (L168): the shop, one item, or straight to checkout with an item. The item must belong to this church and be for sale.
   * The item's name is kept on the advert so the history reads well.
   */
  async function actionOf(raw: any, orgId: string): Promise<{ kind: 'shop' | 'item' | 'checkout' | 'event'; itemId?: string; qty?: number; itemName?: string; eventId?: string } | null> {
    if (raw === null || raw === undefined || raw === '' || raw.kind === 'link' || raw.kind === 'none') return null;
    if (raw.kind === 'shop') return { kind: 'shop' };
    if (raw.kind === 'event') {
      const ev = (await ctx.db.query<any>(`SELECT id, title, status, ticketed, COALESCE(ends_at, starts_at) AS ends FROM events WHERE id=$1 AND org_id=$2`, [String(raw.eventId ?? ''), orgId]))[0];
      if (!ev) throw new HttpError(404, 'That event was not found', 'not_found');
      if (!ev.ticketed) throw new HttpError(409, `"${ev.title}" does not sell tickets. Set up its tickets first.`, 'no_tickets');
      if (ev.status === 'cancelled' || ev.ends < ctx.clock.now().toISOString()) throw new HttpError(409, `"${ev.title}" is not open for tickets`, 'event_over');
      return { kind: 'event', eventId: ev.id, itemName: ev.title };
    }
    if (raw.kind !== 'item' && raw.kind !== 'checkout') throw new HttpError(400, 'Choose where the advert leads: a link, the shop, one item or checkout', 'bad_action');
    const it = (await ctx.db.query<any>(`SELECT id, name, active FROM shop_items WHERE id=$1 AND org_id=$2`, [String(raw.itemId ?? ''), orgId]))[0];
    if (!it) throw new HttpError(404, 'That shop item was not found', 'not_found');
    if (!it.active) throw new HttpError(409, `"${it.name}" is not for sale at the moment`, 'inactive');
    const qty = raw.kind === 'checkout' ? Math.floor(Number(raw.qty ?? 1)) : undefined;
    if (qty !== undefined && (!Number.isFinite(qty) || qty < 1 || qty > 10)) throw new HttpError(400, 'Choose a quantity from 1 to 10', 'bad_number');
    return { kind: raw.kind, itemId: it.id, ...(qty ? { qty } : {}), itemName: it.name };
  }
  const actionText = (a: any) => {
    const x = a.action as { kind: string; itemName?: string; qty?: number } | null;
    return !x ? null : x.kind === 'shop' ? 'Opens the shop' : x.kind === 'event' ? `Sells tickets for ${x.itemName}` : x.kind === 'item' ? `Shows ${x.itemName}` : `Checkout with ${x.qty} x ${x.itemName}`;
  };

  const flat = (a: any, label: string) => ({
    title: a.title, body: a.body, link: a.link_url, action: actionText(a),
    artwork: `${a.width}x${a.height} ${sha(a.image_data)}`,
    audience: label, startsAt: a.starts_at, endsAt: a.ends_at ?? 'No end date',
    advertiser: a.advertiser_name ?? null, price: a.price == null ? null : Number(a.price), status: a.status,
  });

  async function stats(id: string) {
    const r = (await ctx.db.query<any>(`SELECT count(*) FILTER (WHERE kind='view')::int AS views, count(*) FILTER (WHERE kind='tap')::int AS taps, count(DISTINCT user_id)::int AS viewers FROM advert_seen WHERE advert_id=$1`, [id]))[0];
    const o = (await ctx.db.query<any>(`SELECT count(*)::int AS n, COALESCE(SUM(total),0) AS money FROM shop_sales WHERE advert_id=$1 AND status='completed'`, [id]))[0];
    return { views: r.views, taps: r.taps, viewers: r.viewers, orders: o.n, orderTotal: Number(o.money) };
  }

  async function view(a: any, uid: string | null, canApprove: boolean, imageBase: string) {
    const now = ctx.clock.now().toISOString();
    return {
      id: a.id, orgId: a.org_id, branchId: a.branch_id, title: a.title, body: a.body, link: a.link_url, action: a.action ?? null, actionText: actionText(a), audience: a.audience, audienceLabel: await audienceLabel(a),
      startsAt: a.starts_at, endsAt: a.ends_at, status: a.status, state: advertState(a, now), reason: a.reason,
      advertiser: a.advertiser_name ? { name: a.advertiser_name, contact: a.advertiser_contact, price: a.price == null ? null : Number(a.price) } : null,
      paid: !!a.payment_id, imageUrl: `${imageBase}/${a.id}/image`, width: a.width, height: a.height,
      createdBy: a.created_by_name ?? null, createdAt: a.created_at, stats: await stats(a.id),
      canApprove: canApprove && a.status === 'pending' && uid !== a.created_by && uid !== a.submitted_by,
      payUrl: a.status === 'awaiting_payment' ? `${ctx.givingUrl}/?ad=${a.code}` : null, payCode: a.status === 'awaiting_payment' ? `AD-${a.code}` : null,
    };
  }

  const SELECT = `SELECT a.*, u.name AS created_by_name FROM adverts a LEFT JOIN users u ON u.id=a.created_by`;

  /** An advert the user may act on with a permission. Anything outside their branches is reported as missing (L131). */
  async function load(req: FastifyRequest, id: string, permission: Permission) {
    const a = (await ctx.db.query<any>(`${SELECT} WHERE a.id=$1`, [id]))[0];
    if (!a) throw new HttpError(404, 'advert not found', 'not_found');
    const rows = await branchesFor(ctx.db, req.session!.uid, permission);
    const mine = rows.filter((r) => r.orgId === a.org_id).map((r) => r.branchId);
    const all = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM branches WHERE org_id=$1`, [a.org_id]))[0].n);
    const ok = a.branch_id ? mine.includes(a.branch_id) : mine.length === all && all > 0;
    if (!ok) throw new HttpError(404, 'advert not found', 'not_found');
    return a;
  }

  async function record(a: any, req: FastifyRequest, action: string, summary: string, before: Record<string, any> | null, reason?: string | null) {
    const label = await audienceLabel(a);
    const after = flat(a, label);
    const changes = diff(ADVERT_SPECS, before, after);
    const evt = await ctx.ledger.audit({ orgId: a.org_id, branchId: a.branch_id, actor: req.session!.uid, action, entity: 'advert', entityId: a.id, summary, changes, reason: reason ?? null, links: { advertId: a.id } });
    await recordVersion(ctx, { orgId: a.org_id, branchId: a.branch_id, entity: 'advert', entityId: a.id, snapshot: maskedSnapshot(ADVERT_SPECS, after), summary, eventId: evt });
  }

  const reload = async (id: string) => (await ctx.db.query<any>(`${SELECT} WHERE a.id=$1`, [id]))[0];
  const newCode = () => randomBytes(6).toString('hex').toUpperCase(); // 48 bits: the code is a public secret (AZ-17)

  // ---------- church side ----------

  app.get('/adverts', auth, async (req) => {
    const g = await grants(req, 'adverts.view');
    const approver = (await branchesFor(ctx.db, req.session!.uid, 'adverts.approve')).some((r) => r.orgId === g.orgId);
    const rows = await ctx.db.query<any>(`${SELECT} WHERE a.org_id=$1 ORDER BY a.created_at DESC LIMIT 200`, [g.orgId]);
    const seen = rows.filter((a) => (a.branch_id ? g.branchIds.includes(a.branch_id) : g.wholeOrg));
    const out = [];
    for (const a of seen) out.push(await view(a, req.session!.uid, approver, '/adverts'));
    return out;
  });

  app.get('/adverts/:id', auth, async (req) => {
    const a = await load(req, (req.params as any).id, 'adverts.view');
    const approver = (await branchesFor(ctx.db, req.session!.uid, 'adverts.approve')).some((r) => r.orgId === a.org_id);
    return view(a, req.session!.uid, approver, '/adverts');
  });

  app.get('/adverts/:id/image', auth, async (req, reply) => {
    const a = await load(req, (req.params as any).id, 'adverts.view');
    return reply.header('content-type', a.image_mime).header('cache-control', 'private, max-age=300').send(Buffer.from(a.image_data, 'base64'));
  });

  app.post('/adverts', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const g = await grants(req, 'adverts.manage');
    const aud = await audienceOf(b.audience, g);
    const art = validateArtwork(b.image);
    const when = window(b);
    const adv = advertiser(b);
    const action = await actionOf(b.action, g.orgId);
    const id = ctx.newId('adv');
    const now = ctx.clock.now().toISOString();
    await ctx.db.query(
      `INSERT INTO adverts (id, code, org_id, branch_id, title, body, link_url, image_mime, image_data, width, height, audience, starts_at, ends_at, advertiser_name, advertiser_contact, price, created_by, created_at, updated_at, action)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19,$20)`,
      [id, newCode(), g.orgId, aud.branchId, text(b.title, 60, 'headline', true), text(b.body, 160, 'text'), action ? null : link(b.link), art.mime, art.data, art.width, art.height, JSON.stringify(aud.audience), when.startsAt, when.endsAt, adv.name, adv.contact, adv.price, req.session!.uid, now, action ? JSON.stringify(action) : null],
    );
    const a = await reload(id);
    await record(a, req, 'advert.create', `Created the advert "${a.title}"`, null);
    return { id };
  });

  /** Changing an advert that was already submitted takes it offline until someone approves the new version. */
  app.put('/adverts/:id', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const old = await load(req, (req.params as any).id, 'adverts.manage');
    if (old.status === 'ended' || old.status === 'taken_down') throw new HttpError(409, 'This advert has finished and cannot be changed. Create a new one.', 'locked');
    const g = await grants(req, 'adverts.manage', old.org_id);
    const aud = b.audience ? await audienceOf(b.audience, g) : { audience: old.audience as Audience, branchId: old.branch_id as string | null, label: await audienceLabel(old) };
    const art = b.image ? validateArtwork(b.image) : { mime: old.image_mime, data: old.image_data, width: old.width, height: old.height };
    const when = window(b, old);
    const adv = advertiser(b, old);
    const action = 'action' in b ? await actionOf(b.action, old.org_id) : (old.action as any) ?? null;
    const before = flat(old, await audienceLabel(old));
    const status = old.status === 'draft' || old.status === 'rejected' ? old.status : 'draft';
    await ctx.db.query(
      `UPDATE adverts SET title=$2, body=$3, link_url=$4, image_mime=$5, image_data=$6, width=$7, height=$8, audience=$9, branch_id=$10, starts_at=$11, ends_at=$12, advertiser_name=$13, advertiser_contact=$14, price=$15, status=$16, updated_at=$17, action=$18 WHERE id=$1`,
      [old.id, 'title' in b ? text(b.title, 60, 'headline', true) : old.title, 'body' in b ? text(b.body, 160, 'text') : old.body, action ? null : 'link' in b ? link(b.link) : old.link_url, art.mime, art.data, art.width, art.height, JSON.stringify(aud.audience), aud.branchId, when.startsAt, when.endsAt, adv.name, adv.contact, adv.price, status, ctx.clock.now().toISOString(), action ? JSON.stringify(action) : null],
    );
    const a = await reload(old.id);
    const changes = diff(ADVERT_SPECS, before, flat(a, await audienceLabel(a)));
    if (changes.length === 0) return { id: a.id, status: a.status };
    await record(a, req, 'advert.update', `Changed the advert "${a.title}"${status !== old.status ? ' (needs approval again)' : ''}`, before);
    return { id: a.id, status: a.status };
  });

  app.post('/adverts/:id/submit', auth, async (req) => {
    const a = await load(req, (req.params as any).id, 'adverts.manage');
    if (a.status !== 'draft' && a.status !== 'rejected') throw new HttpError(409, 'This advert was already submitted', 'wrong_state');
    const when = window({}, a);
    void when;
    const before = flat(a, await audienceLabel(a));
    await ctx.db.query(`UPDATE adverts SET status='pending', submitted_by=$2, reason=NULL, updated_at=$3 WHERE id=$1`, [a.id, req.session!.uid, ctx.clock.now().toISOString()]);
    await record(await reload(a.id), req, 'advert.submit', `Sent the advert "${a.title}" for approval`, before);
    return { id: a.id, status: 'pending' };
  });

  /** A different person approves (L131), so nobody can publish their own advert. */
  app.post('/adverts/:id/decide', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const a = await load(req, (req.params as any).id, 'adverts.approve');
    if (a.status !== 'pending') throw new HttpError(409, 'This advert is not waiting for approval', 'wrong_state');
    if (a.created_by === req.session!.uid || a.submitted_by === req.session!.uid) throw new HttpError(403, 'Someone else must approve an advert you created or submitted', 'same_person');
    const approve = b.approve !== false;
    const reason = text(b.reason, 200, 'reason');
    if (!approve && !reason) throw new HttpError(400, 'Say why the advert was not approved so the team can fix it', 'reason_required');
    if (approve) window({}, a); // an advert whose end date has passed cannot be approved
    const status = !approve ? 'rejected' : a.advertiser_name && !a.payment_id ? 'awaiting_payment' : 'approved';
    const before = flat(a, await audienceLabel(a));
    const now = ctx.clock.now().toISOString();
    await ctx.db.query(`UPDATE adverts SET status=$2, decided_by=$3, decided_at=$4, reason=$5, updated_at=$4 WHERE id=$1`, [a.id, status, req.session!.uid, now, approve ? null : reason]);
    const n = await reload(a.id);
    await record(n, req, approve ? 'advert.approve' : 'advert.reject', `${approve ? 'Approved' : 'Did not approve'} the advert "${a.title}"`, before, reason);
    await notify(a.org_id, a.created_by, approve ? (status === 'awaiting_payment' ? 'Advert approved, waiting for payment' : 'Your advert is approved') : 'Your advert needs changes',
      approve ? (status === 'awaiting_payment' ? `"${a.title}" is approved. It goes live as soon as ${a.advertiser_name} pays.` : `"${a.title}" will show on the member app ${a.starts_at > now ? 'from its start date' : 'now'}.`) : `"${a.title}" was not approved: ${reason}`, `staff:adverts?open=${a.id}`);
    return { id: a.id, status, payUrl: status === 'awaiting_payment' ? `${ctx.givingUrl}/?ad=${a.code}` : null };
  });

  for (const [verb, from, to, label] of [['pause', ['approved'], 'paused', 'Paused'], ['resume', ['paused'], 'approved', 'Resumed'], ['end', ['approved', 'paused', 'awaiting_payment', 'pending'], 'ended', 'Ended']] as const) {
    app.post(`/adverts/:id/${verb}`, auth, async (req) => {
      const a = await load(req, (req.params as any).id, 'adverts.manage');
      if (!(from as readonly string[]).includes(a.status)) throw new HttpError(409, `This advert cannot be ${verb === 'end' ? 'ended' : verb + 'd'} while it is ${a.status.replace('_', ' ')}`, 'wrong_state');
      const before = flat(a, await audienceLabel(a));
      await ctx.db.query(`UPDATE adverts SET status=$2, updated_at=$3 WHERE id=$1`, [a.id, to, ctx.clock.now().toISOString()]);
      await record(await reload(a.id), req, `advert.${verb}`, `${label} the advert "${a.title}"`, before);
      return { id: a.id, status: to };
    });
  }

  // ---------- platform admin ----------

  app.get('/admin/adverts', adm, async (req) => {
    const st = String((req.query as any).status ?? '');
    const rows = await ctx.db.query<any>(`${SELECT} ${st ? 'WHERE a.status=$1' : ''} ORDER BY a.created_at DESC LIMIT 200`, st ? [st] : []);
    const orgs = new Map((await ctx.db.query<any>(`SELECT id, name FROM organisations`)).map((o) => [o.id, o.name]));
    const out = [];
    for (const a of rows) out.push({ ...(await view(a, null, false, '/admin/adverts')), orgName: orgs.get(a.org_id) });
    return out;
  });

  app.get('/admin/adverts/:id/image', adm, async (req, reply) => {
    const a = (await ctx.db.query<any>(`SELECT image_mime, image_data FROM adverts WHERE id=$1`, [(req.params as any).id]))[0];
    if (!a) throw new HttpError(404, 'advert not found', 'not_found');
    return reply.header('content-type', a.image_mime).header('cache-control', 'private, max-age=300').send(Buffer.from(a.image_data, 'base64'));
  });

  /** Removes an advert at once, whatever the church says. The church sees the reason (L132). */
  app.post('/admin/adverts/:id/takedown', adm, async (req) => {
    const a = (await ctx.db.query<any>(`${SELECT} WHERE a.id=$1`, [(req.params as any).id]))[0];
    if (!a) throw new HttpError(404, 'advert not found', 'not_found');
    const reason = text((req.body as any)?.reason, 200, 'reason', true);
    if (a.status === 'taken_down' || a.status === 'ended') throw new HttpError(409, 'This advert is already off', 'wrong_state');
    const before = flat(a, await audienceLabel(a));
    await ctx.db.query(`UPDATE adverts SET status='taken_down', taken_down_by=$2, reason=$3, updated_at=$4 WHERE id=$1`, [a.id, req.session!.uid, reason, ctx.clock.now().toISOString()]);
    await record(await reload(a.id), req, 'advert.takedown', `Took down the advert "${a.title}"`, before, reason);
    await notify(a.org_id, a.created_by, 'An advert was taken down', `"${a.title}" was removed by ChurchOS: ${reason}`, `staff:adverts?open=${a.id}`);
    return { id: a.id, status: 'taken_down' };
  });

  // ---------- paying for a third-party advert ----------

  /** Lets the giving page show the advertiser what they are paying for. Only while it waits for payment. */
  app.get('/public/ad/:code', async (req) => {
    const a = (await ctx.db.query<any>(`SELECT a.id, a.code, a.title, a.advertiser_name, a.price, a.starts_at, a.ends_at, b.code AS church_code, b.name AS church FROM adverts a JOIN branches b ON b.id = COALESCE(a.branch_id, (SELECT id FROM branches WHERE org_id=a.org_id ORDER BY code LIMIT 1)) WHERE a.code=$1 AND a.status='awaiting_payment'`, [String((req.params as any).code).toUpperCase()]))[0];
    if (!a) throw new HttpError(404, 'There is no advert waiting for payment under that link', 'not_found');
    return { code: a.code, title: a.title, advertiser: a.advertiser_name, price: Number(a.price), startsAt: a.starts_at, endsAt: a.ends_at, churchCode: a.church_code, church: a.church, purpose: `AD-${a.code}` };
  });

  // ---------- member app ----------

  const VISIBLE = `a.status='approved' AND a.starts_at <= $2 AND (a.ends_at IS NULL OR a.ends_at > $2)
    AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=$1 AND m.status='active' AND m.org_id=a.org_id AND (
      a.audience->>'type'='org'
      OR (a.audience->>'type'='branch' AND m.branch_id=a.audience->>'id')
      OR (a.audience->>'type'='group' AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id=a.audience->>'id' AND gm.membership_id=m.id))))`;

  app.get('/me/adverts', auth, async (req) => {
    const rows = await ctx.db.query<any>(
      `SELECT a.id, a.title, a.body, a.link_url, a.action, a.advertiser_name, a.width, a.height, o.name AS church FROM adverts a JOIN organisations o ON o.id=a.org_id WHERE ${VISIBLE} ORDER BY a.starts_at DESC, a.created_at DESC LIMIT 10`,
      [req.session!.uid, ctx.clock.now().toISOString()],
    );
    const out = [];
    for (const a of rows) {
      let action: any = null;
      const x = a.action as { kind: string; itemId?: string; qty?: number } | null;
      if (x?.kind === 'shop') action = { kind: 'shop' };
      else if (x?.kind === 'event' && (x as any).eventId) {
        const ev = (await ctx.db.query<any>(`SELECT e.id, e.title, e.code, e.starts_at, e.status, e.ticketed, e.poster_data IS NOT NULL AS has_poster, COALESCE((SELECT MIN(price) FROM ticket_types t WHERE t.event_id=e.id AND t.active),0) AS from_price, COALESCE((SELECT SUM(quantity) FROM ticket_types t WHERE t.event_id=e.id AND t.active),0)::int AS cap, (SELECT count(*) FROM tickets k WHERE k.event_id=e.id AND k.status IN ('valid','used'))::int AS sold FROM events e WHERE e.id=$1`, [(x as any).eventId]))[0];
        action = { kind: 'event', eventId: (x as any).eventId, event: ev && ev.ticketed ? { id: ev.id, code: ev.code, title: ev.title, startsAt: ev.starts_at, from: Number(ev.from_price), available: ev.status === 'scheduled' && ev.cap > ev.sold, posterUrl: ev.has_poster ? `/public/event/${ev.code}/poster` : null } : null };
      }
      else if (x?.itemId) {
        const it = (await ctx.db.query<any>(`SELECT i.id, i.branch_id, i.name, i.price, i.active, i.low_stock, i.image_data IS NOT NULL AS has_image, COALESCE((SELECT SUM(qty) FROM shop_movements m WHERE m.item_id=i.id),0)::int AS stock FROM shop_items i WHERE i.id=$1`, [x.itemId]))[0];
        action = { kind: x.kind, itemId: x.itemId, qty: x.qty ?? 1, item: it ? { id: it.id, branchId: it.branch_id, name: it.name, price: Number(it.price), available: it.active && it.stock > 0, left: it.stock > 0 && it.stock <= it.low_stock ? it.stock : null, imageUrl: it.has_image ? `/me/shop/items/${it.id}/image` : null } : null };
      }
      out.push({ id: a.id, title: a.title, body: a.body, link: a.link_url, action, sponsor: a.advertiser_name, church: a.church, imageUrl: `/me/adverts/${a.id}/image`, width: a.width, height: a.height });
    }
    return out;
  });

  async function visible(req: FastifyRequest) {
    const a = (await ctx.db.query<any>(`SELECT a.* FROM adverts a WHERE a.id=$3 AND ${VISIBLE}`, [req.session!.uid, ctx.clock.now().toISOString(), (req.params as any).id]))[0];
    if (!a) throw new HttpError(404, 'advert not found', 'not_found');
    return a;
  }

  app.get('/me/adverts/:id/image', auth, async (req, reply) => {
    const a = await visible(req);
    return reply.header('content-type', a.image_mime).header('cache-control', 'private, max-age=300').send(Buffer.from(a.image_data, 'base64'));
  });

  for (const kind of ['view', 'tap'] as const) {
    app.post(`/me/adverts/:id/${kind}`, auth, async (req) => {
      const a = await visible(req);
      await ctx.db.query(`INSERT INTO advert_seen (advert_id, org_id, user_id, day, kind) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [a.id, a.org_id, req.session!.uid, eatDay(ctx.clock.now()), kind]);
      return { ok: true };
    });
  }
}

/** Called when a payment for AD-<code> arrives: the advert goes live (L131). */
export async function advertPaid(ctx: Ctx, code: string, paymentId: string): Promise<void> {
  const a = (await ctx.db.query<any>(`SELECT * FROM adverts WHERE code=$1 AND status='awaiting_payment'`, [code]))[0];
  if (!a) return;
  await ctx.db.query(`UPDATE adverts SET status='approved', payment_id=$2, updated_at=$3 WHERE id=$1`, [a.id, paymentId, ctx.clock.now().toISOString()]);
  await ctx.ledger.audit({ orgId: a.org_id, branchId: a.branch_id, actorType: 'psp', action: 'advert.paid', entity: 'advert', entityId: a.id, summary: `Payment received from ${a.advertiser_name} for the advert "${a.title}". It is now live.`, links: { advertId: a.id, paymentId } });
  await addNotification(ctx, { orgId: a.org_id, userId: a.created_by, kind: 'announcement', title: 'Advert paid and live', body: `${a.advertiser_name} has paid. "${a.title}" is now on the member app.`, link: `staff:adverts?open=${a.id}`, audience: 'staff' });
}
