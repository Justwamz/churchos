import { randomUUID } from 'node:crypto';
import {
  bpsOf,
  computeFee,
  DEFAULT_FEE_SCHEDULE,
  parseReference,
  type Cents,
  type FeeBearer,
  type FeeResult,
  type FeeSchedule,
  type PaymentMethod,
} from '@churchos/shared';
import type { InboundPayment, PaymentProvider, PayoutDestination } from '@churchos/payments';
import type { Clock } from './clock';
import type { Db } from './db';
import { writeAudit, type AuditInput } from './audit';
import { LEDGER_SCHEMA } from './schema';

export interface LedgerOptions {
  holdHours: number;
  reversalWindowHours: number;
  suspenseHours: number;
  minPayout: Cents;
  debtCapRatio: number;
}

export const DEFAULT_OPTIONS: LedgerOptions = {
  holdHours: 48,
  reversalWindowHours: 72,
  suspenseHours: 48,
  minPayout: 100,
  debtCapRatio: 0.1,
};

/** Debit-normal accounts show sum(postings). Everything else is credit-normal and shows -sum. */
const DEBIT_NORMAL = new Set(['wallet', 'receivable']);
const PLATFORM_KINDS = ['wallet', 'suspense', 'fee_revenue', 'psp_cost_payable', 'in_transit', 'sms_revenue'] as const;
const BRANCH_KINDS = ['pending', 'available', 'receivable'] as const;
export type AccountKind = (typeof PLATFORM_KINDS)[number] | (typeof BRANCH_KINDS)[number] | 'sms_wallet';

export interface Posting {
  accountId: string;
  amount: Cents;
}

export type ReceiveResult =
  | { status: 'matched'; paymentId: string; branchId: string; fee: FeeResult }
  | { status: 'suspense'; paymentId: string }
  | { status: 'duplicate'; paymentId: string };

export class LedgerError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export class Ledger {
  constructor(
    public db: Db,
    public clock: Clock,
    public provider: PaymentProvider,
    opts: Partial<LedgerOptions> = {},
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }
  opts: LedgerOptions;

  // ---------- setup ----------

  async migrate() {
    await this.db.exec(LEDGER_SCHEMA);
    for (const kind of PLATFORM_KINDS) {
      await this.db.query(
        `INSERT INTO accounts (id, org_id, branch_id, kind) VALUES ($1, NULL, NULL, $2) ON CONFLICT DO NOTHING`,
        [`platform:${kind}`, kind],
      );
    }
  }

  async createOrg(o: { id: string; name: string; feeBearer?: FeeBearer; feeSchedule?: FeeSchedule; smsCode?: string }) {
    await this.db.query(
      `INSERT INTO organisations (id, name, fee_bearer, fee_schedule, sms_code, created_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO NOTHING`,
      [o.id, o.name, o.feeBearer ?? 'church', JSON.stringify(o.feeSchedule ?? DEFAULT_FEE_SCHEDULE), o.smsCode?.toUpperCase() ?? null, this.now()],
    );
    // The SMS wallet is one account per organisation (L87), kept apart from collections (L58).
    await this.db.query(`INSERT INTO accounts (id, org_id, branch_id, kind) VALUES ($1,$2,NULL,'sms_wallet') ON CONFLICT DO NOTHING`, [
      `${o.id}:sms_wallet`,
      o.id,
    ]);
  }

  async createBranch(b: {
    id: string;
    orgId: string;
    code: string;
    name: string;
    region?: string;
    payoutDestination?: PayoutDestination;
    payoutVerified?: boolean;
  }) {
    await this.db.tx(async (q) => {
      await q.query(
        `INSERT INTO branches (id, org_id, code, name, region, payout_destination, payout_verified, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [b.id, b.orgId, b.code.toUpperCase(), b.name, b.region ?? null, b.payoutDestination ? JSON.stringify(b.payoutDestination) : null, !!b.payoutVerified, this.now()],
      );
      for (const kind of BRANCH_KINDS) {
        await q.query(`INSERT INTO accounts (id, org_id, branch_id, kind) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [
          `${b.id}:${kind}`,
          b.orgId,
          b.id,
          kind,
        ]);
      }
    });
  }

  now(): string {
    return this.clock.now().toISOString();
  }

  // ---------- core ----------

  accountId(kind: AccountKind, branchId?: string): string {
    return branchId ? `${branchId}:${kind}` : `platform:${kind}`;
  }

  // ---------- verification and payout destination (L81, L88) ----------

  async setBranchVerified(branchId: string, verified: boolean) {
    await this.db.query(`UPDATE branches SET payout_verified=$2 WHERE id=$1`, [branchId, verified]);
  }

  async setPayoutDestination(branchId: string, destination: PayoutDestination) {
    await this.db.query(`UPDATE branches SET payout_destination=$2 WHERE id=$1`, [branchId, JSON.stringify(destination)]);
  }

  // ---------- SMS wallet (L57 to L60, L87) ----------

  async smsBalance(orgId: string, q: Db = this.db): Promise<Cents> {
    const r = await q.query<{ s: number }>(`SELECT COALESCE(SUM(amount),0) AS s FROM postings WHERE account_id=$1`, [`${orgId}:sms_wallet`]);
    const sum = Number(r[0]?.s ?? 0);
    return sum === 0 ? 0 : -sum;
  }

  /** Credits an organisation's SMS wallet from a direct payment. A top-up is never mixed with collections. Idempotent. */
  async receiveSmsTopup(orgId: string, inb: InboundPayment): Promise<'credited' | 'duplicate'> {
    return this.db.tx(async (q) => {
      const ins = await q.query(
        `INSERT INTO sms_topups_ledger (provider_tx_id, org_id, amount, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING provider_tx_id`,
        [inb.providerTxId, orgId, inb.amount, this.now()],
      );
      if (ins.length === 0) return 'duplicate';
      await this.postEntry(q, {
        idemKey: `smstopup:${inb.providerTxId}`,
        kind: 'sms_topup',
        postings: [
          { accountId: this.accountId('wallet'), amount: inb.amount },
          { accountId: `${orgId}:sms_wallet`, amount: -inb.amount },
        ],
      });
      return 'credited';
    });
  }

  /** Deducts one message cost. Returns false, and changes nothing, when the balance cannot cover it (L59). */
  async chargeSms(orgId: string, cost: Cents, idemKey: string): Promise<boolean> {
    return this.db.tx(async (q) => {
      if ((await this.smsBalance(orgId, q)) < cost) return false;
      await this.postEntry(q, {
        idemKey: `sms:${idemKey}`,
        kind: 'sms_charge',
        postings: [
          { accountId: `${orgId}:sms_wallet`, amount: cost },
          { accountId: this.accountId('sms_revenue'), amount: -cost },
        ],
      });
      return true;
    });
  }

  async balance(kind: AccountKind, branchId?: string, q: Db = this.db): Promise<Cents> {
    const rows = await q.query<{ s: number | null }>(`SELECT COALESCE(SUM(amount),0) AS s FROM postings WHERE account_id = $1`, [
      this.accountId(kind, branchId),
    ]);
    const sum = Number(rows[0]?.s ?? 0);
    if (sum === 0) return 0;
    return DEBIT_NORMAL.has(kind) ? sum : -sum;
  }

  /** Posts a balanced entry. Throws if postings do not sum to zero. Returns false if the idempotency key was already used. */
  async postEntry(
    q: Db,
    e: { idemKey: string; kind: string; paymentId?: string; postings: Posting[]; meta?: unknown },
  ): Promise<boolean> {
    const postings = e.postings.filter((p) => p.amount !== 0);
    const sum = postings.reduce((s, p) => s + p.amount, 0);
    if (sum !== 0) throw new LedgerError('unbalanced', `entry ${e.idemKey} does not balance (off by ${sum})`);
    const inserted = await q.query<{ id: number }>(
      `INSERT INTO journal_entries (idem_key, kind, payment_id, meta, created_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (idem_key) DO NOTHING RETURNING id`,
      [e.idemKey, e.kind, e.paymentId ?? null, e.meta ? JSON.stringify(e.meta) : null, this.now()],
    );
    if (inserted.length === 0) return false;
    for (const p of postings) {
      await q.query(`INSERT INTO postings (entry_id, account_id, amount) VALUES ($1,$2,$3)`, [inserted[0].id, p.accountId, p.amount]);
    }
    return true;
  }

  /**
   * Supplies who and where for audit events written outside a request handler's own knowledge (the API sets this from the
   * current request). Whatever the caller passes explicitly wins over it.
   */
  auditContext?: () => Partial<AuditInput> | undefined;

  /**
   * Records an audit event. `actor` is a shorthand for actorId. Returns the event id so a version snapshot can point at it.
   */
  async audit(a: Partial<AuditInput> & { action: string; actor?: string | null }): Promise<string> {
    const ctx = this.auditContext?.() ?? {};
    const actorId = a.actorId ?? a.actor ?? ctx.actorId ?? null;
    const { actor: _actor, ...rest } = a;
    return writeAudit(this.db, this.now(), {
      ...ctx,
      ...rest,
      actorId,
      actorName: a.actorName ?? (actorId && actorId === ctx.actorId ? ctx.actorName : null),
      actorType: a.actorType ?? (actorId && actorId === ctx.actorId ? ctx.actorType : !actorId || actorId === 'system' ? 'system' : 'user'),
    });
  }

  // ---------- intake (L8, L9, L10) ----------

  async receivePayment(inb: InboundPayment, expectedFee?: FeeResult): Promise<ReceiveResult> {
    return this.db.tx(async (q) => {
      const existing = await q.query<{ id: string }>(`SELECT id FROM payments WHERE provider_tx_id = $1`, [inb.providerTxId]);
      if (existing.length) return { status: 'duplicate', paymentId: existing[0].id };

      const paymentId = `pay_${randomUUID().slice(0, 12)}`;
      const ref = parseReference(inb.reference);
      const branch = ref
        ? (
            await q.query<any>(
              `SELECT b.id, b.org_id, o.fee_bearer, o.fee_schedule FROM branches b JOIN organisations o ON o.id = b.org_id WHERE b.code = $1`,
              [ref.code],
            )
          )[0]
        : undefined;
      const received = inb.occurredAt && !Number.isNaN(Date.parse(inb.occurredAt)) ? this.now() : this.now();

      if (!branch) {
        const pspCost = this.defaultPspCost(inb.method, inb.amount);
        await q.query(
          `INSERT INTO payments (id, provider_tx_id, method, reference, purpose, payer_phone, amount_paid, psp_cost, stage, received_at, hold_from)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'suspense',$9,$9)`,
          [paymentId, inb.providerTxId, inb.method, inb.reference, ref?.purpose ?? null, inb.phone, inb.amount, pspCost, received],
        );
        await this.postEntry(q, {
          idemKey: `receive:${inb.providerTxId}`,
          kind: 'receive_suspense',
          paymentId,
          postings: [
            { accountId: this.accountId('wallet'), amount: inb.amount },
            { accountId: this.accountId('suspense'), amount: -inb.amount },
          ],
        });
        return { status: 'suspense', paymentId };
      }

      const schedule: FeeSchedule = branch.fee_schedule;
      const fee =
        expectedFee && expectedFee.amountPaid === inb.amount
          ? expectedFee
          : computeFee(schedule, inb.method, inb.amount, 'church');
      await q.query(
        `INSERT INTO payments (id, provider_tx_id, org_id, branch_id, method, reference, purpose, payer_phone, amount_paid, net, platform_fee, psp_cost, stage, received_at, hold_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13,$13)`,
        [paymentId, inb.providerTxId, branch.org_id, branch.id, inb.method, inb.reference, ref!.purpose, inb.phone, inb.amount, fee.netToChurch, fee.platformFee, fee.pspCost, received],
      );
      await this.postEntry(q, {
        idemKey: `receive:${inb.providerTxId}`,
        kind: 'receive_matched',
        paymentId,
        postings: [
          { accountId: this.accountId('wallet'), amount: inb.amount },
          { accountId: this.accountId('pending', branch.id), amount: -fee.netToChurch },
          { accountId: this.accountId('fee_revenue'), amount: -fee.platformFee },
          { accountId: this.accountId('psp_cost_payable'), amount: -fee.pspCost },
        ],
      });
      return { status: 'matched', paymentId, branchId: branch.id, fee };
    });
  }

  private defaultPspCost(method: PaymentMethod, amount: Cents): Cents {
    const p = DEFAULT_FEE_SCHEDULE.psp[method];
    return bpsOf(amount, p.bps) + p.fixed;
  }

  /** Staff or support resolve a suspense payment into a branch (L10). Starts the hold clock now. */
  async claimSuspense(paymentId: string, branchId: string, actor?: string) {
    await this.db.tx(async (q) => {
      const p = (await q.query<any>(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [paymentId]))[0];
      if (!p) throw new LedgerError('not_found', 'payment not found');
      if (p.stage !== 'suspense') throw new LedgerError('not_in_suspense', 'payment is not in suspense');
      const b = (
        await q.query<any>(`SELECT b.id, b.org_id, o.fee_schedule FROM branches b JOIN organisations o ON o.id=b.org_id WHERE b.id = $1`, [branchId])
      )[0];
      if (!b) throw new LedgerError('not_found', 'branch not found');
      const fee = computeFee(b.fee_schedule, p.method, p.amount_paid, 'church');
      await q.query(
        `UPDATE payments SET org_id=$2, branch_id=$3, stage='pending', net=$4, platform_fee=$5, psp_cost=$6, hold_from=$7 WHERE id=$1`,
        [paymentId, b.org_id, b.id, fee.netToChurch, fee.platformFee, fee.pspCost, this.now()],
      );
      await this.postEntry(q, {
        idemKey: `claim:${paymentId}`,
        kind: 'claim_suspense',
        paymentId,
        postings: [
          { accountId: this.accountId('suspense'), amount: p.amount_paid },
          { accountId: this.accountId('pending', b.id), amount: -fee.netToChurch },
          { accountId: this.accountId('fee_revenue'), amount: -fee.platformFee },
          { accountId: this.accountId('psp_cost_payable'), amount: -fee.pspCost },
        ],
      });
    });
    await this.audit({ actor, action: 'suspense.claim', entity: 'payment', entityId: paymentId, meta: { branchId } });
  }

  // ---------- 48h hold (L3) ----------

  async releasePending(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - this.opts.holdHours * 3600_000).toISOString();
    return this.db.tx(async (q) => {
      const due = await q.query<any>(`SELECT id, branch_id, net FROM payments WHERE stage='pending' AND hold_from <= $1`, [cutoff]);
      for (const p of due) {
        await this.postEntry(q, {
          idemKey: `release:${p.id}`,
          kind: 'release_pending',
          paymentId: p.id,
          postings: [
            { accountId: this.accountId('pending', p.branch_id), amount: p.net },
            { accountId: this.accountId('available', p.branch_id), amount: -p.net },
          ],
        });
        await q.query(`UPDATE payments SET stage='available' WHERE id=$1`, [p.id]);
      }
      return due.length;
    });
  }

  // ---------- cash fee (L36) ----------

  /** Debits the platform fee for approved cash from Available; any shortfall becomes a receivable (D4). */
  async chargeCashFee(q: Db, branchId: string, cashId: string, fee: Cents) {
    const avail = Math.max(0, await this.balance('available', branchId, q));
    const fromAvail = Math.min(avail, fee);
    await this.postEntry(q, {
      idemKey: `cashfee:${cashId}`,
      kind: 'cash_fee',
      postings: [
        { accountId: this.accountId('available', branchId), amount: fromAvail },
        { accountId: this.accountId('receivable', branchId), amount: fee - fromAvail },
        { accountId: this.accountId('fee_revenue'), amount: -fee },
      ],
      meta: { cashId },
    });
  }

  // ---------- settlement (L16, L18, L19, D3, D5) ----------

  async resumeBranch(branchId: string) {
    await this.db.query(`UPDATE branches SET payout_paused=false WHERE id=$1`, [branchId]);
  }

  private async avgDailyCollections(branchId: string): Promise<Cents> {
    const since = new Date(this.clock.now().getTime() - 30 * 86400_000).toISOString();
    const r = await this.db.query<{ s: number }>(
      `SELECT COALESCE(SUM(net),0) AS s FROM payments WHERE branch_id=$1 AND received_at >= $2 AND stage <> 'reversed'`,
      [branchId, since],
    );
    return Math.floor(Number(r[0].s) / 30);
  }

  async runSettlement(): Promise<SettlementResult[]> {
    await this.releasePending();
    const branches = await this.db.query<any>(`SELECT id, org_id, payout_destination, payout_paused, payout_verified FROM branches ORDER BY id`);
    const results: SettlementResult[] = [];
    for (const b of branches) {
      results.push(await this.settleBranch(b));
    }
    return results;
  }

  private async settleBranch(b: any): Promise<SettlementResult> {
    const base = { branchId: b.id as string };
    if (b.payout_paused) return { ...base, status: 'paused', reason: 'payouts paused' };
    const avail = await this.balance('available', b.id);
    if (avail <= 0) return { ...base, status: 'nothing' };
    if (!b.payout_verified) return { ...base, status: 'skipped', reason: 'not verified yet, funds are held safely' };
    if (!b.payout_destination) return { ...base, status: 'skipped', reason: 'no payout destination' };

    const owed = await this.balance('receivable', b.id);
    const netted = Math.min(Math.max(owed, 0), avail);
    const remainingDebt = Math.max(owed, 0) - netted;
    const cap = Math.floor((await this.avgDailyCollections(b.id)) * this.opts.debtCapRatio);
    if (remainingDebt > 0 && remainingDebt > cap) {
      await this.db.query(`UPDATE branches SET payout_paused=true WHERE id=$1`, [b.id]);
      await this.audit({ orgId: b.org_id, action: 'payout.paused', entity: 'branch', entityId: b.id, meta: { remainingDebt, cap } });
      return { ...base, status: 'paused', reason: `debt ${remainingDebt} exceeds cap ${cap}` };
    }
    const payoutAmt = avail - netted;
    if (payoutAmt > 0 && payoutAmt < this.opts.minPayout) return { ...base, status: 'carried', amount: payoutAmt };

    const payoutId = `po_${randomUUID().slice(0, 12)}`;
    // Reserve first, so a failed PSP call can never drop funds.
    await this.db.tx(async (q) => {
      await q.query(`INSERT INTO payouts (id, org_id, branch_id, amount, netted, gross, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,'created',$7)`, [
        payoutId, b.org_id, b.id, payoutAmt, netted, avail, this.now(),
      ]);
      await this.postEntry(q, {
        idemKey: `payout:reserve:${payoutId}`,
        kind: 'payout_reserve',
        postings: [
          { accountId: this.accountId('available', b.id), amount: avail },
          { accountId: this.accountId('in_transit'), amount: -avail },
        ],
      });
    });

    const res = payoutAmt > 0
      ? await this.provider.payout({ payoutId, destination: b.payout_destination, amount: payoutAmt })
      : { status: 'confirmed' as const };

    await this.db.tx(async (q) => {
      if (res.status === 'confirmed') {
        await this.postEntry(q, {
          idemKey: `payout:confirm:${payoutId}`,
          kind: 'payout_confirm',
          postings: [
            { accountId: this.accountId('in_transit'), amount: avail },
            { accountId: this.accountId('wallet'), amount: -payoutAmt },
            { accountId: this.accountId('receivable', b.id), amount: -netted },
          ],
        });
        await q.query(`UPDATE payouts SET status='confirmed' WHERE id=$1`, [payoutId]);
        await q.query(`UPDATE payments SET stage='paid_out', payout_id=$2 WHERE branch_id=$1 AND stage='available'`, [b.id, payoutId]);
      } else {
        await this.postEntry(q, {
          idemKey: `payout:fail:${payoutId}`,
          kind: 'payout_failed',
          postings: [
            { accountId: this.accountId('in_transit'), amount: avail },
            { accountId: this.accountId('available', b.id), amount: -avail },
          ],
        });
        await q.query(`UPDATE payouts SET status='failed', failure='psp declined' WHERE id=$1`, [payoutId]);
      }
    });
    return res.status === 'confirmed'
      ? { ...base, status: 'paid', payoutId, amount: payoutAmt, netted }
      : { ...base, status: 'failed', payoutId, amount: payoutAmt, reason: 'PSP declined, funds kept' };
  }

  // ---------- reversals (L11 to L14, L17, L19) ----------

  /**
   * Reverses a payment, following the spec order: suspense, then Pending, then Available, then receivable.
   * The sender gets back the amount paid less non-refundable third-party cost. The platform fee is returned (L13).
   */
  async reverse(paymentId: string, opts: { reason: string; actor?: string; force?: boolean }) {
    const p = (await this.db.query<any>(`SELECT * FROM payments WHERE id=$1`, [paymentId]))[0];
    if (!p) throw new LedgerError('not_found', 'payment not found');
    if (p.stage === 'reversed' || p.stage === 'refunded') throw new LedgerError('already_reversed', 'payment already reversed');
    const ageMs = this.clock.now().getTime() - new Date(p.received_at).getTime();
    if (p.stage !== 'suspense' && !opts.force && ageMs > this.opts.reversalWindowHours * 3600_000) {
      throw new LedgerError('window_expired', `reversal window of ${this.opts.reversalWindowHours}h has passed`);
    }
    const refundAmount = p.amount_paid - p.psp_cost;
    const refunded = await this.provider.refund({ providerTxId: p.provider_tx_id, amount: refundAmount });
    if (refunded.status !== 'confirmed') throw new LedgerError('refund_failed', 'PSP did not confirm the refund, nothing was changed');

    await this.db.tx(async (q) => {
      if (p.stage === 'suspense') {
        await this.postEntry(q, {
          idemKey: `reverse:${paymentId}`,
          kind: 'refund_suspense',
          paymentId,
          postings: [
            { accountId: this.accountId('suspense'), amount: p.amount_paid },
            { accountId: this.accountId('wallet'), amount: -refundAmount },
            { accountId: this.accountId('psp_cost_payable'), amount: -p.psp_cost },
          ],
        });
        await q.query(`UPDATE payments SET stage='refunded', reversed_at=$2, reversal_reason=$3 WHERE id=$1`, [paymentId, this.now(), opts.reason]);
        return;
      }
      const order: ('pending' | 'available')[] = p.stage === 'pending' ? ['pending', 'available'] : ['available', 'pending'];
      let remaining = p.net as number;
      const postings: Posting[] = [];
      for (const kind of order) {
        const bal = Math.max(0, await this.balance(kind, p.branch_id, q));
        const take = Math.min(bal, remaining);
        if (take > 0) postings.push({ accountId: this.accountId(kind, p.branch_id), amount: take });
        remaining -= take;
      }
      if (remaining > 0) postings.push({ accountId: this.accountId('receivable', p.branch_id), amount: remaining });
      postings.push({ accountId: this.accountId('fee_revenue'), amount: p.platform_fee });
      postings.push({ accountId: this.accountId('wallet'), amount: -refundAmount });
      await this.postEntry(q, { idemKey: `reverse:${paymentId}`, kind: 'reversal', paymentId, postings, meta: { reason: opts.reason, receivable: remaining } });
      await q.query(`UPDATE payments SET stage='reversed', reversed_at=$2, reversal_reason=$3 WHERE id=$1`, [paymentId, this.now(), opts.reason]);
    });
    await this.audit({ orgId: p.org_id ?? null, branchId: p.branch_id ?? null, actor: opts.actor, action: 'payment.reverse', entity: 'payment', entityId: paymentId, summary: `Reversed payment ${p.provider_tx_id}`, reason: opts.reason, links: { paymentId, ledgerEntry: `reverse:${paymentId}` }, meta: { refunded: refundAmount, platformFeeReturned: p.platform_fee ?? 0 } });
  }

  /** Auto-refunds suspense payments that stayed unclaimed past the suspense period (L14). */
  async expireSuspense(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - this.opts.suspenseHours * 3600_000).toISOString();
    const due = await this.db.query<{ id: string }>(`SELECT id FROM payments WHERE stage='suspense' AND received_at <= $1`, [cutoff]);
    let n = 0;
    for (const p of due) {
      try {
        await this.reverse(p.id, { reason: 'suspense expired', actor: 'system' });
        n++;
      } catch {
        // PSP refused, it stays in suspense and is retried next run.
      }
    }
    return n;
  }

  // ---------- reconciliation (L20) ----------

  async reconcile() {
    const ledgerWallet = await this.balance('wallet');
    const pspWallet = await this.provider.walletBalance();
    const z = await this.db.query<{ s: number }>(`SELECT COALESCE(SUM(amount),0) AS s FROM postings`);
    const zeroSum = Number(z[0].s) === 0;
    const liabilities: Record<string, Cents> = {};
    for (const k of ['suspense', 'fee_revenue', 'psp_cost_payable', 'in_transit', 'sms_revenue'] as const) liabilities[k] = await this.balance(k);
    const sms = await this.db.query<{ s: number }>(`SELECT COALESCE(SUM(p.amount),0) AS s FROM postings p JOIN accounts a ON a.id=p.account_id WHERE a.kind='sms_wallet'`);
    liabilities.sms_wallets = Number(sms[0].s) === 0 ? 0 : -Number(sms[0].s);
    const rows = await this.db.query<{ kind: string; s: number }>(
      `SELECT a.kind, COALESCE(SUM(p.amount),0) AS s FROM accounts a LEFT JOIN postings p ON p.account_id=a.id WHERE a.branch_id IS NOT NULL GROUP BY a.kind`,
    );
    for (const r of rows) liabilities[`branch_${r.kind}`] = DEBIT_NORMAL.has(r.kind) ? Number(r.s) : -Number(r.s);
    return { ok: ledgerWallet === pspWallet && zeroSum, ledgerWallet, pspWallet, difference: ledgerWallet - pspWallet, zeroSum, accounts: liabilities };
  }
}

export type SettlementResult =
  | { branchId: string; status: 'paid'; payoutId: string; amount: Cents; netted: Cents }
  | { branchId: string; status: 'failed'; payoutId: string; amount: Cents; reason: string }
  | { branchId: string; status: 'carried'; amount: Cents }
  | { branchId: string; status: 'paused' | 'skipped'; reason: string }
  | { branchId: string; status: 'nothing' };
