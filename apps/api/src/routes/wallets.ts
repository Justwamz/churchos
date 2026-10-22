import type { FastifyInstance, FastifyRequest } from 'fastify';
import { maskEmail, maskPhone } from '@churchos/shared';
import { parseKes } from '../limits';
import { branchesFor, normalizePhone } from '../auth';
import { promptGuard } from '../abuse';
import { assertEmail, checkEmail } from '../email-rules';
import { diff, maskedSnapshot, recordVersion, type FieldSpec } from '../audit';
import { checkoutLink, HttpError, isMock, requireAdmin, requireSession, staffScope, type Ctx } from '../ctx';
import { activeBands, costOf, priceInfo, unitsUsed } from '../pricing';
import { checkLowBalance, emailRequired, requireVerifiedEmail, sendEmail, CHANNELS, DEFAULT_THRESHOLD, ensureWallets, integrationSettings, PAYBILL_PREFIX, RATES, walletFor, walletView, type Channel, type WalletRow } from '../wallets';
import { consentOf } from '../consent';
import { csv } from './helpers';

const INTEGRATION_SPECS: FieldSpec[] = [
  { field: 'walletMode', label: 'Who pays for messages' },
  { field: 'smsSenderId', label: 'SMS sender name' },
  { field: 'whatsappDisplayName', label: 'WhatsApp display name' },
  { field: 'whatsappNumber', label: 'WhatsApp number', mask: 'phone' },
  { field: 'alertEmails', label: 'Extra alert emails', mask: 'email' },
  { field: 'branchOverrides', label: 'Branch overrides' },
];


export function walletRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };
  const adm = { preHandler: requireAdmin };

  /** Org and branches the signed-in person can see wallets for. A wallet at organisation level is visible to anyone with wallets.view in that church. */
  async function walletScope(req: FastifyRequest, perm: 'wallets.view' | 'wallets.topup' | 'wallets.manage' | 'integrations.manage') {
    await requireVerifiedEmail(ctx, req.session!.uid, req.session!.isAdmin);
    const s = await staffScope(ctx, req, perm);
    return s;
  }

  /** True when the branches cover every branch of the church. Church-level things (the church wallet, alert emails) need this, not one branch (AZ-19). */
  async function coversChurch(orgId: string, branchIds: string[]) {
    const all = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM branches WHERE org_id=$1`, [orgId]))[0].n);
    return all > 0 && new Set(branchIds).size === all;
  }

  async function namesOf(orgId: string) {
    const org = (await ctx.db.query<any>(`SELECT name FROM organisations WHERE id=$1`, [orgId]))[0]?.name ?? '';
    const branches = new Map((await ctx.db.query<any>(`SELECT id, name FROM branches WHERE org_id=$1`, [orgId])).map((b) => [b.id, b.name]));
    return { org, branches };
  }

  async function loadWallet(req: FastifyRequest, perm: 'wallets.view' | 'wallets.topup' | 'wallets.manage', id: string): Promise<WalletRow> {
    await requireVerifiedEmail(ctx, req.session!.uid, req.session!.isAdmin);
    const rows = await branchesFor(ctx.db, req.session!.uid, perm);
    if (rows.length === 0) throw new HttpError(403, `missing permission ${perm}`, 'forbidden');
    const w = (await ctx.db.query<any>(`SELECT * FROM wallets WHERE id=$1`, [id]))[0] as WalletRow | undefined;
    // A wallet in another church looks exactly like one that does not exist.
    const inOrg = w && rows.some((r) => r.orgId === w.org_id);
    const inScope = w && (w.branch_id ? rows.some((r) => r.branchId === w.branch_id) : await coversChurch(w.org_id, rows.filter((r) => r.orgId === w.org_id).map((r) => r.branchId)));
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
    const churchWide = await coversChurch(s.orgId, s.branchIds);
    // The church's own wallet is only for people who hold wallets.view over every branch (AZ-19).
    const rows = await ctx.db.query<any>(`SELECT * FROM wallets WHERE org_id=$1 AND ((branch_id IS NULL AND $3::boolean) OR branch_id = ANY($2::text[])) ORDER BY (branch_id IS NOT NULL), branch_id, channel`, [s.orgId, s.branchIds, churchWide]);
    const wallets = [];
    for (const w of rows as WalletRow[]) {
      const v = await walletView(ctx, w, { org: n.org, branch: w.branch_id ? n.branches.get(w.branch_id) ?? null : null });
      wallets.push({ ...v, canTopUp: w.branch_id ? topup.has(w.branch_id) : topup.size > 0, canManage: w.branch_id ? manage.has(w.branch_id) : manage.size > 0 });
    }
    const settings = await integrationSettings(ctx.db, s.orgId);
    const prices: Record<string, any> = {};
    for (const ch of CHANNELS) prices[ch] = await priceInfo(ctx, s.orgId, ch);
    return { organisation: { id: s.orgId, name: n.org }, mode: settings.walletMode, rates: { sms: prices.sms.currentPrice, whatsapp: prices.whatsapp.currentPrice }, prices, wallets };
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
    amount = parseKes(b.amount, { min: 0, max: 1_000_000, label: 'an amount' });
    if (amount < 10_000) throw new HttpError(400, 'The minimum top-up is KES 100', 'amount_too_small');
    if (amount > 5_000_000) throw new HttpError(400, 'The maximum top-up is KES 50,000', 'amount_too_large');
    if (b.method !== 'mpesa' && b.method !== 'card') throw new HttpError(400, 'Choose M-Pesa or card', 'bad_method');
    const reference = `${PAYBILL_PREFIX[w.channel]}#${w.code}`;
    const id = ctx.newId('top');
    const now = ctx.clock.now().toISOString();
    if (b.method === 'mpesa') {
      const phone = normalizePhone(b.phone);
      if (!phone) throw new HttpError(400, 'Enter a valid Kenyan phone number', 'bad_phone');
      promptGuard(ctx, req, { phone, uid: req.session!.uid, staff: true });
      const { providerTxId } = await ctx.provider.initiateStkPush({ phone, amount, reference, method: 'mpesa' });
      await ctx.db.query(`INSERT INTO wallet_topups (id, wallet_id, org_id, amount, method, phone, provider_tx_id, created_by, created_at) VALUES ($1,$2,$3,$4,'mpesa',$5,$6,$7,$8)`, [id, w.id, w.org_id, amount, phone, providerTxId, req.session!.uid, now]);
      return { id, method: 'mpesa', status: 'initiated', message: `Check ${phone.replace(/^254/, '0')} and enter your PIN to complete the top-up.` };
    }
    // Card: the person pays on the payment provider's own page, so card details never reach ChurchOS.
    promptGuard(ctx, req, { uid: req.session!.uid, staff: true });
    const card = await ctx.provider.initiateCardCheckout({ amount, reference, phone: req.session!.phone });
    const { providerTxId } = card;
    await ctx.db.query(`INSERT INTO wallet_topups (id, wallet_id, org_id, amount, method, provider_tx_id, created_by, created_at) VALUES ($1,$2,$3,$4,'card',$5,$6,$7)`, [id, w.id, w.org_id, amount, providerTxId, req.session!.uid, now]);
    return { id, method: 'card', status: 'initiated', checkoutUrl: checkoutLink(ctx, card), message: 'Complete the payment on the secure card page.' };
  });

  app.get('/wallets/topups/:id', auth, async (req) => {
    await requireVerifiedEmail(ctx, req.session!.uid, req.session!.isAdmin);
    const rows = await branchesFor(ctx.db, req.session!.uid, 'wallets.topup');
    const t = (await ctx.db.query<any>(`SELECT id, wallet_id, org_id, amount, method, status FROM wallet_topups WHERE id=$1`, [(req.params as any).id]))[0];
    if (!t || !rows.some((r) => r.orgId === t.org_id)) throw new HttpError(404, 'top-up not found', 'not_found');
    return { id: t.id, status: t.status, amount: t.amount, method: t.method, walletId: t.wallet_id };
  });

  // ---------- thresholds and moving credit between wallets ----------

  app.put('/wallets/:id/threshold', auth, async (req) => {
    const w = await loadWallet(req, 'wallets.manage', (req.params as any).id);
    let threshold: number;
    threshold = parseKes((req.body as any)?.threshold, { min: 0, max: 1_000_000, label: 'an amount' });
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
    amount = parseKes(b.amount, { min: 1, max: 100_000_000, label: 'an amount' });
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
    const reqs = await ctx.db.query<any>(`SELECT id, branch_id, kind, value, status, reason, created_at FROM sender_requests WHERE org_id=$1 AND status IN ('pending','approved','rejected') ORDER BY created_at DESC LIMIT 30`, [orgId]);
    const requests = reqs.map((q) => ({ id: q.id, branchId: q.branch_id, kind: q.kind, value: q.kind === 'whatsapp_number' ? maskPhone(q.value) : q.value, status: q.status, reason: q.reason, createdAt: q.created_at }));
    return { ...s, branches: branches.map((b) => ({ id: b.id, code: b.code, name: b.name, smsSenderId: b.sms_sender_id, whatsappNumber: b.whatsapp_number })), requests };
  }

  const flatIntegration = (s: any, branches: any[]) => ({
    walletMode: s.walletMode, smsSenderId: s.smsSenderId ?? null, whatsappDisplayName: s.whatsappDisplayName ?? null, whatsappNumber: s.whatsappNumber ?? null, alertEmails: s.alertEmails ?? [],
    branchOverrides: branches.filter((b) => b.smsSenderId || b.whatsappNumber).map((b) => `${b.code}: ${b.smsSenderId ?? '-'} / ${b.whatsappNumber ? maskPhone(b.whatsappNumber) : '-'}`),
  });

  app.get('/integrations', auth, async (req) => {
    await requireVerifiedEmail(ctx, req.session!.uid, req.session!.isAdmin);
    const rows = [...(await branchesFor(ctx.db, req.session!.uid, 'integrations.manage')), ...(await branchesFor(ctx.db, req.session!.uid, 'wallets.view'))];
    if (rows.length === 0) throw new HttpError(403, 'missing permission integrations.manage', 'forbidden');
    const wanted = (req.query as any).org as string | undefined;
    const orgId = wanted && rows.some((r) => r.orgId === wanted) ? wanted : rows[0].orgId;
    const mine = rows.filter((r) => r.orgId === orgId).map((r) => r.branchId);
    const wholeChurch = await coversChurch(orgId, mine);
    const canEdit = wholeChurch && (await branchesFor(ctx.db, req.session!.uid, 'integrations.manage')).some((r) => r.orgId === orgId);
    const n = await namesOf(orgId);
    const prices: Record<string, any> = {};
    for (const ch of CHANNELS) prices[ch] = await priceInfo(ctx, orgId, ch);
    const view = await integrationView(orgId);
    // Church-level settings (alert emails, the full WhatsApp number, other branches' overrides) are for people who cover the whole church (AZ-19).
    const shown = wholeChurch ? view : {
      ...view,
      whatsappNumber: view.whatsappNumber ? maskPhone(view.whatsappNumber) : null,
      alertEmails: [],
      branches: view.branches.filter((b: any) => mine.includes(b.id)).map((b: any) => ({ ...b, whatsappNumber: b.whatsappNumber ? maskPhone(b.whatsappNumber) : null })),
      requests: view.requests.filter((q: any) => q.branchId && mine.includes(q.branchId)),
    };
    return { organisation: { id: orgId, name: n.org }, canEdit, restricted: !wholeChurch, rates: { sms: prices.sms.currentPrice, whatsapp: prices.whatsapp.currentPrice }, prices, defaultThresholds: DEFAULT_THRESHOLD, ...shown };
  });

  app.put('/integrations', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const scope = await walletScope(req, 'integrations.manage');
    const orgId = scope.orgId;
    if (!(await coversChurch(orgId, scope.branchIds))) throw new HttpError(403, 'Only people who manage every branch can change the church settings', 'forbidden');
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
    for (const e of emails) { const c = checkEmail(e); if (!c.ok) throw new HttpError(400, `"${e}": ${c.message}`, 'bad_email'); }
    const display = String(b.whatsappDisplayName ?? '').trim().slice(0, 60) || null;
    const wanted = { smsSenderId: sender(b.smsSenderId), whatsappDisplayName: display, whatsappNumber: waNumber(b.whatsappNumber) };
    const branchRows = (Array.isArray(b.branches) ? b.branches : []).map((x: any) => ({ branchId: String(x.branchId), smsSenderId: sender(x.smsSenderId), whatsappNumber: waNumber(x.whatsappNumber) }));
    const known = new Set(before.branches.map((x: any) => x.id));
    for (const r of branchRows) if (!known.has(r.branchId)) throw new HttpError(400, 'One of the branches is not part of this church', 'bad_branch');

    // Sender names and numbers are not set here. A change becomes a request that ChurchOS approves, and the old value keeps being
    // used until then. Clearing a value needs no approval (L128).
    const asked: { kind: string; branchId: string | null; value: string; label: string }[] = [];
    const apply = { smsSenderId: before.smsSenderId ?? null, whatsappDisplayName: before.whatsappDisplayName ?? null, whatsappNumber: before.whatsappNumber ?? null };
    const handle = (kind: 'sms_sender' | 'whatsapp_number' | 'whatsapp_display', branchId: string | null, current: string | null, next: string | null, label: string, set: (v: string | null) => void) => {
      if ((current ?? null) === (next ?? null)) return;
      if (next === null) { set(null); return; }
      asked.push({ kind, branchId, value: next, label });
    };
    handle('sms_sender', null, apply.smsSenderId, wanted.smsSenderId, 'SMS sender name', (v) => (apply.smsSenderId = v));
    handle('whatsapp_display', null, apply.whatsappDisplayName, wanted.whatsappDisplayName, 'WhatsApp display name', (v) => (apply.whatsappDisplayName = v));
    handle('whatsapp_number', null, apply.whatsappNumber, wanted.whatsappNumber, 'WhatsApp number', (v) => (apply.whatsappNumber = v));
    const branchApply = new Map<string, { sms: string | null; wa: string | null }>();
    for (const r of branchRows) {
      const cur = before.branches.find((x: any) => x.id === r.branchId);
      const st = { sms: cur?.smsSenderId ?? null, wa: cur?.whatsappNumber ?? null };
      handle('sms_sender', r.branchId, st.sms, r.smsSenderId, `SMS sender name for ${cur?.name}`, (v) => (st.sms = v));
      handle('whatsapp_number', r.branchId, st.wa, r.whatsappNumber, `WhatsApp number for ${cur?.name}`, (v) => (st.wa = v));
      branchApply.set(r.branchId, st);
    }
    const next = { walletMode: b.walletMode, smsSenderId: apply.smsSenderId, whatsappDisplayName: apply.whatsappDisplayName, whatsappNumber: apply.whatsappNumber, alertEmails: emails };

    await ctx.db.query(
      `UPDATE integration_settings SET wallet_mode=$2, sms_sender_id=$3, whatsapp_display_name=$4, whatsapp_number=$5, alert_emails=$6 WHERE org_id=$1`,
      [orgId, next.walletMode, next.smsSenderId, next.whatsappDisplayName, next.whatsappNumber, JSON.stringify(next.alertEmails)],
    );
    for (const [branchId, st] of branchApply) {
      await ctx.db.query(
        `INSERT INTO branch_integrations (branch_id, org_id, sms_sender_id, whatsapp_number) VALUES ($1,$2,$3,$4) ON CONFLICT (branch_id) DO UPDATE SET sms_sender_id=$3, whatsapp_number=$4`,
        [branchId, orgId, st.sms, st.wa],
      );
    }
    for (const q of asked) {
      await ctx.db.query(`UPDATE sender_requests SET status='withdrawn' WHERE org_id=$1 AND kind=$2 AND COALESCE(branch_id,'')=$3 AND status='pending'`, [orgId, q.kind, q.branchId ?? '']);
      const id = ctx.newId('snd');
      await ctx.db.query(`INSERT INTO sender_requests (id, org_id, branch_id, kind, value, requested_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, orgId, q.branchId, q.kind, q.value, req.session!.uid, ctx.clock.now().toISOString()]);
      await ctx.ledger.audit({ orgId, branchId: q.branchId, actor: req.session!.uid, action: 'integration.sender_request', category: 'config', entity: 'sender_request', entityId: id, summary: `Asked to use a new ${q.label.toLowerCase()}`, changes: [{ field: q.kind, label: q.label, before: null, after: q.kind === 'whatsapp_number' ? maskPhone(q.value) : q.value, ...(q.kind === 'whatsapp_number' ? { masked: true } : {}) }] });
    }
    await ensureWallets(ctx, orgId); // switching to per-branch creates each branch's own wallets. Nothing is ever removed.
    const after = await integrationView(orgId);
    const beforeFlat = flatIntegration(before, before.branches);
    const afterFlat = flatIntegration(after, after.branches);
    const changes = diff(INTEGRATION_SPECS, beforeFlat, afterFlat);
    const evt = await ctx.ledger.audit({ orgId, actor: req.session!.uid, action: 'integration.update', category: 'config', entity: 'integration', entityId: orgId, summary: changes.length ? `Changed messaging settings: ${changes.map((c) => c.label).join(', ')}` : 'Saved messaging settings without changes', changes });
    if (changes.length) await recordVersion(ctx, { orgId, entity: 'integration', entityId: orgId, snapshot: maskedSnapshot(INTEGRATION_SPECS, afterFlat), summary: changes.map((c) => c.label).join(', '), eventId: evt });
    return { ok: true, requested: asked.length, ...after };
  });

  /** Sends one test message to the signed-in person's own number, so they can see the channel works and what it costs. */
  app.post('/integrations/test', auth, async (req) => {
    const channel = (req.body as any)?.channel as Channel;
    if (!CHANNELS.includes(channel)) throw new HttpError(400, 'Choose SMS or WhatsApp', 'bad_channel');
    const scope = await walletScope(req, 'integrations.manage');
    const phone = req.session!.phone;
    if (channel === 'whatsapp') {
      const p = await consentOf(ctx, scope.orgId, phone);
      if (!p?.whatsapp_opt_in) throw new HttpError(409, 'WhatsApp only goes to numbers that have agreed to it. Turn on WhatsApp for your own number in My profile first.', 'not_opted_in');
    }
    const branchId = scope.branchIds[0] ?? null;
    const w = await walletFor(ctx, scope.orgId, branchId, channel);
    if (!w) throw new HttpError(409, 'There is no wallet for that channel yet', 'no_wallet');
    const key = `test:${ctx.newId('t')}`;
    const cost = costOf(await activeBands(ctx, scope.orgId, channel), await unitsUsed(ctx, scope.orgId, channel), 1);
    if (!(await ctx.ledger.chargeWallet(w.id, cost, key, channel))) throw new HttpError(409, 'The wallet is empty. Top it up first.', 'insufficient');
    const settings = await integrationSettings(ctx.db, scope.orgId);
    const [res] = await ctx.messaging.send(channel, [{ to: phone, body: 'This is a test message from ChurchOS. Your messaging connection is working.', from: channel === 'sms' ? settings.smsSenderId : settings.whatsappNumber }]);
    if (res?.status !== 'sent') {
      await ctx.ledger.refundWallet(w.id, cost, key, channel);
      throw new HttpError(502, 'The test message could not be delivered', 'provider_failed');
    }
    await checkLowBalance(ctx, w.id);
    await ctx.ledger.audit({ orgId: scope.orgId, actor: req.session!.uid, action: 'integration.test', category: 'messaging', entity: 'integration', entityId: scope.orgId, summary: `Sent a test ${channel === 'sms' ? 'SMS' : 'WhatsApp message'} to themselves` });
    return { ok: true, cost };
  });

  // ---------- a person's own profile (alerts go to this email) ----------

  // ---------- a person's own profile. Alerts go to this email once it is confirmed (L123) ----------

  const CODE_TTL_MS = 30 * 60_000;
  const RESEND_MS = 60_000;
  const MAX_ATTEMPTS = 5;

  async function profileOf(uid: string) {
    const u = (await ctx.db.query<any>(`SELECT name, phone, email, email_verified FROM users WHERE id=$1`, [uid]))[0];
    return { name: u.name, phone: u.phone, email: u.email ?? null, emailVerified: !!u.email_verified, emailRequired: await emailRequired(ctx, uid) };
  }

  async function sendCode(uid: string, name: string, email: string) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const now = ctx.clock.now();
    await ctx.db.query(
      `INSERT INTO email_codes (user_id, email, code, attempts, expires_at, sent_at) VALUES ($1,$2,$3,0,$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET email=$2, code=$3, attempts=0, expires_at=$4, sent_at=$5`,
      [uid, email, code, new Date(now.getTime() + CODE_TTL_MS).toISOString(), now.toISOString()],
    );
    await sendEmail(ctx, null, email, 'Your ChurchOS confirmation code', `Hello ${name.split(' ')[0]},\n\nYour confirmation code is ${code}. It works for 30 minutes.\n\nIf you did not ask for this, you can ignore this email.`);
    return code;
  }

  app.get('/me/profile', auth, async (req) => profileOf(req.session!.uid));

  app.put('/me/profile', auth, async (req) => {
    const email = String((req.body as any)?.email ?? '').trim().toLowerCase() || null;
    if (email) assertEmail(email);
    const uid = req.session!.uid;
    const cur = (await ctx.db.query<any>(`SELECT email, email_verified, name FROM users WHERE id=$1`, [uid]))[0];
    if (!email && (await emailRequired(ctx, uid))) throw new HttpError(400, 'Your role receives email alerts, so it needs an email address', 'email_required');
    if ((cur.email ?? null) === email) return { ok: true, ...(await profileOf(uid)) }; // unchanged
    await ctx.db.query(`UPDATE users SET email=$2, email_verified=false WHERE id=$1`, [uid, email]);
    await ctx.db.query(`DELETE FROM email_codes WHERE user_id=$1`, [uid]);
    await ctx.ledger.audit({ actor: uid, action: 'member.profile_email', category: 'member', entity: 'user', entityId: uid, summary: email ? 'Changed their email address' : 'Removed their email address', changes: [{ field: 'email', label: 'Email', before: maskEmail(cur.email), after: maskEmail(email), masked: true }] });
    let devCode: string | undefined;
    if (email) devCode = await sendCode(uid, cur.name, email);
    return { ok: true, ...(await profileOf(uid)), ...(process.env.NODE_ENV === 'production' ? {} : { devCode }) };
  });

  app.post('/me/profile/resend', auth, async (req) => {
    const uid = req.session!.uid;
    const u = (await ctx.db.query<any>(`SELECT email, email_verified, name FROM users WHERE id=$1`, [uid]))[0];
    if (!u.email) throw new HttpError(400, 'Add an email address first', 'no_email');
    if (u.email_verified) throw new HttpError(409, 'Your email is already confirmed', 'already_verified');
    const prev = (await ctx.db.query<any>(`SELECT sent_at FROM email_codes WHERE user_id=$1`, [uid]))[0];
    if (prev && ctx.clock.now().getTime() - new Date(prev.sent_at).getTime() < RESEND_MS) throw new HttpError(429, 'Please wait a minute before asking for another code', 'too_soon');
    const devCode = await sendCode(uid, u.name, u.email);
    return { ok: true, ...(process.env.NODE_ENV === 'production' ? {} : { devCode }) };
  });

  app.post('/me/profile/verify', auth, async (req) => {
    const uid = req.session!.uid;
    const code = String((req.body as any)?.code ?? '').trim();
    const row = (await ctx.db.query<any>(`SELECT * FROM email_codes WHERE user_id=$1`, [uid]))[0];
    const u = (await ctx.db.query<any>(`SELECT email FROM users WHERE id=$1`, [uid]))[0];
    if (!row || !u.email || row.email !== u.email) throw new HttpError(400, 'Ask for a new code first', 'no_code');
    if (new Date(row.expires_at).getTime() < ctx.clock.now().getTime()) throw new HttpError(400, 'That code has expired. Ask for a new one.', 'code_expired');
    if (row.attempts >= MAX_ATTEMPTS) throw new HttpError(429, 'Too many wrong codes. Ask for a new one.', 'too_many_attempts');
    if (code !== row.code) {
      await ctx.db.query(`UPDATE email_codes SET attempts = attempts + 1 WHERE user_id=$1`, [uid]);
      throw new HttpError(400, 'That code is not correct', 'bad_code');
    }
    await ctx.db.query(`UPDATE users SET email_verified=true WHERE id=$1`, [uid]);
    await ctx.db.query(`DELETE FROM email_codes WHERE user_id=$1`, [uid]);
    await ctx.ledger.audit({ actor: uid, action: 'member.email_verified', category: 'member', entity: 'user', entityId: uid, summary: 'Confirmed their email address' });
    return { ok: true, ...(await profileOf(uid)) };
  });

  // ---------- simulated hosted card page (development only) ----------
  // A real payment provider hosts this page. ChurchOS only gets a checkout id and, later, a signed notification.

  app.get('/public/checkout/:id', async (req) => {
    if (!isMock(ctx.provider)) throw new HttpError(404, 'This payment link is not available', 'not_found'); // the live card page is hosted by the payment provider
    const info = ctx.provider.checkoutInfo((req.params as any).id);
    if (!info) throw new HttpError(404, 'This payment link has expired or was already used', 'not_found');
    // A gift shows the church being paid, a wallet top-up shows the messaging credit.
    const gift = (await ctx.db.query<any>(`SELECT b.name, g.purpose FROM give_intents g JOIN branches b ON b.id=g.branch_id WHERE g.provider_tx_id=$1`, [(req.params as any).id]))[0];
    const what = (p: string) => (p.startsWith('SHOP-') ? 'Shop order at' : p.startsWith('BK-') ? 'Booking at' : p.startsWith('AD-') ? 'Advert at' : p.startsWith('CERT-') ? 'Certificate copy from' : 'Giving to');
    return { amount: info.amount, merchant: gift ? `${what(String(gift.purpose ?? ''))} ${gift.name}` : 'ChurchOS messaging credit' };
  });

  app.post('/public/checkout/:id/pay', async (req) => {
    if (!isMock(ctx.provider)) throw new HttpError(404, 'This payment link is not available', 'not_found');
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
    const def = (await ctx.db.query<any>(`SELECT v.bands FROM tariffs t JOIN tariff_versions v ON v.tariff_id=t.id WHERE t.is_default AND v.effective_from <= $1 ORDER BY v.effective_from DESC, v.version DESC LIMIT 1`, [ctx.clock.now().toISOString()]))[0];
    return { rates: { sms: def?.bands?.sms?.[0]?.price ?? RATES.sms, whatsapp: def?.bands?.whatsapp?.[0]?.price ?? RATES.whatsapp }, revenue: { sms: await ctx.ledger.balance('sms_revenue'), whatsapp: await ctx.ledger.balance('whatsapp_revenue') }, organisations: out };
  });

  // The development email outbox. Real email goes through a provider.
  app.get('/admin/outbox', adm, async () => {
    const rows = await ctx.db.query<any>(`SELECT id, org_id, to_email, subject, body, html, status, error, created_at FROM email_outbox ORDER BY created_at DESC LIMIT 100`);
    return rows.map((r) => ({ ...r, to_email: maskEmail(r.to_email) }));
  });

  // The development SMS outbox: single messages such as receipts, pick-up codes and late alerts. Numbers are masked.
  app.get('/admin/sms-outbox', adm, async () => {
    const rows = await ctx.db.query<any>(`SELECT id, org_id, to_phone, kind, body, cost, status, created_at FROM sms_messages ORDER BY created_at DESC LIMIT 200`);
    return rows.map((r) => ({ ...r, cost: Number(r.cost), to_phone: r.to_phone && r.to_phone.length >= 10 ? `0${r.to_phone.slice(3, 6)} *** ${r.to_phone.slice(-3)}` : r.to_phone }));
  });

  void csv;
}
