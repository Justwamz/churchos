import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { branchesFor } from '../auth';
import { HttpError, requireSession, type Ctx } from '../ctx';
import { buildPdf, textWidth, wrap, type PdfItem } from '../pdf';
import { inStaffScope } from '../scope';
import { REASONS } from './giving-ledger';

/**
 * Annual giving statements (Slice 20+1, L245 to L249): a member asks for one for a year, or a treasurer makes one on request with a reason.
 * Nothing is sent by itself. A statement lists the gifts the church can link to the member (never anonymous ones), is kept exactly as issued,
 * and carries a number anyone can check.
 */

const EAT = 3 * 3600_000;
const eatDate = (iso: string) => new Date(Date.parse(iso) + EAT).toISOString().slice(0, 10);
const eatYear = (iso: string) => Number(eatDate(iso).slice(0, 4));
const kes = (c: number) => (c / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const text = (v: unknown, max: number) => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (s.length > max) throw new HttpError(400, `That is too long (at most ${max} characters)`, 'bad_content');
  return s || null;
};
const HOW: Record<string, string> = { mpesa: 'M-Pesa', airtel: 'Airtel Money', tkash: 'T-Kash', card: 'Card', cash: 'Cash' };
const PURPOSE: Record<string, string> = { TITHE: 'Tithe', OFFERING: 'Offering' };

interface SnapLine { date: string; what: string; how: string; ref: string; amount: number; reversal: boolean }
interface Snapshot {
  number: string; year: number; yearToDate: boolean; generatedAt: string;
  church: string; branch: string; address: string | null; phone: string | null; email: string | null;
  registrationNo: string | null; kraPin: string | null; signatoryName: string | null; signatoryTitle: string | null; footer: string | null;
  member: { name: string; number: string };
  lines: SnapLine[]; byPurpose: { name: string; amount: number }[]; total: number; gifts: number;
}

/** Renders a kept statement as a PDF. The same snapshot always gives the same document. */
export function renderStatement(s: Snapshot): Buffer {
  const items: PdfItem[] = [];
  const W = 495;
  items.push({ kind: 'text', text: s.church, bold: true, size: 18 });
  items.push({ kind: 'text', text: [s.branch, s.address, s.phone, s.email].filter(Boolean).join('   '), size: 9, grey: true });
  const reg = [s.registrationNo ? `Registration no. ${s.registrationNo}` : null, s.kraPin ? `KRA PIN ${s.kraPin}` : null].filter(Boolean).join('   ');
  if (reg) items.push({ kind: 'text', text: reg, size: 9, grey: true });
  items.push({ kind: 'gap', h: 10 });
  items.push({ kind: 'text', text: `Giving statement ${s.year}${s.yearToDate ? ' (so far this year)' : ''}`, bold: true, size: 14 });
  items.push({ kind: 'gap', h: 4 });
  items.push({ kind: 'text', text: `${s.member.name}   Member no. ${s.member.number}`, size: 11 });
  items.push({ kind: 'text', text: `Statement ${s.number}   Issued ${eatDate(s.generatedAt)}`, size: 9, grey: true });
  items.push({ kind: 'gap', h: 8 });
  items.push({ kind: 'text', text: `Total given in ${s.year}: KES ${kes(s.total)}`, bold: true, size: 12 });
  items.push({ kind: 'text', text: `${s.gifts} gift${s.gifts === 1 ? '' : 's'}${s.lines.some((l) => l.reversal) ? ', after reversals' : ''}`, size: 9, grey: true });
  items.push({ kind: 'gap', h: 8 });
  items.push({ kind: 'text', text: 'By purpose', bold: true, size: 10 });
  for (const p of s.byPurpose) items.push({ kind: 'text', cols: [{ x: 0, text: p.name }, { x: W, text: `KES ${kes(p.amount)}`, right: true }], size: 10 });
  items.push({ kind: 'gap', h: 10 });
  items.push({ kind: 'text', text: 'Every gift', bold: true, size: 10 });
  items.push({ kind: 'rule' });
  items.push({ kind: 'text', bold: true, size: 9, cols: [{ x: 0, text: 'Date' }, { x: 62, text: 'For' }, { x: 250, text: 'How' }, { x: 320, text: 'Reference' }, { x: W, text: 'KES', right: true }] });
  items.push({ kind: 'rule' });
  for (const l of s.lines) {
    const what = wrap(l.what, 9, 180)[0] ?? '';
    items.push({ kind: 'text', size: 9, cols: [{ x: 0, text: l.date }, { x: 62, text: what }, { x: 250, text: l.how }, { x: 320, text: l.ref.slice(0, 22) }, { x: W, text: `${l.amount < 0 ? '-' : ''}${kes(Math.abs(l.amount))}`, right: true }] });
  }
  items.push({ kind: 'rule' });
  items.push({ kind: 'text', bold: true, size: 10, cols: [{ x: 0, text: 'Total' }, { x: W, text: `KES ${kes(s.total)}`, right: true }] });
  items.push({ kind: 'gap', h: 12 });
  const notes = [
    'This statement lists the gifts recorded by the church and linked to your membership: payments through ChurchOS and cash the church counted and signed off against your name. Anonymous gifts are not included, because they are not linked to you.',
    `You can check this statement on the ChurchOS giving page (/statement) with the number ${s.number}.`,
    s.footer ?? '',
  ].filter(Boolean);
  for (const n of notes) for (const ln of wrap(n, 8.5, W)) items.push({ kind: 'text', text: ln, size: 8.5, grey: true });
  if (s.signatoryName) {
    items.push({ kind: 'gap', h: 18 });
    items.push({ kind: 'text', text: s.signatoryName, bold: true, size: 10 });
    if (s.signatoryTitle) items.push({ kind: 'text', text: s.signatoryTitle, size: 9, grey: true });
  }
  void textWidth;
  return buildPdf(items, { title: `Giving statement ${s.year} ${s.number}`, footer: `${s.church} - statement ${s.number}` });
}

export function statementRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };
  const nowIso = () => ctx.clock.now().toISOString();

  const thisYear = () => eatYear(nowIso());

  async function giftsOf(orgId: string, membershipIds: string[], year: number) {
    const rows = await ctx.db.query<any>(
      `SELECT g.*, p.name AS project_name FROM giving_ledger g LEFT JOIN projects p ON p.id=g.project_id WHERE g.org_id=$1 AND g.membership_id = ANY($2::text[]) ORDER BY g.at, g.seq`,
      [orgId, membershipIds],
    );
    return rows.filter((r) => eatYear(r.at) === year);
  }

  /** Builds and keeps a statement. Fails when nothing was given that year. */
  async function make(opts: { orgId: string; membershipIds: string[]; primaryId: string; userId: string | null; year: number; by: { id: string | null; name: string; role: 'member' | 'staff' }; reason?: string | null; note?: string | null }) {
    const y = opts.year;
    if (!Number.isInteger(y) || y < 2000 || y > thisYear()) throw new HttpError(400, 'Choose a year from the past or this year', 'bad_year');
    const rows = await giftsOf(opts.orgId, opts.membershipIds, y);
    const total = rows.reduce((s, r) => s + Number(r.amount), 0);
    const gifts = rows.filter((r) => r.kind !== 'reversal').length;
    if (!rows.length) throw new HttpError(404, `There are no gifts recorded for ${y}`, 'no_gifts');
    const m = (await ctx.db.query<any>(`SELECT m.full_name, m.member_number, m.branch_id, b.name AS branch FROM memberships m JOIN branches b ON b.id=m.branch_id WHERE m.id=$1`, [opts.primaryId]))[0];
    const org = (await ctx.db.query<any>(`SELECT name FROM organisations WHERE id=$1`, [opts.orgId]))[0];
    const prof = (await ctx.db.query<any>(`SELECT address, town, phone, email FROM branch_profiles WHERE branch_id=$1`, [m.branch_id]))[0];
    const cfg = (await ctx.db.query<any>(`SELECT * FROM statement_settings WHERE org_id=$1`, [opts.orgId]))[0];
    const byPurpose = new Map<string, number>();
    const lines: SnapLine[] = rows.map((r) => {
      const purpose = String(r.purpose ?? 'OTHER').toUpperCase();
      const name = r.project_name ? `Project: ${r.project_name}` : PURPOSE[purpose] ?? purpose.charAt(0) + purpose.slice(1).toLowerCase();
      byPurpose.set(name, (byPurpose.get(name) ?? 0) + Number(r.amount));
      return { date: eatDate(r.at), what: r.kind === 'reversal' ? `Reversal: ${name}` : name, how: HOW[r.method ?? ''] ?? 'Payment', ref: String(r.ref ?? ''), amount: Number(r.amount), reversal: r.kind === 'reversal' };
    });
    const number = `GS-${y}-${randomBytes(3).toString('hex').toUpperCase()}`;
    const snap: Snapshot = {
      number, year: y, yearToDate: y === thisYear(), generatedAt: nowIso(),
      church: org.name, branch: m.branch, address: [prof?.address, prof?.town].filter(Boolean).join(', ') || null, phone: prof?.phone ?? null, email: prof?.email ?? null,
      registrationNo: cfg?.registration_no ?? null, kraPin: cfg?.kra_pin ?? null, signatoryName: cfg?.signatory_name ?? null, signatoryTitle: cfg?.signatory_title ?? null, footer: cfg?.footer ?? null,
      member: { name: m.full_name, number: m.member_number },
      lines, byPurpose: [...byPurpose.entries()].map(([name, amount]) => ({ name, amount })), total, gifts,
    };
    const id = ctx.newId('gst');
    await ctx.db.query(
      `INSERT INTO giving_statements (id, org_id, membership_id, user_id, year, number, total, gifts, snapshot, requested_by, requested_by_name, requested_by_role, reason, note, generated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, opts.orgId, opts.primaryId, opts.userId, y, number, total, gifts, JSON.stringify(snap), opts.by.id, opts.by.name, opts.by.role, opts.reason ?? null, opts.note ?? null, snap.generatedAt],
    );
    return { id, number, year: y, total, gifts, memberName: m.full_name, memberNumber: m.member_number, branchId: m.branch_id, snap };
  }

  const pdfReply = (reply: FastifyReply, row: any) => {
    const snap = JSON.parse(row.snapshot) as Snapshot;
    return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="giving-statement-${row.year}-${snap.number}.pdf"`).header('cache-control', 'private, no-store').send(renderStatement(snap));
  };

  const myMemberships = async (uid: string) => ctx.db.query<any>(`SELECT m.id, m.org_id, m.full_name, o.name AS church FROM memberships m JOIN organisations o ON o.id=m.org_id WHERE m.user_id=$1 ORDER BY m.joined_at`, [uid]);

  // ======================= the member =======================

  app.get('/me/statements', auth, async (req) => {
    const mine = await myMemberships(req.session!.uid);
    const churches: any[] = [];
    for (const orgId of [...new Set(mine.map((m) => m.org_id as string))]) {
      const ids = mine.filter((m) => m.org_id === orgId).map((m) => m.id as string);
      const rows = await ctx.db.query<any>(`SELECT at, amount, kind FROM giving_ledger WHERE org_id=$1 AND membership_id = ANY($2::text[])`, [orgId, ids]);
      const years = new Map<number, { year: number; gifts: number; total: number }>();
      for (const r of rows) {
        const y = eatYear(r.at);
        const c = years.get(y) ?? { year: y, gifts: 0, total: 0 };
        c.total += Number(r.amount);
        if (r.kind !== 'reversal') c.gifts++;
        years.set(y, c);
      }
      churches.push({ orgId, church: mine.find((m) => m.org_id === orgId).church, years: [...years.values()].sort((a, b) => b.year - a.year) });
    }
    const issued = await ctx.db.query<any>(
      `SELECT s.id, s.number, s.year, s.total, s.gifts, s.generated_at, s.requested_by_role, s.requested_by_name, o.name AS church FROM giving_statements s JOIN organisations o ON o.id=s.org_id WHERE s.membership_id = ANY($1::text[]) ORDER BY s.generated_at DESC LIMIT 50`,
      [mine.map((m) => m.id)],
    );
    return {
      churches, thisYear: thisYear(), note: 'Anonymous gifts are not on a statement, because the church cannot link them to you.',
      issued: issued.map((s) => ({ id: s.id, number: s.number, year: s.year, total: Number(s.total), gifts: s.gifts, at: s.generated_at, church: s.church, by: s.requested_by_role === 'staff' ? s.requested_by_name : 'You' })),
    };
  });

  app.post('/me/statements', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const mine = await myMemberships(req.session!.uid);
    const orgId = String(b.orgId ?? mine[0]?.org_id ?? '');
    const ids = mine.filter((m) => m.org_id === orgId);
    if (!ids.length) throw new HttpError(404, 'church not found', 'not_found');
    const recent = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM giving_statements WHERE user_id=$1 AND requested_by_role='member' AND generated_at > $2`, [req.session!.uid, new Date(ctx.clock.now().getTime() - 86_400_000).toISOString()]))[0].n);
    if (recent >= 10) throw new HttpError(429, 'You have asked for 10 statements today. Please try again tomorrow.', 'too_many');
    const s = await make({ orgId, membershipIds: ids.map((m) => m.id), primaryId: ids[0].id, userId: req.session!.uid, year: Number(b.year), by: { id: req.session!.uid, name: ids[0].full_name, role: 'member' } });
    await ctx.ledger.audit({ orgId, branchId: s.branchId, actor: req.session!.uid, action: 'statement.member', entity: 'membership', entityId: ids[0].id, summary: `${s.memberName} asked for their giving statement for ${s.year} (${s.number})`, meta: { number: s.number, total: s.total } });
    return { id: s.id, number: s.number, year: s.year, total: s.total, gifts: s.gifts };
  });

  app.get('/me/statements/:id/pdf', auth, async (req, reply) => {
    const mine = await myMemberships(req.session!.uid);
    const row = (await ctx.db.query<any>(`SELECT * FROM giving_statements WHERE id=$1 AND membership_id = ANY($2::text[])`, [(req.params as any).id, mine.map((m) => m.id)]))[0];
    if (!row) throw new HttpError(404, 'statement not found', 'not_found');
    return pdfReply(reply, row);
  });

  // ======================= the church =======================

  app.get('/members/:id/statements', auth, async (req) => {
    const m = (await ctx.db.query<any>(`SELECT id, org_id, branch_id FROM memberships WHERE id=$1`, [(req.params as any).id]))[0];
    if (!m || !(await inStaffScope(ctx, req, 'giving.ledger', m.org_id, m.branch_id))) throw new HttpError(404, 'not found', 'not_found');
    const rows = await ctx.db.query<any>(`SELECT id, number, year, total, gifts, generated_at, requested_by_role, requested_by_name, reason FROM giving_statements WHERE membership_id=$1 ORDER BY generated_at DESC LIMIT 50`, [m.id]);
    return { statements: rows.map((s) => ({ id: s.id, number: s.number, year: s.year, total: Number(s.total), gifts: s.gifts, at: s.generated_at, by: s.requested_by_role === 'member' ? 'The member' : s.requested_by_name, reason: s.reason ? REASONS[s.reason] ?? s.reason : null })), thisYear: thisYear() };
  });

  /** A treasurer makes a statement on request. The reason is recorded, shown to the member, and the member is told. */
  app.post('/members/:id/statements', auth, async (req) => {
    const m = (await ctx.db.query<any>(`SELECT m.id, m.org_id, m.branch_id, m.user_id, m.full_name, m.member_number FROM memberships m WHERE m.id=$1`, [(req.params as any).id]))[0];
    if (!m || !(await inStaffScope(ctx, req, 'giving.ledger', m.org_id, m.branch_id))) throw new HttpError(404, 'not found', 'not_found');
    const b = (req.body ?? {}) as any;
    const reason = String(b.reason ?? '');
    if (!REASONS[reason]) throw new HttpError(400, 'Choose why you are making this statement', 'reason_required');
    const note = text(b.note, 120);
    if (reason === 'other' && !note) throw new HttpError(400, 'Say what the reason is', 'reason_required');
    const ids = (await ctx.db.query<any>(`SELECT id FROM memberships WHERE org_id=$1 AND ((user_id IS NOT NULL AND user_id=$2) OR id=$3)`, [m.org_id, m.user_id, m.id])).map((x) => x.id as string);
    const s = await make({ orgId: m.org_id, membershipIds: ids, primaryId: m.id, userId: m.user_id ?? null, year: Number(b.year), by: { id: req.session!.uid, name: req.session!.name, role: 'staff' }, reason, note });
    const label = `${REASONS[reason]}${note ? `: ${note}` : ''}`;
    await ctx.db.query(`INSERT INTO giving_ledger_access (id, org_id, membership_id, at, staff_id, staff_name, action, reason, note) VALUES ($1,$2,$3,$4,$5,$6,'exported',$7,$8)`, [ctx.newId('gla'), m.org_id, m.id, nowIso(), req.session!.uid, req.session!.name, reason, `Statement ${s.number} for ${s.year}${note ? `. ${note}` : ''}`]);
    await ctx.ledger.audit({ orgId: m.org_id, branchId: m.branch_id, actor: req.session!.uid, action: 'statement.staff', entity: 'membership', entityId: m.id, summary: `Made the ${s.year} giving statement (${s.number}) for ${m.full_name} (${m.member_number}), KES ${kes(s.total)}`, reason: label, meta: { number: s.number, total: s.total } });
    if (m.user_id) await ctx.db.query(`INSERT INTO notifications (id, org_id, user_id, kind, title, body, created_at) VALUES ($1,$2,$3,'announcement',$4,$5,$6)`, [ctx.newId('ntf'), m.org_id, m.user_id, `A giving statement for ${s.year} was made`, `${req.session!.name} made your ${s.year} giving statement (${s.number}). Reason: ${label}. You can see it under Giving > My giving statements.`, nowIso()]);
    return { id: s.id, number: s.number, year: s.year, total: s.total, gifts: s.gifts };
  });

  app.get('/statements/:id/pdf', auth, async (req, reply) => {
    const row = (await ctx.db.query<any>(`SELECT s.*, m.branch_id FROM giving_statements s JOIN memberships m ON m.id=s.membership_id WHERE s.id=$1`, [(req.params as any).id]))[0];
    if (!row || !(await inStaffScope(ctx, req, 'giving.ledger', row.org_id, row.branch_id))) throw new HttpError(404, 'statement not found', 'not_found');
    await ctx.db.query(`INSERT INTO giving_ledger_access (id, org_id, membership_id, at, staff_id, staff_name, action, reason, note) VALUES ($1,$2,$3,$4,$5,$6,'viewed','statement_request',$7)`, [ctx.newId('gla'), row.org_id, row.membership_id, nowIso(), req.session!.uid, req.session!.name, `Opened statement ${row.number}`]);
    return pdfReply(reply, row);
  });

  /** Anyone with a statement can check it is real: church, year, total and the member's initials. */
  app.get('/public/statement/:number', async (req) => {
    const n = String((req.params as any).number ?? '').toUpperCase().slice(0, 30);
    const row = (await ctx.db.query<any>(`SELECT s.number, s.year, s.total, s.generated_at, s.snapshot, o.name AS church FROM giving_statements s JOIN organisations o ON o.id=s.org_id WHERE s.number=$1`, [n]))[0];
    if (!row) return { valid: false };
    const snap = JSON.parse(row.snapshot) as Snapshot;
    const initials = snap.member.name.split(/\s+/).filter(Boolean).map((p) => `${p[0].toUpperCase()}.`).join(' ');
    return { valid: true, church: row.church, year: row.year, total: Number(row.total), issued: eatDate(row.generated_at), memberInitials: initials };
  });

  // ======================= what appears on a statement =======================

  async function settingsOrg(req: any) {
    const rows = await branchesFor(ctx.db, req.session!.uid, 'giving.ledger');
    if (!rows.length) throw new HttpError(403, 'missing permission giving.ledger', 'forbidden');
    return rows[0].orgId as string;
  }

  app.get('/statements/settings', auth, async (req) => {
    const orgId = await settingsOrg(req);
    const c = (await ctx.db.query<any>(`SELECT * FROM statement_settings WHERE org_id=$1`, [orgId]))[0];
    return { registrationNo: c?.registration_no ?? '', kraPin: c?.kra_pin ?? '', signatoryName: c?.signatory_name ?? '', signatoryTitle: c?.signatory_title ?? '', footer: c?.footer ?? '' };
  });

  app.put('/statements/settings', auth, async (req) => {
    const orgId = await settingsOrg(req);
    const b = (req.body ?? {}) as any;
    const v = { reg: text(b.registrationNo, 60), kra: text(b.kraPin, 30), sn: text(b.signatoryName, 80), st: text(b.signatoryTitle, 80), foot: text(b.footer, 400) };
    await ctx.db.query(
      `INSERT INTO statement_settings (org_id, registration_no, kra_pin, signatory_name, signatory_title, footer, updated_at, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (org_id) DO UPDATE SET registration_no=$2, kra_pin=$3, signatory_name=$4, signatory_title=$5, footer=$6, updated_at=$7, updated_by=$8`,
      [orgId, v.reg, v.kra, v.sn, v.st, v.foot, nowIso(), req.session!.uid],
    );
    await ctx.ledger.audit({ orgId, actor: req.session!.uid, action: 'statement.settings', entity: 'organisation', entityId: orgId, summary: 'Changed what appears on giving statements' });
    return { ok: true };
  });
}
