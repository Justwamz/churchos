/**
 * Database CHECK constraints on money and quantity columns (slice 38). The API already parses and caps amounts; these make a negative or
 * absurd value impossible even for code that forgets to. Idempotent and additive: each is added NOT VALID (so an old bad row cannot
 * block start-up) and then validated; a validation that fails is skipped and the constraint keeps guarding new writes.
 *
 * Ceiling: 1e12 cents (KES 10 billion). Quantities: 0..10000, ticket stock up to 1,000,000.
 * NOT constrained, because a negative value is valid there: postings.amount (signed ledger legs), giving_ledger.amount (reversal
 * entries), shop_movements.qty and unit_cost (stock out), payments.net and payouts.netted (net of fees, can go below zero on small
 * amounts), shop_tills.expected and counted (a till can be short), message and fee schedules held as JSON (bps live in
 * organisations.fee_schedule and tariff bands, validated in code; a JSON path cannot be checked per element here).
 */
const MONEY: [string, string][] = [
  ['payments', 'amount_paid'], ['payments', 'platform_fee'], ['payments', 'psp_cost'],
  ['payouts', 'amount'], ['payouts', 'gross'],
  ['pledges', 'amount'], ['projects', 'target'], ['projects', 'budget'],
  ['ticket_types', 'price'], ['ticket_orders', 'subtotal'], ['ticket_orders', 'service_fee'], ['ticket_orders', 'total'], ['ticket_orders', 'credit_used'], ['ticket_orders', 'credit_issued'],
  ['shop_items', 'price'], ['shop_items', 'cost'], ['shop_sale_lines', 'unit_price'],
  ['expenses', 'amount'], ['expense_budgets', 'amount'], ['expense_settings', 'approval_limit'], ['expense_settings', 'receipt_required_above'],
  ['event_credits', 'amount'], ['event_credits', 'balance'], ['event_credit_moves', 'amount'],
  ['credit_refunds', 'amount'], ['credit_refund_holds', 'amount'], ['credit_transfers', 'amount'],
  ['wallet_topups', 'amount'], ['wallet_topups_ledger', 'amount'], ['sms_messages', 'cost'],
  ['giving_plans', 'amount'], ['giving_plan_runs', 'amount'], ['held_payments', 'expected'], ['held_payments', 'paid'],
  ['cash_entries', 'amount'], ['cash_entries', 'fee'], ['cash_entry_gifts', 'amount'],
  ['adverts', 'price'], ['bookings', 'price'], ['resources', 'price'], ['give_intents', 'base_amount'], ['give_intents', 'amount_paid'],
];
// [table, column, min, max]
const QTY: [string, string, number, number][] = [
  ['shop_sale_lines', 'qty', 1, 10000],
  ['ticket_types', 'quantity', 0, 1000000],
  ['ticket_types', 'per_order_max', 0, 10000],
  ['events', 'capacity', 0, 1000000],
  ['resources', 'capacity', 0, 10000],
];

const rows = [
  ...MONEY.map(([t, c]) => `('${t}','${c}',0,1000000000000)`),
  ...QTY.map(([t, c, lo, hi]) => `('${t}','${c}',${lo},${hi})`),
].join(',\n    ');

export const CHECKS_SQL = `
DO $$ DECLARE c record; cname text; BEGIN
  FOR c IN SELECT * FROM (VALUES
    ${rows}
  ) AS v(t, col, lo, hi) LOOP
    IF to_regclass(c.t) IS NULL THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = c.t AND column_name = c.col AND table_schema = 'public') THEN CONTINUE; END IF;
    cname := 'chk_' || c.t || '_' || c.col;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = cname AND conrelid = to_regclass(c.t)) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I IS NULL OR %I BETWEEN %s AND %s) NOT VALID', c.t, cname, c.col, c.col, c.lo, c.hi);
    END IF;
    BEGIN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', c.t, cname);
    EXCEPTION WHEN others THEN NULL;
    END;
  END LOOP;
END $$;
`;
