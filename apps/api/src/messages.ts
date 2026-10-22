import { HttpError, type Ctx } from './ctx';
import { addNotification } from './notifications';
import { consentFor } from './consent';
import { ageBand, ageOn } from './members';
import { CHANNEL_LABEL, checkLowBalance, integrationSettings, walletFor, walletLabel, type Channel } from './wallets';
import { activeBands, allocate, costOf, recordUnits, unitsUsed } from './pricing';
import { WHATSAPP_TEMPLATE } from '@churchos/messaging';

export type SendChannel = 'inapp' | Channel;
export const SEND_CHANNELS: SendChannel[] = ['inapp', 'sms', 'whatsapp'];

/** Who a message is for. The sender picks a list, never numbers (L118). */
export interface AudienceSpec {
  scope: { type: 'org' } | { type: 'region'; id: string } | { type: 'branch'; id: string } | { type: 'group'; id: string };
  /** 'children' means the guardians of children. */
  who?: 'all' | 'adults' | 'children';
  ageBands?: string[];
  sex?: 'male' | 'female';
  /** A group leader choosing particular people in the group. */
  onlyMembershipIds?: string[];
  /** The branches the sender may message, fixed when the message is created so a later role change cannot widen it. */
  allowedBranchIds: string[];
  /** When set, this branch's wallet (or the organisation's, for null) pays for every recipient. Used for group messages (L122). */
  chargeTo?: { branchId: string | null };
}

export interface Recipient {
  membershipId: string;
  branchId: string;
  userId: string | null;
  phone: string | null;
  firstName: string;
  name: string;
  /** Children this person is being messaged about, as their guardian. A child never receives anything directly (L125). */
  forChildren?: { id: string; firstName: string }[];
}

const MAX_RECIPIENTS = 20_000;
const NAME_CAP = 15;

/** Everyone sees the same body with {name} filled in. Names are capped so every message costs the same. */
export const renderBody = (body: string, firstName: string) => body.replace(/\{name\}/gi, firstName.slice(0, NAME_CAP));
/** "For Ruth: " when a guardian is being told about their child. At most two names are shown so the length stays predictable. */
export const forPrefix = (r: Pick<Recipient, 'forChildren'>) => {
  const k = r.forChildren ?? [];
  if (!k.length) return '';
  const n = k.map((c) => c.firstName.slice(0, NAME_CAP));
  return `For ${n.length > 2 ? `${n[0]}, ${n[1]} and ${n.length - 2} more` : n.join(' and ')}: `;
};
export const renderFor = (body: string, r: Recipient) => forPrefix(r) + renderBody(body, r.firstName);
const PREFIX_RESERVE = 'For '.length + NAME_CAP * 2 + ' and 99 more: '.length;
export const smsSegments = (body: string, withChildren = false) => Math.max(1, Math.ceil((renderBody(body, 'X'.repeat(NAME_CAP)).length + (withChildren ? PREFIX_RESERVE : 0)) / 160));

export function validateAudience(raw: any): AudienceSpec {
  const s = raw?.scope;
  if (!s || !['org', 'region', 'branch', 'group'].includes(s.type)) throw new HttpError(400, 'Choose who the message is for', 'bad_audience');
  if (s.type !== 'org' && !s.id) throw new HttpError(400, 'Choose the branch, region or group', 'bad_audience');
  const who = raw.who ?? 'all';
  if (!['all', 'adults', 'children'].includes(who)) throw new HttpError(400, 'Choose everyone, adults or children', 'bad_audience');
  if (raw.sex && raw.sex !== 'male' && raw.sex !== 'female') throw new HttpError(400, 'Choose male or female, or leave it blank', 'bad_audience');
  return { scope: s, who, ageBands: Array.isArray(raw.ageBands) ? raw.ageBands.map(String) : undefined, sex: raw.sex, onlyMembershipIds: Array.isArray(raw.onlyMembershipIds) ? raw.onlyMembershipIds.map(String) : undefined, allowedBranchIds: [] };
}

/** Turns an audience into people. Children are reached through their guardians and nobody is counted twice (L119). */
export async function resolveAudience(ctx: Ctx, orgId: string, spec: AudienceSpec): Promise<Recipient[]> {
  const allowed = spec.allowedBranchIds;
  if (allowed.length === 0) return [];
  let baseIds: string[] | null = null;
  let branchFilter = allowed;
  if (spec.scope.type === 'region') {
    const inRegion = (await ctx.db.query<any>(`SELECT id FROM branches WHERE org_id=$1 AND region=$2`, [orgId, spec.scope.id])).map((b) => b.id);
    branchFilter = allowed.filter((b) => inRegion.includes(b));
  } else if (spec.scope.type === 'branch') {
    branchFilter = allowed.filter((b) => b === (spec.scope as any).id);
  } else if (spec.scope.type === 'group') {
    const g = (await ctx.db.query<any>(`SELECT id, branch_id FROM groups WHERE id=$1 AND org_id=$2`, [spec.scope.id, orgId]))[0];
    if (!g) throw new HttpError(404, 'That group was not found', 'not_found');
    baseIds = (await ctx.db.query<any>(`SELECT membership_id FROM group_members WHERE group_id=$1`, [g.id])).map((r) => r.membership_id);
    if (spec.onlyMembershipIds) baseIds = baseIds.filter((id) => spec.onlyMembershipIds!.includes(id));
    branchFilter = allowed; // a group may span branches, the sender's scope still limits whose branch pays and who is reached
  }
  const params: unknown[] = [orgId];
  let where = `m.org_id=$1 AND m.status='active'`;
  if (baseIds) {
    if (baseIds.length === 0) return [];
    params.push(baseIds);
    where += ` AND m.id = ANY($${params.length}::text[])`;
  } else {
    if (branchFilter.length === 0) return [];
    params.push(branchFilter);
    where += ` AND m.branch_id = ANY($${params.length}::text[])`;
  }
  if (spec.sex) { params.push(spec.sex); where += ` AND m.sex=$${params.length}`; }
  const rows = await ctx.db.query<any>(`SELECT m.id, m.full_name, m.phone, m.user_id, m.branch_id, m.category, m.dob FROM memberships m WHERE ${where} ORDER BY m.full_name LIMIT ${MAX_RECIPIENTS + 1}`, params);
  if (rows.length > MAX_RECIPIENTS) throw new HttpError(400, 'That audience is too large for one message. Narrow it down, for example by branch.', 'audience_too_large');

  const now = ctx.clock.now();
  const bandOk = (r: any) => !spec.ageBands?.length || (r.dob && spec.ageBands.includes(ageBand(ageOn(r.dob, now))));
  const people = rows.filter(bandOk);
  const adults = people.filter((r) => r.category === 'adult');
  const children = people.filter((r) => r.category === 'child');

  const chosen = new Map<string, any>();
  const who = spec.who ?? 'all';
  const adultIds = new Set<string>();
  if (who !== 'children') for (const a of adults) { chosen.set(a.id, a); adultIds.add(a.id); }
  if (who !== 'adults' && children.length) {
    const kids = new Map(children.map((c) => [c.id, String(c.full_name).split(' ')[0]]));
    const links = await ctx.db.query<any>(
      `SELECT g.guardian_id AS id, g.child_id, mm.full_name, mm.phone, mm.user_id, mm.branch_id FROM guardians g JOIN memberships mm ON mm.id=g.guardian_id
        WHERE g.child_id = ANY($1::text[]) AND mm.status='active' ORDER BY g.child_id`,
      [children.map((c) => c.id)],
    );
    // One copy per guardian however many children they have, with the children named (L125).
    for (const g of links) {
      if (adultIds.has(g.id)) continue; // already told as an adult, so the same message is not repeated
      const row = chosen.get(g.id) ?? { ...g };
      row.forChildren = [...(row.forChildren ?? []), { id: g.child_id, firstName: kids.get(g.child_id)! }];
      chosen.set(g.id, row);
    }
  }
  return [...chosen.values()]
    .map((r) => ({ membershipId: r.id, branchId: r.branch_id, userId: r.user_id ?? null, phone: r.phone ?? null, firstName: String(r.full_name).split(' ')[0], name: r.full_name, forChildren: r.forChildren as Recipient['forChildren'] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

type Skip = 'skipped_no_phone' | 'skipped_opted_out' | 'skipped_not_opted_in';

/** Splits recipients into those who may receive a channel and those who may not, with the reason (L119). */
async function eligibility(ctx: Ctx, orgId: string, recipients: Recipient[], channel: Channel) {
  const phones = recipients.map((r) => r.phone).filter(Boolean) as string[];
  // The person's own choice first, then this church's own record (AZ-07).
  const prefs = await consentFor(ctx, orgId, phones);
  const ok: Recipient[] = [];
  const skipped: { r: Recipient; status: Skip }[] = [];
  for (const r of recipients) {
    if (!r.phone) { skipped.push({ r, status: 'skipped_no_phone' }); continue; }
    const p = prefs.get(r.phone);
    if (channel === 'sms' && p?.sms_opt_out) { skipped.push({ r, status: 'skipped_opted_out' }); continue; }
    if (channel === 'whatsapp' && !p?.whatsapp_opt_in) { skipped.push({ r, status: 'skipped_not_opted_in' }); continue; }
    ok.push(r);
  }
  return { ok, skipped };
}

/** Units each recipient uses: one per 160-character part for SMS, one for WhatsApp. */
const unitsEach = (channel: Channel, body: string, recipients: Recipient[]) => (channel === 'sms' ? smsSegments(body, recipients.some((r) => r.forChildren?.length)) : 1);

async function walletGroups(ctx: Ctx, orgId: string, recipients: Recipient[], channel: Channel, chargeTo?: { branchId: string | null }) {
  const groups = new Map<string, { wallet: any; people: Recipient[] }>();
  for (const r of recipients) {
    const w = await walletFor(ctx, orgId, chargeTo ? chargeTo.branchId : r.branchId, channel);
    if (!w) continue;
    const g = groups.get(w.id) ?? { wallet: w, people: [] };
    g.people.push(r);
    groups.set(w.id, g);
  }
  return groups;
}

async function names(ctx: Ctx, orgId: string) {
  const org = (await ctx.db.query<any>(`SELECT name FROM organisations WHERE id=$1`, [orgId]))[0]?.name ?? '';
  const branches = new Map((await ctx.db.query<any>(`SELECT id, name FROM branches WHERE org_id=$1`, [orgId])).map((b) => [b.id, b.name]));
  return { org, branches };
}

/** How many people a message would reach, what each wallet would pay, and where a wallet would run short (L118, L120, L124). */
export async function estimate(ctx: Ctx, orgId: string, spec: AudienceSpec, channels: SendChannel[], body: string) {
  const recipients = await resolveAudience(ctx, orgId, spec);
  const n = await names(ctx, orgId);
  const out: any = { people: recipients.length, inApp: { reachable: recipients.filter((r) => r.userId).length, noAccount: recipients.filter((r) => !r.userId).length }, wallets: [] as any[], totalCost: 0, shortBranches: [] as string[] };
  for (const ch of ['sms', 'whatsapp'] as Channel[]) {
    if (!channels.includes(ch)) continue;
    const el = await eligibility(ctx, orgId, recipients, ch);
    const reasons = { noPhone: 0, optedOut: 0, notOptedIn: 0 };
    for (const s of el.skipped) {
      if (s.status === 'skipped_no_phone') reasons.noPhone++;
      else if (s.status === 'skipped_opted_out') reasons.optedOut++;
      else reasons.notOptedIn++;
    }
    const units = unitsEach(ch, body, recipients);
    const bands = await activeBands(ctx, orgId, ch);
    let used = await unitsUsed(ctx, orgId, ch);
    out[ch] = { eligible: el.ok.length, ...reasons, perMessage: costOf(bands, used, units), segments: ch === 'sms' ? smsSegments(body, recipients.some((r) => r.forChildren?.length)) : 1 };
    const groups = await walletGroups(ctx, orgId, el.ok, ch, spec.chargeTo);
    for (const g of groups.values()) {
      const balance = await ctx.ledger.walletBalance(g.wallet.id);
      const a = allocate(bands, used, balance, g.people.length, units);
      const needed = costOf(bands, used, g.people.length * units);
      const label = walletLabel(g.wallet, n.org, g.wallet.branch_id ? n.branches.get(g.wallet.branch_id) ?? null : null);
      out.wallets.push({ walletId: g.wallet.id, label, channel: ch, recipients: g.people.length, needed, balance, affordable: a.costs.length, short: g.people.length - a.costs.length });
      out.totalCost += a.spent;
      used = a.usedAfter;
      if (a.costs.length < g.people.length) out.shortBranches.push(label);
    }
  }
  return out;
}

async function bulkInsertRecipients(ctx: Ctx, rows: { m: string; membership: string; channel: SendChannel; status: string; cost: number; wallet: string | null }[]) {
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const params: unknown[] = [];
    const values = chunk.map((r, k) => {
      params.push(r.m, r.membership, r.channel, r.status, r.cost, r.wallet);
      const o = k * 6;
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6})`;
    });
    await ctx.db.query(`INSERT INTO message_recipients (message_id, membership_id, channel, status, cost, wallet_id) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`, params);
  }
}

/**
 * Delivers one message. Claims it first, so two runs cannot both send it. In-app goes to everyone with an account. SMS and WhatsApp
 * go only to people who may receive them, and only as many as each wallet can pay for. Each wallet is charged once for its batch
 * (L118, L119, L120).
 */
export async function sendMessage(ctx: Ctx, messageId: string): Promise<any> {
  const claimed = await ctx.db.query<any>(`UPDATE messages SET status='sending' WHERE id=$1 AND status='scheduled' RETURNING *`, [messageId]);
  const m = claimed[0];
  if (!m) return null;
  const spec: AudienceSpec = m.audience;
  const channels: SendChannel[] = m.channels;
  try {
    const recipients = await resolveAudience(ctx, m.org_id, spec);
    const n = await names(ctx, m.org_id);
    const now = ctx.clock.now().toISOString();
    const settings = await integrationSettings(ctx.db, m.org_id);
    const branchOverride = m.branch_id ? (await ctx.db.query<any>(`SELECT * FROM branch_integrations WHERE branch_id=$1`, [m.branch_id]))[0] : null;
    const summary: any = { people: recipients.length, channels: {}, cost: 0, shortWallets: [] };
    const rows: Parameters<typeof bulkInsertRecipients>[1] = [];

    if (channels.includes('inapp')) {
      const withUser = recipients.filter((r) => r.userId);
      for (let i = 0; i < withUser.length; i += 200) {
        const chunk = withUser.slice(i, i + 200);
        for (const r of chunk) {
          await addNotification(ctx, { orgId: m.org_id, userId: r.userId!, kind: 'message', title: m.title, body: renderFor(m.body, r), messageId: m.id, memberId: r.forChildren?.length === 1 ? r.forChildren[0].id : null, forName: r.forChildren?.length ? r.forChildren.map((c) => c.firstName).join(', ') : null });
        }
      }
      for (const r of recipients) rows.push({ m: m.id, membership: r.membershipId, channel: 'inapp', status: r.userId ? 'sent' : 'skipped_no_account', cost: 0, wallet: null });
      summary.channels.inapp = { sent: withUser.length, noAccount: recipients.length - withUser.length };
    }

    const touched = new Set<string>();
    for (const ch of ['sms', 'whatsapp'] as Channel[]) {
      if (!channels.includes(ch)) continue;
      const el = await eligibility(ctx, m.org_id, recipients, ch);
      const stat = { sent: 0, failed: 0, noPhone: 0, optedOut: 0, notOptedIn: 0, noBalance: 0, cost: 0 };
      for (const s of el.skipped) {
        rows.push({ m: m.id, membership: s.r.membershipId, channel: ch, status: s.status, cost: 0, wallet: null });
        if (s.status === 'skipped_no_phone') stat.noPhone++;
        else if (s.status === 'skipped_opted_out') stat.optedOut++;
        else stat.notOptedIn++;
      }
      const units = unitsEach(ch, m.body, recipients);
      const bands = await activeBands(ctx, m.org_id, ch);
      let used = await unitsUsed(ctx, m.org_id, ch);
      let deliveredUnits = 0;
      const from = ch === 'sms' ? branchOverride?.sms_sender_id ?? settings.smsSenderId : branchOverride?.whatsapp_number ?? settings.whatsappNumber;
      for (const g of (await walletGroups(ctx, m.org_id, el.ok, ch, spec.chargeTo)).values()) {
        const balance = await ctx.ledger.walletBalance(g.wallet.id);
        const alloc = allocate(bands, used, balance, g.people.length, units);
        let costs = alloc.costs;
        // Each wallet is charged once for its batch, at marginal band prices (L124).
        if (costs.length > 0 && !(await ctx.ledger.chargeWallet(g.wallet.id, alloc.spent, `${m.id}:${ch}:${g.wallet.id}`, ch))) costs = [];
        touched.add(g.wallet.id);
        const paid = g.people.slice(0, costs.length);
        for (const r of g.people.slice(costs.length)) { rows.push({ m: m.id, membership: r.membershipId, channel: ch, status: 'skipped_no_balance', cost: 0, wallet: g.wallet.id }); stat.noBalance++; }
        let failedCost = 0;
        let failed = 0;
        for (let i = 0; i < paid.length; i += 200) {
          const chunk = paid.slice(i, i + 200);
          const results = await ctx.messaging.send(ch, chunk.map((r) => ({ to: r.phone!, body: renderFor(m.body, r), from, ...(ch === 'whatsapp' ? { template: WHATSAPP_TEMPLATE } : {}) })));
          chunk.forEach((r, k) => {
            const ok = results[k]?.status === 'sent';
            const cost = costs[i + k];
            if (!ok) { failed++; failedCost += cost; }
            rows.push({ m: m.id, membership: r.membershipId, channel: ch, status: ok ? 'sent' : 'failed', cost: ok ? cost : 0, wallet: g.wallet.id });
          });
        }
        if (failedCost) await ctx.ledger.refundWallet(g.wallet.id, failedCost, `${m.id}:${ch}:${g.wallet.id}`, ch);
        const okCount = paid.length - failed;
        deliveredUnits += okCount * units;
        used += okCount * units; // only delivered messages count towards the month's volume (L125)
        stat.sent += okCount;
        stat.failed += failed;
        stat.cost += alloc.spent - failedCost;
        if (costs.length < g.people.length) summary.shortWallets.push({ label: walletLabel(g.wallet, n.org, g.wallet.branch_id ? n.branches.get(g.wallet.branch_id) ?? null : null), channel: ch, short: g.people.length - costs.length });
      }
      await recordUnits(ctx, m.org_id, ch, deliveredUnits);
      summary.channels[ch] = stat;
      summary.cost += stat.cost;
    }
    await bulkInsertRecipients(ctx, rows);
    for (const w of touched) await checkLowBalance(ctx, w);
    await ctx.db.query(`UPDATE messages SET status='sent', sent_at=$2, summary=$3 WHERE id=$1`, [m.id, now, JSON.stringify(summary)]);
    const parts = Object.entries(summary.channels).map(([k, v]: any) => `${k === 'inapp' ? 'in-app' : CHANNEL_LABEL[k as Channel]} ${v.sent}`);
    await ctx.ledger.audit({
      orgId: m.org_id, branchId: m.branch_id, actorId: m.sender_id, actorName: m.sender_name, actorType: 'user', action: 'message.send', entity: 'message', entityId: m.id,
      summary: `Sent "${m.title}" to ${recipients.length} people (${parts.join(', ')})`, links: { messageId: m.id },
      meta: { people: recipients.length, cost: summary.cost, source: m.source, short: summary.shortWallets.length },
    });
    return summary;
  } catch (e: any) {
    await ctx.db.query(`UPDATE messages SET status='failed', summary=$2 WHERE id=$1`, [m.id, JSON.stringify({ error: e.message })]);
    await ctx.ledger.audit({ orgId: m.org_id, action: 'message.failed', entity: 'message', entityId: m.id, summary: `Sending "${m.title}" failed`, actorType: 'system', meta: { error: String(e.message).slice(0, 200) } });
    throw e;
  }
}

/** Sends every scheduled message whose time has come. Run by the scheduler and after the development clock moves (L118). */
export async function runScheduledMessages(ctx: Ctx): Promise<number> {
  const due = await ctx.db.query<any>(`SELECT id FROM messages WHERE status='scheduled' AND scheduled_at <= $1 ORDER BY scheduled_at LIMIT 50`, [ctx.clock.now().toISOString()]);
  let n = 0;
  for (const d of due) {
    try {
      if (await sendMessage(ctx, d.id)) n++;
    } catch (e) {
      console.error('scheduled message failed', d.id, e);
    }
  }
  return n;
}
