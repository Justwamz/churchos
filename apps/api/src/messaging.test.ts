import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';
import { runScheduledMessages } from './messages';

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

const OWNER = '0700000001', TREAS = '0700000002', ADMIN = '0700000003', COAST = '0700000004', HOPE = '0700000005', PA1 = '0700000099';
const JANE = '0711000001', PETER = '0711000002', AMINA = '0711000003';
const FULL_PHONE = /\b254\d{9}\b|\b07\d{8}\b/;
const SMS_ORG = 'wal:org_grace:sms', SMS_NBO = 'wal:br_grc001:sms', SMS_MSA = 'wal:br_grc002:sms', WA_NBO = 'wal:br_grc001:whatsapp';
const wallets = async (who = OWNER) => (await call(who, 'GET', '/wallets')).json();
const bal = async (id: string, who = OWNER) => (await wallets(who)).wallets.find((w: any) => w.id === id)?.balance as number;
const wait = async (fn: () => Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
// Anyone whose role receives alerts must confirm an email before using wallets (L123), so tests go through the real flow.
const confirmEmail = async (who: string, email: string) => {
  const r = await call(who, 'PUT', '/me/profile', { email });
  const v = await call(who, 'POST', '/me/profile/verify', { code: r.json().devCode });
  expect(v.statusCode).toBe(200);
};
const send = (who: string, extra: any = {}) =>
  call(who, 'POST', '/messages', { audience: { scope: { type: 'org' }, who: 'all' }, channels: ['sms'], title: 'Hello', body: 'Hello {name}, a note from church.', ...extra });
const sentTo = (channel: 'sms' | 'whatsapp', phone: string) => ctx.messaging.sent.filter((s) => s.channel === channel && s.to === phone).length;

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
}, 60000);

describe('wallets: balances people can see (L113, L116)', () => {
  it('shows every wallet to the owner, with who pays, the price and the paybill reference', async () => {
    const w = await wallets();
    expect(w.mode).toBe('per_branch');
    expect(w.rates).toEqual({ sms: 100, whatsapp: 300 });
    const ids = w.wallets.map((x: any) => x.id);
    expect(ids).toEqual(expect.arrayContaining([SMS_ORG, 'wal:org_grace:whatsapp', SMS_NBO, SMS_MSA, WA_NBO]));
    const org = w.wallets.find((x: any) => x.id === SMS_ORG);
    expect(org).toMatchObject({ scope: 'organisation', balance: 50000, messagesLeft: 500, paybillReference: 'SMS#GRACE', canTopUp: true, canManage: true, state: 'ok' });
    expect(w.wallets.find((x: any) => x.id === SMS_MSA)).toMatchObject({ balance: 0, state: 'empty', paybillReference: 'SMS#GRC002' });
  });

  it('a branch person sees the headquarters wallet and their own branch, never another branch', async () => {
    expect((await call(COAST, 'GET', '/wallets')).json().code).toBe('email_required'); // Fatuma has not confirmed an email yet
    await confirmEmail(COAST, 'fatuma@grace.example');
    const ids = (await wallets(ADMIN)).wallets.map((x: any) => x.id);
    expect(ids).toContain(SMS_ORG);
    expect(ids).toContain(SMS_NBO);
    expect(ids).not.toContain(SMS_MSA);
    const coast = (await wallets(COAST)).wallets.map((x: any) => x.id);
    expect(coast).toContain(SMS_MSA);
    expect(coast).not.toContain(SMS_NBO);
  });

  it('only people with the permission can see balances', async () => {
    expect((await call(JANE, 'GET', '/wallets')).statusCode).toBe(403);
    expect((await call(null, 'GET', '/wallets')).statusCode).toBe(401);
    expect((await call(TREAS, 'GET', '/wallets')).statusCode).toBe(200); // finance can see and top up
    expect((await call(HOPE, 'GET', `/wallets/${SMS_ORG}/activity`)).statusCode).toBe(404); // another church's wallet looks missing
  });
});

describe('top-up: M-Pesa prompt or card (L116)', () => {
  it('an M-Pesa top-up credits the chosen wallet and not collections', async () => {
    const before = await bal(SMS_NBO);
    const dash = Number((await call(OWNER, 'GET', '/dashboard')).json().today.gross);
    const t = await call(OWNER, 'POST', `/wallets/${SMS_NBO}/topup`, { amount: 200, method: 'mpesa', phone: '0700000001' });
    expect(t.statusCode).toBe(200);
    expect(await wait(async () => (await call(OWNER, 'GET', `/wallets/topups/${t.json().id}`)).json().status === 'completed')).toBe(true);
    expect(await bal(SMS_NBO)).toBe(before + 20000);
    expect(Number((await call(OWNER, 'GET', '/dashboard')).json().today.gross)).toBe(dash);
  });

  it('validates amount, method and phone, and refuses people without the permission', async () => {
    const top = (body: any, who = OWNER, id = SMS_NBO) => call(who, 'POST', `/wallets/${id}/topup`, body);
    expect((await top({ amount: 5, method: 'mpesa', phone: '0700000001' })).json().code).toBe('amount_too_small');
    expect((await top({ amount: 90000, method: 'mpesa', phone: '0700000001' })).json().code).toBe('amount_too_large');
    expect((await top({ amount: 200, method: 'cheque' })).json().code).toBe('bad_method');
    expect((await top({ amount: 200, method: 'mpesa', phone: '123' })).json().code).toBe('bad_phone');
    expect((await top({ amount: 200, method: 'mpesa', phone: '0700000001' }, JANE)).statusCode).toBe(403);
    expect((await top({ amount: 200, method: 'mpesa', phone: '0700000001' }, HOPE)).statusCode).toBe(404);
    expect((await top({ amount: 200, method: 'mpesa', phone: '0700000001' }, ADMIN, SMS_MSA)).statusCode).toBe(404); // a branch they cannot see
  });

  it('a card top-up goes through the provider-hosted page, so card details never reach ChurchOS', async () => {
    const before = await bal(SMS_ORG);
    const t = (await call(OWNER, 'POST', `/wallets/${SMS_ORG}/topup`, { amount: 150, method: 'card' })).json();
    expect(t.checkoutUrl).toMatch(/\/checkout\/CARD[A-Z0-9]+$/);
    const txId = t.checkoutUrl.split('/').pop();
    const info = (await call(null, 'GET', `/public/checkout/${txId}`)).json();
    expect(info.amount).toBe(15000);
    const pay = (card: any) => call(null, 'POST', `/public/checkout/${txId}/pay`, card);
    expect((await pay({ number: '1234', expiry: '12/30', cvc: '12' })).json().code).toBe('bad_card');
    expect((await pay({ number: '4000 0000 0000 0002', expiry: '12/30', cvc: '123' })).statusCode).toBe(402);
    expect((await pay({ number: '4242 4242 4242 4242', expiry: '12/30', cvc: '123' })).json().status).toBe('paid');
    expect(await wait(async () => (await call(OWNER, 'GET', `/wallets/topups/${t.id}`)).json().status === 'completed')).toBe(true);
    expect(await bal(SMS_ORG)).toBe(before + 15000);
    expect((await pay({ number: '4242 4242 4242 4242', expiry: '12/30', cvc: '123' })).statusCode).toBe(404); // a payment link works once
    // Nothing about the card was stored anywhere.
    const rows = JSON.stringify(await ctx.db.query(`SELECT * FROM wallet_topups`));
    expect(rows).not.toMatch(/4242|cvc|expiry/i);
    expect((await call(PA1, 'GET', '/admin/reconcile')).json().ok).toBe(true);
  });

  it('a duplicate notification credits once, and an unknown wallet code is held in suspense', async () => {
    const before = await bal(SMS_ORG);
    await call(PA1, 'POST', '/admin/simulate/paybill', { phone: '0700000001', amount: 100, reference: 'sms#grace', duplicate: true });
    expect(await bal(SMS_ORG)).toBe(before + 10000);
    await call(PA1, 'POST', '/admin/simulate/paybill', { phone: '0700000001', amount: 100, reference: 'WA#NOPE' });
    expect((await call(PA1, 'GET', '/admin/suspense')).json().some((x: any) => x.reference === 'WA#NOPE')).toBe(true);
    expect((await call(PA1, 'GET', '/admin/reconcile')).json().ok).toBe(true);
  });

  it('lists top-ups and what each message spent on the wallet activity page', async () => {
    const a = (await call(OWNER, 'GET', `/wallets/${SMS_NBO}/activity`)).json();
    expect(a.topups.length).toBeGreaterThan(0);
    expect(Array.isArray(a.spent)).toBe(true);
  });
});

describe('thresholds, transfers and low-balance alerts (L113, L115)', () => {
  it('only people who manage wallets change the warning level, and it is audited', async () => {
    expect((await call(TREAS, 'PUT', `/wallets/${SMS_NBO}/threshold`, { threshold: 50 })).statusCode).toBe(403);
    expect((await call(OWNER, 'PUT', `/wallets/${SMS_NBO}/threshold`, { threshold: -1 })).statusCode).toBe(400);
    expect((await call(OWNER, 'PUT', `/wallets/${SMS_NBO}/threshold`, { threshold: 25 })).statusCode).toBe(200);
    expect((await wallets()).wallets.find((x: any) => x.id === SMS_NBO).threshold).toBe(2500);
    const evt = (await call(OWNER, 'GET', '/audit/events?action=wallet.threshold')).json().events[0];
    expect(evt.changes[0]).toMatchObject({ field: 'low_threshold', before: 2000, after: 2500 });
  });

  it('headquarters moves credit to a branch wallet, and nothing is created or lost', async () => {
    const [hq, br] = [await bal(SMS_ORG), await bal(SMS_MSA)];
    expect((await call(OWNER, 'POST', '/wallets/transfer', { fromWalletId: SMS_ORG, toWalletId: SMS_MSA, amount: 50 })).statusCode).toBe(200);
    expect(await bal(SMS_ORG)).toBe(hq - 5000);
    expect(await bal(SMS_MSA)).toBe(br + 5000);
    expect((await call(PA1, 'GET', '/admin/reconcile')).json().ok).toBe(true);
    const t = (x: any, who = OWNER) => call(who, 'POST', '/wallets/transfer', x);
    expect((await t({ fromWalletId: SMS_ORG, toWalletId: SMS_ORG, amount: 5 })).json().code).toBe('same_wallet');
    expect((await t({ fromWalletId: SMS_ORG, toWalletId: 'wal:org_grace:whatsapp', amount: 5 })).json().code).toBe('bad_transfer');
    expect((await t({ fromWalletId: SMS_MSA, toWalletId: SMS_ORG, amount: 99999 })).json().code).toBe('insufficient');
    expect((await t({ fromWalletId: SMS_ORG, toWalletId: SMS_NBO, amount: 0 })).json().code).toBe('bad_amount');
    expect((await t({ fromWalletId: SMS_ORG, toWalletId: SMS_NBO, amount: 5 }, TREAS)).statusCode).toBe(403);
    expect((await t({ fromWalletId: SMS_ORG, toWalletId: SMS_MSA, amount: 5 }, ADMIN)).statusCode).toBe(404); // the branch admin cannot manage Mombasa
    expect((await t({ fromWalletId: SMS_ORG, toWalletId: SMS_NBO, amount: 5 }, HOPE)).statusCode).toBe(404);
  });

  it('an empty wallet never breaks a gift: the receipt stays in-app, and everyone who can see the wallet is told once, by app and email', async () => {
    // Grace Mombasa has an empty wallet (and Fatuma, its finance lead, has no email on file).
    await call(OWNER, 'POST', '/wallets/transfer', { fromWalletId: SMS_MSA, toWalletId: SMS_ORG, amount: await bal(SMS_MSA) / 100 });
    expect(await bal(SMS_MSA)).toBe(0);
    const mombasaAlerts = async (who: string) => (await call(who, 'GET', '/me/notifications')).json().rows.filter((r: any) => /Grace Mombasa · SMS credit has run out/.test(r.title)).length;
    const outboxAlerts = async () => (await call(PA1, 'GET', '/admin/outbox')).json().filter((e: any) => /Mombasa · SMS credit has run out/.test(e.subject)).length;
    const [ownerBefore, coastBefore, mailBefore] = [await mombasaAlerts(OWNER), await mombasaAlerts(COAST), await outboxAlerts()];
    const g = await call(null, 'POST', '/public/give', { code: 'GRC002', purpose: 'TITHE', phone: '0711000003', amount: 300 });
    expect(await wait(async () => (await call(null, 'GET', `/public/give/${g.json().intentId}`)).json().status === 'completed')).toBe(true);
    await wait(async () => (await call(AMINA, 'GET', '/me/notifications')).json().rows.some((r: any) => r.kind === 'receipt' && /KES 300/.test(r.body)));
    expect(sentTo('sms', '254711000003')).toBe(0); // no credit, no SMS
    expect(await bal(SMS_MSA)).toBe(0); // never negative

    // The wallet was already empty, so the gift raises no new alert: one alert per crossing, not one per message.
    expect(await mombasaAlerts(OWNER)).toBe(ownerBefore);
    expect(await mombasaAlerts(COAST)).toBe(coastBefore);
    expect(await outboxAlerts()).toBe(mailBefore);
    const g2 = await call(null, 'POST', '/public/give', { code: 'GRC002', purpose: 'TITHE', phone: '0711000003', amount: 200 });
    await wait(async () => (await call(null, 'GET', `/public/give/${g2.json().intentId}`)).json().status === 'completed');
    expect(await mombasaAlerts(OWNER)).toBe(ownerBefore);
  });

  it('when a wallet becomes empty, everyone who can see it is told in the app and by email, once', async () => {
    // Put some credit in Mombasa, then spend it all, and watch the alert go out.
    await call(OWNER, 'POST', '/wallets/transfer', { fromWalletId: SMS_ORG, toWalletId: SMS_MSA, amount: 1 });
    expect(await bal(SMS_MSA)).toBe(100);
    const count = async (who: string) => (await call(who, 'GET', '/me/notifications')).json().rows.filter((r: any) => /Grace Mombasa · SMS credit/.test(r.title)).length;
    const [owner0, coast0] = [await count(OWNER), await count(COAST)];
    const mail0 = (await call(PA1, 'GET', '/admin/outbox')).json().length;
    const g = await call(null, 'POST', '/public/give', { code: 'GRC002', purpose: 'TITHE', phone: '0711000003', amount: 400 });
    await wait(async () => (await call(null, 'GET', `/public/give/${g.json().intentId}`)).json().status === 'completed');
    expect(sentTo('sms', '254711000003')).toBeGreaterThan(0); // the last message was paid for
    expect(await bal(SMS_MSA)).toBe(0);
    expect(await count(OWNER)).toBe(owner0 + 1);
    expect(await count(COAST)).toBe(coast0 + 1); // the regional finance lead sees it in-app even without an email on file
    const mail = (await call(PA1, 'GET', '/admin/outbox')).json();
    const fresh = mail.slice(0, mail.length - mail0 > 0 ? mail.length - mail0 : 0).filter((e: any) => /Mombasa · SMS credit has run out/.test(e.subject));
    expect(fresh.length).toBe(3); // Daniel, Fatuma (now confirmed) and the extra finance address on the Integrations page
    expect(fresh.every((e: any) => !/@/.test(e.to_email.replace(/•+/, '')) || /•••/.test(e.to_email))).toBe(true); // addresses masked
  });

  it('a low (not empty) wallet warns once, and a top-up above the level re-arms it (Hope Chapel, shared wallet)', async () => {
    const HOPE_SMS = 'wal:org_hope:sms';
    await call(PA1, 'POST', '/admin/simulate/paybill', { phone: '0700000005', amount: 100, reference: 'SMS#HOPE' }); // KES 100
    expect(await bal(HOPE_SMS, HOPE)).toBe(10000);
    expect((await call(HOPE, 'PUT', `/wallets/${HOPE_SMS}/threshold`, { threshold: 99.5 })).statusCode).toBe(200);
    const gift = async (amount: number) => {
      const g = await call(null, 'POST', '/public/give', { code: 'HPC001', purpose: 'TITHE', phone: '0722000111', amount });
      await wait(async () => (await call(null, 'GET', `/public/give/${g.json().intentId}`)).json().status === 'completed');
    };
    await ctx.db.query(`INSERT INTO users (id, phone, name, created_at) VALUES ('u_hopegiver','254722000111','Hope Giver',$1) ON CONFLICT DO NOTHING`, [ctx.clock.now().toISOString()]);
    await gift(300); // the receipt SMS takes the balance to KES 99, below the warning level of KES 99.50
    const low = (await call(HOPE, 'GET', '/me/notifications')).json().rows.filter((r: any) => /credit is low/.test(r.title));
    expect(low).toHaveLength(1);
    expect(low[0].body).toMatch(/KES 99\.00/);
    expect((await call(PA1, 'GET', '/admin/outbox')).json().some((e: any) => /credit is low/.test(e.subject) && e.to_email.startsWith('g•••@hope'))).toBe(true);
    await gift(200);
    expect((await call(HOPE, 'GET', '/me/notifications')).json().rows.filter((r: any) => /credit is low/.test(r.title))).toHaveLength(1);
  });
});

describe('integrations: one page per church (L113, L114)', () => {
  it('shows the settings to people who can see wallets, but only the owner may change them', async () => {
    const g = (await call(OWNER, 'GET', '/integrations')).json();
    expect(g).toMatchObject({ walletMode: 'per_branch', smsSenderId: 'GRACECHURCH', canEdit: true });
    expect(g.branches.map((b: any) => b.code).sort()).toEqual(['GRC001', 'GRC002']);
    expect((await call(ADMIN, 'GET', '/integrations')).json().canEdit).toBe(false);
    expect((await call(ADMIN, 'PUT', '/integrations', { walletMode: 'shared' })).statusCode).toBe(403);
    expect((await call(JANE, 'GET', '/integrations')).statusCode).toBe(403);
  });

  it('validates sender names, WhatsApp numbers and alert emails', async () => {
    const base = (await call(OWNER, 'GET', '/integrations')).json();
    const put = (x: any) => call(OWNER, 'PUT', '/integrations', { walletMode: base.walletMode, smsSenderId: base.smsSenderId, whatsappDisplayName: base.whatsappDisplayName, whatsappNumber: base.whatsappNumber, alertEmails: base.alertEmails, ...x });
    expect((await put({ walletMode: 'both' })).json().code).toBe('bad_mode');
    expect((await put({ smsSenderId: 'X' })).json().code).toBe('bad_sender');
    expect((await put({ smsSenderId: 'A very long sender name' })).json().code).toBe('bad_sender');
    expect((await put({ whatsappNumber: '0712' })).json().code).toBe('bad_whatsapp');
    expect((await put({ alertEmails: ['not-an-email'] })).json().code).toBe('bad_email');
    expect((await put({ alertEmails: ['a@b.co', 'b@b.co', 'c@b.co', 'd@b.co', 'e@b.co', 'f@b.co'] })).json().code).toBe('too_many');
    expect((await put({ branches: [{ branchId: 'br_hpc001', smsSenderId: 'GRACEKISUMU' }] })).json().code).toBe('bad_branch'); // another church's branch
  });

  it('saves changes with masked history, and switching a church to per-branch creates each branch wallet', async () => {
    const hopeBefore = (await call(HOPE, 'GET', '/wallets')).json().wallets.map((w: any) => w.id);
    expect(hopeBefore).toEqual(['wal:org_hope:sms', 'wal:org_hope:whatsapp']); // shared: just the church's two wallets
    const r = await call(HOPE, 'PUT', '/integrations', { walletMode: 'per_branch', smsSenderId: 'HOPECHAPEL', whatsappDisplayName: 'Hope Chapel', whatsappNumber: '+254 722 000 999', alertEmails: ['accounts@hope.example'], branches: [{ branchId: 'br_hpc001', smsSenderId: 'HOPEKISUMU', whatsappNumber: '254722111222' }] });
    expect(r.statusCode).toBe(200);
    const ids = (await call(HOPE, 'GET', '/wallets')).json().wallets.map((w: any) => w.id);
    expect(ids).toEqual(expect.arrayContaining(['wal:org_hope:sms', 'wal:br_hpc001:sms', 'wal:br_hpc001:whatsapp']));
    const evt = (await call(HOPE, 'GET', '/audit/events?action=integration.update')).json().events[0];
    const fields = evt.changes.map((c: any) => c.field);
    // Who pays and the alert emails apply at once. Sender names and numbers become requests until ChurchOS approves them (L128).
    expect(fields).toEqual(expect.arrayContaining(['walletMode', 'alertEmails']));
    expect(fields).not.toContain('smsSenderId');
    expect(fields).not.toContain('whatsappNumber');
    expect(JSON.stringify(evt)).not.toMatch(/722000999|722111222|accounts@hope/); // numbers and emails masked in the log
    const pending = (await call(HOPE, 'GET', '/integrations')).json();
    expect(pending.smsSenderId).toBeNull();
    expect(pending.requests.filter((q: any) => q.status === 'pending').map((q: any) => q.kind).sort()).toEqual(['sms_sender', 'sms_sender', 'whatsapp_display', 'whatsapp_number', 'whatsapp_number']);
    expect(JSON.stringify(pending.requests)).not.toMatch(/254722000999|254722111222/);
    // A platform admin approves the church-level sender name, and from then on it is the active one.
    const queue = (await call(PA1, 'GET', '/admin/sender-requests?status=pending')).json();
    const sms = queue.find((q: any) => q.kind === 'sms_sender' && q.value === 'HOPECHAPEL');
    expect((await call(HOPE, 'POST', `/admin/sender-requests/${sms.id}/decide`, { approve: true })).statusCode).toBe(403);
    expect((await call(PA1, 'POST', `/admin/sender-requests/${sms.id}/decide`, { approve: false })).json().code).toBe('reason_required');
    expect((await call(PA1, 'POST', `/admin/sender-requests/${sms.id}/decide`, { approve: true })).json().status).toBe('approved');
    expect((await call(PA1, 'POST', `/admin/sender-requests/${sms.id}/decide`, { approve: true })).statusCode).toBe(409);
    expect((await call(HOPE, 'GET', '/integrations')).json().smsSenderId).toBe('HOPECHAPEL');
    const wa = queue.find((q: any) => q.kind === 'whatsapp_number' && !q.branch_id);
    expect(wa.value).toMatch(/•••/); // masked even for platform admins in the list
    expect((await call(PA1, 'POST', `/admin/sender-requests/${wa.id}/decide`, { approve: false, reason: 'Number is not verified with the provider' })).json().status).toBe('rejected');
    expect((await call(HOPE, 'GET', '/integrations')).json().whatsappNumber).toBeNull(); // a rejected number is never used
    const note = (await call(HOPE, 'GET', '/me/notifications')).json().rows.map((r: any) => r.title);
    expect(note).toEqual(expect.arrayContaining(['Your sms sender name was approved', 'Your whatsapp number was not approved']));
    const audit = (await call(PA1, 'GET', '/admin/audit/events?action=integration.sender')).json().events.map((e: any) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['integration.sender_request', 'integration.sender_approved', 'integration.sender_rejected']));
    const h = (await call(HOPE, 'GET', '/audit/history?entity=integration&entityId=org_hope')).json();
    expect(h.versions).toHaveLength(1);
    // Switching back keeps the branch wallet and its balance: nothing is ever removed.
    await call(HOPE, 'PUT', '/integrations', { walletMode: 'shared', smsSenderId: 'HOPECHAPEL', whatsappNumber: '254722000999', alertEmails: [] });
    expect((await call(HOPE, 'GET', '/wallets')).json().wallets.map((w: any) => w.id)).toContain('wal:br_hpc001:sms');
  });

  it('the owner can send a test message to their own number, and WhatsApp needs their own consent first', async () => {
    const before = await bal(SMS_NBO);
    const r = await call(OWNER, 'POST', '/integrations/test', { channel: 'sms' });
    expect(r.statusCode).toBe(200);
    expect(sentTo('sms', '254700000001')).toBeGreaterThan(0);
    expect(await bal(SMS_NBO)).toBe(before - 100);
    expect((await call(OWNER, 'POST', '/integrations/test', { channel: 'whatsapp' })).json().code).toBe('not_opted_in');
    await call(OWNER, 'PUT', '/me/preferences', { whatsappOptIn: true });
    expect((await call(OWNER, 'POST', '/integrations/test', { channel: 'whatsapp' })).statusCode).toBe(200);
    expect((await call(OWNER, 'POST', '/integrations/test', { channel: 'fax' })).json().code).toBe('bad_channel');
    expect((await call(ADMIN, 'POST', '/integrations/test', { channel: 'sms' })).statusCode).toBe(403);
  });

  it('a person can add their email for alerts, and the log shows it hidden', async () => {
    expect((await call(COAST, 'PUT', '/me/profile', { email: 'nope' })).json().code).toBe('bad_email');
    expect((await call(COAST, 'PUT', '/me/profile', { email: 'Fatuma@Grace.example' })).statusCode).toBe(200); // same address, nothing changes
    expect((await call(COAST, 'GET', '/me/profile')).json().email).toBe('fatuma@grace.example');
    const evt = (await call(PA1, 'GET', '/admin/audit/events?action=member.profile_email')).json().events[0];
    expect(evt.changes[0]).toMatchObject({ field: 'email', masked: true });
    expect(JSON.stringify(evt)).not.toMatch(/fatuma@grace/);
  });
});

describe('REVIEW FOCUS 2: consent (L119)', () => {
  it('staff can record a choice on someone\'s behalf only with confirmation and a source, and it is logged', async () => {
    const amina = (await call(ADMIN, 'GET', '/members?q=Amina')).json();
    expect(amina).toHaveLength(0); // Amina is in Mombasa, which the Nairobi branch admin cannot see
    const jane = (await call(ADMIN, 'GET', '/members?q=Jane')).json()[0];
    const c = (body: any, who = ADMIN, id = jane.id) => call(who, 'POST', `/members/${id}/consent`, body);
    expect((await c({ channel: 'whatsapp', optIn: true, source: 'form' })).json().code).toBe('confirmation_required');
    expect((await c({ channel: 'whatsapp', optIn: true, source: 'telepathy', confirmed: true })).json().code).toBe('bad_source');
    expect((await c({ channel: 'telegram', optIn: true, source: 'form', confirmed: true })).json().code).toBe('bad_channel');
    const ruth = (await call(ADMIN, 'GET', '/members?q=Ruth')).json()[0];
    expect((await c({ channel: 'whatsapp', optIn: true, source: 'form', confirmed: true }, ADMIN, ruth.id)).json().code).toBe('not_adult');
    const ok = await c({ channel: 'sms', optIn: false, source: 'in_person', confirmed: true });
    expect(ok.json().smsOptOut).toBe(true);
    const evt = (await call(OWNER, 'GET', '/audit/events?action=member.consent')).json().events[0];
    expect(evt.summary).toMatch(/declined SMS messages \(in person\)/);
    expect(JSON.stringify(evt)).not.toMatch(FULL_PHONE);
    await c({ channel: 'sms', optIn: true, source: 'in_person', confirmed: true }); // restore
    expect((await c({ channel: 'sms', optIn: true, source: 'form', confirmed: true }, TREAS)).statusCode).toBe(403);
  });

  it('members manage their own choices in the app', async () => {
    expect((await call(AMINA, 'GET', '/me/preferences')).json()).toMatchObject({ whatsappOptIn: false, smsOptOut: false });
    expect((await call(AMINA, 'PUT', '/me/preferences', { whatsappOptIn: true })).json().whatsappOptIn).toBe(true);
    expect((await call(AMINA, 'PUT', '/me/preferences', { whatsappOptIn: false })).json().whatsappOptIn).toBe(false);
    expect((await call(null, 'GET', '/me/preferences')).statusCode).toBe(401);
  });
});

describe('messages: audiences, estimates and sending (L118 to L120)', () => {
  it('estimates reach and cost, never numbers, and shows which wallets run short', async () => {
    const e = await call(OWNER, 'POST', '/messages/estimate', { audience: { scope: { type: 'org' }, who: 'all' }, channels: ['sms', 'whatsapp'], body: 'Hello {name}, a note.' });
    expect(e.statusCode).toBe(200);
    const est = e.json();
    expect(est.people).toBe(4); // Jane, David, Peter and Amina. The children are reached through their guardians, who are already counted.
    expect(est.inApp.reachable).toBe(4);
    expect(est.sms).toMatchObject({ eligible: 3, optedOut: 1, perMessage: 100 }); // David opted out of SMS
    expect(est.whatsapp.notOptedIn).toBeGreaterThanOrEqual(2); // David and Amina have not agreed to WhatsApp
    expect(JSON.stringify(est)).not.toMatch(FULL_PHONE);
    expect(est.wallets.every((w: any) => typeof w.label === 'string')).toBe(true);
  });

  it('REVIEW FOCUS 1 and 2: SMS and WhatsApp go only to people who agreed, each branch pays for its own people, and a short wallet skips only its branch', async () => {
    // Make Mombasa's SMS wallet empty and Nairobi's comfortable.
    const mombasa = await bal(SMS_MSA);
    if (mombasa) await call(OWNER, 'POST', '/wallets/transfer', { fromWalletId: SMS_MSA, toWalletId: SMS_ORG, amount: mombasa / 100 });
    const [nbo, nboWa, hq] = [await bal(SMS_NBO), await bal(WA_NBO), await bal(SMS_ORG)];
    const sms0 = ctx.messaging.count('sms'), wa0 = ctx.messaging.count('whatsapp');
    await call(OWNER, 'PUT', '/me/preferences', { whatsappOptIn: false });
    const r = await send(OWNER, { channels: ['sms', 'whatsapp'], title: 'All church notice', body: 'Hello {name}, service is at 9am.' });
    expect(r.statusCode).toBe(200);
    const s = r.json().summary;
    expect(s.people).toBe(4);
    expect(s.channels.inapp).toMatchObject({ sent: 4, noAccount: 0 });
    // SMS: Jane and Peter (Nairobi) are sent. David opted out. Amina (Mombasa) is skipped because that branch wallet is empty.
    expect(s.channels.sms).toMatchObject({ sent: 2, optedOut: 1, noBalance: 1, cost: 200 });
    // WhatsApp: only Jane and Peter agreed, and Nairobi pays 2 x KES 3.
    expect(s.channels.whatsapp).toMatchObject({ sent: 2, notOptedIn: 2, cost: 600 });
    expect(s.shortWallets).toEqual([expect.objectContaining({ label: 'Grace Mombasa · SMS', channel: 'sms', short: 1 })]);
    expect(await bal(SMS_NBO)).toBe(nbo - 200);
    expect(await bal(WA_NBO)).toBe(nboWa - 600);
    expect(await bal(SMS_ORG)).toBe(hq + (mombasa || 0)); // headquarters did not pay for a branch's people
    expect(ctx.messaging.count('sms') - sms0).toBe(2);
    expect(ctx.messaging.count('whatsapp') - wa0).toBe(2);
    expect(sentTo('sms', '254711000004')).toBe(0); // David opted out of SMS
    expect(sentTo('whatsapp', '254711000003')).toBe(0); // Amina never agreed to WhatsApp
    // The message was personalised, and WhatsApp used the approved template.
    expect(ctx.messaging.sent.filter((x) => x.channel === 'sms' && x.to === '254711000001').at(-1)!.body).toBe('Hello Jane, service is at 9am.');
    expect(ctx.messaging.sent.filter((x) => x.channel === 'whatsapp' && /^Hello /.test(x.body)).every((x) => x.template === 'church_notice')).toBe(true);
    expect(ctx.messaging.sent.filter((x) => x.channel === 'sms' && x.to === '254711000001').at(-1)!.from).toBe('GRACECHURCH');
    expect((await call(PA1, 'GET', '/admin/reconcile')).json().ok).toBe(true);
  });

  it('REVIEW FOCUS 3: no response, delivery record or audit event contains a phone number', async () => {
    const list = await call(OWNER, 'GET', '/messages');
    const detail = await call(OWNER, 'GET', `/messages/${list.json().find((m: any) => m.title === 'All church notice').id}`);
    expect(list.body).not.toMatch(FULL_PHONE);
    expect(detail.body).not.toMatch(FULL_PHONE);
    expect(detail.json().delivery.length).toBeGreaterThan(0);
    const cols = (await ctx.db.query<any>(`SELECT column_name FROM information_schema.columns WHERE table_name='message_recipients'`)).map((r) => r.column_name);
    expect(cols).not.toContain('phone');
    expect(cols).not.toContain('to');
    const audit = await call(OWNER, 'GET', '/audit/events?limit=200');
    expect(audit.body).not.toMatch(FULL_PHONE);
    const evt = audit.json().events.find((e: any) => e.action === 'message.send');
    expect(evt.summary).toMatch(/Sent "All church notice" to 4 people/);
    expect(evt.links.messageId).toBeTruthy();
  });

  it('a guardian who is also a direct recipient gets one message, and children are reached only through guardians', async () => {
    const sms0 = sentTo('sms', '254711000001');
    const r = await call(OWNER, 'POST', '/messages', { audience: { scope: { type: 'branch', id: 'br_grc001' }, who: 'children' }, channels: ['sms'], title: 'For the parents', body: 'Hello {name}, a note about the children.' });
    expect(r.statusCode).toBe(200);
    // Ruth's guardians are Jane and David, Brian's is Peter: three people, each once.
    expect(r.json().summary.people).toBe(3);
    expect(sentTo('sms', '254711000001') - sms0).toBe(1);
    const all = await call(OWNER, 'POST', '/messages/estimate', { audience: { scope: { type: 'branch', id: 'br_grc001' }, who: 'all' }, channels: ['sms'], body: 'x' });
    expect(all.json().people).toBe(3); // adults and guardians together are still three people
  });

  it('can narrow by age band and sex, and refuses an empty audience', async () => {
    const e = (audience: any) => call(OWNER, 'POST', '/messages/estimate', { audience, channels: ['sms'], body: 'x' });
    const youth = (await e({ scope: { type: 'org' }, who: 'children', ageBands: ['13 to 17'] })).json();
    expect(youth.people).toBe(1); // Brian, 17, so Peter
    expect((await e({ scope: { type: 'org' }, who: 'adults', sex: 'female' })).json().people).toBe(2); // Jane and Amina
    expect((await e({ scope: { type: 'org' }, who: 'adults', ageBands: ['60 and over'] })).json().people).toBe(0);
    const none = await send(OWNER, { audience: { scope: { type: 'org' }, who: 'adults', ageBands: ['60 and over'] } });
    expect(none.json().code).toBe('nobody');
  });

  it('validates the audience, channels, title and body', async () => {
    expect((await send(OWNER, { audience: { scope: { type: 'planet' } } })).json().code).toBe('bad_audience');
    expect((await send(OWNER, { audience: { scope: { type: 'branch' } } })).json().code).toBe('bad_audience');
    expect((await send(OWNER, { audience: { scope: { type: 'org' }, who: 'aliens' } })).json().code).toBe('bad_audience');
    expect((await send(OWNER, { channels: ['pigeon'] })).json().code).toBe('bad_channel');
    expect((await send(OWNER, { title: '' })).json().code).toBe('bad_title');
    expect((await send(OWNER, { body: '' })).json().code).toBe('bad_body');
    expect((await send(OWNER, { body: 'x'.repeat(1001) })).json().code).toBe('bad_body');
  });

  it('in-app is always included, even when the sender only picked SMS', async () => {
    const before = (await call(JANE, 'GET', '/me/notifications')).json().rows.length;
    await send(OWNER, { channels: ['sms'], title: 'In-app check', audience: { scope: { type: 'branch', id: 'br_grc001' }, who: 'adults' } });
    const rows = (await call(JANE, 'GET', '/me/notifications')).json().rows;
    expect(rows.length).toBeGreaterThan(before);
    expect(rows.some((r: any) => r.kind === 'message' && r.title === 'In-app check')).toBe(true);
  });

  it('a long SMS costs one price per 160-character part', async () => {
    const long = 'x'.repeat(200);
    const e = (await call(OWNER, 'POST', '/messages/estimate', { audience: { scope: { type: 'branch', id: 'br_grc001' }, who: 'adults' }, channels: ['sms'], body: long })).json();
    expect(e.sms.segments).toBe(2);
    expect(e.sms.perMessage).toBe(200);
  });

  it('REVIEW FOCUS 1: a batch never spends more than the wallet holds', async () => {
    // Nairobi SMS credit enough for exactly one message.
    const have = await bal(SMS_NBO);
    await call(OWNER, 'POST', '/wallets/transfer', { fromWalletId: SMS_NBO, toWalletId: SMS_ORG, amount: (have - 100) / 100 });
    expect(await bal(SMS_NBO)).toBe(100);
    const r = await call(OWNER, 'POST', '/messages', { audience: { scope: { type: 'branch', id: 'br_grc001' }, who: 'adults' }, channels: ['sms'], title: 'Short', body: 'Hello {name}' });
    const s = r.json().summary.channels.sms;
    expect(s.sent).toBe(1);
    expect(s.noBalance).toBe(1); // Jane, David (opted out, skipped for that reason) and Peter: one sent, one short
    expect(await bal(SMS_NBO)).toBe(0);
  });

  it('refunds messages the provider could not deliver, and the books balance', async () => {
    await call(OWNER, 'POST', '/wallets/transfer', { fromWalletId: SMS_ORG, toWalletId: SMS_NBO, amount: 10 });
    const before = await bal(SMS_NBO);
    ctx.messaging.failNextSends(1);
    const r = await call(OWNER, 'POST', '/messages', { audience: { scope: { type: 'branch', id: 'br_grc001' }, who: 'adults' }, channels: ['sms'], title: 'Flaky', body: 'Hello {name}' });
    expect(r.json().summary.channels.sms).toMatchObject({ failed: 1, sent: 1 });
    expect(await bal(SMS_NBO)).toBe(before - 100); // only the delivered one is paid for
    expect((await call(PA1, 'GET', '/admin/reconcile')).json().ok).toBe(true);
  });
});

describe('REVIEW FOCUS 4: who can send (L117)', () => {
  it('sending is a permission: finance cannot, a branch admin can for their branch only', async () => {
    expect((await send(TREAS)).statusCode).toBe(403);
    expect((await send(JANE)).statusCode).toBe(403);
    expect((await send(null as any)).statusCode).toBe(401);
    expect((await send(ADMIN, { audience: { scope: { type: 'branch', id: 'br_grc002' }, who: 'all' } })).statusCode).toBe(403);
    expect((await send(ADMIN, { audience: { scope: { type: 'region', id: 'Coast' }, who: 'all' } })).statusCode).toBe(403);
    const own = await send(ADMIN, { channels: [], audience: { scope: { type: 'org' }, who: 'adults' }, title: 'Nairobi only' });
    expect(own.statusCode).toBe(200);
    expect(own.json().summary.people).toBe(3); // "the whole church" for a branch admin means their own branch
  });

  it('a role can be given the permission, and its reach follows the role scope', async () => {
    await ctx.db.query(`INSERT INTO users (id, phone, name, created_at) VALUES ('u_msg','254733000050','Mavis Messenger',$1)`, [ctx.clock.now().toISOString()]);
    await ctx.db.query(`INSERT INTO roles (id, org_id, name, permissions) VALUES ('org_grace:Messenger','org_grace','Messenger','["messages.send","messages.view"]')`);
    await ctx.db.query(`INSERT INTO role_assignments (id, org_id, user_id, role_id, scope_type, scope_id) VALUES ('ra_msg','org_grace','u_msg','org_grace:Messenger','region','Coast')`);
    const r = await send('0733000050', { channels: [], audience: { scope: { type: 'org' }, who: 'all' }, title: 'Coast only' });
    expect(r.statusCode).toBe(200);
    expect(r.json().summary.people).toBe(1); // Amina, the only person in the Coast region
    expect((await send('0733000050', { audience: { scope: { type: 'branch', id: 'br_grc001' }, who: 'all' } })).statusCode).toBe(403);
    expect((await call('0733000050', 'GET', '/wallets')).statusCode).toBe(403); // sending does not show balances
  });

  it('staff of another church cannot message or read this church\'s messages', async () => {
    const id = (await call(OWNER, 'GET', '/messages')).json()[0].id;
    expect((await call(HOPE, 'GET', `/messages/${id}`)).statusCode).toBe(404);
    expect((await call(HOPE, 'POST', `/messages/${id}/cancel`, {})).statusCode).toBe(404);
    expect(((await call(HOPE, 'GET', '/messages')).json() as any[]).every((m) => m.title !== 'All church notice')).toBe(true);
    expect((await send(HOPE, { audience: { scope: { type: 'branch', id: 'br_grc001' }, who: 'all' } })).statusCode).toBe(403);
  });
});

describe('REVIEW FOCUS 5: scheduling (L118)', () => {
  it('the seeded demo message waits, goes out once when its time comes, and is never sent twice', async () => {
    const wait0 = (await call(OWNER, 'GET', '/messages?status=scheduled')).json();
    expect(wait0.some((m: any) => m.id === 'msg_demo')).toBe(true);
    const before = ctx.messaging.count('sms');
    await call(PA1, 'POST', '/admin/clock/advance', { hours: 47 });
    expect(ctx.messaging.count('sms')).toBe(before); // not yet
    await call(PA1, 'POST', '/admin/clock/advance', { hours: 2 });
    const demo = (await call(OWNER, 'GET', '/messages/msg_demo')).json();
    expect(demo.status).toBe('sent');
    expect(demo.summary.people).toBe(4);
    const after = ctx.messaging.count('sms');
    expect(after).toBeGreaterThan(before);
    expect(await runScheduledMessages(ctx)).toBe(0); // nothing left to send
    expect(ctx.messaging.count('sms')).toBe(after);
  });

  it('a scheduled message can be cancelled until it goes, and a cancelled one never sends', async () => {
    const when = new Date(ctx.clock.now().getTime() + 5 * 3600_000).toISOString();
    const r = await send(OWNER, { channels: ['sms'], title: 'Later', scheduleAt: when });
    expect(r.json()).toMatchObject({ status: 'scheduled', scheduledAt: when });
    const id = r.json().id;
    const sms0 = ctx.messaging.count('sms');
    expect((await call(OWNER, 'POST', `/messages/${id}/cancel`, {})).json().status).toBe('cancelled');
    expect((await call(OWNER, 'POST', `/messages/${id}/cancel`, {})).statusCode).toBe(409);
    await call(PA1, 'POST', '/admin/clock/advance', { hours: 6 });
    expect(ctx.messaging.count('sms')).toBe(sms0);
    expect((await call(OWNER, 'GET', `/messages/${id}`)).json().status).toBe('cancelled');
    const sent = (await call(OWNER, 'GET', '/messages?status=sent')).json()[0];
    expect((await call(OWNER, 'POST', `/messages/${sent.id}/cancel`, {})).json().code).toBe('not_cancellable');
    expect((await call(ADMIN, 'POST', `/messages/${sent.id}/cancel`, {})).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('refuses a time in the past or more than a year ahead, and a non-date', async () => {
    const past = new Date(ctx.clock.now().getTime() - 3600_000).toISOString();
    expect((await send(OWNER, { scheduleAt: past })).json().code).toBe('in_past');
    expect((await send(OWNER, { scheduleAt: new Date(ctx.clock.now().getTime() + 400 * 86400_000).toISOString() })).json().code).toBe('too_far');
    expect((await send(OWNER, { scheduleAt: 'next tuesday' })).json().code).toBe('bad_schedule');
  });

  it('the audience a scheduled message was created with is fixed, so a later role change cannot widen it', async () => {
    const when = new Date(ctx.clock.now().getTime() + 3600_000).toISOString();
    await ctx.db.query(`INSERT INTO users (id, phone, name, created_at) VALUES ('u_temp','254733000060','Temp Admin',$1)`, [ctx.clock.now().toISOString()]);
    await ctx.db.query(`INSERT INTO role_assignments (id, org_id, user_id, role_id, scope_type, scope_id) VALUES ('ra_temp','org_grace','u_temp','org_grace:Branch Admin','branch','br_grc001')`);
    const r = await send('0733000060', { channels: [], scheduleAt: when, title: 'Fixed scope', audience: { scope: { type: 'org' }, who: 'all' } });
    await ctx.db.query(`DELETE FROM role_assignments WHERE user_id='u_temp'`);
    await call(PA1, 'POST', '/admin/clock/advance', { hours: 2 });
    const m = (await call(OWNER, 'GET', `/messages/${r.json().id}`)).json();
    expect(m.status).toBe('sent');
    expect(m.summary.people).toBe(3); // still only the Nairobi branch
  });
});

describe('groups and leaders (L117, L122)', () => {
  it('staff list groups with leaders and sizes, and see who can be reached how, never numbers', async () => {
    const groups = (await call(ADMIN, 'GET', '/groups')).json();
    const youth = groups.find((g: any) => g.name === 'Youth Fellowship');
    expect(youth).toMatchObject({ member_count: 4, leaders: 'Peter Otieno' });
    const d = await call(OWNER, 'GET', '/groups/grp_youth');
    expect(d.body).not.toMatch(FULL_PHONE);
    const peter = d.json().members.find((m: any) => m.name === 'Peter Otieno');
    expect(peter).toMatchObject({ role: 'leader', reach: { inApp: true, sms: true, whatsapp: true } });
    expect(d.json().members.find((m: any) => m.name === 'Ruth Wanjiku').reach.sms).toBe(false); // a child has no phone of their own
  });

  it('staff create groups within their scope, add members and leaders, and it is all audited', async () => {
    expect((await call(ADMIN, 'POST', '/groups', { name: 'X' })).json().code).toBe('bad_name');
    expect((await call(ADMIN, 'POST', '/groups', { name: 'Choir', branchId: 'br_grc002' })).statusCode).toBe(403);
    expect((await call(ADMIN, 'POST', '/groups', { name: 'Church-wide group' })).statusCode).toBe(403); // needs whole-church scope
    expect((await call(TREAS, 'POST', '/groups', { name: 'Choir', branchId: 'br_grc001' })).statusCode).toBe(403);
    const g = (await call(ADMIN, 'POST', '/groups', { name: 'Choir', branchId: 'br_grc001', description: 'Sunday worship' })).json();
    expect((await call(ADMIN, 'POST', '/groups', { name: 'choir', branchId: 'br_grc001' })).json().code).toBe('duplicate');
    const members = (await call(ADMIN, 'GET', '/members')).json();
    const jane = members.find((m: any) => m.full_name === 'Jane Wanjiku'), ruth = members.find((m: any) => m.full_name === 'Ruth Wanjiku');
    expect((await call(ADMIN, 'POST', `/groups/${g.id}/members`, { membershipIds: [jane.id], role: 'leader' })).json().added).toBe(1);
    expect((await call(ADMIN, 'POST', `/groups/${g.id}/members`, { membershipIds: [ruth.id], role: 'leader' })).json().code).toBe('bad_leader');
    expect((await call(ADMIN, 'POST', `/groups/${g.id}/members`, { membershipIds: ['m_nobody'] })).json().code).toBe('bad_members');
    expect((await call(ADMIN, 'POST', `/groups/${g.id}/members`, { membershipIds: [ruth.id] })).statusCode).toBe(200);
    expect((await call(ADMIN, 'POST', `/groups/${g.id}/members/${ruth.id}/remove`, {})).statusCode).toBe(200);
    expect((await call(ADMIN, 'POST', `/groups/${g.id}/members/${ruth.id}/remove`, {})).statusCode).toBe(404);
    const acts = (await call(OWNER, 'GET', '/audit/events?limit=100&entity=group')).json().events.map((e: any) => e.action);
    expect(acts).toEqual(expect.arrayContaining(['group.create', 'group.members']));
    expect((await call(HOPE, 'GET', `/groups/${g.id}`)).statusCode).toBe(404);
  });

  it('a leader sees their groups in the member app, and an ordinary member sees no roster', async () => {
    const mine = (await call(PETER, 'GET', '/me/groups')).json();
    expect(mine.find((g: any) => g.name === 'Youth Fellowship')).toMatchObject({ role: 'leader', canMessage: true, memberCount: 4 });
    const detail = (await call(PETER, 'GET', '/me/groups/grp_youth')).json();
    expect(detail.members.map((m: any) => m.name)).toContain('Ruth Wanjiku');
    expect(JSON.stringify(detail)).not.toMatch(FULL_PHONE);
    const member = (await call(AMINA, 'GET', '/me/groups')).json().find((g: any) => g.name === 'Youth Fellowship');
    expect(member).toMatchObject({ role: 'member', canMessage: false });
    expect((await call(AMINA, 'GET', '/me/groups/grp_youth')).json().members).toEqual([]);
    expect((await call(HOPE, 'GET', '/me/groups/grp_youth')).statusCode).toBe(404);
  });

  it('a leader messages their whole group or chosen people in it, and the group\'s own wallet pays', async () => {
    const [nbo, hq] = [await bal(SMS_NBO), await bal(SMS_ORG)];
    await call(OWNER, 'POST', '/wallets/transfer', { fromWalletId: SMS_ORG, toWalletId: SMS_NBO, amount: 5 });
    const est = await call(PETER, 'POST', '/me/groups/grp_youth/estimate', { channels: ['sms'], body: 'Youth meet Friday' });
    expect(est.statusCode).toBe(200);
    expect(est.json().people).toBe(4); // Peter, Amina, and Jane and David through Ruth (Brian's guardian is Peter, counted once)
    expect(JSON.stringify(est.json())).not.toMatch(/balance|wallet/i); // a leader sees cost, not balances
    const before = ctx.messaging.count('sms');
    const r = await call(PETER, 'POST', '/me/groups/grp_youth/messages', { channels: ['sms'], title: 'Friday', body: 'Hello {name}, youth meet Friday at 6.', recipientIds: ['m_amina'] });
    expect(r.statusCode).toBe(200);
    expect(r.json().summary.people).toBe(1);
    // Amina is a Mombasa member, but the youth group is a Nairobi group, so Nairobi's wallet pays for the message (L122).
    expect(ctx.messaging.count('sms') - before).toBe(1);
    expect(await bal(SMS_NBO)).toBe(nbo + 500 - 100);
    void hq;
  });

  it('REVIEW FOCUS 4: only a leader can message a group, only people in it, with a daily cap', async () => {
    expect((await call(AMINA, 'POST', '/me/groups/grp_youth/messages', { channels: [], title: 'x', body: 'y' })).statusCode).toBe(403);
    expect((await call(JANE, 'POST', '/me/groups/grp_youth/messages', { channels: [], title: 'x', body: 'y' })).statusCode).toBe(404);
    expect((await call(PETER, 'POST', '/me/groups/grp_mothers/messages', { channels: [], title: 'x', body: 'y' })).statusCode).toBe(404); // not in that group at all
    expect((await call(PETER, 'POST', '/me/groups/grp_youth/messages', { channels: [], title: 'x', body: 'y', recipientIds: ['m_jane'] })).statusCode).toBe(403); // Jane is not in the youth group
    expect((await call(PETER, 'POST', '/me/groups/grp_youth/messages', { channels: [], title: '', body: 'y' })).json().code).toBe('bad_title');
    // Fill most of the daily allowance, then go over it.
    await ctx.db.query(`INSERT INTO messages (id, org_id, sender_id, sender_name, source, audience, channels, title, body, status, summary, created_at) VALUES ('msg_cap','org_grace','u_peter','Peter','group_leader','{}','["inapp"]','Cap','x','sent','{"people":999}',$1)`, [ctx.clock.now().toISOString()]);
    const over = await call(PETER, 'POST', '/me/groups/grp_youth/messages', { channels: [], title: 'Too many', body: 'y' });
    expect(over.statusCode).toBe(429);
    expect(over.json().code).toBe('daily_cap');
  });

  it('leaders\' messages are logged with the leader as the sender', async () => {
    const e = (await call(OWNER, 'GET', '/audit/events?action=message.send&limit=50')).json().events.find((x: any) => x.actor_name === 'Peter Otieno');
    expect(e).toBeTruthy();
    expect(e.meta.source).toBe('group_leader');
  });
});
