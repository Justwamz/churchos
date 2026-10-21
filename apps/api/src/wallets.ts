import { maskEmail } from '@churchos/shared';
import type { Db } from '@churchos/ledger';
import { HttpError, type Ctx } from './ctx';
import { addNotification } from './notifications';
import { messagesBuyable, priceInfo } from './pricing';

export type Channel = 'sms' | 'whatsapp';
export const CHANNELS: Channel[] = ['sms', 'whatsapp'];
export const CHANNEL_LABEL: Record<Channel, string> = { sms: 'SMS', whatsapp: 'WhatsApp' };

/** List prices in cents, used only to seed the default tariff. The price a church pays comes from its tariff (L124). In-app is free. */
export const RATES: Record<Channel, number> = { sms: 100, whatsapp: 300 };
/** A wallet is "low" below this much credit unless the church sets its own (L115). KES 20 for SMS, KES 60 for WhatsApp. */
export const DEFAULT_THRESHOLD: Record<Channel, number> = { sms: 2000, whatsapp: 6000 };
export const PAYBILL_PREFIX: Record<Channel, string> = { sms: 'SMS', whatsapp: 'WA' };

export interface WalletRow {
  id: string;
  org_id: string;
  branch_id: string | null;
  channel: Channel;
  code: string;
  low_threshold: number;
  state: 'ok' | 'low' | 'empty';
}

export async function integrationSettings(q: Db, orgId: string) {
  await q.query(`INSERT INTO integration_settings (org_id) VALUES ($1) ON CONFLICT DO NOTHING`, [orgId]);
  const r = (await q.query<any>(`SELECT * FROM integration_settings WHERE org_id=$1`, [orgId]))[0];
  return { orgId, walletMode: r.wallet_mode as 'shared' | 'per_branch', smsSenderId: r.sms_sender_id, whatsappDisplayName: r.whatsapp_display_name, whatsappNumber: r.whatsapp_number, alertEmails: (r.alert_emails ?? []) as string[] };
}

/**
 * Makes sure the wallets the church's mode needs exist (L113). The organisation always has one wallet per channel, and in
 * per-branch mode every branch also has its own. Switching mode never removes a wallet or its balance.
 */
export async function ensureWallets(ctx: Ctx, orgId: string): Promise<void> {
  const org = (await ctx.db.query<any>(`SELECT id, sms_code FROM organisations WHERE id=$1`, [orgId]))[0];
  if (!org) return;
  const mode = (await integrationSettings(ctx.db, orgId)).walletMode;
  const make = async (id: string, branchId: string | null, channel: Channel, code: string) => {
    await ctx.db.query(
      `INSERT INTO wallets (id, org_id, branch_id, channel, code, low_threshold, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [id, orgId, branchId, channel, code, DEFAULT_THRESHOLD[channel], ctx.clock.now().toISOString()],
    );
    await ctx.ledger.createWallet(id, orgId);
  };
  const orgCode = org.sms_code ?? orgId.replace(/^org_/, '').toUpperCase();
  for (const ch of CHANNELS) await make(`wal:${orgId}:${ch}`, null, ch, orgCode);
  if (mode === 'per_branch') {
    const branches = await ctx.db.query<any>(`SELECT id, code FROM branches WHERE org_id=$1`, [orgId]);
    for (const b of branches) for (const ch of CHANNELS) await make(`wal:${b.id}:${ch}`, b.id, ch, b.code);
  }
}

/** The wallet that pays for a message to someone in a branch. In per-branch mode it is the branch's own (L120). */
export async function walletFor(ctx: Ctx, orgId: string, branchId: string | null, channel: Channel, q: Db = ctx.db): Promise<WalletRow | null> {
  const mode = (await integrationSettings(q, orgId)).walletMode;
  if (mode === 'per_branch' && branchId) {
    const w = (await q.query<any>(`SELECT * FROM wallets WHERE org_id=$1 AND branch_id=$2 AND channel=$3`, [orgId, branchId, channel]))[0];
    if (w) return w;
  }
  return (await q.query<any>(`SELECT * FROM wallets WHERE org_id=$1 AND branch_id IS NULL AND channel=$2`, [orgId, channel]))[0] ?? null;
}

export function walletLabel(w: WalletRow, orgName: string, branchName: string | null): string {
  return `${w.branch_id ? branchName : orgName} · ${CHANNEL_LABEL[w.channel]}`;
}

/** What the screens show for a wallet: balance, what it buys, the threshold, and how to pay into it by paybill (L116). */
export async function walletView(ctx: Ctx, w: WalletRow, names: { org: string; branch: string | null }) {
  const balance = await ctx.ledger.walletBalance(w.id);
  const info = await priceInfo(ctx, w.org_id, w.channel);
  const messagesLeft = messagesBuyable(info.bands, info.used, balance);
  return {
    id: w.id,
    orgId: w.org_id,
    branchId: w.branch_id,
    channel: w.channel,
    scope: w.branch_id ? 'branch' : 'organisation',
    label: walletLabel(w, names.org, names.branch),
    balance,
    rate: info.currentPrice,
    price: { current: info.currentPrice, next: info.nextPrice, unitsLeftInBand: info.unitsLeftInBand, usedThisMonth: info.used, month: info.month },
    messagesLeft,
    threshold: Number(w.low_threshold),
    state: messagesLeft < 1 ? 'empty' : balance < Number(w.low_threshold) ? 'low' : 'ok',
    paybillReference: `${PAYBILL_PREFIX[w.channel]}#${w.code}`,
  };
}

/** Who can see a wallet (L115, L116): anyone whose role has wallets.view over its scope. */
export async function walletViewers(ctx: Ctx, w: WalletRow): Promise<{ id: string; name: string; email: string | null; email_verified: boolean }[]> {
  const rows = await ctx.db.query<any>(
    `SELECT ra.user_id, ra.scope_type, ra.scope_id FROM role_assignments ra JOIN roles r ON r.id = ra.role_id
      WHERE ra.org_id=$1 AND r.permissions @> '["wallets.view"]'::jsonb`,
    [w.org_id],
  );
  const users = new Set<string>();
  for (const a of rows) {
    if (!w.branch_id || a.scope_type === 'org') { users.add(a.user_id); continue; }
    if (a.scope_type === 'branch' && a.scope_id === w.branch_id) users.add(a.user_id);
    if (a.scope_type === 'region') {
      const inRegion = (await ctx.db.query<any>(`SELECT 1 FROM branches WHERE id=$1 AND region=$2`, [w.branch_id, a.scope_id]))[0];
      if (inRegion) users.add(a.user_id);
    }
  }
  if (users.size === 0) return [];
  return ctx.db.query<any>(`SELECT id, name, email, email_verified FROM users WHERE id = ANY($1::text[])`, [[...users]]);
}

/** Permissions that make a person a recipient of email alerts. Holding one means a verified email is required (L123). */
export const ALERT_PERMISSIONS = ['wallets.view'];

/** True when this person receives email alerts through any of their roles. Platform admins are exempt, they have their own tools. */
export async function emailRequired(ctx: Ctx, uid: string): Promise<boolean> {
  const rows = await ctx.db.query<any>(
    `SELECT 1 FROM role_assignments ra JOIN roles r ON r.id = ra.role_id WHERE ra.user_id=$1 AND r.permissions ?| $2::text[] LIMIT 1`,
    [uid, ALERT_PERMISSIONS],
  );
  return rows.length > 0;
}

/** Throws 428 when someone who must have a verified email does not (L123). */
export async function requireVerifiedEmail(ctx: Ctx, uid: string, isAdmin: boolean): Promise<void> {
  if (isAdmin || !(await emailRequired(ctx, uid))) return;
  const u = (await ctx.db.query<any>(`SELECT email, email_verified FROM users WHERE id=$1`, [uid]))[0];
  if (!u?.email || !u.email_verified) throw new HttpError(428, 'Add your email address and confirm it with the code we send you, so you receive messaging alerts.', 'email_required');
}

export async function sendEmail(ctx: Ctx, orgId: string | null, to: string, subject: string, body: string, html?: string) {
  const res = await ctx.email.send({ to, subject, body, html });
  await ctx.db.query(`INSERT INTO email_outbox (id, org_id, to_email, subject, body, html, status, error, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
    ctx.newId('eml'), orgId, to, subject, body, html ?? null, res.status, res.error ?? null, ctx.clock.now().toISOString(),
  ]);
  return res.status === 'sent';
}

/**
 * Checks a wallet after its balance changed. When it gets worse (ok to low, or anything to empty) everyone who can view the
 * wallet gets an in-app notice and an email, once for that crossing (L115). A balance back above the threshold re-arms it.
 */
export async function checkLowBalance(ctx: Ctx, walletId: string): Promise<'ok' | 'low' | 'empty'> {
  const w = (await ctx.db.query<any>(`SELECT * FROM wallets WHERE id=$1`, [walletId]))[0] as WalletRow | undefined;
  if (!w) return 'ok';
  const org = (await ctx.db.query<any>(`SELECT name FROM organisations WHERE id=$1`, [w.org_id]))[0];
  const branch = w.branch_id ? (await ctx.db.query<any>(`SELECT name FROM branches WHERE id=$1`, [w.branch_id]))[0] : null;
  const v = await walletView(ctx, w, { org: org?.name ?? '', branch: branch?.name ?? null });
  const next = v.state as 'ok' | 'low' | 'empty';
  const order = { ok: 0, low: 1, empty: 2 } as const;
  if (next === w.state) return next;
  await ctx.db.query(`UPDATE wallets SET state=$2 WHERE id=$1`, [walletId, next]);
  if (order[next] < order[w.state]) return next; // topped up: re-armed, no alert

  const channel = CHANNEL_LABEL[w.channel];
  const kes = (c: number) => `KES ${(c / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const title = next === 'empty' ? `${v.label} credit has run out` : `${v.label} credit is low`;
  const body =
    next === 'empty'
      ? `The ${channel} wallet for ${v.label.split(' · ')[0]} is empty, so ${channel} messages are not being sent. In-app messages still go out. Top up in Messaging wallets to start again.`
      : `The ${channel} wallet for ${v.label.split(' · ')[0]} has ${kes(v.balance)} left, about ${v.messagesLeft} messages. Top up in Messaging wallets before it runs out.`;
  const viewers = await walletViewers(ctx, w);
  const now = ctx.clock.now().toISOString();
  let emailed = 0;
  for (const u of viewers) {
    await addNotification(ctx, { orgId: w.org_id, userId: u.id, kind: 'announcement', title, body, link: 'staff:wallets', audience: 'staff' });
    if (u.email && u.email_verified && (await sendEmail(ctx, w.org_id, u.email, `ChurchOS: ${title}`, `Hello ${u.name.split(' ')[0]},\n\n${body}\n\nThis message was sent because you can view this wallet.`))) emailed++;
  }
  const extra = (await integrationSettings(ctx.db, w.org_id)).alertEmails;
  for (const e of extra) if (await sendEmail(ctx, w.org_id, e, `ChurchOS: ${title}`, body)) emailed++;
  await ctx.ledger.audit({
    orgId: w.org_id, branchId: w.branch_id, actorType: 'system', action: 'wallet.low_balance', category: 'money', entity: 'wallet', entityId: walletId,
    summary: `${title}. Alert sent to ${viewers.length} ${viewers.length === 1 ? 'person' : 'people'}, ${emailed} by email`,
    meta: { state: next, balance: v.balance, threshold: v.threshold, recipients: viewers.length, emailed, noEmail: viewers.filter((x) => !x.email || !x.email_verified).length, extraEmails: extra.map((e) => maskEmail(e)) },
  });
  return next;
}
