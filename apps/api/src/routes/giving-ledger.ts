import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { branchesFor } from '../auth';
import { HttpError, requireSession, type Ctx } from '../ctx';
import { inStaffScope } from '../scope';
import { csv } from './helpers';

/**
 * The member giving ledger (L217 to L224): one append-only, hash-chained line for every gift a church can link to a member,
 * and a reversal line when a gift is reversed. Only people with the right can read it, every look is recorded, and the member
 * can see who looked. Anonymous gifts are never in it.
 */

export const REASONS: Record<string, string> = {
  statement_request: 'A statement was requested',
  pastoral_visit: 'Pastoral visit',
  audit: 'Audit or review',
  reconciliation: 'Reconciling the books',
  other: 'Other reason',
};

export const isGivingPurpose = (p: unknown) => {
  const s = String(p ?? '').toUpperCase();
  return s === 'TITHE' || s === 'OFFERING' || s.startsWith('PROJ-');
};

interface Line {
  id: string;
  org_id: string;
  branch_id: string | null;
  membership_id: string;
  at: string;
  kind: 'gift' | 'cash_gift' | 'reversal';
  amount: number;
  method: string | null;
  purpose: string | null;
  project_id: string | null;
  payment_id: string | null;
  cash_entry_id: string | null;
  ref: string | null;
  reverses: string | null;
  note: string | null;
  recorded_by: string | null;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const hashLine = (prev: string | null, l: Line) =>
  sha(`${prev ?? ''}|${[l.id, l.org_id, l.branch_id, l.membership_id, l.at, l.kind, String(l.amount), l.method, l.purpose, l.project_id, l.payment_id, l.cash_entry_id, l.ref, l.reverses, l.note, l.recorded_by].map((v) => v ?? '').join('|')}`);

async function insertLine(ctx: Ctx, l: Omit<Line, 'id' | 'at'>) {
  return ctx.db.tx(async (q) => {
    const prev = (await q.query<any>(`SELECT hash FROM giving_ledger WHERE org_id=$1 ORDER BY seq DESC LIMIT 1`, [l.org_id]))[0];
    const line: Line = { ...l, id: ctx.newId('gl'), at: ctx.clock.now().toISOString() };
    await q.query(
      `INSERT INTO giving_ledger (id, org_id, branch_id, membership_id, at, kind, amount, method, purpose, project_id, payment_id, cash_entry_id, ref, reverses, note, recorded_by, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [line.id, line.org_id, line.branch_id, line.membership_id, line.at, line.kind, line.amount, line.method, line.purpose, line.project_id, line.payment_id, line.cash_entry_id, line.ref, line.reverses, line.note, line.recorded_by, prev?.hash ?? null, hashLine(prev?.hash ?? null, line)],
    );
    return line.id;
  });
}

/** A gift that can be tied to a member goes in the ledger (never an anonymous one, never a purchase). */
export async function appendGift(ctx: Ctx, paymentId: string): Promise<void> {
  const p = (await ctx.db.query<any>(`SELECT * FROM payments WHERE id=$1`, [paymentId]))[0];
  if (!p || p.anonymous || !p.member_id || !p.org_id || !isGivingPurpose(p.purpose)) return;
  if ((await ctx.db.query<any>(`SELECT 1 FROM giving_ledger WHERE payment_id=$1 AND kind='gift'`, [paymentId])).length) return;
  const intent = (await ctx.db.query<any>(`SELECT base_amount FROM give_intents WHERE provider_tx_id=$1`, [p.provider_tx_id]))[0];
  await insertLine(ctx, {
    org_id: p.org_id, branch_id: p.branch_id, membership_id: p.member_id, kind: 'gift', amount: Number(intent ? intent.base_amount : p.amount_paid), method: p.method, purpose: String(p.purpose).toUpperCase(),
    project_id: p.project_id ?? null, payment_id: p.id, cash_entry_id: null, ref: p.provider_tx_id, reverses: null, note: null, recorded_by: null,
  });
}

/** A reversed gift is cancelled out by a new line. The original is never touched. */
export async function appendReversal(ctx: Ctx, paymentId: string, reason: string | null): Promise<void> {
  const gift = (await ctx.db.query<any>(`SELECT * FROM giving_ledger WHERE payment_id=$1 AND kind='gift'`, [paymentId]))[0];
  if (!gift) return;
  if ((await ctx.db.query<any>(`SELECT 1 FROM giving_ledger WHERE reverses=$1`, [gift.id])).length) return;
  await insertLine(ctx, {
    org_id: gift.org_id, branch_id: gift.branch_id, membership_id: gift.membership_id, kind: 'reversal', amount: -Number(gift.amount), method: gift.method, purpose: gift.purpose, project_id: gift.project_id,
    payment_id: paymentId, cash_entry_id: null, ref: gift.ref, reverses: gift.id, note: reason ? String(reason).slice(0, 200) : null, recorded_by: null,
  });
}

/** Cash a church counted and a second person signed off, for the members it was given by (L222). */
export async function appendCashGifts(ctx: Ctx, cashId: string): Promise<void> {
  const c = (await ctx.db.query<any>(`SELECT * FROM cash_entries WHERE id=$1 AND status='approved'`, [cashId]))[0];
  if (!c) return;
  const gifts = await ctx.db.query<any>(`SELECT membership_id, amount FROM cash_entry_gifts WHERE cash_entry_id=$1`, [cashId]);
  for (const g of gifts) {
    if ((await ctx.db.query<any>(`SELECT 1 FROM giving_ledger WHERE cash_entry_id=$1 AND membership_id=$2`, [cashId, g.membership_id])).length) continue;
    await insertLine(ctx, {
      org_id: c.org_id, branch_id: c.branch_id, membership_id: g.membership_id, kind: 'cash_gift', amount: Number(g.amount), method: 'cash', purpose: String(c.purpose).toUpperCase(), project_id: null,
      payment_id: null, cash_entry_id: cashId, ref: cashId, reverses: null, note: c.note ? String(c.note).slice(0, 200) : null, recorded_by: c.counted_by,
    });
  }
}

export async function verifyChain(ctx: Ctx, orgId: string): Promise<{ ok: boolean; lines: number; brokenAt: string | null }> {
  const rows = await ctx.db.query<any>(`SELECT * FROM giving_ledger WHERE org_id=$1 ORDER BY seq`, [orgId]);
  let prev: string | null = null;
  for (const r of rows) {
    const line: Line = { id: r.id, org_id: r.org_id, branch_id: r.branch_id, membership_id: r.membership_id, at: r.at, kind: r.kind, amount: Number(r.amount), method: r.method, purpose: r.purpose, project_id: r.project_id, payment_id: r.payment_id, cash_entry_id: r.cash_entry_id, ref: r.ref, reverses: r.reverses, note: r.note, recorded_by: r.recorded_by };
    if ((r.prev_hash ?? null) !== prev || hashLine(prev, line) !== r.hash) return { ok: false, lines: rows.length, brokenAt: r.id };
    prev = r.hash;
  }
  return { ok: true, lines: rows.length, brokenAt: null };
}

export function givingLedgerRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };
  const nowIso = () => ctx.clock.now().toISOString();

  const lineView = (r: any) => ({
    id: r.id, at: r.at, kind: r.kind, amount: Number(r.amount), method: r.method, purpose: r.purpose, project: r.project_name ?? null, ref: r.ref, reverses: r.reverses, note: r.note,
    source: r.kind === 'cash_gift' ? 'Cash recorded by the church' : r.kind === 'reversal' ? 'Reversal' : r.method === 'card' ? 'Card' : r.method === 'mpesa' ? 'M-Pesa' : r.method === 'airtel' ? 'Airtel Money' : r.method === 'tkash' ? 'T-Kash' : 'Payment',
  });

  const SELECT = `SELECT g.*, p.name AS project_name FROM giving_ledger g LEFT JOIN projects p ON p.id=g.project_id`;

  function totals(lines: { at: string; amount: number; purpose: string | null }[]) {
    const byYear: Record<string, number> = {};
    const byPurpose: Record<string, number> = {};
    let given = 0;
    for (const l of lines) {
      given += l.amount;
      const y = new Date(Date.parse(l.at) + 3 * 3600_000).getUTCFullYear().toString();
      byYear[y] = (byYear[y] ?? 0) + l.amount;
      const k = l.purpose ?? 'OTHER';
      byPurpose[k] = (byPurpose[k] ?? 0) + l.amount;
    }
    return { given, byYear, byPurpose };
  }

  /**
   * Finds a member by name or number, for people who can open giving records or count cash. It gives only a name, a number and a branch,
   * so a treasurer does not need the right to see every member's details just to find someone.
   */
  app.get('/members/lookup', auth, async (req) => {
    const rows = [...(await branchesFor(ctx.db, req.session!.uid, 'giving.ledger')), ...(await branchesFor(ctx.db, req.session!.uid, 'cash.count'))];
    if (!rows.length) throw new HttpError(403, 'missing permission giving.ledger', 'forbidden');
    const orgId = rows[0].orgId;
    const branchIds = [...new Set(rows.filter((r) => r.orgId === orgId).map((r) => r.branchId))];
    const q = String((req.query as any).q ?? '').trim().slice(0, 40);
    if (q.length < 2) return { members: [] };
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const found = await ctx.db.query<any>(
      `SELECT m.id, m.full_name, m.member_number, b.name AS branch FROM memberships m JOIN branches b ON b.id=m.branch_id
        WHERE m.org_id=$1 AND m.branch_id = ANY($2::text[]) AND m.status='active' AND m.category='adult' AND (m.full_name ILIKE $3 OR m.member_number ILIKE $3) ORDER BY m.full_name LIMIT 15`,
      [orgId, branchIds, like],
    );
    return { members: found.map((m) => ({ id: m.id, name: m.full_name, memberNumber: m.member_number, branch: m.branch })) };
  });

  /** A member's giving record, for people with the right. Needs a reason, and every look is recorded (L220, L221). */
  app.get('/members/:id/giving-ledger', auth, async (req) => {
    const m = (await ctx.db.query<any>(`SELECT m.id, m.org_id, m.branch_id, m.full_name, m.member_number, b.name AS branch FROM memberships m JOIN branches b ON b.id=m.branch_id WHERE m.id=$1`, [(req.params as any).id]))[0];
    if (!m || !(await inStaffScope(ctx, req, 'giving.ledger', m.org_id, m.branch_id))) throw new HttpError(404, 'not found', 'not_found');
    const q = req.query as any;
    const reason = String(q.reason ?? '');
    if (!REASONS[reason]) throw new HttpError(400, 'Choose why you are opening this giving record', 'reason_required');
    const note = String(q.note ?? '').trim().slice(0, 120);
    if (reason === 'other' && !note) throw new HttpError(400, 'Say what the reason is', 'reason_required');
    const csvOut = q.format === 'csv';
    const rows = await ctx.db.query<any>(`${SELECT} WHERE g.membership_id=$1 ORDER BY g.seq DESC`, [m.id]);
    const label = `${REASONS[reason]}${note ? `: ${note}` : ''}`;
    await ctx.db.query(`INSERT INTO giving_ledger_access (id, org_id, membership_id, at, staff_id, staff_name, action, reason, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [ctx.newId('gla'), m.org_id, m.id, nowIso(), req.session!.uid, req.session!.name, csvOut ? 'exported' : 'viewed', reason, note || null]);
    await ctx.ledger.audit({ orgId: m.org_id, branchId: m.branch_id, actor: req.session!.uid, action: csvOut ? 'giving_ledger.exported' : 'giving_ledger.viewed', entity: 'membership', entityId: m.id, summary: `${csvOut ? 'Exported' : 'Opened'} the giving record of ${m.full_name} (${m.member_number}), ${rows.length} lines`, reason: label, meta: { lines: rows.length } });
    const lines = rows.map(lineView);
    if (csvOut) return csv(lines.map((l) => ({ Date: l.at, Kind: l.kind, Amount: l.amount / 100, Purpose: l.purpose ?? '', Project: l.project ?? '', How: l.source, Reference: l.ref ?? '', Note: l.note ?? '' })));
    return { member: { id: m.id, name: m.full_name, memberNumber: m.member_number, branch: m.branch }, lines, totals: totals(lines), integrity: await verifyChain(ctx, m.org_id), reasons: REASONS };
  });

  app.get('/giving-ledger/verify', auth, async (req) => {
    const mine = await branchesFor(ctx.db, req.session!.uid, 'giving.ledger');
    if (!mine.length) throw new HttpError(403, 'missing permission giving.ledger', 'forbidden');
    const orgId = mine[0].orgId;
    const v = await verifyChain(ctx, orgId);
    await ctx.ledger.audit({ orgId, actor: req.session!.uid, action: 'giving_ledger.verified', entity: 'organisation', entityId: orgId, summary: `Checked the giving ledger: ${v.ok ? 'intact' : 'BROKEN'}, ${v.lines} lines` });
    return v;
  });

  // ======================= the member's own record (L223, L224) =======================

  async function myIds(uid: string) {
    return (await ctx.db.query<any>(`SELECT id FROM memberships WHERE user_id=$1`, [uid])).map((m) => m.id as string);
  }

  app.get('/me/giving/ledger', auth, async (req) => {
    const ids = await myIds(req.session!.uid);
    const rows = ids.length ? await ctx.db.query<any>(`${SELECT} WHERE g.membership_id = ANY($1::text[]) ORDER BY g.seq DESC`, [ids]) : [];
    const anon = await ctx.db.query<any>(
      `SELECT p.id, p.received_at, p.method, p.purpose, p.amount_paid, p.stage, i.base_amount, b.name AS church FROM anonymous_gifts a JOIN payments p ON p.id=a.payment_id LEFT JOIN give_intents i ON i.id=a.intent_id LEFT JOIN branches b ON b.id=p.branch_id WHERE a.user_id=$1 ORDER BY p.received_at DESC`,
      [req.session!.uid],
    );
    const lines = rows.map(lineView);
    const anonymous = anon.map((p) => ({ id: p.id, at: p.received_at, kind: 'gift', anonymous: true, amount: Number(p.base_amount ?? p.amount_paid), method: p.method, purpose: String(p.purpose ?? '').toUpperCase(), church: p.church, reversed: p.stage === 'reversed' || p.stage === 'refunded' }));
    const t = totals([...lines, ...anonymous.filter((a) => !a.reversed)].map((l) => ({ at: l.at, amount: l.amount, purpose: l.purpose })));
    return { lines, anonymous, totals: t, anonymousTotal: anonymous.filter((a) => !a.reversed).reduce((s, a) => s + a.amount, 0) };
  });

  app.get('/me/giving/access-log', auth, async (req) => {
    const ids = await myIds(req.session!.uid);
    if (!ids.length) return { log: [] };
    const rows = await ctx.db.query<any>(`SELECT a.*, o.name AS church FROM giving_ledger_access a JOIN organisations o ON o.id=a.org_id WHERE a.membership_id = ANY($1::text[]) ORDER BY a.at DESC LIMIT 200`, [ids]);
    return { log: rows.map((r) => ({ at: r.at, action: r.action, who: r.staff_name, church: r.church, reason: REASONS[r.reason] ?? r.reason, note: r.note })) };
  });
}
