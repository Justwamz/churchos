import type { FastifyInstance, FastifyRequest } from 'fastify';
import { maskEmail, maskPhone, toCents } from '@churchos/shared';
import { branchesFor, normalizePhone } from '../auth';
import { diff, maskedSnapshot, recordVersion, type FieldSpec } from '../audit';
import { HttpError, requireAdmin, requireSession, staffScope, type Ctx } from '../ctx';
import { checkLowBalance, CHANNELS, DEFAULT_THRESHOLD, ensureWallets, integrationSettings, PAYBILL_PREFIX, RATES, walletFor, walletView, type Channel, type WalletRow } from '../wallets';
import { csv } from './helpers';

const INTEGRATION_SPECS: FieldSpec[] = [
  { field: 'walletMode', label: 'Who pays for messages' },
  { field: 'smsSenderId', label: 'SMS sender name' },
  { field: 'whatsappDisplayName', label: 'WhatsApp display name' },
  { field: 'whatsappNumber', label: 'WhatsApp number', mask: 'phone' },
  { field: 'alertEmails', label: 'Extra alert emails', mask: 'email' },
  { field: 'branchOverrides', label: 'Branch overrides' },
];

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function walletRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };
  const adm = { preHandler: requireAdmin };

  /** Org and branches the signed-in person can see wallets for. A wallet at organisation level is visible to anyone with wallets.view in that church. */
  async function walletScope(req: FastifyRequest, perm: 'wallets.view' | 'wallets.topup' | 'wallets.manage' | 'integrations.manage') {
    const s = await staffScope(ctx, req, perm);
    return s;
  }

  async function namesOf(orgId: string) {
    const org = (await ctx.db.query<any>(`SELECT name FROM organisations WHERE id=$1`, [orgId]))[0]?.name ?? '';
    const branches = new Map((await ctx.db.query<any>(`SELECT id, name FROM branches WHERE org_id=$1`, [orgId])).map((b) => [b.id, b.name]));
    return { org, branches };
  }

  async function loadWallet(req: FastifyRequest, perm: 'wallets.view' | 'wallets.topup' | 'wallets.manage', id: string): Promise<WalletRow> {
    const rows = await branchesFor(ctx.db, req.session!.uid, perm);
    if (rows.length === 0) throw new HttpError(403, `missing permission ${perm}`, 'forbidden');
    const w = (await ctx.db.query<any>(`SELECT * FROM wallets WHERE id=$1`, [id]))[0] as WalletRow | undefined;
    // A wallet in another church looks exactly like one that does not exist.
    const inOrg = w && rows.some((r) => r.orgId === w.org_id);
    const inScope = w && (!w.branch_id || rows.some((r) => r.branchId === w.branch_id));
    if (!w || !inOrg || !inScope) throw new HttpError(404, 'wallet not found', 'not_found');
    return w;
  }

  // ---------- balances, always visible to people who may see them (L116) ----------

  app.get('/wallets', auth, async (req) => {
    const s = await walletScope(req, 'wallets.view');
    const n = await namesOf(s.orgId);
    const can = async (perm: 'wallets.topup' | 'wallets.manage') => (await branchesFor(ctx.db, req.session!.uid, perm)).filter((r) => r.orgId === s.orgId).map((r) => r.branchId);
    const topup = new Set(await can('wallets.topup'));
    const manage = new Set(await can('wallets.manage'));
    const rows = await ctx.db.query<any>(`SELECT * FROM wallets WHERE org_id=$1 AND (branch_id IS NULL OR branch_id = ANY($2::text[])) ORDER BY (branch_id IS NOT NULL), branch_id, channel`, [s.orgId, s.branchIds]);
    const wallets = [];
    for (const w of rows as WalletRow[]) {
      const v = await walletView(ctx, w, { org: n.org, branch: w.branch_id ? n.branches.get(w.branch_id) ?? null : null });
      wallets.push({ ...v, canTopUp: w.branch_id ? topup.has(w.branch_id) : topup.size > 0, canManage: w.branch_id ? manage.has(w.branch_id) : manage.size > 0 });
    }
    const settings = await integrationSettings(ctx.db, s.orgId);
    return { organisation: { id: s.orgId, name: n.org }, mode: settings.walletMode, rates: RATES, wallets };
  });

  app.get('/wallets/:id/activity', auth, async (req) => {
    const w = await loadWallet(req, 'wallets.view', (req.params as any).id);
    const topups = await ctx.db.query<any>(`SELECT id, amount, method, status, created_at FROM wallet_topups WHERE wallet_id=$1 ORDER BY created_at DESC LIMIT 30`, [w.id]);
    const spent = await ctx.db.query<any>(
      `SELECT r.message_id, m.title, m.sent_at, r.channel, COUNT(*) FILTER (WHERE r.status='sent') AS sent, COALESCE(SUM(r.cost),0) AS cost
         FROM message_recipients r JOIN messages m ON m.id=r.message_id WHERE r.wallet_id=$1 AND r.channel <> 'inapp' GROUP BY r.message_id, m.title, m.sent_at, r.channel ORDER BY m.sent_at DESC LIMIT 30`,
      [w.id],
    );
    return { topups, spent };
  });

  // ---------- top-up: M-Pesa prompt or card, one short journey (L116) ----------

  app.post('/wallets/:id/topup', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const w = await loadWallet(req, 'wallets.topup', (req.params as any).id);
    let amount: number;
    try { amount = toCents(b.amount); } catch { throw new HttpError(400, 'Enter an amount', 'bad_amount'); }
    if (amount < 10_000) throw new HttpError(400, 'The minimum top-up is KES 100', 'amount_too_small');
    if (amount > 5_000_000) throw new HttpError(400, 'The maximum top-up is KES 50,000', 'amount_too_large');
    if (b.method !== 'mpesa' && b.method !== 'card') throw new HttpError(400, 'Choose M-Pesa or card', 'bad_method');
    const reference = `${PAYBILL_PREFIX[w.channel]}#${w.code}`;
    const id = ctx.newId('top');
    const now = ctx.clock.now().toISOString();
    if (b.method === 'mpesa') {
      const phone = normalizePhone(b.phone);
      if (!phone) throw new HttpError(400, 'Enter a valid Kenyan phone number', 'bad_phone');
      const { providerTxId } = await ctx.provider.initiateStkPush({ phone, amount, reference, method: 'mpesa' });
      await ctx.db.query(`INSERT INTO wallet_topups (id, wallet_id, org_id, amount, method, phone, provider_tx_id, created_by, created_at) VALUES ($1,$2,$3,$4,'mpesa',$5,$6,$7,$8)`, [id, w.id, w.org_id, amount, phone, providerTxId, req.session!.uid, now]);
      return { id, method: 'mpesa', status: 'initiated', message: `Check ${phone.replace(/^254/, '0')} and enter your PIN to complete the top-up.` };
    }
    // Card: the person pays on the payment provider's own page, so card details never reach ChurchOS.
    const { providerTxId } = await ctx.provider.initiateCardCheckout({ amount, reference, phone: req.session!.phone });
    await ctx.db.query(`INSERT INTO wallet_topups (id, wallet_id, org_id, amount, method, provider_tx_id, created_by, created_at) VALUES ($1,$2,$3,$4,'card',$5,$6,$7)`, [id, w.id, w.org_id, amount, providerTxId, req.session!.uid, now]);
    return { id, method: 'card', status: 'initiated', checkoutUrl: `${ctx.givingUrl}/checkout/${providerTxId}`, message: 'Complete the payment on the secure card page.' };
  });

  app.get('/wallets/topups/:id', auth, async (req) => {
    const rows = await branchesFor(ctx.db, req.session!.uid, 'wallets.topup');
    const t = (await ctx.db.query<any>(`SELECT id, wallet_id, org_id, amount, method, status FROM wallet_topups WHERE id=$1`, [(req.params as any).id]))[0];
    if (!t || !rows.some((r) => r.orgId === t.org_id)) throw new HttpError(404, 'top-up not found', 'not_found');
    return { id: t.id, status: t.status, amount: t.amount, method: t.method, walletId: t.wallet_id };
  });

  // ---------- thresholds and moving credit between wallets ----------

  app.put('/wallets/:id/threshold', auth, async (req) => {
    const w = await loadWallet(req, 'wallets.manage', (req.params as any).id);
    let threshold: number;
    try { threshold = toCents((req.body as any)?.threshold); } catch { throw new HttpError(400, 'Enter an amount', 'bad_amount'); }
    if (threshold < 0 || threshold > 5_000_000) throw new HttpError(400, 'The warning level can be between KES 0 and KES 50,000', 'bad_amount');
    await ctx.db.query(`UPDATE wallets SET low_threshold=$2 WHERE id=$1`, [w.id, threshold]);
    await ctx.ledger.audit({ orgId: w.org_id, branchId: w.branch_id, actor: req.session!.uid, action: 'wallet.threshold', category: 'config', entity: 'wallet', entityId: w.id, summary: 'Changed the low-balance warning level', changes: [{ field: 'low_threshold', label: 'Warning level (cents)', before: Number(w.low_threshold), after: threshold }] });
    await checkLowBalance(ctx, w.id);
    return { ok: true };
  });

  /** Headquarters moves credit to a branch wallet, or back (L113). */
  app.post('/wallets/transfer', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const from = await loadWallet(req, 'wallets.manage', String(b.fromWalletId));
    const to = await loadWallet(req, 'wallets.manage', String(b.toWalletId));
    if (from.id === to.id) throw new HttpError(400, 'Choose two different wallets', 'same_wallet');
    if (from.org_id !== to.org_id || from.channel !== to.channel) throw new HttpError(400, 'Credit can only move between wallets of the same church and channel', 'bad_transfer');
    let amount: number;
    try { amount = toCents(b.amount); } catch { throw new HttpError(400, 'Enter an amount', 'bad_amount'); }
    if (!(amount > 0)) throw new HttpError(400, 'The amount must be more than zero', 'bad_amount');
    const key = ctx.newId('mv');
    if (!(await ctx.ledger.transferWallet(from.id, to.id, amount, key))) throw new HttpError(409, 'The wallet you are moving credit from does not have enough', 'insufficient');
    await ctx.ledger.audit({ orgId: from.org_id, actor: req.session!.uid, action: 'wallet.transfer', category: 'money', entity: 'wallet', entityId: from.id, summary: `Moved KES ${(amount / 100).toLocaleString('en-KE')} of credit between wallets`, links: { fromWallet: from.id, toWallet: to.id, ledgerEntry: `wtransfer:${key}` }, meta: { amount } });
    await checkLowBalance(ctx, from.id);
    await checkLowBalance(ctx, to.id);
    return { ok: true };
  });

  // ---------- the Integrations page (L114) ----------

  async function integrationView(orgId: string) {
    const s = await integrationSettings(ctx.db, orgId);
    const branches = await ctx.db.query<any>(
      `SELECT b.id, b.code, b.name, i.sms_sender_id, i.whatsapp_number FROM branches b LEFT JOIN branch_integrations i ON i.branch_id=b.id WHERE b.org_id=$1 ORDER BY b.name`,
      [orgId],
    );
    return { ...s, branches: branches.map((b) => ({ id: b.id, code: b.code, name: b.name, smsSenderId: b.sms_sender_id, whatsappNumber: b.whatsapp_number })) };
  }

  const flatIntegration = (s: any, branches: any[]) => ({
    walletMode: s.walletMode, smsSenderId: s.smsSenderId ?? null, whatsappDisplayName: s.whatsappDisplayName ?? null, whatsappNumber: s.whatsappNumber ?? null, alertEmails: s.alertEmails ?? [],
    branchOverrides: branches.filter((b) => b.smsSenderId || b.whatsappNumber).map((b) => `${b.code}: ${b.smsSenderId ?? '-'} / ${b.whatsappNumber ? maskPhone(b.whatsappNumber) : '-'}`),
  });

  app.get('/integrations', auth, async (req) => {
    const rows = [...(await branchesFor(ctx.db, req.session!.uid, 'integrations.manage')), ...(await branchesFor(ctx.db, req.session!.uid, 'wallets.view'))];
    if (rows.length === 0) throw new HttpError(403, 'missing permission integrations.manage', 'forbidden');
    const wanted = (req.query as any).org as string | undefined;
    const orgId = wanted && rows.some((r) => r.orgId === wanted) ? wanted : rows[0].orgId;
    const canEdit = (await branchesFor(ctx.db, req.session!.uid, 'integrations.manage')).some((r) => r.orgId === orgId);
    const n = await namesOf(orgId);
    return { organisation: { id: orgId, name: n.org }, canEdit, rates: RATES, defaultThresholds: DEFAULT_THRESHOLD, ...(await integrationView(orgId)) };
  });

  app.put('/integrations', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const scope = await walletScope(req, 'integrations.manage');
    const orgId = scope.orgId;
    const before = await integrationView(orgId);
    if (b.walletMode !== 'shared' && b.walletMode !== 'per_branch') throw new HttpError(400, 'Choose shared or per branch', 'bad_mode');
    const sender = (v: unknown) => {
      const s = String(v ?? '').trim();
      if (!s) return null;
      if (!/^[A-Za-z][A-Za-z0-9 ]{2,10}$/.test(s)) throw new HttpError(400, 'An SMS sender name is 3 to 11 letters and numbers, starting with a letter', 'bad_sender');
      return s;
    };
    const waNumber = (v: unknown) => {
      const s = String(v ?? '').replace(/[\s+()-]/g, '');
      if (!s) return null;
      if (!/^\d{10,15}$/.test(s)) throw new HttpError(400, 'Enter the WhatsApp number with its country code, for example 254700123456', 'bad_whatsapp');
      return s;
    };
    const emails = [...new Set((Array.isArray(b.alertEmails) ? b.alertEmails : []).map((e: any) => String(e).trim().toLowerCase()).filter(Boolean))] as string[];
    if (emails.length > 5) throw new HttpError(400, 'You can add up to 5 extra alert emails', 'too_many');
    for (const e of emails) if (!EMAIL.test(e)) throw new HttpError(400, `"${e}" is not a valid email address`, 'bad_email');
    const display = String(b.whatsappDisplayName ?? '').trim().slice(0, 60) || null;
    const next = { walletMode: b.walletMode, smsSenderId: sender(b.smsSenderId), whatsappDisplayName: display, whatsappNumber: waNumber(b.whatsappNumber), alertEmails: emails };
    const branchRows = (Array.isArray(b.branches) ? b.branches : []).map((x: any) => ({ branchId: String(x.branchId), smsSenderId: sender(x.smsSenderId), whatsappNumber: waNumber(x.whatsappNumber) }));
    const known = new Set(before.branches.map((x: any) => x.id));
    for (const r of branchRows) if (!known.has(r.branchId)) throw new HttpError(400, 'One of the branches is not part of this church', 'bad_branch');

    await ctx.db.query(
      `UPDATE integration_settings SET wallet_mode=$2, sms_sender_id=$3, whatsapp_display_name=$4, whatsapp_number=$5, alert_emails=$6 WHERE org_id=$1`,
      [orgId, next.walletMode, next.smsSenderId, next.whatsappDisplayName, next.whatsappNumber, JSON.stringify(next.alertEmails)],
    );
    for (const r of branchRows) {
      await ctx.db.query(
        `INSERT INTO branch_integrations (branch_id, org_id, sms_sender_id, whatsapp_number) VALUES ($1,$2,$3,$4) ON CONFLICT (branch_id) DO UPDATE SET sms_sender_id=$3, whatsapp_number=$4`,
        [r.branchId, orgId, r.smsSenderId, r.whatsappNumber],
      );
    }
    await ensureWallets(ctx, orgId); // switching to per-branch creates each branch's own wallets. Nothing is ever removed.
    const after = await integrationView(orgId);
    const beforeFlat = flatIntegration(before, before.branches);
    const afterFlat = flatIntegration(after, after.branches);
    const changes = diff(INTEGRATION_SPECS, beforeFlat, afterFlat);
    const evt = await ctx.ledger.audit({ orgId, actor: req.session!.uid, action: 'integration.update', category: 'config', entity: 'integration', entityId: orgId, summary: changes.length ? `Changed messaging settings: ${changes.map((c) => c.label).join(', ')}` : 'Saved messaging settings without changes', changes });
    if (changes.length) await recordVersion(ctx, { orgId, entity: 'integration', entityId: orgId, snapshot: maskedSnapshot(INTEGRATION_SPECS, afterFlat), summary: changes.map((c) => c.label).join(', '), eventId: evt });
    return { ok: true, ...after };
  });

  /** Sends one test message to the signed-in person's own number, so they can see the channel works and what it costs. */
  app.post('/integrations/test', auth, async (req) => {
    const channel = (req.body as any)?.channel as Channel;
    if (!CHANNELS.includes(channel)) throw new HttpError(400, 'Choose SMS or WhatsApp', 'bad_channel');
    const scope = await walletScope(req, 'integrations.manage');
    const phone = req.session!.phone;
    if (channel === 'whatsapp') {
      const p = (await ctx.db.query<any>(`SELECT whatsapp_opt_in FROM contact_prefs WHERE phone=$1`, [phone]))[0];
      if (!p?.whatsapp_opt_in) throw new HttpError(409, 'WhatsApp only goes to numbers that have agreed to it. Turn on WhatsApp for your own number in My profile first.', 'not_opted_in');
    }
    const branchId = scope.branchIds[0] ?? null;
    const w = await walletFor(ctx, scope.orgId, branchId, channel);
    if (!w) throw new HttpError(409, 'There is no wallet for that channel yet', 'no_wallet');
    const key = `test:${ctx.newId('t')}`;
    if (!(await ctx.ledger.chargeWallet(w.id, RATES[channel], key, channel))) throw new HttpError(409, 'The wallet is empty. Top it up first.', 'insufficient');
    const settings = await integrationSettings(ctx.db, scope.orgId);
    const [res] = await ctx.messaging.send(channel, [{ to: phone, body: 'This is a test message from ChurchOS. Your messaging connection is working.', from: channel === 'sms' ? settings.smsSenderId : settings.whatsappNumber }]);
    if (res?.status !== 'sent') {
      await ctx.ledger.refundWallet(w.id, RATES[channel], key, channel);
      throw new HttpError(502, 'The test message could not be delivered', 'provider_failed');
    }
    await checkLowBalance(ctx, w.id);
    await ctx.ledger.audit({ orgId: scope.orgId, actor: req.session!.uid, action: 'integration.test', category: 'messaging', entity: 'integration', entityId: scope.orgId, summary: `Sent a test ${channel === 'sms' ? 'SMS' : 'WhatsApp message'} to themselves` });
    return { ok: true, cost: RATES[channel] };
  });

  // ---------- a person's own profile (alerts go to this email) ----------

  app.get('/me/profile', auth, async (req) => {
    const u = (await ctx.db.query<any>(`SELECT name, phone, email FROM users WHERE id=$1`, [req.session!.uid]))[0];
    return { name: u.name, phone: u.phone, email: u.email ?? null };
  });

  app.put('/me/profile', auth, async (req) => {
    const email = String((req.body as any)?.email ?? '').trim().toLowerCase() || null;
    if (email && !EMAIL.test(email)) throw new HttpError(400, 'Enter a valid email address', 'bad_email');
    const cur = (await ctx.db.query<any>(`SELECT email FROM users WHERE id=$1`, [req.session!.uid]))[0];
    await ctx.db.query(`UPDATE users SET email=$2 WHERE id=$1`, [req.session!.uid, email]);
    if ((cur.email ?? null) !== email) {
      await ctx.ledger.audit({ actor: req.session!.uid, action: 'member.profile_email', category: 'member', entity: 'user', entityId: req.session!.uid, summary: 'Changed their email address', changes: [{ field: 'email', label: 'Email', before: maskEmail(cur.email), after: maskEmail(email), masked: true }] });
    }
    return { ok: true, email };
  });

  // ---------- simulated hosted card page (development only) ----------
  // A real payment provider hosts this page. ChurchOS only gets a checkout id and, later, a signed notification.

  app.get('/public/checkout/:id', async (req) => {
    const info = ctx.provider.checkoutInfo((req.params as any).id);
    if (!info) throw new HttpError(404, 'This payment link has expired or was already used', 'not_found');
    return { amount: info.amount, merchant: 'ChurchOS messaging credit' };
  });

  app.post('/public/checkout/:id/pay', async (req) => {
    const r = await ctx.provider.completeCardCheckout((req.params as any).id, (req.body ?? {}) as any);
    if (r.status === 'unknown') throw new HttpError(404, 'This payment link has expired or was already used', 'not_found');
    if (r.status === 'invalid') throw new HttpError(400, 'Check the card details and try again. For testing use 4242 4242 4242 4242.', 'bad_card');
    if (r.status === 'declined') throw new HttpError(402, 'The card was declined. Try another card.', 'declined');
    return { status: 'paid' };
  });

  // ---------- platform view ----------

  app.get('/admin/messaging', adm, async () => {
    const orgs = await ctx.db.query<any>(`SELECT id, name FROM organisations ORDER BY name`);
    const out = [];
    for (const o of orgs) {
      const mode = (await integrationSettings(ctx.db, o.id)).walletMode;
      const ws = await ctx.db.query<any>(`SELECT * FROM wallets WHERE org_id=$1 ORDER BY (branch_id IS NOT NULL), branch_id, channel`, [o.id]);
      const n = await namesOf(o.id);
      const wallets = [];
      for (const w of ws as WalletRow[]) wallets.push(await walletView(ctx, w, { org: n.org, branch: w.branch_id ? n.branches.get(w.branch_id) ?? null : null }));
      const sent = (await ctx.db.query<any>(`SELECT COUNT(*) AS n FROM messages WHERE org_id=$1 AND status='sent'`, [o.id]))[0].n;
      out.push({ id: o.id, name: o.name, mode, messagesSent: Number(sent), wallets });
    }
    return { rates: RATES, revenue: { sms: await ctx.ledger.balance('sms_revenue'), whatsapp: await ctx.ledger.balance('whatsapp_revenue') }, organisations: out };
  });

  // The development email outbox. Real email goes through a provider.
  app.get('/admin/outbox', adm, async () => {
    const rows = await ctx.db.query<any>(`SELECT id, org_id, to_email, subject, body, status, error, created_at FROM email_outbox ORDER BY created_at DESC LIMIT 100`);
    return rows.map((r) => ({ ...r, to_email: maskEmail(r.to_email) }));
  });

  void csv;
}
