import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { toCents } from '@churchos/shared';
import { branchesFor, type Permission } from '../auth';
import { HttpError, requireSession, type Ctx } from '../ctx';
import { addNotification } from '../notifications';
import { grantsFor, inStaffScope, staffWith } from '../scope';
import { notify } from '../sms';
import { csv } from './helpers';

/** Expenses (L235 to L244): recorded here, paid elsewhere. One person records, another approves, and approved means fixed. */

const METHODS = ['cash', 'mpesa', 'bank', 'cheque', 'other'] as const;
const METHOD_LABEL: Record<string, string> = { cash: 'Cash', mpesa: 'M-Pesa', bank: 'Bank', cheque: 'Cheque', other: 'Other' };
const DEFAULT_CATEGORIES = ['Salaries and allowances', 'Utilities', 'Repairs and maintenance', 'Supplies', 'Transport', 'Events and outreach', 'Welfare', 'Equipment', 'Printing and communication', 'Other'];
const FILE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_FILES = 3;
const MAX_FILE_BYTES = 1_200_000;
const MAX_AMOUNT = 100_000_000; // KES 1,000,000
const DEFAULTS = { approval_mode: 'above_limit', approval_limit: 500_000, two_approver_limit: 5_000_000 as number | null, receipt_required_above: 100_000 };

const cap = (v: unknown, n: number) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, n);
const kes = (c: number) => `KES ${(c / 100).toLocaleString('en-KE')}`;
const isDate = (s: unknown): s is string => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ''));

export function expenseRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };
  const nowIso = () => ctx.clock.now().toISOString();
  const today = () => new Date(ctx.clock.now().getTime() + 3 * 3600_000).toISOString().slice(0, 10);

  // ======================= settings and categories =======================

  async function settingsOf(orgId: string) {
    const r = (await ctx.db.query<any>(`SELECT * FROM expense_settings WHERE org_id=$1`, [orgId]))[0];
    return r ? { approval_mode: r.approval_mode as string, approval_limit: Number(r.approval_limit), two_approver_limit: r.two_approver_limit === null ? null : Number(r.two_approver_limit), receipt_required_above: Number(r.receipt_required_above), standard: false }
      : { ...DEFAULTS, standard: true };
  }

  async function categoriesOf(orgId: string) {
    if (!(await ctx.db.query<any>(`SELECT 1 FROM expense_categories WHERE org_id=$1 LIMIT 1`, [orgId])).length) {
      let i = 0;
      for (const name of DEFAULT_CATEGORIES) await ctx.db.query(`INSERT INTO expense_categories (id, org_id, name, sort) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [ctx.newId('exc'), orgId, name, i++]);
    }
    return ctx.db.query<any>(`SELECT id, name, active, sort FROM expense_categories WHERE org_id=$1 ORDER BY sort, name`, [orgId]);
  }

  /** The organisation and branches where the person holds any of the permissions, and which of them each permission covers. */
  async function scopeOf(req: FastifyRequest, perms: Permission[]) {
    const per = new Map<Permission, Set<string>>();
    let orgId = '';
    const hint = (req.query as any)?.org as string | undefined;
    for (const p of perms) {
      const rows = await branchesFor(ctx.db, req.session!.uid, p);
      for (const r of rows) if (!orgId || (hint && r.orgId === hint)) orgId = r.orgId;
    }
    for (const p of perms) per.set(p, new Set((await branchesFor(ctx.db, req.session!.uid, p)).filter((r) => r.orgId === orgId).map((r) => r.branchId)));
    const all = new Set<string>();
    for (const s of per.values()) for (const b of s) all.add(b);
    if (!orgId || !all.size) throw new HttpError(403, `missing permission ${perms[0]}`, 'forbidden');
    return { orgId, per, all: [...all] };
  }

  app.get('/expenses/setup', auth, async (req) => {
    const sc = await scopeOf(req, ['expenses.view', 'expenses.record', 'expenses.approve', 'expenses.manage', 'expenses.settings']);
    const settings = await settingsOf(sc.orgId);
    const branches = await ctx.db.query<any>(`SELECT id, name FROM branches WHERE org_id=$1 AND id = ANY($2::text[]) ORDER BY name`, [sc.orgId, sc.all]);
    const projects = await ctx.db.query<any>(`SELECT id, branch_id, code, name, restricted, budget, status FROM projects WHERE org_id=$1 AND branch_id = ANY($2::text[]) ORDER BY created_at`, [sc.orgId, sc.all]);
    const out = [];
    for (const p of projects) out.push({ id: p.id, branchId: p.branch_id, code: p.code, name: p.name, restricted: p.restricted, open: p.status === 'open', budget: p.budget === null ? null : Number(p.budget), available: p.restricted ? (await fund(p.id)).available : null });
    return {
      settings: { approvalMode: settings.approval_mode, approvalLimit: settings.approval_limit, twoApproverLimit: settings.two_approver_limit, receiptRequiredAbove: settings.receipt_required_above, standard: settings.standard },
      categories: (await categoriesOf(sc.orgId)).map((c) => ({ id: c.id, name: c.name, active: c.active })), methods: METHODS.map((m) => ({ key: m, label: METHOD_LABEL[m] })), branches: branches.map((b) => ({ id: b.id, name: b.name, canRecord: sc.per.get('expenses.record')!.has(b.id), canApprove: sc.per.get('expenses.approve')!.has(b.id), canManage: sc.per.get('expenses.manage')!.has(b.id) })), projects: out,
      can: { view: sc.per.get('expenses.view')!.size > 0, record: sc.per.get('expenses.record')!.size > 0, approve: sc.per.get('expenses.approve')!.size > 0, manage: sc.per.get('expenses.manage')!.size > 0, settings: sc.per.get('expenses.settings')!.size > 0 },
    };
  });

  app.put('/expenses/settings', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'expenses.settings');
    const b = (req.body ?? {}) as any;
    const mode = String(b.approvalMode ?? '');
    if (mode !== 'all' && mode !== 'above_limit') throw new HttpError(400, 'Choose whether every expense needs approval, or only those above a limit', 'bad_mode');
    const money = (v: unknown, label: string, allowNull = false) => {
      if (allowNull && (v === null || v === '' || v === undefined)) return null;
      try { const c = toCents(v as any); if (c < 0 || c > MAX_AMOUNT) throw new Error('range'); return c; } catch { throw new HttpError(400, `Enter a valid ${label}`, 'bad_amount'); }
    };
    const limit = money(b.approvalLimit ?? 0, 'approval limit')!;
    const two = money(b.twoApproverLimit, 'amount for two approvers', true);
    const receipt = money(b.receiptRequiredAbove ?? 0, 'receipt limit')!;
    if (two !== null && two <= limit && mode === 'above_limit') throw new HttpError(400, 'The amount for two approvers must be more than the approval limit', 'bad_amount');
    await ctx.db.query(`INSERT INTO expense_settings (org_id, approval_mode, approval_limit, two_approver_limit, receipt_required_above, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (org_id) DO UPDATE SET approval_mode=$2, approval_limit=$3, two_approver_limit=$4, receipt_required_above=$5, updated_by=$6, updated_at=$7`, [g.orgId, mode, limit, two, receipt, req.session!.uid, nowIso()]);
    await ctx.ledger.audit({ orgId: g.orgId, actor: req.session!.uid, action: 'expense.settings', entity: 'organisation', entityId: g.orgId, summary: `Changed the expense rules: ${mode === 'all' ? 'every expense needs approval' : `approval above ${kes(limit)}`}${two !== null ? `, two approvers above ${kes(two)}` : ''}, receipt above ${kes(receipt)}` });
    return { ok: true };
  });

  app.post('/expenses/categories', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'expenses.manage');
    const name = cap((req.body as any)?.name, 40);
    if (!name) throw new HttpError(400, 'Enter a name for the category', 'bad_content');
    await categoriesOf(g.orgId);
    if ((await ctx.db.query<any>(`SELECT 1 FROM expense_categories WHERE org_id=$1 AND lower(name)=lower($2)`, [g.orgId, name])).length) throw new HttpError(409, `There is already a category called "${name}"`, 'duplicate');
    const id = ctx.newId('exc');
    await ctx.db.query(`INSERT INTO expense_categories (id, org_id, name, sort) VALUES ($1,$2,$3,(SELECT COALESCE(MAX(sort),0)+1 FROM expense_categories WHERE org_id=$2))`, [id, g.orgId, name]);
    await ctx.ledger.audit({ orgId: g.orgId, actor: req.session!.uid, action: 'expense.category_added', entity: 'expense_category', entityId: id, summary: `Added the expense category "${name}"` });
    return { id };
  });

  app.patch('/expenses/categories/:id', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'expenses.manage');
    const c = (await ctx.db.query<any>(`SELECT * FROM expense_categories WHERE id=$1 AND org_id=$2`, [(req.params as any).id, g.orgId]))[0];
    if (!c) throw new HttpError(404, 'not found', 'not_found');
    const b = (req.body ?? {}) as any;
    const name = b.name !== undefined ? cap(b.name, 40) : c.name;
    if (!name) throw new HttpError(400, 'Enter a name for the category', 'bad_content');
    if (name.toLowerCase() !== c.name.toLowerCase() && (await ctx.db.query<any>(`SELECT 1 FROM expense_categories WHERE org_id=$1 AND lower(name)=lower($2)`, [g.orgId, name])).length) throw new HttpError(409, `There is already a category called "${name}"`, 'duplicate');
    await ctx.db.query(`UPDATE expense_categories SET name=$2, active=$3 WHERE id=$1`, [c.id, name, b.active === undefined ? c.active : !!b.active]);
    return { ok: true };
  });

  // ======================= restricted funds, budgets and alerts =======================

  /** What a restricted project has raised and not yet committed to expenses (L242). */
  async function fund(projectId: string, excludeId?: string) {
    const raised = Number((await ctx.db.query<any>(`SELECT COALESCE(SUM(net),0) AS n FROM payments WHERE project_id=$1 AND stage IN ('pending','available','paid_out')`, [projectId]))[0].n);
    const committed = Number((await ctx.db.query<any>(`SELECT COALESCE(SUM(amount),0) AS n FROM expenses WHERE project_id=$1 AND status IN ('submitted','awaiting_second','approved') AND id <> $2`, [projectId, excludeId ?? '']))[0].n);
    return { raised, committed, available: raised - committed };
  }

  async function budgetAlerts(e: any) {
    const year = Number(String(e.date).slice(0, 4));
    const checks: { scope: string; label: string; spent: number; budget: number }[] = [];
    const cat = (await ctx.db.query<any>(`SELECT amount FROM expense_budgets WHERE branch_id=$1 AND year=$2 AND category_id=$3`, [e.branch_id, year, e.category_id]))[0];
    if (cat && Number(cat.amount) > 0) {
      const spent = Number((await ctx.db.query<any>(`SELECT COALESCE(SUM(amount),0) AS n FROM expenses WHERE branch_id=$1 AND category_id=$2 AND status='approved' AND date >= $3 AND date <= $4`, [e.branch_id, e.category_id, `${year}-01-01`, `${year}-12-31`]))[0].n);
      checks.push({ scope: `cat:${e.branch_id}:${year}:${e.category_id}`, label: `${e.category_name} for ${year}`, spent, budget: Number(cat.amount) });
    }
    if (e.project_id) {
      const p = (await ctx.db.query<any>(`SELECT name, budget FROM projects WHERE id=$1`, [e.project_id]))[0];
      if (p?.budget && Number(p.budget) > 0) {
        const spent = Number((await ctx.db.query<any>(`SELECT COALESCE(SUM(amount),0) AS n FROM expenses WHERE project_id=$1 AND status='approved'`, [e.project_id]))[0].n);
        checks.push({ scope: `proj:${e.project_id}`, label: `the project ${p.name}`, spent, budget: Number(p.budget) });
      }
    }
    for (const c of checks) {
      const pct = (c.spent * 100) / c.budget;
      for (const level of [80, 100]) {
        if (pct < level) continue;
        const claimed = await ctx.db.query<any>(`INSERT INTO expense_budget_alerts (scope, level, at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING scope`, [c.scope, level, nowIso()]);
        if (!claimed[0]) continue;
        for (const u of await staffWith(ctx, e.org_id, e.branch_id, 'expenses.manage')) {
          await addNotification(ctx, { orgId: e.org_id, userId: u.id, kind: 'announcement', title: level >= 100 ? `Over budget: ${c.label}` : `Budget alert: ${c.label}`, body: `${c.label} has used ${Math.round(pct)}% of its budget (${kes(c.spent)} of ${kes(c.budget)}).`, link: 'staff:expenses?tab=budgets', audience: 'staff' });
        }
      }
    }
  }

  app.get('/expenses/budgets', auth, async (req) => {
    const sc = await scopeOf(req, ['expenses.view', 'expenses.manage']);
    const q = req.query as any;
    const branchId = String(q.branchId ?? sc.all[0]);
    if (!sc.all.includes(branchId)) throw new HttpError(404, 'not found', 'not_found');
    const year = Number(q.year) || Number(today().slice(0, 4));
    const cats = await categoriesOf(sc.orgId);
    const budgets = new Map((await ctx.db.query<any>(`SELECT category_id, amount FROM expense_budgets WHERE branch_id=$1 AND year=$2`, [branchId, year])).map((b) => [b.category_id, Number(b.amount)]));
    const spent = new Map((await ctx.db.query<any>(`SELECT category_id, SUM(amount) AS n FROM expenses WHERE branch_id=$1 AND status='approved' AND date >= $2 AND date <= $3 GROUP BY category_id`, [branchId, `${year}-01-01`, `${year}-12-31`])).map((r) => [r.category_id, Number(r.n)]));
    const projects = await ctx.db.query<any>(`SELECT id, code, name, budget, restricted FROM projects WHERE branch_id=$1 ORDER BY created_at`, [branchId]);
    const pOut = [];
    for (const p of projects) {
      const s = Number((await ctx.db.query<any>(`SELECT COALESCE(SUM(amount),0) AS n FROM expenses WHERE project_id=$1 AND status='approved'`, [p.id]))[0].n);
      pOut.push({ id: p.id, code: p.code, name: p.name, restricted: p.restricted, budget: p.budget === null ? null : Number(p.budget), spent: s, percent: p.budget && Number(p.budget) > 0 ? Math.round((s * 100) / Number(p.budget)) : null });
    }
    return {
      year, branchId, canManage: sc.per.get('expenses.manage')!.has(branchId),
      categories: cats.filter((c) => c.active || budgets.has(c.id)).map((c) => ({ categoryId: c.id, name: c.name, budget: budgets.get(c.id) ?? 0, spent: spent.get(c.id) ?? 0, percent: budgets.get(c.id) ? Math.round(((spent.get(c.id) ?? 0) * 100) / budgets.get(c.id)!) : null })),
      projects: pOut,
    };
  });

  app.put('/expenses/budgets', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'expenses.manage');
    const b = (req.body ?? {}) as any;
    if (!g.branchIds.includes(String(b.branchId))) throw new HttpError(404, 'not found', 'not_found');
    const year = Number(b.year);
    if (!Number.isInteger(year) || year < 2020 || year > 2100) throw new HttpError(400, 'Choose a year', 'bad_year');
    const cats = new Set((await categoriesOf(g.orgId)).map((c) => c.id));
    for (const c of Array.isArray(b.categories) ? b.categories : []) {
      if (!cats.has(String(c?.categoryId))) throw new HttpError(404, 'One of the categories was not found', 'not_found');
      let amt = 0;
      if (c.amount !== null && c.amount !== '' && c.amount !== undefined) { try { amt = toCents(c.amount); } catch { throw new HttpError(400, 'Enter a valid amount for each budget', 'bad_amount'); } }
      if (amt < 0 || amt > MAX_AMOUNT * 10) throw new HttpError(400, 'Enter a valid amount for each budget', 'bad_amount');
      await ctx.db.query(`INSERT INTO expense_budgets (org_id, branch_id, year, category_id, amount) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (branch_id, year, category_id) DO UPDATE SET amount=$5`, [g.orgId, b.branchId, year, c.categoryId, amt]);
    }
    await ctx.ledger.audit({ orgId: g.orgId, branchId: b.branchId, actor: req.session!.uid, action: 'expense.budgets', entity: 'branch', entityId: b.branchId, summary: `Set the ${year} expense budgets by category` });
    return { ok: true };
  });

  app.put('/expenses/project-budget', auth, async (req) => {
    const g = await grantsFor(ctx, req, 'expenses.manage');
    const b = (req.body ?? {}) as any;
    const p = (await ctx.db.query<any>(`SELECT id, branch_id, name FROM projects WHERE id=$1 AND org_id=$2`, [String(b.projectId ?? ''), g.orgId]))[0];
    if (!p || !g.branchIds.includes(p.branch_id)) throw new HttpError(404, 'not found', 'not_found');
    let amt: number | null = null;
    if (b.amount !== null && b.amount !== '' && b.amount !== undefined) { try { amt = toCents(b.amount); } catch { throw new HttpError(400, 'Enter a valid budget', 'bad_amount'); } if (amt < 0) throw new HttpError(400, 'Enter a valid budget', 'bad_amount'); }
    await ctx.db.query(`UPDATE projects SET budget=$2 WHERE id=$1`, [p.id, amt]);
    await ctx.ledger.audit({ orgId: g.orgId, branchId: p.branch_id, actor: req.session!.uid, action: 'expense.project_budget', entity: 'project', entityId: p.id, summary: amt === null ? `Removed the budget of the project ${p.name}` : `Set the budget of the project ${p.name} to ${kes(amt)}` });
    return { ok: true };
  });

  // ======================= recording (staff) and claiming (members) =======================

  const rowView = (e: any, me: { uid: string; approveBranches: Set<string> }) => ({
    id: e.id, code: e.code, kind: e.kind, date: e.date, amount: Number(e.amount), category: e.category_name, categoryId: e.category_id, projectId: e.project_id, project: e.project_name ?? null, branchId: e.branch_id, branch: e.branch_name, payee: e.payee,
    method: e.method, methodLabel: METHOD_LABEL[e.method], reference: e.reference, note: e.note, noReceiptReason: e.no_receipt_reason, status: e.status, autoApproved: e.auto_approved, recordedBy: e.recorded_by_name, recordedAt: e.created_at,
    firstApprover: e.first_approver_name, approver: e.approver_name, approvedAt: e.approved_at, decisionNote: e.decision_note, overridden: !!e.override_reason, overrideReason: e.override_reason, voidedBy: e.voided_by_name, voidReason: e.void_reason, voidedAt: e.voided_at,
    paid: !!e.paid_at, paidAt: e.paid_at, paidBy: e.paid_by_name, paidReference: e.paid_reference, files: Number(e.files ?? 0),
    mayApprove: ['submitted', 'awaiting_second'].includes(e.status) && me.approveBranches.has(e.branch_id) && e.recorded_by !== me.uid && !(e.status === 'awaiting_second' && e.first_approver === me.uid),
  });

  const SELECT = `SELECT e.*, b.name AS branch_name, p.name AS project_name, (SELECT count(*)::int FROM expense_files f WHERE f.expense_id=e.id) AS files FROM expenses e JOIN branches b ON b.id=e.branch_id LEFT JOIN projects p ON p.id=e.project_id`;

  async function newCode() {
    for (let i = 0; i < 20; i++) {
      const code = `EX-${randomBytes(3).toString('hex').toUpperCase()}`;
      if (!(await ctx.db.query<any>(`SELECT 1 FROM expenses WHERE code=$1`, [code])).length) return code;
    }
    throw new HttpError(500, 'Could not make a code', 'internal');
  }

  function readFiles(raw: unknown) {
    const list = Array.isArray(raw) ? raw : [];
    if (list.length > MAX_FILES) throw new HttpError(400, `You can attach up to ${MAX_FILES} receipts`, 'too_many_files');
    return list.map((f: any) => {
      const mime = String(f?.mime ?? '');
      if (!FILE_TYPES.has(mime)) throw new HttpError(400, 'Receipts must be a photo (JPEG, PNG or WebP) or a PDF', 'bad_file');
      const data = String(f?.data ?? '').replace(/^data:[^,]*,/, '');
      const size = Math.floor((data.length * 3) / 4);
      if (!data || size > MAX_FILE_BYTES) throw new HttpError(400, 'A receipt can be at most 1.2 MB. Photos are shrunk automatically: try a smaller picture.', 'file_too_big');
      return { name: cap(f?.name, 80) || 'receipt', mime, size, data };
    });
  }

  async function create(req: FastifyRequest, kind: 'expense' | 'claim') {
    const uid = req.session!.uid;
    const b = (req.body ?? {}) as any;
    const perm: Permission = kind === 'claim' ? 'expenses.claim' : 'expenses.record';
    const g = await grantsFor(ctx, req, perm);
    const branchId = String(b.branchId ?? (g.branchIds.length === 1 ? g.branchIds[0] : ''));
    if (!g.branchIds.includes(branchId)) throw new HttpError(404, 'not found', 'not_found');
    if (!isDate(b.date)) throw new HttpError(400, 'Choose the date it was spent', 'bad_date');
    const t = today();
    if (b.date > t || b.date < `${Number(t.slice(0, 4)) - 1}${t.slice(4)}`) throw new HttpError(400, 'The date must be within the last year and not in the future', 'bad_date');
    let amount: number;
    try { amount = toCents(b.amount); } catch { throw new HttpError(400, 'Enter a valid amount', 'bad_amount'); }
    if (!(amount > 0) || amount > MAX_AMOUNT) throw new HttpError(400, 'Enter an amount between KES 1 and KES 1,000,000', 'bad_amount');
    const cat = (await categoriesOf(g.orgId)).find((c) => c.id === String(b.categoryId ?? '') && c.active);
    if (!cat) throw new HttpError(400, 'Choose a category', 'bad_category');
    let projectId: string | null = null;
    if (b.projectId) {
      const p = (await ctx.db.query<any>(`SELECT id, branch_id FROM projects WHERE id=$1 AND org_id=$2`, [String(b.projectId), g.orgId]))[0];
      if (!p || p.branch_id !== branchId) throw new HttpError(400, 'Choose a project of this branch', 'bad_project');
      projectId = p.id;
    }
    const payee = cap(b.payee, 80);
    if (!payee) throw new HttpError(400, kind === 'claim' ? 'Say what you spent it on' : 'Say who was paid', 'bad_content');
    const method = String(b.method ?? (kind === 'claim' ? 'other' : ''));
    if (!(METHODS as readonly string[]).includes(method)) throw new HttpError(400, 'Choose how it was paid', 'bad_method');
    const files = readFiles(b.files);
    const settings = await settingsOf(g.orgId);
    const noReason = cap(b.noReceiptReason, 200);
    if (amount > settings.receipt_required_above && files.length === 0 && !noReason) {
      throw new HttpError(400, `Attach a receipt for anything above ${kes(settings.receipt_required_above)}, or say why there is none`, 'receipt_required');
    }
    // A restricted project's fund cannot be overspent, unless the owner overrides with a reason (L242).
    let overrideBy: string | null = null;
    let overrideReason: string | null = null;
    if (projectId) {
      const proj = (await ctx.db.query<any>(`SELECT restricted FROM projects WHERE id=$1`, [projectId]))[0];
      if (proj.restricted) {
        const f = await fund(projectId);
        if (amount > f.available) {
          const reason = cap(b.overrideReason, 200);
          const mayOverride = (await branchesFor(ctx.db, uid, 'expenses.settings')).some((r) => r.orgId === g.orgId && r.branchId === branchId);
          if (!(mayOverride && reason.length >= 10)) throw new HttpError(409, `This project's restricted fund has ${kes(Math.max(0, f.available))} left, which is less than ${kes(amount)}.${mayOverride ? ' As the owner you can go ahead by giving a reason.' : ' Ask the owner if it must go ahead.'}`, 'fund_short');
          overrideBy = uid; overrideReason = reason;
        }
      }
    }
    const id = ctx.newId('exp');
    const auto = kind === 'expense' && settings.approval_mode === 'above_limit' && amount <= settings.approval_limit;
    await ctx.db.query(
      `INSERT INTO expenses (id, org_id, branch_id, code, kind, date, amount, category_id, category_name, project_id, payee, method, reference, note, no_receipt_reason, status, auto_approved, recorded_by, recorded_by_name, approver_name, approved_at, override_by, override_reason, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$24)`,
      [id, g.orgId, branchId, await newCode(), kind, b.date, amount, cat.id, cat.name, projectId, payee, method, cap(b.reference, 60) || null, cap(b.note, 400) || null, noReason || null, auto ? 'approved' : 'submitted', auto, uid, req.session!.name, auto ? 'Approved automatically (under the limit)' : null, auto ? nowIso() : null, overrideBy, overrideReason, nowIso()],
    );
    for (const f of files) await ctx.db.query(`INSERT INTO expense_files (id, expense_id, org_id, name, mime, size, data, uploaded_by, uploaded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [ctx.newId('exf'), id, g.orgId, f.name, f.mime, f.size, f.data, uid, nowIso()]);
    const e = (await ctx.db.query<any>(`SELECT * FROM expenses WHERE id=$1`, [id]))[0];
    await ctx.ledger.audit({ orgId: g.orgId, branchId, actor: uid, action: kind === 'claim' ? 'expense.claimed' : 'expense.recorded', entity: 'expense', entityId: id, summary: `${kind === 'claim' ? 'Claimed' : 'Recorded'} ${kes(amount)} for ${cat.name.toLowerCase()} (${e.code})${auto ? ', approved automatically under the limit' : ''}${overrideReason ? ', restricted fund overridden' : ''}`, reason: overrideReason ?? undefined, meta: { receipts: files.length } });
    if (auto) await budgetAlerts(e);
    else {
      for (const u of await staffWith(ctx, g.orgId, branchId, 'expenses.approve')) {
        if (u.id === uid) continue;
        await addNotification(ctx, { orgId: g.orgId, userId: u.id, kind: 'announcement', title: kind === 'claim' ? 'An expense claim needs approval' : 'An expense needs approval', body: `${req.session!.name} ${kind === 'claim' ? 'claimed' : 'recorded'} ${kes(amount)} for ${cat.name.toLowerCase()} (${payee}). Open Expenses to approve it.`, link: `staff:expenses?open=${id}`, audience: 'staff' });
      }
    }
    return { id, code: e.code, status: e.status, autoApproved: auto };
  }

  app.post('/expenses', auth, async (req) => create(req, 'expense'));
  app.post('/me/claims', auth, async (req) => create(req, 'claim'));

  app.get('/me/claims/setup', auth, async (req) => {
    const rows = await branchesFor(ctx.db, req.session!.uid, 'expenses.claim');
    if (!rows.length) return { allowed: false };
    const orgId = rows[0].orgId;
    const ids = rows.filter((r) => r.orgId === orgId).map((r) => r.branchId);
    const settings = await settingsOf(orgId);
    const branches = await ctx.db.query<any>(`SELECT id, name FROM branches WHERE id = ANY($1::text[]) ORDER BY name`, [ids]);
    const projects = await ctx.db.query<any>(`SELECT id, branch_id, name FROM projects WHERE org_id=$1 AND branch_id = ANY($2::text[]) AND status='open' ORDER BY created_at`, [orgId, ids]);
    return { allowed: true, branches: branches.map((b) => ({ id: b.id, name: b.name })), categories: (await categoriesOf(orgId)).filter((c) => c.active).map((c) => ({ id: c.id, name: c.name })), projects: projects.map((p) => ({ id: p.id, branchId: p.branch_id, name: p.name })), methods: METHODS.map((m) => ({ key: m, label: METHOD_LABEL[m] })), receiptRequiredAbove: settings.receipt_required_above };
  });

  app.get('/me/claims', auth, async (req) => {
    const rows = await ctx.db.query<any>(`${SELECT} WHERE e.recorded_by=$1 AND e.kind='claim' ORDER BY e.created_at DESC LIMIT 100`, [req.session!.uid]);
    return { claims: rows.map((e) => rowView(e, { uid: req.session!.uid, approveBranches: new Set() })) };
  });

  // ======================= the list, detail and receipts =======================

  app.get('/expenses', auth, async (req) => {
    const sc = await scopeOf(req, ['expenses.view', 'expenses.record', 'expenses.approve']);
    const q = req.query as any;
    const params: unknown[] = [sc.orgId, sc.all];
    let where = `e.org_id=$1 AND e.branch_id = ANY($2::text[])`;
    const add = (sql: string, v: unknown) => { params.push(v); where += ` AND ${sql.replace('?', `$${params.length}`)}`; };
    if (q.branchId) add('e.branch_id = ?', String(q.branchId));
    if (q.status) add('e.status = ANY(?::text[])', String(q.status).split(','));
    if (q.kind) add('e.kind = ?', String(q.kind));
    if (q.category) add('e.category_id = ?', String(q.category));
    if (q.project) add('e.project_id = ?', String(q.project));
    if (isDate(q.from)) add('e.date >= ?', q.from);
    if (isDate(q.to)) add('e.date <= ?', q.to);
    if (q.unpaid) where += ` AND e.kind='claim' AND e.status='approved' AND e.paid_at IS NULL`;
    const term = String(q.q ?? '').trim().slice(0, 60);
    if (term) add(`(e.payee ILIKE ? ESCAPE '!' OR e.code ILIKE ? ESCAPE '!' OR e.reference ILIKE ? ESCAPE '!' OR e.recorded_by_name ILIKE ? ESCAPE '!' OR e.note ILIKE ? ESCAPE '!')`.replace(/\?/g, `$${params.length + 1}`), `%${term.replace(/[!%_]/g, (c) => `!${c}`)}%`);
    const rows = await ctx.db.query<any>(`${SELECT} WHERE ${where} ORDER BY e.date DESC, e.created_at DESC LIMIT 500`, params);
    const me = { uid: req.session!.uid, approveBranches: sc.per.get('expenses.approve')! };
    const view = rows.map((e) => rowView(e, me));
    if (q.csv) return csv(view.map((v) => ({ Code: v.code, Date: v.date, Kind: v.kind, Branch: v.branch, Category: v.category, Project: v.project ?? '', 'Paid to': v.payee, Amount: v.amount / 100, How: v.methodLabel, Reference: v.reference ?? '', Status: v.status, 'Recorded by': v.recordedBy, 'Approved by': v.autoApproved ? 'Automatic' : [v.firstApprover, v.approver].filter(Boolean).join(' and '), Receipts: v.files, 'No receipt because': v.noReceiptReason ?? '', Note: v.note ?? '' })));
    const live = view.filter((v) => v.status === 'approved');
    return {
      expenses: view,
      summary: { toApprove: view.filter((v) => v.mayApprove).length, approvedTotal: live.reduce((s, v) => s + v.amount, 0), claimsToPay: view.filter((v) => v.kind === 'claim' && v.status === 'approved' && !v.paid).length },
    };
  });

  async function load(req: FastifyRequest, id: string, perms: Permission[]) {
    const e = (await ctx.db.query<any>(`${SELECT} WHERE e.id=$1`, [id]))[0];
    if (!e) throw new HttpError(404, 'not found', 'not_found');
    for (const p of perms) if (await inStaffScope(ctx, req, p, e.org_id, e.branch_id)) return e;
    throw new HttpError(404, 'not found', 'not_found');
  }

  app.get('/expenses/:id', auth, async (req) => {
    const e = await load(req, (req.params as any).id, ['expenses.view', 'expenses.record', 'expenses.approve']);
    const files = await ctx.db.query<any>(`SELECT id, name, mime, size, uploaded_at FROM expense_files WHERE expense_id=$1 ORDER BY uploaded_at`, [e.id]);
    const approve = new Set((await branchesFor(ctx.db, req.session!.uid, 'expenses.approve')).filter((r) => r.orgId === e.org_id).map((r) => r.branchId));
    const settings = await settingsOf(e.org_id);
    const f = e.project_id ? await ctx.db.query<any>(`SELECT restricted FROM projects WHERE id=$1`, [e.project_id]) : [];
    return { ...rowView(e, { uid: req.session!.uid, approveBranches: approve }), fileList: files.map((x) => ({ id: x.id, name: x.name, mime: x.mime, size: x.size, at: x.uploaded_at })), needsTwo: settings.two_approver_limit !== null && Number(e.amount) > settings.two_approver_limit, restrictedFund: !!f[0]?.restricted };
  });

  app.get('/expenses/:id/files/:fid', auth, async (req, reply) => {
    const e = (await ctx.db.query<any>(`SELECT * FROM expenses WHERE id=$1`, [(req.params as any).id]))[0];
    if (!e) throw new HttpError(404, 'not found', 'not_found');
    let ok = e.recorded_by === req.session!.uid;
    for (const p of ['expenses.view', 'expenses.record', 'expenses.approve'] as Permission[]) if (!ok && (await inStaffScope(ctx, req, p, e.org_id, e.branch_id))) ok = true;
    if (!ok) throw new HttpError(404, 'not found', 'not_found');
    const f = (await ctx.db.query<any>(`SELECT * FROM expense_files WHERE id=$1 AND expense_id=$2`, [(req.params as any).fid, e.id]))[0];
    if (!f) throw new HttpError(404, 'not found', 'not_found');
    return reply.header('content-type', f.mime).header('content-disposition', `inline; filename="${String(f.name).replace(/[^\w.\- ]/g, '_')}"`).header('cache-control', 'private, max-age=60').send(Buffer.from(f.data, 'base64'));
  });

  app.post('/expenses/:id/files', auth, async (req) => {
    const e = (await ctx.db.query<any>(`SELECT * FROM expenses WHERE id=$1`, [(req.params as any).id]))[0];
    if (!e || e.recorded_by !== req.session!.uid) throw new HttpError(404, 'not found', 'not_found');
    if (!['submitted', 'awaiting_second'].includes(e.status)) throw new HttpError(409, 'Receipts can be added until it is approved', 'locked');
    const files = readFiles([req.body]);
    const have = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM expense_files WHERE expense_id=$1`, [e.id]))[0].n);
    if (have + files.length > MAX_FILES) throw new HttpError(400, `You can attach up to ${MAX_FILES} receipts`, 'too_many_files');
    await ctx.db.query(`INSERT INTO expense_files (id, expense_id, org_id, name, mime, size, data, uploaded_by, uploaded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [ctx.newId('exf'), e.id, e.org_id, files[0].name, files[0].mime, files[0].size, files[0].data, req.session!.uid, nowIso()]);
    return { ok: true };
  });

  // ======================= approving, voiding and paying =======================

  app.post('/expenses/:id/decide', auth, async (req) => {
    const e = await load(req, (req.params as any).id, ['expenses.approve']);
    const uid = req.session!.uid;
    const b = (req.body ?? {}) as any;
    if (!['submitted', 'awaiting_second'].includes(e.status)) throw new HttpError(409, 'This was already decided', 'already_decided');
    if (e.recorded_by === uid) throw new HttpError(403, e.kind === 'claim' ? 'Someone else must approve your claim' : 'Someone else must approve what you recorded', 'same_person');
    const note = cap(b.note, 300);
    if (!b.approve) {
      if (!note) throw new HttpError(400, 'Say why you are rejecting it', 'bad_content');
      await ctx.db.query(`UPDATE expenses SET status='rejected', approver=$2, approver_name=$3, approved_at=$4, decision_note=$5, updated_at=$4 WHERE id=$1`, [e.id, uid, req.session!.name, nowIso(), note]);
      await ctx.ledger.audit({ orgId: e.org_id, branchId: e.branch_id, actor: uid, action: 'expense.rejected', entity: 'expense', entityId: e.id, summary: `Rejected ${kes(Number(e.amount))} for ${e.category_name.toLowerCase()} (${e.code})`, reason: note });
      await addNotification(ctx, { orgId: e.org_id, userId: e.recorded_by, kind: 'announcement', title: e.kind === 'claim' ? 'Your claim was not approved' : 'An expense was not approved', body: `${kes(Number(e.amount))} for ${e.category_name.toLowerCase()} (${e.code}): ${note}`, link: e.kind === 'claim' ? 'staff:my-claims' : `staff:expenses?open=${e.id}`, audience: 'staff' });
      return { id: e.id, status: 'rejected' };
    }
    let overrideBy = e.override_by as string | null;
    let overrideReason = e.override_reason as string | null;
    if (e.project_id) {
      const proj = (await ctx.db.query<any>(`SELECT restricted FROM projects WHERE id=$1`, [e.project_id]))[0];
      if (proj.restricted && !overrideReason) {
        const f = await fund(e.project_id, e.id);
        if (Number(e.amount) > f.available) {
          const reason = cap(b.overrideReason, 200);
          const mayOverride = (await branchesFor(ctx.db, uid, 'expenses.settings')).some((r) => r.orgId === e.org_id && r.branchId === e.branch_id);
          if (!(mayOverride && reason.length >= 10)) throw new HttpError(409, `The restricted fund for this project has ${kes(Math.max(0, f.available))} left, less than ${kes(Number(e.amount))}.${mayOverride ? ' As the owner you can approve it by giving a reason.' : ' Ask the owner.'}`, 'fund_short');
          overrideBy = uid; overrideReason = reason;
        }
      }
    }
    const settings = await settingsOf(e.org_id);
    const needsTwo = settings.two_approver_limit !== null && Number(e.amount) > settings.two_approver_limit;
    if (needsTwo && e.status === 'submitted') {
      await ctx.db.query(`UPDATE expenses SET status='awaiting_second', first_approver=$2, first_approver_name=$3, first_approved_at=$4, override_by=$5, override_reason=$6, updated_at=$4 WHERE id=$1`, [e.id, uid, req.session!.name, nowIso(), overrideBy, overrideReason]);
      await ctx.ledger.audit({ orgId: e.org_id, branchId: e.branch_id, actor: uid, action: 'expense.first_approval', entity: 'expense', entityId: e.id, summary: `First approval of ${kes(Number(e.amount))} for ${e.category_name.toLowerCase()} (${e.code}); a second person must approve` });
      for (const u of await staffWith(ctx, e.org_id, e.branch_id, 'expenses.approve')) {
        if (u.id === uid || u.id === e.recorded_by) continue;
        await addNotification(ctx, { orgId: e.org_id, userId: u.id, kind: 'announcement', title: 'A second approval is needed', body: `${kes(Number(e.amount))} for ${e.category_name.toLowerCase()} (${e.code}) is above ${kes(settings.two_approver_limit!)} and needs a second approver.`, link: `staff:expenses?open=${e.id}`, audience: 'staff' });
      }
      return { id: e.id, status: 'awaiting_second' };
    }
    if (needsTwo && e.first_approver === uid) throw new HttpError(403, 'A different person must give the second approval', 'same_person');
    await ctx.db.query(`UPDATE expenses SET status='approved', approver=$2, approver_name=$3, approved_at=$4, decision_note=$5, override_by=$6, override_reason=$7, updated_at=$4 WHERE id=$1`, [e.id, uid, req.session!.name, nowIso(), note || null, overrideBy, overrideReason]);
    await ctx.ledger.audit({ orgId: e.org_id, branchId: e.branch_id, actor: uid, action: 'expense.approved', entity: 'expense', entityId: e.id, summary: `Approved ${kes(Number(e.amount))} for ${e.category_name.toLowerCase()} (${e.code})${overrideReason ? ', restricted fund overridden' : ''}`, reason: overrideReason ?? undefined });
    await addNotification(ctx, { orgId: e.org_id, userId: e.recorded_by, kind: 'announcement', title: e.kind === 'claim' ? 'Your claim was approved' : 'An expense was approved', body: `${kes(Number(e.amount))} for ${e.category_name.toLowerCase()} (${e.code}) was approved.${e.kind === 'claim' ? ' You will be told when it is paid.' : ''}`, link: e.kind === 'claim' ? 'staff:my-claims' : `staff:expenses?open=${e.id}`, audience: 'staff' });
    await budgetAlerts({ ...e, status: 'approved' });
    return { id: e.id, status: 'approved' };
  });

  /** A mistake is corrected by voiding it, never by editing it (L238). */
  app.post('/expenses/:id/void', auth, async (req) => {
    const e = (await ctx.db.query<any>(`SELECT * FROM expenses WHERE id=$1`, [(req.params as any).id]))[0];
    if (!e) throw new HttpError(404, 'not found', 'not_found');
    const uid = req.session!.uid;
    const reason = cap((req.body as any)?.reason, 200);
    if (reason.length < 5) throw new HttpError(400, 'Say why you are voiding it', 'bad_content');
    if (e.status === 'voided' || e.status === 'rejected') throw new HttpError(409, 'This is already closed', 'wrong_state');
    const mayApprove = await inStaffScope(ctx, req, 'expenses.approve', e.org_id, e.branch_id);
    const withdrawing = e.recorded_by === uid && ['submitted', 'awaiting_second'].includes(e.status);
    if (!mayApprove && !withdrawing) throw new HttpError(404, 'not found', 'not_found');
    if (e.kind === 'claim' && e.paid_at) throw new HttpError(409, 'This claim was already paid. Record the correction as a new expense.', 'paid');
    await ctx.db.query(`UPDATE expenses SET status='voided', voided_by=$2, voided_by_name=$3, voided_at=$4, void_reason=$5, updated_at=$4 WHERE id=$1`, [e.id, uid, req.session!.name, nowIso(), reason]);
    await ctx.ledger.audit({ orgId: e.org_id, branchId: e.branch_id, actor: uid, action: 'expense.voided', entity: 'expense', entityId: e.id, summary: `Voided ${kes(Number(e.amount))} for ${e.category_name.toLowerCase()} (${e.code})`, reason });
    if (e.recorded_by !== uid) await addNotification(ctx, { orgId: e.org_id, userId: e.recorded_by, kind: 'announcement', title: 'An expense was voided', body: `${kes(Number(e.amount))} for ${e.category_name.toLowerCase()} (${e.code}) was voided: ${reason}`, link: e.kind === 'claim' ? 'staff:my-claims' : `staff:expenses?open=${e.id}`, audience: 'staff' });
    return { id: e.id, status: 'voided' };
  });

  /** An approved claim is marked paid once the church has reimbursed it elsewhere. Nothing moves through ChurchOS (L240). */
  app.post('/expenses/:id/paid', auth, async (req) => {
    const e = await load(req, (req.params as any).id, ['expenses.record']);
    if (e.kind !== 'claim') throw new HttpError(409, 'Only a claim is marked paid', 'wrong_state');
    if (e.status !== 'approved') throw new HttpError(409, 'A claim can be marked paid once it is approved', 'wrong_state');
    if (e.paid_at) throw new HttpError(409, 'This claim was already marked paid', 'already_paid');
    const ref = cap((req.body as any)?.reference, 60);
    if (!ref) throw new HttpError(400, 'Enter the payment reference (for example the M-Pesa code)', 'bad_content');
    await ctx.db.query(`UPDATE expenses SET paid_at=$2, paid_by=$3, paid_by_name=$4, paid_reference=$5, updated_at=$2 WHERE id=$1`, [e.id, nowIso(), req.session!.uid, req.session!.name, ref]);
    await ctx.ledger.audit({ orgId: e.org_id, branchId: e.branch_id, actor: req.session!.uid, action: 'expense.claim_paid', entity: 'expense', entityId: e.id, summary: `Marked the claim ${e.code} (${kes(Number(e.amount))}) as paid, reference ${ref}` });
    const u = (await ctx.db.query<any>(`SELECT phone FROM users WHERE id=$1`, [e.recorded_by]))[0];
    if (u) await notify(ctx, { orgId: e.org_id, branchId: e.branch_id, phone: u.phone, kind: 'receipt', title: 'Your claim was paid', body: `Your claim of ${kes(Number(e.amount))} (${e.code}) was paid. Reference ${ref}.`, idemKey: `claimpaid:${e.id}`, sms: true, link: 'staff:my-claims', audience: 'staff' });
    return { id: e.id, paid: true };
  });

  // ======================= reports (L243) =======================

  app.get('/expenses/summary', auth, async (req) => {
    const sc = await scopeOf(req, ['expenses.view']);
    const q = req.query as any;
    const branchIds = q.branchId ? [String(q.branchId)] : sc.all;
    if (q.branchId && !sc.all.includes(String(q.branchId))) throw new HttpError(404, 'not found', 'not_found');
    const year = Number(today().slice(0, 4));
    const from = isDate(q.from) ? q.from : `${year}-01-01`;
    const to = isDate(q.to) ? q.to : `${year}-12-31`;
    const rows = await ctx.db.query<any>(`SELECT e.*, b.name AS branch_name, p.name AS project_name, (SELECT count(*)::int FROM expense_files f WHERE f.expense_id=e.id) AS files FROM expenses e JOIN branches b ON b.id=e.branch_id LEFT JOIN projects p ON p.id=e.project_id WHERE e.org_id=$1 AND e.branch_id = ANY($2::text[]) AND e.status='approved' AND e.date >= $3 AND e.date <= $4`, [sc.orgId, branchIds, from, to]);
    const group = (key: (r: any) => string) => {
      const m = new Map<string, { amount: number; count: number }>();
      for (const r of rows) { const k = key(r); const c = m.get(k) ?? { amount: 0, count: 0 }; c.amount += Number(r.amount); c.count++; m.set(k, c); }
      return [...m.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.amount - a.amount);
    };
    const total = rows.reduce((s, r) => s + Number(r.amount), 0);
    const withReceipt = rows.filter((r) => r.files > 0);
    const fromTs = new Date(`${from}T00:00:00+03:00`).toISOString();
    const toTs = new Date(new Date(`${to}T00:00:00+03:00`).getTime() + 86400_000).toISOString();
    const giving = Number((await ctx.db.query<any>(`SELECT COALESCE(SUM(net),0) AS n FROM payments WHERE branch_id = ANY($1::text[]) AND stage IN ('pending','available','paid_out') AND received_at >= $2 AND received_at < $3`, [branchIds, fromTs, toTs]))[0].n);
    const cash = Number((await ctx.db.query<any>(`SELECT COALESCE(SUM(amount - fee),0) AS n FROM cash_entries WHERE branch_id = ANY($1::text[]) AND status='approved' AND approved_at >= $2 AND approved_at < $3`, [branchIds, fromTs, toTs]))[0].n);
    const byMonth = group((r) => String(r.date).slice(0, 7)).sort((a, b) => a.name.localeCompare(b.name));
    return {
      from, to, totals: { count: rows.length, amount: total, withReceipt: withReceipt.length, receiptShare: rows.length ? Math.round((withReceipt.length / rows.length) * 100) : null, receiptAmountShare: total ? Math.round((withReceipt.reduce((s, r) => s + Number(r.amount), 0) / total) * 100) : null },
      byCategory: group((r) => r.category_name), byProject: group((r) => r.project_name ?? 'No project'), byBranch: group((r) => r.branch_name), byMonth,
      income: { giving, cash, total: giving + cash }, balance: giving + cash - total,
    };
  });
}
