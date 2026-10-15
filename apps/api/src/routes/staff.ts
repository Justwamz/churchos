import type { FastifyInstance } from 'fastify';
import { computeFee, toCents } from '@churchos/shared';
import { branchesFor, loadGrants, PERMISSIONS, type Permission } from '../auth';
import { HttpError, inList, requireSession, staffScope, startOfDayEat, bearer, type Ctx } from '../ctx';
import { verifyToken } from '../auth';
import { csv, maskPhoneSql } from './helpers';
import { emailRequired } from '../wallets';
import { nextMemberNumber } from '../members';
import { diff, maskedSnapshot, PROJECT_SPECS, recordVersion } from '../audit';

const DONE = `('pending','available','paid_out')`;

export function staffRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };

  /** Who am I, and where can I do what. Drives navigation in the staff dashboard. */
  app.get('/staff/me', auth, async (req) => {
    const s = req.session!;
    const grants = await loadGrants(ctx.db, s.uid);
    const out = [];
    for (const g of grants) {
      const org = (await ctx.db.query<any>(`SELECT id, name, fee_bearer FROM organisations WHERE id=$1`, [g.orgId]))[0];
      const branches = await ctx.db.query<any>(`SELECT id, code, name, region FROM branches WHERE id IN (${inList(1, g.branchIds.length || 1)}) ORDER BY name`, g.branchIds.length ? g.branchIds : ['-']);
      out.push({ org, permissions: [...g.permissions], branches });
    }
    const prof = (await ctx.db.query<any>(`SELECT email, email_verified FROM users WHERE id=$1`, [s.uid]))[0];
    const need = await emailRequired(ctx, s.uid);
    return { user: { id: s.uid, name: s.name, phone: s.phone, email: prof?.email ?? null }, emailRequired: need && !s.isAdmin, emailVerified: !!prof?.email_verified, orgs: out };
  });

  // ---------- live dashboard (L65) ----------

  app.get('/dashboard', auth, async (req) => {
    const branch = (req.query as any).branch as string | undefined;
    const scope = await staffScope(ctx, req, 'collections.view', branch);
    const now = ctx.clock.now();
    const dayStart = startOfDayEat(now);
    const weekStart = new Date(now.getTime() - 7 * 86400_000).toISOString();
    const ids = scope.branchIds;
    return ctx.db.asOrg(scope.orgId, async (q) => {
      const where = `branch_id IN (${inList(1, ids.length)}) AND stage IN ${DONE}`;
      const total = async (from: string) =>
        (await q.query<any>(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_paid),0) AS gross, COALESCE(SUM(net),0) AS net FROM payments WHERE ${where} AND received_at >= $${ids.length + 1}`, [...ids, from]))[0];
      const today = await total(dayStart);
      const week = await total(weekStart);
      const byMethod = await q.query<any>(
        `SELECT method, COUNT(*) AS n, SUM(amount_paid) AS gross FROM payments WHERE ${where} AND received_at >= $${ids.length + 1} GROUP BY method ORDER BY gross DESC`,
        [...ids, dayStart],
      );
      const byPurpose = await q.query<any>(
        `SELECT purpose, COUNT(*) AS n, SUM(amount_paid) AS gross FROM payments WHERE ${where} AND received_at >= $${ids.length + 1} GROUP BY purpose ORDER BY gross DESC`,
        [...ids, dayStart],
      );
      const cashToday = (
        await q.query<any>(
          `SELECT COALESCE(SUM(amount),0) AS gross FROM cash_entries WHERE branch_id IN (${inList(1, ids.length)}) AND status='approved' AND approved_at >= $${ids.length + 1}`,
          [...ids, dayStart],
        )
      )[0];
      const recent = await q.query<any>(
        `SELECT p.id, p.method, p.purpose, p.amount_paid, p.net, (p.platform_fee + p.psp_cost) AS fee, p.stage, p.received_at, ${maskPhoneSql('p.payer_phone')} AS payer_phone, b.name AS branch
           FROM payments p JOIN branches b ON b.id = p.branch_id WHERE ${where.replace(/branch_id/, 'p.branch_id').replace('stage', 'p.stage')}
          ORDER BY p.received_at DESC LIMIT 20`,
        ids,
      );
      const branches = [];
      for (const id of ids) {
        const b = (await q.query<any>(`SELECT id, code, name, region, payout_paused FROM branches WHERE id=$1`, [id]))[0];
        const t = (await q.query<any>(`SELECT COALESCE(SUM(amount_paid),0) AS gross, COUNT(*) AS n FROM payments WHERE branch_id=$1 AND stage IN ${DONE} AND received_at >= $2`, [id, dayStart]))[0];
        branches.push({
          ...b,
          todayGross: t.gross,
          todayCount: t.n,
          pending: await ctx.ledger.balance('pending', id, q),
          available: await ctx.ledger.balance('available', id, q),
          receivable: await ctx.ledger.balance('receivable', id, q),
        });
      }
      return { scope: { orgId: scope.orgId, branchIds: ids }, today, week, byMethod, byPurpose, cashToday: cashToday.gross, recent, branches };
    });
  });

  /** Server-sent events for real-time collections. EventSource cannot set headers, so the token travels in the query string. */
  app.get('/stream/collections', async (req, reply) => {
    const session = verifyToken(bearer(req));
    if (!session) throw new HttpError(401, 'sign in required', 'unauthenticated');
    req.session = session;
    const allowed = new Set((await branchesFor(ctx.db, session.uid, 'collections.view')).map((r) => r.branchId));
    if (allowed.size === 0) throw new HttpError(403, 'missing permission collections.view', 'forbidden');
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    reply.raw.write('retry: 2000\n\n');
    const onPayment = async (e: any) => {
      if (!e.branchId || !allowed.has(e.branchId)) return;
      const p = (
        await ctx.db.query<any>(
          `SELECT p.id, p.method, p.purpose, p.amount_paid, p.net, (p.platform_fee + p.psp_cost) AS fee, p.stage, p.received_at, ${maskPhoneSql('p.payer_phone')} AS payer_phone, b.name AS branch, p.branch_id
             FROM payments p JOIN branches b ON b.id = p.branch_id WHERE p.id=$1`,
          [e.paymentId],
        )
      )[0];
      if (p) reply.raw.write(`event: payment\ndata: ${JSON.stringify(p)}\n\n`);
    };
    ctx.events.on('payment', onPayment);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 20000);
    req.raw.on('close', () => {
      ctx.events.off('payment', onPayment);
      clearInterval(ping);
    });
    return reply;
  });

  // ---------- collections report (L65) ----------

  app.get('/collections', auth, async (req, reply) => {
    const q = req.query as any;
    const scope = await staffScope(ctx, req, 'collections.view', q.branch);
    const ids = scope.branchIds;
    const params: unknown[] = [...ids];
    let where = `p.branch_id IN (${inList(1, ids.length)}) AND p.stage IN ('pending','available','paid_out','reversed')`;
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where += ` AND ${sql.replace('?', `$${params.length}`)}`;
    };
    if (q.from) add('p.received_at >= ?', new Date(q.from).toISOString());
    if (q.to) add('p.received_at <= ?', new Date(new Date(q.to).getTime() + 86400_000 - 1).toISOString());
    if (q.purpose) add('p.purpose = ?', String(q.purpose).toUpperCase());
    if (q.method) add('p.method = ?', String(q.method).toLowerCase());
    const rows = await ctx.db.asOrg(scope.orgId, async (db) => {
      const pay = await db.query<any>(
        `SELECT p.id, p.received_at AS date, b.code AS branch, p.method, p.purpose, ${maskPhoneSql('p.payer_phone')} AS phone, m.full_name AS member, m.member_number,
                p.amount_paid AS gross, (p.platform_fee + p.psp_cost) AS fee, p.net, p.stage AS status, p.provider_tx_id AS receipt
           FROM payments p JOIN branches b ON b.id = p.branch_id LEFT JOIN memberships m ON m.id = p.member_id
          WHERE ${where} ORDER BY p.received_at DESC LIMIT 1000`,
        params,
      );
      const cashParams: unknown[] = [...ids];
      let cashWhere = `c.branch_id IN (${inList(1, ids.length)}) AND c.status='approved'`;
      if (q.from) { cashParams.push(new Date(q.from).toISOString()); cashWhere += ` AND c.approved_at >= $${cashParams.length}`; }
      if (q.to) { cashParams.push(new Date(new Date(q.to).getTime() + 86400_000 - 1).toISOString()); cashWhere += ` AND c.approved_at <= $${cashParams.length}`; }
      const cash =
        q.method && q.method !== 'cash'
          ? []
          : await db.query<any>(
              `SELECT c.id, c.approved_at AS date, b.code AS branch, 'cash' AS method, c.purpose, NULL AS phone, NULL AS member, NULL AS member_number,
                      c.amount AS gross, c.fee, (c.amount - c.fee) AS net, 'recorded' AS status, c.id AS receipt
                 FROM cash_entries c JOIN branches b ON b.id = c.branch_id WHERE ${cashWhere} ORDER BY c.approved_at DESC`,
              cashParams,
            );
      return [...pay, ...cash].sort((a, b) => String(b.date).localeCompare(String(a.date)));
    });
    if (q.format === 'csv') {
      reply.header('content-type', 'text/csv').header('content-disposition', 'attachment; filename="collections.csv"');
      return csv(rows.map((r) => ({ ...r, gross: (r.gross / 100).toFixed(2), fee: (r.fee / 100).toFixed(2), net: (r.net / 100).toFixed(2) })));
    }
    const live = rows.filter((r) => r.status !== 'reversed');
    const sum = (key: string) => {
      const m = new Map<string, { gross: number; fee: number; net: number; n: number }>();
      for (const r of live) {
        const k = String(r[key] ?? '-');
        const cur = m.get(k) ?? { gross: 0, fee: 0, net: 0, n: 0 };
        cur.gross += r.gross; cur.fee += r.fee; cur.net += r.net; cur.n += 1;
        m.set(k, cur);
      }
      return [...m.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.gross - a.gross);
    };
    return {
      rows,
      totals: live.reduce((t, r) => ({ gross: t.gross + r.gross, fee: t.fee + r.fee, net: t.net + r.net, n: t.n + 1 }), { gross: 0, fee: 0, net: 0, n: 0 }),
      byMethod: sum('method'),
      byPurpose: sum('purpose'),
      byBranch: sum('branch'),
    };
  });

  // ---------- settlements (L65) ----------

  app.get('/settlements', auth, async (req) => {
    const scope = await staffScope(ctx, req, 'settlements.view', (req.query as any).branch);
    const ids = scope.branchIds;
    return ctx.db.asOrg(scope.orgId, async (db) => {
      const rows = await db.query<any>(
        `SELECT po.id, po.created_at, po.status, po.gross, po.netted, po.amount AS paid, b.code AS branch, b.name AS branch_name,
                (SELECT COUNT(*) FROM payments WHERE payout_id = po.id) AS payments
           FROM payouts po JOIN branches b ON b.id = po.branch_id WHERE po.branch_id IN (${inList(1, ids.length)}) ORDER BY po.created_at DESC LIMIT 200`,
        ids,
      );
      const balances = [];
      for (const id of ids) {
        const b = (await db.query<any>(`SELECT id, code, name FROM branches WHERE id=$1`, [id]))[0];
        balances.push({
          ...b,
          pending: await ctx.ledger.balance('pending', id, db),
          available: await ctx.ledger.balance('available', id, db),
          receivable: await ctx.ledger.balance('receivable', id, db),
        });
      }
      return { payouts: rows, balances };
    });
  });

  app.get('/settlements/:id', auth, async (req) => {
    const scope = await staffScope(ctx, req, 'settlements.view');
    return ctx.db.asOrg(scope.orgId, async (db) => {
      const po = (await db.query<any>(`SELECT * FROM payouts WHERE id=$1`, [(req.params as any).id]))[0];
      if (!po || !scope.branchIds.includes(po.branch_id)) throw new HttpError(404, 'settlement not found', 'not_found');
      const payments = await db.query<any>(
        `SELECT id, received_at, method, purpose, amount_paid AS gross, (platform_fee + psp_cost) AS fee, net FROM payments WHERE payout_id=$1 ORDER BY received_at`,
        [po.id],
      );
      return { payout: po, payments };
    });
  });

  // ---------- cash with dual sign-off (L36 to L38) ----------

  app.get('/cash', auth, async (req) => {
    const scope = await staffScope(ctx, req, 'cash.count', (req.query as any).branch);
    return ctx.db.asOrg(scope.orgId, (db) =>
      db.query<any>(
        `SELECT c.*, b.name AS branch_name, u1.name AS counted_by_name, u2.name AS approved_by_name
           FROM cash_entries c JOIN branches b ON b.id=c.branch_id LEFT JOIN users u1 ON u1.id=c.counted_by LEFT JOIN users u2 ON u2.id=c.approved_by
          WHERE c.branch_id IN (${inList(1, scope.branchIds.length)}) ORDER BY c.created_at DESC LIMIT 100`,
        scope.branchIds,
      ),
    );
  });

  app.post('/cash', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const scope = await staffScope(ctx, req, 'cash.count', b.branchId);
    if (!b.branchId) throw new HttpError(400, 'Choose a branch', 'bad_branch');
    let amount: number;
    try { amount = toCents(b.amount); } catch { throw new HttpError(400, 'Enter the counted amount', 'bad_amount'); }
    if (!(amount > 0)) throw new HttpError(400, 'The counted amount must be more than zero', 'bad_amount');
    const purpose = String(b.purpose ?? 'OFFERING').toUpperCase();
    const id = ctx.newId('cash');
    await ctx.db.query(
      `INSERT INTO cash_entries (id, org_id, branch_id, amount, purpose, note, status, counted_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,'counted',$7,$8)`,
      [id, scope.orgId, b.branchId, amount, purpose, b.note ?? null, req.session!.uid, ctx.clock.now().toISOString()],
    );
    await ctx.ledger.audit({ orgId: scope.orgId, branchId: b.branchId, actor: req.session!.uid, action: 'cash.count', entity: 'cash', entityId: id, summary: `Counted KES ${(amount / 100).toLocaleString('en-KE')} of cash for ${purpose.toLowerCase()}, waiting for a second person`, changes: [{ field: 'amount', label: 'Counted amount (cents)', before: null, after: amount }, { field: 'purpose', label: 'Purpose', before: null, after: purpose }], links: { cashId: id } });
    return { id, status: 'counted' };
  });

  /** Second person confirms the count (maker-checker, L35, L37). Approval charges the platform fee against the branch ledger (L36). */
  app.post('/cash/:id/signoff', auth, async (req) => {
    const id = (req.params as any).id;
    const approve = (req.body as any)?.approve !== false;
    const row = (await ctx.db.query<any>(`SELECT * FROM cash_entries WHERE id=$1`, [id]))[0];
    if (!row) throw new HttpError(404, 'cash entry not found', 'not_found');
    const scope = await staffScope(ctx, req, 'cash.approve', row.branch_id);
    if (scope.orgId !== row.org_id) throw new HttpError(403, 'no access', 'forbidden');
    if (row.status !== 'counted') throw new HttpError(409, 'This count has already been signed off', 'already_decided');
    if (row.counted_by === req.session!.uid) throw new HttpError(403, 'A second person must sign off the count', 'same_person');
    if (!approve) {
      await ctx.db.query(`UPDATE cash_entries SET status='rejected', approved_by=$2, approved_at=$3 WHERE id=$1`, [id, req.session!.uid, ctx.clock.now().toISOString()]);
      await ctx.ledger.audit({ orgId: row.org_id, branchId: row.branch_id, actor: req.session!.uid, action: 'cash.reject', entity: 'cash', entityId: id, summary: 'Rejected a cash count', reason: (req.body as any)?.reason ? String((req.body as any).reason).slice(0, 200) : null, links: { cashId: id }, meta: { counted: Number(row.amount) } });
      return { id, status: 'rejected' };
    }
    const org = (await ctx.db.query<any>(`SELECT fee_schedule FROM organisations WHERE id=$1`, [row.org_id]))[0];
    const fee = computeFee(org.fee_schedule, 'cash', Number(row.amount), 'church').totalFee;
    await ctx.db.tx(async (q) => {
      await q.query(`UPDATE cash_entries SET status='approved', approved_by=$2, approved_at=$3, fee=$4 WHERE id=$1`, [id, req.session!.uid, ctx.clock.now().toISOString(), fee]);
      await ctx.ledger.chargeCashFee(q, row.branch_id, id, fee);
    });
    await ctx.ledger.audit({ orgId: row.org_id, branchId: row.branch_id, actor: req.session!.uid, action: 'cash.approve', entity: 'cash', entityId: id, summary: `Signed off a cash count of KES ${(Number(row.amount) / 100).toLocaleString('en-KE')}, fee KES ${(fee / 100).toLocaleString('en-KE')} charged`, links: { cashId: id, ledgerEntry: `cashfee:${id}` }, meta: { amount: Number(row.amount), fee, countedBy: row.counted_by } });
    return { id, status: 'approved', fee };
  });

  // ---------- members, households, transfers (L25 to L31) ----------

  app.get('/transfers', auth, async (req) => {
    // Receiving branches decide, so show transfers whose destination the user manages.
    const rows = await branchesFor(ctx.db, req.session!.uid, 'transfers.approve');
    if (rows.length === 0) throw new HttpError(403, 'missing permission transfers.approve', 'forbidden');
    const ids = rows.map((r) => r.branchId);
    return ctx.db.query<any>(
      `SELECT t.*, m.full_name, m.member_number, fb.name AS from_name, tb.name AS to_name
         FROM transfers t JOIN memberships m ON m.id=t.membership_id JOIN branches fb ON fb.id=t.from_branch JOIN branches tb ON tb.id=t.to_branch
        WHERE t.to_branch IN (${inList(1, ids.length)}) ORDER BY t.created_at DESC LIMIT 100`,
      ids,
    );
  });

  app.post('/transfers/:id/decide', auth, async (req) => {
    const t = (await ctx.db.query<any>(`SELECT * FROM transfers WHERE id=$1`, [(req.params as any).id]))[0];
    if (!t) throw new HttpError(404, 'transfer not found', 'not_found');
    const rows = await branchesFor(ctx.db, req.session!.uid, 'transfers.approve');
    if (!rows.some((r) => r.branchId === t.to_branch)) throw new HttpError(403, 'Only the receiving branch can decide this transfer', 'forbidden');
    if (t.status !== 'requested') throw new HttpError(409, 'This transfer was already decided', 'already_decided');
    const approve = (req.body as any)?.approve !== false;
    const now = ctx.clock.now().toISOString();
    await ctx.db.tx(async (q) => {
      if (approve) await applyTransfer(ctx, q, t, now);
      await q.query(`UPDATE transfers SET status=$2, decided_by=$3, decided_at=$4 WHERE id=$1`, [t.id, approve ? 'approved' : 'rejected', req.session!.uid, now]);
    });
    await ctx.ledger.audit({ orgId: t.to_org_id, branchId: t.to_branch, actor: req.session!.uid, action: approve ? 'transfer.approve' : 'transfer.reject', entity: 'transfer', entityId: t.id, summary: `${approve ? 'Approved' : 'Rejected'} a member transfer`, changes: approve ? [{ field: 'branch_id', label: 'Branch', before: t.from_branch, after: t.to_branch }] : undefined, links: { membershipId: t.membership_id } });
    return { id: t.id, status: approve ? 'approved' : 'rejected' };
  });

  // ---------- projects and pledges (L39 to L41) ----------

  app.get('/projects', auth, async (req) => {
    const scope = await staffScope(ctx, req, 'collections.view', (req.query as any).branch);
    return projectList(ctx, scope.orgId, scope.branchIds);
  });

  app.post('/projects', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const scope = await staffScope(ctx, req, 'projects.manage', b.branchId);
    if (!b.branchId) throw new HttpError(400, 'Choose a branch', 'bad_branch');
    const code = String(b.code ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) throw new HttpError(400, 'Give the project a short code, such as ROOF', 'bad_code');
    if (!String(b.name ?? '').trim()) throw new HttpError(400, 'Enter a project name', 'bad_name');
    let target: number;
    try { target = toCents(b.target); } catch { throw new HttpError(400, 'Enter a target amount', 'bad_amount'); }
    if (!(target > 0)) throw new HttpError(400, 'The target must be more than zero', 'bad_amount');
    const dupe = (await ctx.db.query<any>(`SELECT 1 FROM projects WHERE branch_id=$1 AND code=$2`, [b.branchId, code]))[0];
    if (dupe) throw new HttpError(409, 'That project code is already used', 'duplicate_code');
    const id = ctx.newId('prj');
    await ctx.db.query(
      `INSERT INTO projects (id, org_id, branch_id, code, name, description, target, deadline, restricted, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, scope.orgId, b.branchId, code, String(b.name).trim(), b.description ?? null, target, b.deadline || null, !!b.restricted, ctx.clock.now().toISOString()],
    );
    const projFlat = { name: String(b.name).trim(), code, description: b.description ?? null, target, deadline: b.deadline || null, restricted: !!b.restricted, status: 'open' };
    const evt = await ctx.ledger.audit({ orgId: scope.orgId, branchId: b.branchId, actor: req.session!.uid, action: 'project.create', entity: 'project', entityId: id, summary: `Created the project ${projFlat.name}`, changes: diff(PROJECT_SPECS, null, projFlat) });
    await recordVersion(ctx, { orgId: scope.orgId, branchId: b.branchId, entity: 'project', entityId: id, snapshot: maskedSnapshot(PROJECT_SPECS, projFlat), summary: 'Created', eventId: evt });
    return { id, code };
  });

  app.get('/projects/:id/pledges', auth, async (req) => {
    const scope = await staffScope(ctx, req, 'collections.view');
    return ctx.db.asOrg(scope.orgId, (db) =>
      db.query<any>(
        `SELECT pl.id, pl.amount, m.full_name, m.member_number,
                COALESCE((SELECT SUM(net) FROM payments WHERE project_id=pl.project_id AND member_id=pl.membership_id AND stage IN ${DONE}),0) AS paid
           FROM pledges pl JOIN memberships m ON m.id=pl.membership_id WHERE pl.project_id=$1 ORDER BY pl.created_at`,
        [(req.params as any).id],
      ),
    );
  });

  /** Requests a reversal for a payment the staff member can see (L11). */
  app.post('/reversal-requests', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const scope = await staffScope(ctx, req, 'reversals.request');
    const { createReversalRequest } = await import('./reversals');
    return createReversalRequest(ctx, { requestedBy: req.session!.uid, source: 'staff', message: b.message, paymentId: b.paymentId, reason: b.reason, orgId: scope.orgId, branchIds: scope.branchIds });
  });

  app.get('/permissions', async () => ({ permissions: PERMISSIONS as readonly Permission[] }));
}

export async function projectList(ctx: Ctx, orgId: string, branchIds: string[]) {
  return ctx.db.asOrg(orgId, (db) =>
    db.query<any>(
      `SELECT p.id, p.code, p.name, p.description, p.target, p.deadline, p.restricted, p.status, p.branch_id, b.name AS branch_name,
              COALESCE((SELECT SUM(net) FROM payments WHERE project_id=p.id AND stage IN ${DONE}),0) AS raised,
              COALESCE((SELECT SUM(amount) FROM pledges WHERE project_id=p.id),0) AS pledged
         FROM projects p JOIN branches b ON b.id=p.branch_id WHERE p.branch_id IN (${inList(1, branchIds.length)}) ORDER BY p.created_at DESC`,
      branchIds,
    ),
  );
}

/**
 * Same organisation: the member number is kept and only the branch changes (L29, L31).
 * Different organisation: a new membership with a new number under the same identity (L31). The old one is closed, never deleted (L30).
 */
export async function applyTransfer(ctx: Ctx, q: import('@churchos/ledger').Db, t: any, now: string) {
  const m = (await q.query<any>(`SELECT * FROM memberships WHERE id=$1`, [t.membership_id]))[0];
  if (!m || m.status !== 'active') throw new HttpError(409, 'The membership is no longer active', 'inactive');
  if (t.to_org_id === t.org_id) {
    await q.query(`UPDATE memberships SET branch_id=$2 WHERE id=$1`, [m.id, t.to_branch]);
    await q.query(`INSERT INTO membership_history (org_id, membership_id, event, from_branch, to_branch, at) VALUES ($1,$2,'transfer',$3,$4,$5)`, [m.org_id, m.id, t.from_branch, t.to_branch, now]);
    return;
  }
  // No child may be left without an active guardian (L125), so neither a child nor a child's only guardian can leave the organisation.
  if (m.category === 'child') throw new HttpError(409, 'A child cannot move to another church on their own. A guardian must join first and add them there.', 'child_needs_guardian');
  const orphans = await q.query<any>(
    `SELECT c.full_name FROM guardians g JOIN memberships c ON c.id=g.child_id AND c.status='active'
      WHERE g.guardian_id=$1 AND NOT EXISTS (SELECT 1 FROM guardians g2 JOIN memberships gm ON gm.id=g2.guardian_id AND gm.status='active' WHERE g2.child_id=g.child_id AND g2.guardian_id<>$1)`,
    [m.id],
  );
  if (orphans.length) throw new HttpError(409, `${m.full_name} is the only guardian of ${orphans.map((o) => String(o.full_name).split(' ')[0]).join(', ')}. Add another guardian first.`, 'sole_guardian');
  await q.query(`UPDATE memberships SET status='closed', closed_at=$2 WHERE id=$1`, [m.id, now]);
  await q.query(`INSERT INTO membership_history (org_id, membership_id, event, from_branch, to_branch, at) VALUES ($1,$2,'transfer_out',$3,$4,$5)`, [m.org_id, m.id, t.from_branch, t.to_branch, now]);
  const toBranch = (await q.query<any>('SELECT code FROM branches WHERE id=$1', [t.to_branch]))[0];
  const number = await nextMemberNumber(ctx, t.to_org_id, q, toBranch?.code);
  const newId = ctx.newId('mem');
  await q.query(
    'INSERT INTO memberships (id, org_id, branch_id, user_id, full_name, phone, member_number, category, dob, sex, consent_at, consent_by, joined_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
    [newId, t.to_org_id, t.to_branch, m.user_id, m.full_name, m.phone, number, m.category, m.dob, m.sex, m.consent_at, m.consent_by, now],
  );
  await q.query(`INSERT INTO membership_history (org_id, membership_id, event, from_branch, to_branch, at) VALUES ($1,$2,'transfer_in',$3,$4,$5)`, [t.to_org_id, newId, t.from_branch, t.to_branch, now]);
}
