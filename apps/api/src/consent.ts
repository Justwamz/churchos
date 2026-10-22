import type { Ctx } from './ctx';

/**
 * Message consent (AZ-07). Two layers, both keyed by phone:
 * - `contact_prefs`: the person's OWN choice, made in the member app. It applies to every church and always wins.
 * - `contact_prefs_org`: a church's own record (for example "agreed on a form"). Staff only ever write their own church's row.
 * A number may get SMS unless the person opted out themselves or this church recorded an opt-out. WhatsApp needs an opt-in: the
 * person's own, or this church's own record. One church can never change what another church may send.
 */
export interface Consent {
  whatsapp_opt_in: boolean;
  sms_opt_out: boolean;
}

/** What `orgId` may send to each phone. Phones with no record at all get the defaults (SMS allowed, WhatsApp not). */
export async function consentFor(ctx: Ctx, orgId: string, phones: string[]): Promise<Map<string, Consent>> {
  const out = new Map<string, Consent>();
  const list = [...new Set(phones.filter(Boolean))];
  if (!list.length) return out;
  const own = new Map<string, any>();
  for (const p of await ctx.db.query<any>(`SELECT phone, whatsapp_opt_in, sms_opt_out FROM contact_prefs WHERE phone = ANY($1::text[])`, [list])) own.set(p.phone, p);
  const church = new Map<string, any>();
  for (const p of await ctx.db.query<any>(`SELECT phone, whatsapp_opt_in, sms_opt_out FROM contact_prefs_org WHERE org_id=$1 AND phone = ANY($2::text[])`, [orgId, list])) church.set(p.phone, p);
  for (const phone of list) {
    const a = own.get(phone);
    const c = church.get(phone);
    out.set(phone, { sms_opt_out: !!(a?.sms_opt_out || c?.sms_opt_out), whatsapp_opt_in: !!(a?.whatsapp_opt_in || c?.whatsapp_opt_in) });
  }
  return out;
}

export async function consentOf(ctx: Ctx, orgId: string, phone: string): Promise<Consent> {
  return (await consentFor(ctx, orgId, [phone])).get(phone) ?? { sms_opt_out: false, whatsapp_opt_in: false };
}
