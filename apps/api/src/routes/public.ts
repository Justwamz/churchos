import type { FastifyInstance } from 'fastify';
import { networkMismatch } from '@churchos/shared';
import { buildReference, computeFee, normalizeMethod, toCents } from './helpers';
import { normalizePhone } from '../auth';
import { HttpError, type Ctx } from '../ctx';

const MIN_CENTS = 1000; // KES 10
const MAX_CENTS = 15_000_000; // KES 150,000 per transaction

export async function churchByCode(ctx: Ctx, code: string) {
  const rows = await ctx.db.query<any>(
    `SELECT b.id, b.code, b.name, b.region, b.org_id, o.name AS org_name, o.fee_bearer, o.fee_schedule
       FROM branches b JOIN organisations o ON o.id = b.org_id WHERE b.code = $1`,
    [String(code ?? '').trim().toUpperCase()],
  );
  return rows[0];
}

export function publicRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/public/church/:code', async (req) => {
    const b = await churchByCode(ctx, (req.params as any).code);
    if (!b) throw new HttpError(404, 'We could not find a church with that code', 'unknown_church');
    const projects = await ctx.db.query<any>(
      `SELECT p.id, p.code, p.name, p.description, p.target, p.deadline,
              COALESCE((SELECT SUM(amount_paid - psp_cost - platform_fee) FROM payments WHERE project_id = p.id AND stage IN ('pending','available','paid_out')),0) AS raised
         FROM projects p WHERE p.branch_id = $1 AND p.status = 'open' ORDER BY p.created_at`,
      [b.id],
    );
    return {
      code: b.code,
      name: b.name,
      organisation: b.org_name,
      feeBearer: b.fee_bearer,
      purposes: [
        { key: 'TITHE', label: 'Tithe' },
        { key: 'OFFERING', label: 'Offering' },
        ...projects.map((p) => ({ key: `PROJ-${p.code}`, label: p.name })),
      ],
      projects: projects.map((p) => ({ code: p.code, name: p.name, description: p.description, target: p.target, deadline: p.deadline, raised: p.raised })),
      methods: ['mpesa', 'airtel', 'tkash', 'card'],
      paybill: { number: '888880', accountReference: `${b.code}#TITHE` },
    };
  });

  app.get('/public/fee', async (req) => {
    const q = req.query as any;
    const b = await churchByCode(ctx, q.code);
    if (!b) throw new HttpError(404, 'unknown church', 'unknown_church');
    const base = toCents(q.amount);
    const fee = computeFee(b.fee_schedule, normalizeMethod(q.method), base, b.fee_bearer);
    return { bearer: b.fee_bearer, amountPaid: fee.amountPaid, memberFee: b.fee_bearer === 'member' ? fee.totalFee : 0 };
  });

  app.post('/public/give', async (req) => {
    const body = (req.body ?? {}) as any;
    const b = await churchByCode(ctx, body.code);
    if (!b) throw new HttpError(404, 'We could not find a church with that code', 'unknown_church');
    const phone = normalizePhone(body.phone);
    if (!phone) throw new HttpError(400, 'Enter a valid Kenyan phone number, for example 0712 345 678', 'bad_phone');
    let base: number;
    try {
      base = toCents(body.amount);
    } catch {
      throw new HttpError(400, 'Enter a valid amount', 'bad_amount');
    }
    if (base < MIN_CENTS) throw new HttpError(400, 'The minimum gift is KES 10', 'amount_too_small');
    if (base > MAX_CENTS) throw new HttpError(400, 'The maximum for one gift is KES 150,000', 'amount_too_large');
    const method = normalizeMethod(body.method);
    if (method === 'cash') throw new HttpError(400, 'Cash is recorded by the church, not paid here', 'bad_method');
    // A mobile money prompt can only reach a number on that network (L8).
    const mismatch = networkMismatch(method, phone);
    if (mismatch) throw new HttpError(400, mismatch, 'wrong_network');

    const purpose = String(body.purpose ?? 'OFFERING').trim().toUpperCase();
    let projectId: string | null = null;
    if (purpose.startsWith('PROJ-')) {
      const p = (await ctx.db.query<any>(`SELECT id FROM projects WHERE branch_id=$1 AND code=$2 AND status='open'`, [b.id, purpose.slice(5)]))[0];
      if (!p) throw new HttpError(400, 'That project is not open for giving', 'unknown_purpose');
      projectId = p.id;
    } else if (purpose.startsWith('CERT-')) {
      // A priced certificate copy: the amount is fixed by the church, and only an open request can be paid (L102).
      const rec = (await ctx.db.query<any>(`SELECT id FROM sacramental_records WHERE serial=$1 AND branch_id=$2 AND status='approved'`, [purpose.slice(5), b.id]))[0];
      const open = rec ? (await ctx.db.query<any>(`SELECT fee FROM record_issues WHERE record_id=$1 AND status='awaiting_payment' ORDER BY created_at DESC LIMIT 1`, [rec.id]))[0] : null;
      if (!open) throw new HttpError(400, 'That certificate copy is not waiting for payment', 'unknown_purpose');
      if (base !== Number(open.fee)) throw new HttpError(400, `A copy costs KES ${(Number(open.fee) / 100).toLocaleString('en-KE')}. Enter exactly that amount.`, 'amount_must_be_exact');
    } else if (purpose.startsWith('AD-')) {
      // An advertiser paying for a slot: the price is fixed by the church and only an approved advert can be paid for (L131).
      const ad = (await ctx.db.query<any>(`SELECT price FROM adverts WHERE code=$1 AND org_id=$2 AND status='awaiting_payment'`, [purpose.slice(3), b.org_id]))[0];
      if (!ad) throw new HttpError(400, 'That advert is not waiting for payment', 'unknown_purpose');
      if (base !== Number(ad.price)) throw new HttpError(400, `The advert costs KES ${(Number(ad.price) / 100).toLocaleString('en-KE')}. Enter exactly that amount.`, 'amount_must_be_exact');
    } else if (purpose !== 'TITHE' && purpose !== 'OFFERING') {
      throw new HttpError(400, 'Unknown giving purpose', 'unknown_purpose');
    }

    const fee = computeFee(b.fee_schedule, method, base, b.fee_bearer);
    const reference = buildReference(b.code, purpose);
    // Cards are paid on the payment provider's own page, so card details never reach ChurchOS. Mobile money gets a prompt on the phone.
    const isCard = method === 'card';
    const { providerTxId } = isCard
      ? await ctx.provider.initiateCardCheckout({ amount: fee.amountPaid, reference, phone })
      : await ctx.provider.initiateStkPush({ phone, amount: fee.amountPaid, reference, method });
    const intentId = ctx.newId('int');
    await ctx.db.query(
      `INSERT INTO give_intents (id, provider_tx_id, org_id, branch_id, purpose, project_id, phone, method, base_amount, amount_paid, fee, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [intentId, providerTxId, b.org_id, b.id, purpose, projectId, phone, method, base, fee.amountPaid, JSON.stringify(fee), ctx.clock.now().toISOString()],
    );
    if (isCard) {
      return {
        intentId, status: 'initiated', method: 'card',
        checkoutUrl: `${ctx.givingUrl}/checkout/${providerTxId}?gift=${intentId}`,
        message: 'Complete the payment on the secure card page.',
        amountPaid: fee.amountPaid,
        memberFee: b.fee_bearer === 'member' ? fee.totalFee : 0,
      };
    }
    return {
      intentId,
      status: 'initiated',
      message: `Check your phone (${phone.replace(/^254/, '0')}) and enter your PIN to complete the gift.`,
      amountPaid: fee.amountPaid,
      memberFee: b.fee_bearer === 'member' ? fee.totalFee : 0,
    };
  });

  app.get('/public/give/:id', async (req) => {
    const i = (await ctx.db.query<any>(`SELECT g.*, b.name AS church FROM give_intents g JOIN branches b ON b.id = g.branch_id WHERE g.id=$1`, [(req.params as any).id]))[0];
    if (!i) throw new HttpError(404, 'unknown gift', 'not_found');
    return {
      status: i.status,
      church: i.church,
      purpose: i.purpose,
      amountPaid: i.amount_paid,
      receipt: i.status === 'completed' ? i.provider_tx_id : null,
    };
  });
}
