import { HttpError, type Ctx } from './ctx';
import type { Channel } from './wallets';

/**
 * Message prices (L124, L125). A tariff has volume bands per channel. The price of each message depends on how many messages the
 * church has already sent that month, so bands are marginal: with the first 3,500 at 95 cents and the next at 85, message number
 * 3,501 costs 85 and message 3,500 costs 95.
 */
export interface Band {
  /** Highest unit number this band covers in a month, or null for "and above". */
  upTo: number | null;
  /** Price of one unit in cents. */
  price: number;
}
export interface TariffBands {
  sms: Band[];
  whatsapp: Band[];
}

export const CHANNELS_PRICED: Channel[] = ['sms', 'whatsapp'];
const MAX_PRICE = 10_000; // KES 100 per message is far beyond any real price, so it catches typing slips

export function validateBands(raw: unknown, label: string): Band[] {
  const bands = Array.isArray(raw) ? raw : [];
  if (bands.length === 0) throw new HttpError(400, `${label}: add at least one price band`, 'bad_bands');
  if (bands.length > 8) throw new HttpError(400, `${label}: use at most 8 bands`, 'bad_bands');
  const out: Band[] = [];
  let prev = 0;
  bands.forEach((b: any, i) => {
    const last = i === bands.length - 1;
    const price = Number(b?.price);
    if (!Number.isInteger(price) || price < 1 || price > MAX_PRICE) throw new HttpError(400, `${label}: the price in band ${i + 1} must be between KES 0.01 and KES 100`, 'bad_bands');
    let upTo: number | null = null;
    if (last) {
      if (b?.upTo !== null && b?.upTo !== undefined && b?.upTo !== '') throw new HttpError(400, `${label}: the last band must be open-ended ("and above")`, 'bad_bands');
    } else {
      upTo = Number(b?.upTo);
      if (!Number.isInteger(upTo) || upTo <= prev) throw new HttpError(400, `${label}: each band must end after the one before it`, 'bad_bands');
      prev = upTo;
    }
    out.push({ upTo, price });
  });
  return out;
}

export function validateTariff(raw: any): TariffBands {
  return { sms: validateBands(raw?.sms, 'SMS'), whatsapp: validateBands(raw?.whatsapp, 'WhatsApp') };
}

/** The price, in cents, of each of the next `n` units when `used` have already been sent this month. */
export function unitPrices(bands: Band[], used: number, n: number): number[] {
  const out: number[] = [];
  let i = 0;
  for (let u = used + 1; u <= used + n; u++) {
    while (i < bands.length - 1 && bands[i].upTo !== null && u > (bands[i].upTo as number)) i++;
    out.push(bands[i].price);
  }
  return out;
}

export const costOf = (bands: Band[], used: number, n: number) => unitPrices(bands, used, n).reduce((a, b) => a + b, 0);

/**
 * Walks recipients in order, giving each `unitsEach` units, until the balance cannot pay for the next one. Returns what each
 * paid recipient costs, so a failed delivery can be refunded exactly.
 */
export function allocate(bands: Band[], used: number, balance: number, people: number, unitsEach: number) {
  const costs: number[] = [];
  let spent = 0;
  let u = used;
  for (let p = 0; p < people; p++) {
    const c = costOf(bands, u, unitsEach);
    if (spent + c > balance) break;
    costs.push(c);
    spent += c;
    u += unitsEach;
  }
  return { costs, spent, usedAfter: u };
}

/** The price of the next unit and where the next band starts, for showing on screens. */
export function nextBandInfo(bands: Band[], used: number) {
  const prices = unitPrices(bands, used, 1);
  let i = 0;
  while (i < bands.length - 1 && bands[i].upTo !== null && used + 1 > (bands[i].upTo as number)) i++;
  const cur = bands[i];
  const next = bands[i + 1];
  return {
    currentPrice: prices[0],
    unitsLeftInBand: cur.upTo === null ? null : (cur.upTo as number) - used,
    nextPrice: next ? next.price : null,
  };
}

// ---------- which tariff applies, and this month's usage ----------

export function monthKey(ctx: Ctx): string {
  const eat = new Date(ctx.clock.now().getTime() + 3 * 3600_000);
  return `${eat.getUTCFullYear()}-${String(eat.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The tariff a church is on: its own if one is assigned, otherwise the platform default. */
export async function tariffIdFor(ctx: Ctx, orgId: string): Promise<string> {
  const own = (await ctx.db.query<any>(`SELECT tariff_id FROM org_tariffs WHERE org_id=$1`, [orgId]))[0];
  if (own) return own.tariff_id;
  const def = (await ctx.db.query<any>(`SELECT id FROM tariffs WHERE is_default LIMIT 1`))[0];
  if (!def) throw new HttpError(500, 'No default tariff is set', 'no_tariff');
  return def.id;
}

/** The bands in force right now (a version with a future start date is not used until then). Past charges are never rewritten. */
export async function activeBands(ctx: Ctx, orgId: string, channel: Channel): Promise<Band[]> {
  const tid = await tariffIdFor(ctx, orgId);
  const v = (
    await ctx.db.query<any>(`SELECT bands FROM tariff_versions WHERE tariff_id=$1 AND effective_from <= $2 ORDER BY effective_from DESC, version DESC LIMIT 1`, [tid, ctx.clock.now().toISOString()])
  )[0];
  if (!v) throw new HttpError(500, 'The tariff has no active version', 'no_tariff');
  return (v.bands as TariffBands)[channel];
}

export async function unitsUsed(ctx: Ctx, orgId: string, channel: Channel): Promise<number> {
  const r = (await ctx.db.query<any>(`SELECT units FROM message_usage WHERE org_id=$1 AND channel=$2 AND month=$3`, [orgId, channel, monthKey(ctx)]))[0];
  return Number(r?.units ?? 0);
}

export async function recordUnits(ctx: Ctx, orgId: string, channel: Channel, units: number): Promise<void> {
  if (units <= 0) return;
  await ctx.db.query(
    `INSERT INTO message_usage (org_id, channel, month, units) VALUES ($1,$2,$3,$4) ON CONFLICT (org_id, channel, month) DO UPDATE SET units = message_usage.units + $4`,
    [orgId, channel, monthKey(ctx), units],
  );
}

/** Everything a screen needs about a church's price for a channel right now. */
export async function priceInfo(ctx: Ctx, orgId: string, channel: Channel) {
  const bands = await activeBands(ctx, orgId, channel);
  const used = await unitsUsed(ctx, orgId, channel);
  return { bands, used, month: monthKey(ctx), ...nextBandInfo(bands, used) };
}

/** How many messages a balance buys at today's position in the bands (each message one unit). */
export function messagesBuyable(bands: Band[], used: number, balance: number): number {
  let n = 0;
  let u = used;
  let left = balance;
  // Walk band by band, which is much faster than unit by unit for large balances.
  for (let i = 0; i < bands.length && left > 0; i++) {
    const b = bands[i];
    if (b.upTo !== null && u >= (b.upTo as number)) continue;
    const room = b.upTo === null ? Infinity : (b.upTo as number) - u;
    const k = Math.min(room, Math.floor(left / b.price));
    n += k;
    left -= k * b.price;
    u += k;
    if (b.upTo !== null && k < room) break; // the balance ran out inside this band
  }
  return n;
}
