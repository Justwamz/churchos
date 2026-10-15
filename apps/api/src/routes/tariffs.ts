import type { FastifyInstance } from 'fastify';
import { diff, maskedSnapshot, recordVersion, type FieldSpec } from '../audit';
import { HttpError, requireAdmin, type Ctx } from '../ctx';
import { costOf, unitPrices, validateBands, validateTariff, type Band, type TariffBands } from '../pricing';

const TARIFF_SPECS: FieldSpec[] = [
  { field: 'name', label: 'Name' },
  { field: 'smsBands', label: 'SMS price bands' },
  { field: 'whatsappBands', label: 'WhatsApp price bands' },
  { field: 'effectiveFrom', label: 'Takes effect' },
];

const bandText = (bands: Band[]) => bands.map((b, i) => `${i === 0 ? 0 : (bands[i - 1].upTo as number) + 1}${b.upTo === null ? '+' : `-${b.upTo}`} at ${(b.price / 100).toFixed(2)}`).join(', ');

/** The platform's own tariff screens (L124). Everything here is platform admin only. */
export function tariffRoutes(app: FastifyInstance, ctx: Ctx) {
  const adm = { preHandler: requireAdmin };

  async function describe(t: any) {
    const versions = await ctx.db.query<any>(`SELECT version, effective_from, bands, note, created_at FROM tariff_versions WHERE tariff_id=$1 ORDER BY version`, [t.id]);
    const now = ctx.clock.now().toISOString();
    const inForce = [...versions].filter((v) => v.effective_from <= now).sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.version - a.version)[0];
    const assigned = await ctx.db.query<any>(`SELECT o.id, o.name FROM org_tariffs ot JOIN organisations o ON o.id=ot.org_id WHERE ot.tariff_id=$1 ORDER BY o.name`, [t.id]);
    const onDefault = t.is_default
      ? await ctx.db.query<any>(`SELECT o.id, o.name FROM organisations o WHERE NOT EXISTS (SELECT 1 FROM org_tariffs ot WHERE ot.org_id=o.id) ORDER BY o.name`)
      : [];
    return {
      id: t.id, name: t.name, isDefault: t.is_default,
      current: inForce ? { version: inForce.version, effectiveFrom: inForce.effective_from, bands: inForce.bands } : null,
      versions: versions.map((v) => ({ version: v.version, effectiveFrom: v.effective_from, bands: v.bands, note: v.note, createdAt: v.created_at, inForce: inForce?.version === v.version, scheduled: v.effective_from > now })),
      churches: [...assigned, ...onDefault],
    };
  }

  function effective(raw: unknown, latest?: string): string {
    const now = ctx.clock.now();
    if (raw === undefined || raw === null || raw === '') return now.toISOString();
    const t = Date.parse(String(raw));
    if (Number.isNaN(t)) throw new HttpError(400, 'Choose a valid date for the change to take effect', 'bad_date');
    if (t < now.getTime() - 60_000) throw new HttpError(400, 'A new price cannot start in the past. Past charges are never changed.', 'in_past');
    const iso = new Date(Math.max(t, now.getTime())).toISOString();
    if (latest && iso <= latest && iso > now.toISOString()) throw new HttpError(400, 'Choose a date after the latest scheduled change', 'bad_date');
    return iso;
  }

  app.get('/admin/tariffs', adm, async () => {
    const rows = await ctx.db.query<any>(`SELECT * FROM tariffs ORDER BY is_default DESC, name`);
    const out = [];
    for (const t of rows) out.push(await describe(t));
    return out;
  });

  app.post('/admin/tariffs', adm, async (req) => {
    const b = (req.body ?? {}) as any;
    const name = String(b.name ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 60) throw new HttpError(400, 'Give the tariff a name of 2 to 60 characters', 'bad_name');
    if ((await ctx.db.query<any>(`SELECT 1 FROM tariffs WHERE lower(name)=lower($1)`, [name]))[0]) throw new HttpError(409, 'A tariff with that name already exists', 'duplicate');
    const bands = validateTariff(b.bands);
    const from = effective(b.effectiveFrom);
    const id = ctx.newId('tar');
    const now = ctx.clock.now().toISOString();
    await ctx.db.query(`INSERT INTO tariffs (id, name, is_default, created_at) VALUES ($1,$2,false,$3)`, [id, name, now]);
    await ctx.db.query(`INSERT INTO tariff_versions (id, tariff_id, version, effective_from, bands, note, created_by, created_at) VALUES ($1,$2,1,$3,$4,$5,$6,$7)`, [ctx.newId('tvr'), id, from, JSON.stringify(bands), b.note ? String(b.note).slice(0, 200) : null, req.session!.uid, now]);
    const flat = { name, smsBands: bandText(bands.sms), whatsappBands: bandText(bands.whatsapp), effectiveFrom: from };
    const evt = await ctx.ledger.audit({ actor: req.session!.uid, action: 'tariff.create', category: 'config', entity: 'tariff', entityId: id, summary: `Created the tariff ${name}`, changes: diff(TARIFF_SPECS, null, flat) });
    await recordVersion(ctx, { orgId: 'platform', entity: 'tariff', entityId: id, snapshot: maskedSnapshot(TARIFF_SPECS, flat), summary: 'Created', eventId: evt });
    return { id };
  });

  /** Changing prices creates a new version with an effective date. Charges already made are never rewritten. */
  app.put('/admin/tariffs/:id', adm, async (req) => {
    const b = (req.body ?? {}) as any;
    const t = (await ctx.db.query<any>(`SELECT * FROM tariffs WHERE id=$1`, [(req.params as any).id]))[0];
    if (!t) throw new HttpError(404, 'tariff not found', 'not_found');
    const bands = validateTariff(b.bands);
    const versions = await ctx.db.query<any>(`SELECT version, effective_from, bands FROM tariff_versions WHERE tariff_id=$1 ORDER BY version DESC`, [t.id]);
    const latest = versions[0];
    const from = effective(b.effectiveFrom, latest.effective_from);
    const before = { name: t.name, smsBands: bandText(latest.bands.sms), whatsappBands: bandText(latest.bands.whatsapp), effectiveFrom: latest.effective_from };
    const after = { name: t.name, smsBands: bandText(bands.sms), whatsappBands: bandText(bands.whatsapp), effectiveFrom: from };
    const changes = diff(TARIFF_SPECS, before, after).filter((c) => c.field !== 'effectiveFrom' || true);
    if (!changes.some((c) => c.field === 'smsBands' || c.field === 'whatsappBands')) throw new HttpError(409, 'The prices are the same as the current version', 'no_change');
    const version = latest.version + 1;
    await ctx.db.query(`INSERT INTO tariff_versions (id, tariff_id, version, effective_from, bands, note, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [ctx.newId('tvr'), t.id, version, from, JSON.stringify(bands), b.note ? String(b.note).slice(0, 200) : null, req.session!.uid, ctx.clock.now().toISOString()]);
    const evt = await ctx.ledger.audit({ actor: req.session!.uid, action: 'tariff.update', category: 'config', entity: 'tariff', entityId: t.id, summary: `Changed the prices in ${t.name}, from ${from}`, changes, reason: b.note ? String(b.note).slice(0, 200) : null });
    await recordVersion(ctx, { orgId: 'platform', entity: 'tariff', entityId: t.id, snapshot: maskedSnapshot(TARIFF_SPECS, after), summary: changes.map((c) => c.label).join(', '), eventId: evt });
    return { id: t.id, version, effectiveFrom: from };
  });

  app.post('/admin/tariffs/:id/default', adm, async (req) => {
    const t = (await ctx.db.query<any>(`SELECT * FROM tariffs WHERE id=$1`, [(req.params as any).id]))[0];
    if (!t) throw new HttpError(404, 'tariff not found', 'not_found');
    await ctx.db.tx(async (q) => {
      await q.query(`UPDATE tariffs SET is_default=false WHERE is_default`);
      await q.query(`UPDATE tariffs SET is_default=true WHERE id=$1`, [t.id]);
    });
    await ctx.ledger.audit({ actor: req.session!.uid, action: 'tariff.default', category: 'config', entity: 'tariff', entityId: t.id, summary: `Made ${t.name} the default tariff for churches without their own` });
    return { ok: true };
  });

  /** Gives one church its own tariff, or sends it back to the default (null). */
  app.put('/admin/orgs/:orgId/tariff', adm, async (req) => {
    const orgId = (req.params as any).orgId;
    const tariffId = (req.body as any)?.tariffId ?? null;
    const org = (await ctx.db.query<any>(`SELECT id, name FROM organisations WHERE id=$1`, [orgId]))[0];
    if (!org) throw new HttpError(404, 'church not found', 'not_found');
    const prev = (await ctx.db.query<any>(`SELECT t.name FROM org_tariffs ot JOIN tariffs t ON t.id=ot.tariff_id WHERE ot.org_id=$1`, [orgId]))[0];
    let nextName = 'the default tariff';
    if (tariffId === null) await ctx.db.query(`DELETE FROM org_tariffs WHERE org_id=$1`, [orgId]);
    else {
      const t = (await ctx.db.query<any>(`SELECT id, name FROM tariffs WHERE id=$1`, [tariffId]))[0];
      if (!t) throw new HttpError(404, 'tariff not found', 'not_found');
      nextName = t.name;
      await ctx.db.query(`INSERT INTO org_tariffs (org_id, tariff_id) VALUES ($1,$2) ON CONFLICT (org_id) DO UPDATE SET tariff_id=$2`, [orgId, tariffId]);
    }
    await ctx.ledger.audit({ orgId, actor: req.session!.uid, action: 'tariff.assign', category: 'config', entity: 'organisation', entityId: orgId, summary: `Put ${org.name} on ${nextName}`, changes: [{ field: 'tariff', label: 'Tariff', before: prev?.name ?? 'Default', after: tariffId === null ? 'Default' : nextName }] });
    return { ok: true };
  });

  /** A calculator for the admin screen: what would N messages cost after U already this month? */
  app.post('/admin/tariffs/quote', adm, async (req) => {
    const b = (req.body ?? {}) as any;
    const bands = validateBands(b.bands, 'Bands');
    const used = Math.max(0, Math.floor(Number(b.used ?? 0)));
    const count = Math.floor(Number(b.count));
    if (!Number.isFinite(count) || count < 1 || count > 1_000_000) throw new HttpError(400, 'Enter a number of messages between 1 and 1,000,000', 'bad_count');
    const prices = unitPrices(bands, used, Math.min(count, 200_000));
    const breakdown: { from: number; to: number; price: number; units: number; cost: number }[] = [];
    prices.forEach((p, i) => {
      const last = breakdown[breakdown.length - 1];
      if (last && last.price === p) { last.to = used + i + 1; last.units++; last.cost += p; }
      else breakdown.push({ from: used + i + 1, to: used + i + 1, price: p, units: 1, cost: p });
    });
    return { total: costOf(bands, used, count), average: Math.round(costOf(bands, used, count) / count), breakdown };
  });

  void (null as unknown as TariffBands);
}
