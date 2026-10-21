import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { buildReference, computeFee, networkMismatch, toCents } from '@churchos/shared';
import { maskPhone } from '@churchos/shared';
import { normalizePhone, type Permission } from '../auth';
import { imageSize } from '../artwork';
import { diff, maskedSnapshot, recordVersion, type FieldSpec } from '../audit';
import { checkoutLink, HttpError, requireSession, staffScope, type Ctx } from '../ctx';
import { addNotification } from '../notifications';
import { normalizeMethod } from './helpers';

const HOLD_MINUTES = 30;
const VOID_HOURS = 24;
const EAT = 3 * 3600_000;

const ITEM_SPECS: FieldSpec[] = [
  { field: 'name', label: 'Name' },
  { field: 'code', label: 'Code' },
  { field: 'category', label: 'Category' },
  { field: 'price', label: 'Selling price (cents)' },
  { field: 'cost', label: 'Cost price (cents)' },
  { field: 'lowStock', label: 'Low stock level' },
  { field: 'active', label: 'For sale' },
];

const eatDay = (iso: string) => new Date(new Date(iso).getTime() + EAT).toISOString().slice(0, 10);
const dayRange = (day: string) => { const s = Date.parse(`${day}T00:00:00+03:00`); return { from: new Date(s).toISOString(), to: new Date(s + 86400_000 - 1).toISOString() }; };
const kesText = (c: number) => `KES ${(c / 100).toLocaleString('en-KE')}`;

const text = (v: unknown, max: number, label: string, required = false) => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (required && !s) throw new HttpError(400, `Enter the ${label}`, 'bad_content');
  if (s.length > max) throw new HttpError(400, `The ${label} can be at most ${max} characters`, 'bad_content');
  return s || null;
};
const intIn = (v: unknown, lo: number, hi: number, label: string, fallback?: number): number => {
  if ((v === undefined || v === null || v === '') && fallback !== undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, `${label} must be a whole number from ${lo} to ${hi}`, 'bad_number');
  return n;
};
const money = (v: unknown, label: string, allowZero = false): number => {
  let c: number;
  try { c = toCents(v as any); } catch { throw new HttpError(400, `Enter ${label} in shillings`, 'bad_amount'); }
  if (c < 0 || (!allowZero && c === 0) || c > 100_000_000) throw new HttpError(400, `${label[0].toUpperCase()}${label.slice(1)} must be between ${allowZero ? '0' : 'KES 1'} and KES 1,000,000`, 'bad_amount');
  return c;
};

/** The church shop: items, stock movements, sales at the till, closing the till and reports (L155 to L163). */
export function shopRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };
  const nowIso = () => ctx.clock.now().toISOString();
  const newCode = () => randomBytes(5).toString('hex').toUpperCase().slice(0, 6);

  const scope = (req: FastifyRequest, perm: Permission, branch?: string) => staffScope(ctx, req, perm, branch);
  const canManage = async (req: FastifyRequest, branchId: string) => {
    try { return (await scope(req, 'shop.manage', branchId)).branchIds.includes(branchId); } catch { return false; }
  };

  async function stockOf(itemIds: string[]): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    if (!itemIds.length) return m;
    for (const r of await ctx.db.query<any>(`SELECT item_id, COALESCE(SUM(qty),0)::int AS n FROM shop_movements WHERE item_id = ANY($1::text[]) GROUP BY item_id`, [itemIds])) m.set(r.item_id, Number(r.n));
    return m;
  }

  async function itemRow(req: FastifyRequest, id: string, perm: Permission) {
    const it = (await ctx.db.query<any>(`SELECT * FROM shop_items WHERE id=$1`, [id]))[0];
    if (!it) throw new HttpError(404, 'item not found', 'not_found');
    const sc = await scope(req, perm).catch(() => null);
    if (!sc || sc.orgId !== it.org_id || !sc.branchIds.includes(it.branch_id)) throw new HttpError(404, 'item not found', 'not_found');
    return it;
  }

  const itemFlat = (it: any) => ({ name: it.name, code: it.code ?? null, category: it.category ?? null, price: Number(it.price), cost: it.cost == null ? null : Number(it.cost), lowStock: it.low_stock, active: it.active });

  async function move(q: { query: Function }, e: { orgId: string; branchId: string; itemId: string; kind: string; qty: number; unitCost?: number | null; saleId?: string | null; reason?: string | null; by: string }) {
    await q.query(`INSERT INTO shop_movements (id, org_id, branch_id, item_id, kind, qty, unit_cost, sale_id, reason, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [ctx.newId('mov'), e.orgId, e.branchId, e.itemId, e.kind, e.qty, e.unitCost ?? null, e.saleId ?? null, e.reason ?? null, e.by, nowIso()]);
  }

  // ======================= items =======================

  app.get('/shop/items', auth, async (req) => {
    const qy = req.query as any;
    const sc = await scope(req, 'shop.view', qy.branch);
    const manage = (await scope(req, 'shop.manage', qy.branch).catch(() => null))?.branchIds ?? [];
    const params: unknown[] = [sc.orgId, sc.branchIds];
    let where = `i.org_id=$1 AND i.branch_id = ANY($2::text[])`;
    const term = String(qy.q ?? '').trim().slice(0, 60);
    if (term) { params.push(`%${term.replace(/[!%_]/g, (c) => `!${c}`)}%`); where += ` AND (i.name ILIKE $${params.length} ESCAPE '!' OR i.code ILIKE $${params.length} ESCAPE '!' OR i.category ILIKE $${params.length} ESCAPE '!')`; }
    if (qy.category) { params.push(String(qy.category)); where += ` AND i.category=$${params.length}`; }
    const rows = await ctx.db.query<any>(`SELECT i.id, i.org_id, i.branch_id, i.code, i.name, i.category, i.price, i.cost, i.low_stock, i.active, (i.image_data IS NOT NULL) AS has_image, b.name AS branch_name FROM shop_items i JOIN branches b ON b.id=i.branch_id WHERE ${where} ORDER BY i.active DESC, i.name`, params);
    const stock = await stockOf(rows.map((r) => r.id));
    const out = rows.map((r) => {
      const n = stock.get(r.id) ?? 0;
      const mine = manage.includes(r.branch_id);
      return {
        id: r.id, branchId: r.branch_id, branchName: r.branch_name, code: r.code, name: r.name, category: r.category, price: Number(r.price), cost: mine && r.cost != null ? Number(r.cost) : null,
        lowStock: r.low_stock, active: r.active, hasImage: r.has_image, imageUrl: r.has_image ? `/shop/items/${r.id}/image` : null, stock: n, low: n <= r.low_stock, out: n <= 0, value: mine && r.cost != null ? n * Number(r.cost) : null, canManage: mine,
      };
    });
    return qy.low === '1' ? out.filter((r) => r.low && r.active) : out;
  });

  app.post('/shop/items', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    if (!b.branchId) throw new HttpError(400, 'Choose a branch', 'bad_branch');
    const sc = await scope(req, 'shop.manage', b.branchId);
    const name = text(b.name, 80, 'name', true)!;
    const code = text(b.code, 20, 'code');
    if (code && !/^[A-Za-z0-9._-]+$/.test(code)) throw new HttpError(400, 'A code can use letters, numbers, dots, dashes and underscores', 'bad_code');
    if (code && (await ctx.db.query<any>(`SELECT 1 FROM shop_items WHERE branch_id=$1 AND lower(code)=lower($2)`, [b.branchId, code]))[0]) throw new HttpError(409, 'That code is already used for another item', 'duplicate');
    if ((await ctx.db.query<any>(`SELECT 1 FROM shop_items WHERE branch_id=$1 AND lower(name)=lower($2)`, [b.branchId, name]))[0]) throw new HttpError(409, 'There is already an item with that name', 'duplicate');
    const price = money(b.price, 'the selling price');
    const cost = b.cost === undefined || b.cost === null || b.cost === '' ? null : money(b.cost, 'the cost price', true);
    const low = intIn(b.lowStock, 0, 10000, 'The low stock level', 5);
    const opening = intIn(b.openingStock, 0, 100000, 'Opening stock', 0);
    const id = ctx.newId('itm');
    const now = nowIso();
    await ctx.db.query(`INSERT INTO shop_items (id, org_id, branch_id, code, name, category, price, cost, low_stock, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
      [id, sc.orgId, b.branchId, code, name, text(b.category, 30, 'category'), price, cost, low, req.session!.uid, now]);
    if (opening > 0) await move(ctx.db as any, { orgId: sc.orgId, branchId: b.branchId, itemId: id, kind: 'received', qty: opening, unitCost: cost, reason: 'Opening stock', by: req.session!.uid });
    const flat = itemFlat((await ctx.db.query<any>(`SELECT * FROM shop_items WHERE id=$1`, [id]))[0]);
    const evt = await ctx.ledger.audit({ orgId: sc.orgId, branchId: b.branchId, actor: req.session!.uid, action: 'shop.item_create', entity: 'shop_item', entityId: id, summary: `Added "${name}" to the shop at ${kesText(price)}${opening ? ` with ${opening} in stock` : ''}`, changes: diff(ITEM_SPECS, null, flat) });
    await recordVersion(ctx, { orgId: sc.orgId, branchId: b.branchId, entity: 'shop_item', entityId: id, snapshot: maskedSnapshot(ITEM_SPECS, flat), summary: 'Created', eventId: evt });
    return { id };
  });

  app.put('/shop/items/:id', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const old = await itemRow(req, (req.params as any).id, 'shop.manage');
    const has = (k: string) => k in b;
    const name = has('name') ? text(b.name, 80, 'name', true)! : old.name;
    const code = has('code') ? text(b.code, 20, 'code') : old.code;
    if (code && !/^[A-Za-z0-9._-]+$/.test(code)) throw new HttpError(400, 'A code can use letters, numbers, dots, dashes and underscores', 'bad_code');
    if (code && (await ctx.db.query<any>(`SELECT 1 FROM shop_items WHERE branch_id=$1 AND lower(code)=lower($2) AND id<>$3`, [old.branch_id, code, old.id]))[0]) throw new HttpError(409, 'That code is already used for another item', 'duplicate');
    if (has('name') && (await ctx.db.query<any>(`SELECT 1 FROM shop_items WHERE branch_id=$1 AND lower(name)=lower($2) AND id<>$3`, [old.branch_id, name, old.id]))[0]) throw new HttpError(409, 'There is already an item with that name', 'duplicate');
    const price = has('price') ? money(b.price, 'the selling price') : Number(old.price);
    const cost = has('cost') ? (b.cost === null || b.cost === '' ? null : money(b.cost, 'the cost price', true)) : old.cost == null ? null : Number(old.cost);
    const before = itemFlat(old);
    await ctx.db.query(`UPDATE shop_items SET name=$2, code=$3, category=$4, price=$5, cost=$6, low_stock=$7, active=$8, updated_at=$9 WHERE id=$1`,
      [old.id, name, code, has('category') ? text(b.category, 30, 'category') : old.category, price, cost, has('lowStock') ? intIn(b.lowStock, 0, 10000, 'The low stock level') : old.low_stock, has('active') ? !!b.active : old.active, nowIso()]);
    const flat = itemFlat((await ctx.db.query<any>(`SELECT * FROM shop_items WHERE id=$1`, [old.id]))[0]);
    const changes = diff(ITEM_SPECS, before, flat);
    if (changes.length) {
      const evt = await ctx.ledger.audit({ orgId: old.org_id, branchId: old.branch_id, actor: req.session!.uid, action: changes.some((c) => c.field === 'price') ? 'shop.price_change' : 'shop.item_update', entity: 'shop_item', entityId: old.id, summary: `Changed "${name}"${changes.some((c) => c.field === 'price') ? `: price ${kesText(Number(old.price))} to ${kesText(price)}` : ''}`, changes });
      await recordVersion(ctx, { orgId: old.org_id, branchId: old.branch_id, entity: 'shop_item', entityId: old.id, snapshot: maskedSnapshot(ITEM_SPECS, flat), summary: changes.map((c) => c.label).join(', '), eventId: evt });
    }
    return { id: old.id };
  });

  /** Stock comes in, goes out or is corrected, always as a movement with a reason (L156). */
  app.post('/shop/items/:id/stock', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const it = await itemRow(req, (req.params as any).id, 'shop.manage');
    const kind = String(b.kind);
    if (!['received', 'adjusted', 'written_off'].includes(kind)) throw new HttpError(400, 'Choose received, adjusted or written off', 'bad_kind');
    let qty = kind === 'adjusted' ? intIn(b.qty, -100000, 100000, 'The change') : intIn(b.qty, 1, 100000, 'The quantity');
    if (qty === 0) throw new HttpError(400, 'The change cannot be zero', 'bad_number');
    const reason = text(b.reason, 200, 'reason', kind !== 'received');
    if (kind === 'written_off') qty = -qty;
    const unitCost = kind === 'received' && b.unitCost !== undefined && b.unitCost !== null && b.unitCost !== '' ? money(b.unitCost, 'the cost of each', true) : null;
    const now = (await stockOf([it.id])).get(it.id) ?? 0;
    if (now + qty < 0) throw new HttpError(409, `There are only ${now} in stock, so that would go below zero`, 'below_zero');
    await move(ctx.db as any, { orgId: it.org_id, branchId: it.branch_id, itemId: it.id, kind, qty, unitCost, reason, by: req.session!.uid });
    if (unitCost !== null) await ctx.db.query(`UPDATE shop_items SET cost=$2, updated_at=$3 WHERE id=$1`, [it.id, unitCost, nowIso()]);
    await ctx.ledger.audit({ orgId: it.org_id, branchId: it.branch_id, actor: req.session!.uid, action: `shop.stock_${kind}`, entity: 'shop_item', entityId: it.id, summary: `${kind === 'received' ? 'Received' : kind === 'written_off' ? 'Wrote off' : 'Adjusted'} ${Math.abs(qty)} of "${it.name}"${kind === 'adjusted' ? ` (${qty > 0 ? '+' : ''}${qty})` : ''}`, reason, meta: { qty, from: now, to: now + qty } });
    return { stock: now + qty };
  });

  app.get('/shop/items/:id/movements', auth, async (req) => {
    const it = await itemRow(req, (req.params as any).id, 'shop.view');
    const rows = await ctx.db.query<any>(`SELECT m.kind, m.qty, m.reason, m.created_at, m.sale_id, m.unit_cost, u.name AS by_name, s.receipt_no FROM shop_movements m LEFT JOIN users u ON u.id=m.created_by LEFT JOIN shop_sales s ON s.id=m.sale_id WHERE m.item_id=$1 ORDER BY m.created_at DESC, m.id DESC LIMIT 200`, [it.id]);
    const manage = await canManage(req, it.branch_id);
    return rows.map((r) => ({ kind: r.kind, qty: r.qty, reason: r.reason, at: r.created_at, by: r.by_name, receipt: r.receipt_no ?? null, unitCost: manage && r.unit_cost != null ? Number(r.unit_cost) : null }));
  });

  // ======================= sales =======================

  async function loadLines(orgId: string, branchId: string, raw: any) {
    const lines: { itemId: string; qty: number }[] = [];
    const seen = new Set<string>();
    for (const l of Array.isArray(raw) ? raw : []) {
      const itemId = String(l?.itemId ?? '');
      if (!itemId || seen.has(itemId)) throw new HttpError(400, 'Each item can appear once in a sale. Change its quantity instead.', 'bad_lines');
      seen.add(itemId);
      lines.push({ itemId, qty: intIn(l.qty, 1, 1000, 'The quantity') });
    }
    if (!lines.length || lines.length > 50) throw new HttpError(400, 'Add at least one item to the sale', 'bad_lines');
    const items = await ctx.db.query<any>(`SELECT * FROM shop_items WHERE id = ANY($1::text[]) AND org_id=$2 AND branch_id=$3`, [lines.map((l) => l.itemId), orgId, branchId]);
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const l of lines) {
      const it = byId.get(l.itemId);
      if (!it) throw new HttpError(404, 'One of the items is not sold at this branch', 'not_found');
      if (!it.active) throw new HttpError(409, `"${it.name}" is not for sale at the moment`, 'inactive');
    }
    return lines.map((l) => ({ ...l, item: byId.get(l.itemId)! }));
  }

  async function saleView(s: any, manage: boolean, withLines = true) {
    const lines = withLines ? await ctx.db.query<any>(`SELECT item_id, name, qty, unit_price, unit_cost FROM shop_sale_lines WHERE sale_id=$1 ORDER BY name`, [s.id]) : [];
    return {
      id: s.id, code: s.code, channel: s.channel ?? 'till', fulfilment: s.fulfilment ?? null, receiptNo: s.receipt_no, branchId: s.branch_id, branchName: s.branch_name, status: s.status, method: s.method, total: Number(s.total),
      buyer: s.buyer_name ?? null, soldBy: s.sold_by_name ?? null, createdAt: s.created_at, completedAt: s.completed_at, holdUntil: s.hold_until, paid: !!s.payment_id,
      voidReason: s.void_reason, voidedAt: s.voided_at, items: s.items_text ?? undefined,
      lines: withLines ? lines.map((l) => ({ itemId: l.item_id, name: l.name, qty: l.qty, unitPrice: Number(l.unit_price), total: l.qty * Number(l.unit_price), unitCost: manage && l.unit_cost != null ? Number(l.unit_cost) : undefined })) : undefined,
    };
  }
  const SALE_SELECT = `SELECT s.*, b.name AS branch_name, u.name AS sold_by_name, (SELECT string_agg(l.qty || ' x ' || l.name, ', ' ORDER BY l.name) FROM shop_sale_lines l WHERE l.sale_id=s.id) AS items_text
    FROM shop_sales s JOIN branches b ON b.id=s.branch_id LEFT JOIN users u ON u.id=s.sold_by`;

  app.post('/shop/sales', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    if (!b.branchId) throw new HttpError(400, 'Choose a branch', 'bad_branch');
    const sc = await scope(req, 'shop.sell', b.branchId);
    const method = b.method === 'cash' ? 'cash' : normalizeMethod(b.method);
    const lines = await loadLines(sc.orgId, b.branchId, b.lines);
    const total = lines.reduce((s, l) => s + l.qty * Number(l.item.price), 0);
    let buyerName = text(b.buyerName, 80, 'buyer name');
    let buyerMembership: string | null = null;
    if (b.buyerMembershipId) {
      const m = (await ctx.db.query<any>(`SELECT id, full_name FROM memberships WHERE id=$1 AND org_id=$2 AND status='active'`, [String(b.buyerMembershipId), sc.orgId]))[0];
      if (!m) throw new HttpError(404, 'That member was not found', 'not_found');
      buyerMembership = m.id; buyerName = m.full_name;
    }
    const branch = (await ctx.db.query<any>(`SELECT code, name FROM branches WHERE id=$1`, [b.branchId]))[0];
    const org = (await ctx.db.query<any>(`SELECT fee_schedule FROM organisations WHERE id=$1`, [sc.orgId]))[0];
    const code = newCode();
    let phone: string | null = null;
    if (method !== 'cash') {
      phone = normalizePhone(String(b.phone ?? ''));
      if (!phone && method !== 'card') throw new HttpError(400, 'Enter the buyer phone number to send the payment prompt to', 'bad_phone');
      const mismatch = phone ? networkMismatch(method, phone) : null;
      if (mismatch) throw new HttpError(400, mismatch, 'wrong_network');
    }
    // The stock is checked again inside the transaction, so two sales cannot take the last one.
    const stockNow = await stockOf(lines.map((l) => l.itemId));
    for (const l of lines) if ((stockNow.get(l.itemId) ?? 0) < l.qty) throw new HttpError(409, `Only ${stockNow.get(l.itemId) ?? 0} of "${l.item.name}" in stock`, 'out_of_stock');

    let providerTxId: string | null = null;
    let checkoutUrl: string | null = null;
    const fee = method === 'cash' ? null : computeFee(org.fee_schedule, method, total, 'church');
    if (method !== 'cash' && fee) {
      const reference = buildReference(branch.code, `SHOP-${code}`);
      if (method === 'card') {
        const card = await ctx.provider.initiateCardCheckout({ amount: fee.amountPaid, reference, phone: phone ?? undefined });
        providerTxId = card.providerTxId;
        checkoutUrl = checkoutLink(ctx, card);
      } else {
        providerTxId = (await ctx.provider.initiateStkPush({ phone: phone!, amount: fee.amountPaid, reference, method })).providerTxId;
      }
    }
    const id = ctx.newId('sal');
    const now = nowIso();
    const cash = method === 'cash';
    let receiptNo = '';
    await ctx.db.tx(async (q) => {
      for (const l of lines) {
        const n = Number((await q.query<any>(`SELECT COALESCE(SUM(qty),0) AS n FROM shop_movements WHERE item_id=$1`, [l.itemId]))[0].n);
        if (n < l.qty) throw new HttpError(409, `Only ${n} of "${l.item.name}" in stock`, 'out_of_stock');
      }
      const count = Number((await q.query<any>(`SELECT count(*) AS n FROM shop_sales WHERE branch_id=$1`, [b.branchId]))[0].n);
      receiptNo = `${branch.code}-${String(count + 1).padStart(5, '0')}`;
      await q.query(
        `INSERT INTO shop_sales (id, code, receipt_no, org_id, branch_id, buyer_name, buyer_membership_id, buyer_phone, method, status, total, provider_tx_id, hold_until, sold_by, created_at, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [id, code, receiptNo, sc.orgId, b.branchId, buyerName, buyerMembership, phone, method, cash ? 'completed' : 'awaiting_payment', total, providerTxId, cash ? null : new Date(ctx.clock.now().getTime() + HOLD_MINUTES * 60_000).toISOString(), req.session!.uid, now, cash ? now : null],
      );
      for (const l of lines) {
        await q.query(`INSERT INTO shop_sale_lines (sale_id, item_id, name, qty, unit_price, unit_cost) VALUES ($1,$2,$3,$4,$5,$6)`, [id, l.itemId, l.item.name, l.qty, l.item.price, l.item.cost]);
        await move(q, { orgId: sc.orgId, branchId: b.branchId, itemId: l.itemId, kind: 'sold', qty: -l.qty, saleId: id, by: req.session!.uid });
      }
      if (fee) {
        await q.query(`INSERT INTO give_intents (id, provider_tx_id, org_id, branch_id, purpose, project_id, phone, method, base_amount, amount_paid, fee, created_at) VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,$11)`,
          [ctx.newId('int'), providerTxId, sc.orgId, b.branchId, `SHOP-${code}`, phone ?? '', method, total, fee.amountPaid, JSON.stringify(fee), now]);
      }
    });
    await ctx.ledger.audit({ orgId: sc.orgId, branchId: b.branchId, actor: req.session!.uid, action: 'shop.sale', entity: 'shop_sale', entityId: id, summary: `${cash ? 'Sold' : 'Started a sale of'} ${lines.map((l) => `${l.qty} x ${l.item.name}`).join(', ')} for ${kesText(total)} by ${cash ? 'cash' : method}, receipt ${receiptNo}`, meta: { total, method, receipt: receiptNo, lines: lines.length } });
    const sale = (await ctx.db.query<any>(`${SALE_SELECT} WHERE s.id=$1`, [id]))[0];
    return { ...(await saleView(sale, await canManage(req, b.branchId))), checkoutUrl, message: cash ? 'Sale complete.' : method === 'card' ? 'Open the card page and let the buyer pay.' : `Ask the buyer to check their phone and enter their PIN. The items are held for ${HOLD_MINUTES} minutes.` };
  });

  app.get('/shop/sales', auth, async (req) => {
    const q = req.query as any;
    const sc = await scope(req, 'shop.view', q.branch);
    const params: unknown[] = [sc.orgId, sc.branchIds];
    let where = `s.org_id=$1 AND s.branch_id = ANY($2::text[])`;
    if (q.status) { params.push(String(q.status).split(',')); where += ` AND s.status = ANY($${params.length}::text[])`; }
    if (q.from) { params.push(new Date(String(q.from)).toISOString()); where += ` AND s.created_at >= $${params.length}`; }
    if (q.to) { params.push(new Date(String(q.to)).toISOString()); where += ` AND s.created_at <= $${params.length}`; }
    const term = String(q.q ?? '').trim().slice(0, 60);
    if (term) { params.push(`%${term.replace(/[!%_]/g, (c) => `!${c}`)}%`); where += ` AND (s.receipt_no ILIKE $${params.length} ESCAPE '!' OR s.buyer_name ILIKE $${params.length} ESCAPE '!' OR s.code ILIKE $${params.length} ESCAPE '!' OR EXISTS (SELECT 1 FROM shop_sale_lines l WHERE l.sale_id=s.id AND l.name ILIKE $${params.length} ESCAPE '!'))`; }
    const rows = await ctx.db.query<any>(`${SALE_SELECT} WHERE ${where} ORDER BY s.created_at DESC LIMIT 300`, params);
    const manage = (await scope(req, 'shop.manage', q.branch).catch(() => null))?.branchIds ?? [];
    const out = [];
    for (const s of rows) out.push({ ...(await saleView(s, manage.includes(s.branch_id), false)), canVoid: manage.includes(s.branch_id) && s.status === 'completed' && s.method === 'cash' && (ctx.clock.now().getTime() - Date.parse(s.completed_at)) / 3600_000 <= VOID_HOURS });
    return out;
  });

  async function saleRow(req: FastifyRequest, id: string, perm: Permission) {
    const s = (await ctx.db.query<any>(`${SALE_SELECT} WHERE s.id=$1`, [id]))[0];
    const sc = s ? await scope(req, perm).catch(() => null) : null;
    if (!s || !sc || sc.orgId !== s.org_id || !sc.branchIds.includes(s.branch_id)) throw new HttpError(404, 'sale not found', 'not_found');
    return s;
  }

  app.get('/shop/sales/:id', auth, async (req) => {
    const s = await saleRow(req, (req.params as any).id, 'shop.view');
    return saleView(s, await canManage(req, s.branch_id));
  });

  async function releaseStock(q: { query: Function }, s: any, kind: 'released' | 'returned', by: string, reason: string) {
    const lines = await q.query(`SELECT item_id, qty FROM shop_sale_lines WHERE sale_id=$1`, [s.id]);
    for (const l of lines as any[]) await move(q, { orgId: s.org_id, branchId: s.branch_id, itemId: l.item_id, kind, qty: Number(l.qty), saleId: s.id, reason, by });
  }

  /** A cash sale can be voided for a day, with a reason. Money from mobile or card goes back through the normal reversal process (L159). */
  app.post('/shop/sales/:id/void', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const s = await saleRow(req, (req.params as any).id, 'shop.manage');
    if (s.status !== 'completed') throw new HttpError(409, 'Only a completed sale can be voided', 'wrong_state');
    if (s.method !== 'cash') throw new HttpError(409, 'This was paid by mobile money or card. Ask for the payment to be reversed in Payment help, and record a return for the stock.', 'not_cash');
    if ((ctx.clock.now().getTime() - Date.parse(s.completed_at)) / 3600_000 > VOID_HOURS) throw new HttpError(409, `A sale can only be voided within ${VOID_HOURS} hours`, 'too_late');
    const reason = text(b.reason, 200, 'reason', true)!;
    const restock = b.restock !== false;
    await ctx.db.tx(async (q) => {
      await q.query(`UPDATE shop_sales SET status='voided', void_reason=$2, voided_by=$3, voided_at=$4 WHERE id=$1`, [s.id, reason, req.session!.uid, nowIso()]);
      if (restock) await releaseStock(q, s, 'returned', req.session!.uid, `Voided: ${reason}`);
    });
    await ctx.ledger.audit({ orgId: s.org_id, branchId: s.branch_id, actor: req.session!.uid, action: 'shop.void', entity: 'shop_sale', entityId: s.id, summary: `Voided the cash sale ${s.receipt_no} of ${kesText(Number(s.total))}${restock ? ' and put the stock back' : ''}`, reason, meta: { total: Number(s.total), restock } });
    return { id: s.id, status: 'voided' };
  });

  /** Staff give up on a sale that is still waiting for payment: the stock goes back. */
  app.post('/shop/sales/:id/cancel', auth, async (req) => {
    const s = await saleRow(req, (req.params as any).id, 'shop.sell');
    if (s.status !== 'awaiting_payment') throw new HttpError(409, 'Only a sale that is waiting for payment can be cancelled', 'wrong_state');
    await ctx.db.tx(async (q) => {
      await q.query(`UPDATE shop_sales SET status='lapsed', void_reason='Cancelled at the till', voided_by=$2, voided_at=$3 WHERE id=$1`, [s.id, req.session!.uid, nowIso()]);
      await releaseStock(q, s, 'released', req.session!.uid, 'Sale cancelled before payment');
    });
    await ctx.ledger.audit({ orgId: s.org_id, branchId: s.branch_id, actor: req.session!.uid, action: 'shop.cancel', entity: 'shop_sale', entityId: s.id, summary: `Cancelled the unpaid sale ${s.receipt_no}` });
    return { id: s.id, status: 'lapsed' };
  });

  // ======================= closing the till (L160) =======================

  async function tillFigures(orgId: string, branchId: string, day: string) {
    const { from, to } = dayRange(day);
    const r = (await ctx.db.query<any>(`SELECT COALESCE(SUM(total),0) AS expected, count(*)::int AS n FROM shop_sales WHERE branch_id=$1 AND method='cash' AND status='completed' AND completed_at >= $2 AND completed_at <= $3`, [branchId, from, to]))[0];
    const till = (await ctx.db.query<any>(`SELECT t.*, u.name AS by_name FROM shop_tills t LEFT JOIN users u ON u.id=t.counted_by WHERE t.branch_id=$1 AND t.day=$2`, [branchId, day]))[0];
    return { day, expected: Number(r.expected), cashSales: Number(r.n), till: till ? { counted: Number(till.counted), expected: Number(till.expected), variance: Number(till.counted) - Number(till.expected), note: till.note, by: till.by_name, at: till.created_at, cashEntryId: till.cash_entry_id } : null };
  }

  app.get('/shop/till', auth, async (req) => {
    const q = req.query as any;
    if (!q.branch) throw new HttpError(400, 'Choose a branch', 'bad_branch');
    const sc = await scope(req, 'shop.sell', q.branch);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(q.day ?? '')) ? String(q.day) : eatDay(nowIso());
    return tillFigures(sc.orgId, q.branch, day);
  });

  app.post('/shop/till', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    if (!b.branchId) throw new HttpError(400, 'Choose a branch', 'bad_branch');
    const sc = await scope(req, 'shop.sell', b.branchId);
    const today = eatDay(nowIso());
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(b.day ?? '')) ? String(b.day) : today;
    if (day > today) throw new HttpError(400, 'You cannot close the till for a day that has not happened', 'bad_day');
    const counted = money(b.counted, 'the cash counted', true);
    const fig = await tillFigures(sc.orgId, b.branchId, day);
    if (fig.till) throw new HttpError(409, 'The till was already closed for that day', 'already_closed');
    const variance = counted - fig.expected;
    const note = text(b.note, 200, 'note');
    if (variance !== 0 && !note) throw new HttpError(400, `The count is ${kesText(Math.abs(variance))} ${variance > 0 ? 'more' : 'less'} than the sales say. Write a note to explain.`, 'note_required');
    const id = ctx.newId('till');
    let cashId: string | null = null;
    if (counted > 0) {
      cashId = ctx.newId('cash');
      await ctx.db.query(`INSERT INTO cash_entries (id, org_id, branch_id, amount, purpose, note, status, counted_by, created_at) VALUES ($1,$2,$3,$4,'SHOP',$5,'counted',$6,$7)`, [cashId, sc.orgId, b.branchId, counted, `Shop till ${day}${note ? `: ${note}` : ''}`, req.session!.uid, nowIso()]);
    }
    await ctx.db.query(`INSERT INTO shop_tills (id, org_id, branch_id, day, expected, counted, note, cash_entry_id, counted_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, sc.orgId, b.branchId, day, fig.expected, counted, note, cashId, req.session!.uid, nowIso()]);
    await ctx.ledger.audit({ orgId: sc.orgId, branchId: b.branchId, actor: req.session!.uid, action: 'shop.till', entity: 'shop_till', entityId: id, summary: `Closed the shop till for ${day}: counted ${kesText(counted)}, sales say ${kesText(fig.expected)}${variance ? ` (${variance > 0 ? '+' : ''}${kesText(variance)})` : ''}`, reason: variance ? note : null, links: cashId ? { cashId } : undefined, meta: { expected: fig.expected, counted, variance } });
    return { id, day, expected: fig.expected, counted, variance, cashEntryId: cashId, message: cashId ? 'The count was sent for a second person to sign off in Cash.' : 'Till closed.' };
  });

  // ======================= pictures (L167) =======================

  const MAX_PICTURE = 500 * 1024;
  function validatePicture(raw: any): { mime: string; data: string } {
    if (!raw || !['image/png', 'image/jpeg', 'image/webp'].includes(raw.mime)) throw new HttpError(400, 'Use a PNG, JPEG or WebP picture', 'bad_picture');
    const bytes = Buffer.from(String(raw.data ?? ''), 'base64');
    if (!bytes.length) throw new HttpError(400, 'That picture is empty', 'bad_picture');
    if (bytes.length > MAX_PICTURE) throw new HttpError(413, 'The picture is larger than 500 KB. Use a smaller one.', 'picture_too_large');
    const size = imageSize(bytes, raw.mime);
    if (!size || size.width < 200 || size.height < 200) throw new HttpError(400, 'The picture must be a valid image at least 200 pixels wide and tall', 'bad_picture');
    return { mime: raw.mime, data: String(raw.data) };
  }

  app.post('/shop/items/:id/image', auth, async (req) => {
    const it = await itemRow(req, (req.params as any).id, 'shop.manage');
    const p = validatePicture((req.body as any)?.image);
    await ctx.db.query(`UPDATE shop_items SET image_mime=$2, image_data=$3, updated_at=$4 WHERE id=$1`, [it.id, p.mime, p.data, nowIso()]);
    await ctx.ledger.audit({ orgId: it.org_id, branchId: it.branch_id, actor: req.session!.uid, action: 'shop.item_update', entity: 'shop_item', entityId: it.id, summary: `Changed the picture of "${it.name}"` });
    return { ok: true };
  });

  app.post('/shop/items/:id/image/remove', auth, async (req) => {
    const it = await itemRow(req, (req.params as any).id, 'shop.manage');
    await ctx.db.query(`UPDATE shop_items SET image_mime=NULL, image_data=NULL, updated_at=$2 WHERE id=$1`, [it.id, nowIso()]);
    await ctx.ledger.audit({ orgId: it.org_id, branchId: it.branch_id, actor: req.session!.uid, action: 'shop.item_update', entity: 'shop_item', entityId: it.id, summary: `Removed the picture of "${it.name}"` });
    return { ok: true };
  });

  const sendPicture = (reply: any, it: any) => (it?.image_data ? reply.header('content-type', it.image_mime).header('cache-control', 'private, max-age=300').send(Buffer.from(it.image_data, 'base64')) : reply.status(404).send({ error: 'no picture', code: 'not_found' }));

  app.get('/shop/items/:id/image', auth, async (req, reply) => {
    const it = await itemRow(req, (req.params as any).id, 'shop.view');
    return sendPicture(reply, it);
  });

  // ======================= buying from the member app (L164 to L166) =======================

  const memberOrgs = async (uid: string) => (await ctx.db.query<any>(`SELECT DISTINCT org_id FROM memberships WHERE user_id=$1 AND status='active'`, [uid])).map((r) => r.org_id as string);

  const orderState = (s: any) => (s.status === 'completed' ? s.fulfilment ?? 'to_prepare' : s.status);

  async function orderView(s: any, forStaff = false) {
    const lines = await ctx.db.query<any>(`SELECT item_id, name, qty, unit_price FROM shop_sale_lines WHERE sale_id=$1 ORDER BY name`, [s.id]);
    const state = orderState(s);
    const paid = ['to_prepare', 'ready', 'collected'].includes(state);
    return {
      id: s.id, receiptNo: s.receipt_no, state, method: s.method, total: Number(s.total), branchId: s.branch_id, branchName: s.branch_name, createdAt: s.created_at, holdUntil: s.hold_until,
      readyAt: s.ready_at, collectedAt: s.collected_at,
      collectionCode: paid || forStaff ? s.code : undefined,
      payUrl: s.status === 'awaiting_payment' && s.method === 'card' && s.provider_tx_id ? `${ctx.givingUrl}/checkout/${s.provider_tx_id}` : null,
      buyer: s.buyer_name ?? null, buyerPhone: forStaff ? maskPhone(s.buyer_phone) : undefined,
      lines: lines.map((l) => ({ itemId: l.item_id, name: l.name, qty: l.qty, unitPrice: Number(l.unit_price), total: l.qty * Number(l.unit_price) })),
      items: forStaff ? lines.map((l) => `${l.qty} x ${l.name}`).join(', ') : undefined,
    };
  }

  app.get('/me/shop', auth, async (req) => {
    const uid = req.session!.uid;
    const orgs = await memberOrgs(uid);
    if (!orgs.length) return { branches: [], branchId: null, categories: [], items: [] };
    const branches = await ctx.db.query<any>(
      `SELECT b.id, b.name, o.name AS church, count(*)::int AS items FROM shop_items i JOIN branches b ON b.id=i.branch_id JOIN organisations o ON o.id=i.org_id
        WHERE i.org_id = ANY($1::text[]) AND i.active GROUP BY b.id, b.name, o.name ORDER BY b.name`,
      [orgs],
    );
    if (!branches.length) return { branches: [], branchId: null, categories: [], items: [] };
    const mine = (await ctx.db.query<any>(`SELECT branch_id FROM memberships WHERE user_id=$1 AND status='active' ORDER BY joined_at`, [uid])).map((r) => r.branch_id as string);
    const want = String((req.query as any).branch ?? '');
    const chosen = branches.find((b) => b.id === want) ?? branches.find((b) => mine.includes(b.id)) ?? branches[0];
    const rows = await ctx.db.query<any>(`SELECT i.id, i.name, i.category, i.price, i.low_stock, (i.image_data IS NOT NULL) AS has_image FROM shop_items i WHERE i.branch_id=$1 AND i.active ORDER BY i.category NULLS LAST, i.name`, [chosen.id]);
    const stock = await stockOf(rows.map((r) => r.id));
    return {
      branches: branches.map((b) => ({ id: b.id, name: b.name, church: b.church, items: b.items })),
      branchId: chosen.id,
      categories: [...new Set(rows.map((r) => r.category).filter(Boolean))],
      items: rows.map((r) => {
        const n = stock.get(r.id) ?? 0;
        return { id: r.id, name: r.name, category: r.category, price: Number(r.price), available: n > 0, left: n > 0 && n <= r.low_stock ? n : null, maxQty: Math.min(n, 10), imageUrl: r.has_image ? `/me/shop/items/${r.id}/image` : null };
      }),
    };
  });

  app.get('/me/shop/items/:id/image', auth, async (req, reply) => {
    const it = (await ctx.db.query<any>(`SELECT image_mime, image_data, org_id FROM shop_items WHERE id=$1 AND active`, [(req.params as any).id]))[0];
    if (!it || !(await memberOrgs(req.session!.uid)).includes(it.org_id)) throw new HttpError(404, 'not found', 'not_found');
    return sendPicture(reply, it);
  });

  app.post('/me/shop/orders', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const uid = req.session!.uid;
    const branch = (await ctx.db.query<any>(`SELECT id, org_id, code, name FROM branches WHERE id=$1`, [String(b.branchId ?? '')]))[0];
    const m = branch ? (await ctx.db.query<any>(`SELECT id, full_name FROM memberships WHERE user_id=$1 AND org_id=$2 AND status='active' ORDER BY joined_at LIMIT 1`, [uid, branch.org_id]))[0] : null;
    if (!branch || !m) throw new HttpError(404, 'That shop was not found', 'not_found');
    const method = normalizeMethod(b.method);
    if (method === 'cash') throw new HttpError(400, 'Choose M-Pesa, Airtel Money, T-Kash or card. Cash is paid at the shop counter.', 'bad_method');
    const lines = await loadLines(branch.org_id, branch.id, b.lines);
    if (lines.some((l) => l.qty > 10)) throw new HttpError(400, 'You can order up to 10 of one item', 'bad_number');
    const total = lines.reduce((s, l) => s + l.qty * Number(l.item.price), 0);
    if (total > 15_000_000) throw new HttpError(400, 'An order can be at most KES 150,000. Please split it into two orders.', 'too_large');
    const open = Number((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM shop_sales WHERE buyer_user_id=$1 AND status='awaiting_payment'`, [uid]))[0].n);
    if (open >= 3) throw new HttpError(429, 'You have 3 orders waiting for payment. Pay for them or cancel them first.', 'too_many');
    let phone = normalizePhone(String(b.phone ?? req.session!.phone ?? ''));
    if (!phone && method !== 'card') throw new HttpError(400, 'Enter the phone number to send the payment prompt to', 'bad_phone');
    const mismatch = phone ? networkMismatch(method, phone) : null;
    if (mismatch) throw new HttpError(400, mismatch, 'wrong_network');
    const stockNow = await stockOf(lines.map((l) => l.itemId));
    for (const l of lines) if ((stockNow.get(l.itemId) ?? 0) < l.qty) throw new HttpError(409, (stockNow.get(l.itemId) ?? 0) === 0 ? `"${l.item.name}" is sold out` : `Only ${stockNow.get(l.itemId)} of "${l.item.name}" left`, 'out_of_stock');
    const advert = b.advertId ? (await ctx.db.query<any>(`SELECT id FROM adverts WHERE id=$1 AND org_id=$2`, [String(b.advertId), branch.org_id]))[0] : null;
    const org = (await ctx.db.query<any>(`SELECT fee_schedule FROM organisations WHERE id=$1`, [branch.org_id]))[0];
    const fee = computeFee(org.fee_schedule, method, total, 'church');
    const code = newCode();
    const reference = buildReference(branch.code, `SHOP-${code}`);
    let providerTxId: string;
    if (method === 'card') providerTxId = (await ctx.provider.initiateCardCheckout({ amount: fee.amountPaid, reference, phone: phone ?? undefined })).providerTxId; // payUrl is rebuilt from the id on later views
    else providerTxId = (await ctx.provider.initiateStkPush({ phone: phone!, amount: fee.amountPaid, reference, method })).providerTxId;
    const id = ctx.newId('sal');
    const now = nowIso();
    let receiptNo = '';
    await ctx.db.tx(async (q) => {
      for (const l of lines) {
        const n = Number((await q.query<any>(`SELECT COALESCE(SUM(qty),0) AS n FROM shop_movements WHERE item_id=$1`, [l.itemId]))[0].n);
        if (n < l.qty) throw new HttpError(409, `Only ${n} of "${l.item.name}" left`, 'out_of_stock');
      }
      const count = Number((await q.query<any>(`SELECT count(*) AS n FROM shop_sales WHERE branch_id=$1`, [branch.id]))[0].n);
      receiptNo = `${branch.code}-${String(count + 1).padStart(5, '0')}`;
      await q.query(
        `INSERT INTO shop_sales (id, code, receipt_no, org_id, branch_id, buyer_name, buyer_membership_id, buyer_phone, method, status, total, provider_tx_id, hold_until, sold_by, created_at, channel, advert_id, buyer_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'awaiting_payment',$10,$11,$12,$13,$14,'app',$15,$16)`,
        [id, code, receiptNo, branch.org_id, branch.id, m.full_name, m.id, phone, method, total, providerTxId, new Date(ctx.clock.now().getTime() + HOLD_MINUTES * 60_000).toISOString(), uid, now, advert?.id ?? null, uid],
      );
      for (const l of lines) {
        await q.query(`INSERT INTO shop_sale_lines (sale_id, item_id, name, qty, unit_price, unit_cost) VALUES ($1,$2,$3,$4,$5,$6)`, [id, l.itemId, l.item.name, l.qty, l.item.price, l.item.cost]);
        await move(q, { orgId: branch.org_id, branchId: branch.id, itemId: l.itemId, kind: 'sold', qty: -l.qty, saleId: id, by: uid });
      }
      await q.query(`INSERT INTO give_intents (id, provider_tx_id, org_id, branch_id, purpose, project_id, phone, method, base_amount, amount_paid, fee, created_at) VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,$11)`,
        [ctx.newId('int'), providerTxId, branch.org_id, branch.id, `SHOP-${code}`, phone ?? '', method, total, fee.amountPaid, JSON.stringify(fee), now]);
    });
    await ctx.ledger.audit({ orgId: branch.org_id, branchId: branch.id, actor: uid, action: 'shop.order', entity: 'shop_sale', entityId: id, summary: `A member ordered ${lines.map((l) => `${l.qty} x ${l.item.name}`).join(', ')} for ${kesText(total)} from the app, receipt ${receiptNo}`, meta: { total, method, receipt: receiptNo, advert: advert?.id ?? null } });
    const sale = (await ctx.db.query<any>(`${SALE_SELECT} WHERE s.id=$1`, [id]))[0];
    return { ...(await orderView(sale)), message: method === 'card' ? 'Open the card page to pay. Your items are held for 30 minutes.' : 'Check your phone and enter your PIN. Your items are held for 30 minutes.' };
  });

  app.get('/me/shop/orders', auth, async (req) => {
    const rows = await ctx.db.query<any>(`${SALE_SELECT} WHERE s.buyer_user_id=$1 AND s.channel='app' ORDER BY s.created_at DESC LIMIT 50`, [req.session!.uid]);
    const out = [];
    for (const s of rows) out.push(await orderView(s));
    return out;
  });

  app.post('/me/shop/orders/:id/cancel', auth, async (req) => {
    const s = (await ctx.db.query<any>(`${SALE_SELECT} WHERE s.id=$1 AND s.buyer_user_id=$2`, [(req.params as any).id, req.session!.uid]))[0];
    if (!s) throw new HttpError(404, 'order not found', 'not_found');
    if (s.status !== 'awaiting_payment') throw new HttpError(409, 'Only an order that is waiting for payment can be cancelled', 'wrong_state');
    await ctx.db.tx(async (q) => {
      await q.query(`UPDATE shop_sales SET status='lapsed', void_reason='Cancelled by the buyer', voided_by=$2, voided_at=$3 WHERE id=$1`, [s.id, req.session!.uid, nowIso()]);
      await releaseStock(q, s, 'released', req.session!.uid, 'Order cancelled before payment');
    });
    await ctx.ledger.audit({ orgId: s.org_id, branchId: s.branch_id, actor: req.session!.uid, action: 'shop.cancel', entity: 'shop_sale', entityId: s.id, summary: `The buyer cancelled the unpaid order ${s.receipt_no}` });
    return { id: s.id, state: 'lapsed' };
  });

  // ---------- the branch fulfils orders ----------

  app.get('/shop/orders', auth, async (req) => {
    const q = req.query as any;
    const sc = await scope(req, 'shop.sell', q.branch);
    const params: unknown[] = [sc.orgId, sc.branchIds];
    let where = `s.org_id=$1 AND s.branch_id = ANY($2::text[]) AND s.channel='app'`;
    const state = String(q.state ?? 'open');
    if (state === 'open') where += ` AND s.status='completed' AND s.fulfilment IN ('to_prepare','ready')`;
    else if (['to_prepare', 'ready', 'collected'].includes(state)) { params.push(state); where += ` AND s.status='completed' AND s.fulfilment=$${params.length}`; }
    else if (state === 'waiting') where += ` AND s.status='awaiting_payment'`;
    const term = String(q.q ?? '').trim().slice(0, 60);
    if (term) { params.push(`%${term.replace(/[!%_]/g, (c) => `!${c}`)}%`); where += ` AND (s.receipt_no ILIKE $${params.length} ESCAPE '!' OR s.code ILIKE $${params.length} ESCAPE '!' OR s.buyer_name ILIKE $${params.length} ESCAPE '!')`; }
    const rows = await ctx.db.query<any>(`${SALE_SELECT} WHERE ${where} ORDER BY s.created_at DESC LIMIT 200`, params);
    const out = [];
    for (const s of rows) out.push(await orderView(s, true));
    return out;
  });

  app.post('/shop/orders/:id/ready', auth, async (req) => {
    const s = await saleRow(req, (req.params as any).id, 'shop.sell');
    if (s.channel !== 'app' || s.status !== 'completed' || s.fulfilment !== 'to_prepare') throw new HttpError(409, 'This order is not waiting to be prepared', 'wrong_state');
    await ctx.db.query(`UPDATE shop_sales SET fulfilment='ready', ready_at=$2 WHERE id=$1`, [s.id, nowIso()]);
    await ctx.ledger.audit({ orgId: s.org_id, branchId: s.branch_id, actor: req.session!.uid, action: 'shop.order_ready', entity: 'shop_sale', entityId: s.id, summary: `Order ${s.receipt_no} is ready for collection` });
    if (s.buyer_user_id) await addNotification(ctx, { orgId: s.org_id, userId: s.buyer_user_id, kind: 'announcement', title: 'Your order is ready', body: `Order ${s.receipt_no} is ready to collect at ${s.branch_name}. Show your collection code ${s.code}.`, link: 'member:shop' });
    return { id: s.id, state: 'ready' };
  });

  app.post('/shop/orders/:id/collected', auth, async (req) => {
    const s = await saleRow(req, (req.params as any).id, 'shop.sell');
    if (s.channel !== 'app' || s.status !== 'completed' || !['to_prepare', 'ready'].includes(s.fulfilment)) throw new HttpError(409, 'This order is not waiting for collection', 'wrong_state');
    const code = String((req.body as any)?.code ?? '').trim();
    if (code && code.toUpperCase() !== s.code) throw new HttpError(409, 'That collection code does not match this order', 'wrong_code');
    await ctx.db.query(`UPDATE shop_sales SET fulfilment='collected', collected_at=$2 WHERE id=$1`, [s.id, nowIso()]);
    await ctx.ledger.audit({ orgId: s.org_id, branchId: s.branch_id, actor: req.session!.uid, action: 'shop.order_collected', entity: 'shop_sale', entityId: s.id, summary: `Order ${s.receipt_no} was collected` });
    return { id: s.id, state: 'collected' };
  });

  // ======================= reports (L161) =======================

  app.get('/shop/reports', auth, async (req) => {
    const q = req.query as any;
    const sc = await scope(req, 'shop.view', q.branch);
    const manageIds = (await scope(req, 'shop.manage', q.branch).catch(() => null))?.branchIds ?? [];
    const manage = sc.branchIds.every((b) => manageIds.includes(b));
    const to = q.to ? new Date(String(q.to)).toISOString() : nowIso();
    const from = q.from ? new Date(String(q.from)).toISOString() : new Date(Date.parse(to) - 30 * 86400_000).toISOString();
    const base = [sc.orgId, sc.branchIds, from, to];
    const W = `s.org_id=$1 AND s.branch_id = ANY($2::text[]) AND s.status='completed' AND s.completed_at >= $3 AND s.completed_at <= $4`;
    const totals = (await ctx.db.query<any>(`SELECT count(*)::int AS sales, COALESCE(SUM(s.total),0) AS revenue FROM shop_sales s WHERE ${W}`, base))[0];
    const lineTot = (await ctx.db.query<any>(`SELECT COALESCE(SUM(l.qty),0)::int AS units, COALESCE(SUM(l.qty * l.unit_cost),0) AS cost, COUNT(*) FILTER (WHERE l.unit_cost IS NULL)::int AS unknown FROM shop_sale_lines l JOIN shop_sales s ON s.id=l.sale_id WHERE ${W}`, base))[0];
    const byDayRows = await ctx.db.query<any>(`SELECT to_char((s.completed_at::timestamptz AT TIME ZONE 'Africa/Nairobi'), 'YYYY-MM-DD') AS day, count(*)::int AS sales, SUM(s.total) AS revenue FROM shop_sales s WHERE ${W} GROUP BY 1 ORDER BY 1`, base);
    const byItem = await ctx.db.query<any>(`SELECT l.item_id, l.name, SUM(l.qty)::int AS units, SUM(l.qty * l.unit_price) AS revenue, SUM(l.qty * l.unit_cost) AS cost FROM shop_sale_lines l JOIN shop_sales s ON s.id=l.sale_id WHERE ${W} GROUP BY l.item_id, l.name ORDER BY revenue DESC LIMIT 50`, base);
    const byCategory = await ctx.db.query<any>(`SELECT COALESCE(i.category,'Other') AS category, SUM(l.qty)::int AS units, SUM(l.qty * l.unit_price) AS revenue FROM shop_sale_lines l JOIN shop_sales s ON s.id=l.sale_id JOIN shop_items i ON i.id=l.item_id WHERE ${W} GROUP BY 1 ORDER BY revenue DESC`, base);
    const byMethod = await ctx.db.query<any>(`SELECT s.method, count(*)::int AS sales, SUM(s.total) AS revenue FROM shop_sales s WHERE ${W} GROUP BY 1 ORDER BY revenue DESC`, base);
    const items = await ctx.db.query<any>(`SELECT * FROM shop_items WHERE org_id=$1 AND branch_id = ANY($2::text[]) AND active`, [sc.orgId, sc.branchIds]);
    const stock = await stockOf(items.map((i) => i.id));
    const low = items.map((i) => ({ id: i.id, name: i.name, stock: stock.get(i.id) ?? 0, lowStock: i.low_stock })).filter((i) => i.stock <= i.lowStock).sort((a, b) => a.stock - b.stock);
    const revenue = Number(totals.revenue);
    const cost = Number(lineTot.cost);
    return {
      from, to,
      totals: { sales: totals.sales, revenue, units: lineTot.units, ...(manage ? { cost, margin: revenue - cost, costUnknownLines: lineTot.unknown } : {}) },
      byDay: byDayRows.map((r) => ({ day: r.day, sales: r.sales, revenue: Number(r.revenue) })),
      byItem: byItem.map((r) => ({ itemId: r.item_id, name: r.name, units: r.units, revenue: Number(r.revenue), ...(manage && r.cost != null ? { margin: Number(r.revenue) - Number(r.cost) } : {}) })),
      byCategory: byCategory.map((r) => ({ category: r.category, units: r.units, revenue: Number(r.revenue) })),
      byMethod: byMethod.map((r) => ({ method: r.method, sales: r.sales, revenue: Number(r.revenue) })),
      lowStock: low,
      stockValue: manage ? items.reduce((s, i) => s + (stock.get(i.id) ?? 0) * Number(i.cost ?? 0), 0) : null,
      canSeeCost: manage,
    };
  });
}

/** A mobile or card payment arrived for SHOP-code: the sale is complete (L158). */
export async function shopPaid(ctx: Ctx, code: string, paymentId: string): Promise<void> {
  const now = ctx.clock.now().toISOString();
  const s = (await ctx.db.query<any>(`SELECT * FROM shop_sales WHERE code=$1`, [code]))[0];
  if (!s || s.status === 'completed' || s.status === 'voided') return;
  if (s.status === 'awaiting_payment') {
    await ctx.db.query(`UPDATE shop_sales SET status='completed', payment_id=$2, completed_at=$3, hold_until=NULL WHERE id=$1`, [s.id, paymentId, now]);
    await ctx.ledger.audit({ orgId: s.org_id, branchId: s.branch_id, actorType: 'psp', action: 'shop.sale_paid', entity: 'shop_sale', entityId: s.id, summary: `Payment received for the sale ${s.receipt_no}`, links: { paymentId } });
  } else {
    // The payment came after the hold ran out. Complete the sale if the stock is still there, otherwise flag it for a refund.
    const lines = await ctx.db.query<any>(`SELECT item_id, qty FROM shop_sale_lines WHERE sale_id=$1`, [s.id]);
    let enough = true;
    for (const l of lines) {
      const n = Number((await ctx.db.query<any>(`SELECT COALESCE(SUM(qty),0) AS n FROM shop_movements WHERE item_id=$1`, [l.item_id]))[0].n);
      if (n < Number(l.qty)) enough = false;
    }
    if (!enough) {
      await ctx.db.query(`UPDATE shop_sales SET payment_id=$2 WHERE id=$1`, [s.id, paymentId]);
      await ctx.ledger.audit({ orgId: s.org_id, branchId: s.branch_id, actorType: 'psp', action: 'shop.paid_late', entity: 'shop_sale', entityId: s.id, summary: `Payment arrived for the lapsed sale ${s.receipt_no} but the stock is gone. Arrange a refund.`, links: { paymentId } });
      return;
    }
    await ctx.db.tx(async (q) => {
      await q.query(`UPDATE shop_sales SET status='completed', payment_id=$2, completed_at=$3, hold_until=NULL, void_reason=NULL WHERE id=$1`, [s.id, paymentId, now]);
      for (const l of lines) await q.query(`INSERT INTO shop_movements (id, org_id, branch_id, item_id, kind, qty, sale_id, reason, created_by, created_at) VALUES ($1,$2,$3,$4,'sold',$5,$6,'Paid after the hold ended',$7,$8)`, [ctx.newId('mov'), s.org_id, s.branch_id, l.item_id, -Number(l.qty), s.id, s.sold_by, now]);
    });
    await ctx.ledger.audit({ orgId: s.org_id, branchId: s.branch_id, actorType: 'psp', action: 'shop.sale_paid', entity: 'shop_sale', entityId: s.id, summary: `Payment received for the sale ${s.receipt_no} after its hold ended. The stock was still there, so it is complete.`, links: { paymentId } });
  }
  if (s.channel === 'app') {
    await ctx.db.query(`UPDATE shop_sales SET fulfilment='to_prepare' WHERE id=$1 AND fulfilment IS NULL`, [s.id]);
    const branch = (await ctx.db.query<any>(`SELECT name FROM branches WHERE id=$1`, [s.branch_id]))[0];
    // Tell the people at the branch there is an order to prepare.
    const rows = await ctx.db.query<any>(`SELECT ra.user_id, ra.scope_type, ra.scope_id, r.permissions FROM role_assignments ra JOIN roles r ON r.id=ra.role_id WHERE ra.org_id=$1`, [s.org_id]);
    const region = (await ctx.db.query<any>(`SELECT region FROM branches WHERE id=$1`, [s.branch_id]))[0]?.region;
    const staff = [...new Set(rows.filter((r) => (r.permissions as string[]).includes('shop.sell') && (r.scope_type === 'org' || (r.scope_type === 'branch' && r.scope_id === s.branch_id) || (r.scope_type === 'region' && r.scope_id === region))).map((r) => r.user_id as string))];
    for (const u of staff) await addNotification(ctx, { orgId: s.org_id, userId: u, kind: 'announcement', title: 'New shop order', body: `${s.buyer_name ?? 'A member'} paid ${kesText(Number(s.total))} for order ${s.receipt_no}. Prepare it for collection.`, link: `staff:shop?open=${s.id}`, audience: 'staff' });
    if (s.buyer_user_id) await addNotification(ctx, { orgId: s.org_id, userId: s.buyer_user_id, kind: 'receipt', title: 'Shop order paid', body: `Thank you. Receipt ${s.receipt_no}, ${kesText(Number(s.total))}. Collect it at ${branch?.name ?? 'the shop'} with your code ${s.code}. We will tell you when it is ready.`, link: 'member:shop' });
    return;
  }
  if (s.buyer_membership_id) {
    const u = (await ctx.db.query<any>(`SELECT user_id FROM memberships WHERE id=$1`, [s.buyer_membership_id]))[0]?.user_id;
    if (u) await addNotification(ctx, { orgId: s.org_id, userId: u, kind: 'receipt', title: 'Shop receipt', body: `Thank you. Receipt ${s.receipt_no}, ${kesText(Number(s.total))}.`, link: 'member:shop' });
  }
}

/** Waiting sales that were not paid in 30 minutes lapse and their stock goes back on the shelf (L158). */
export async function runShopJobs(ctx: Ctx): Promise<{ lapsed: number }> {
  const now = ctx.clock.now().toISOString();
  const due = await ctx.db.query<any>(`UPDATE shop_sales SET status='lapsed', void_reason='Not paid in time' WHERE status='awaiting_payment' AND hold_until <= $1 RETURNING *`, [now]);
  for (const s of due) {
    const lines = await ctx.db.query<any>(`SELECT item_id, qty FROM shop_sale_lines WHERE sale_id=$1`, [s.id]);
    for (const l of lines) {
      await ctx.db.query(`INSERT INTO shop_movements (id, org_id, branch_id, item_id, kind, qty, sale_id, reason, created_by, created_at) VALUES ($1,$2,$3,$4,'released',$5,$6,'Not paid in time',$7,$8)`, [ctx.newId('mov'), s.org_id, s.branch_id, l.item_id, Number(l.qty), s.id, s.sold_by, now]);
    }
    await ctx.ledger.audit({ orgId: s.org_id, branchId: s.branch_id, actorType: 'system', action: 'shop.lapsed', entity: 'shop_sale', entityId: s.id, summary: `The sale ${s.receipt_no} was not paid in time. The stock was put back.` });
  }
  return { lapsed: due.length };
}
