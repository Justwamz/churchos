/** Money-side schema. All amounts are integer cents (bigint). Postings are append-only. */
export const LEDGER_SCHEMA = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN CREATE ROLE app_user; END IF;
END $$;

CREATE TABLE IF NOT EXISTS organisations (
  id text PRIMARY KEY,
  name text NOT NULL,
  fee_bearer text NOT NULL DEFAULT 'church' CHECK (fee_bearer IN ('church','member')),
  fee_schedule jsonb NOT NULL,
  sms_code text UNIQUE,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organisations(id),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  region text,
  payout_destination jsonb,
  payout_paused boolean NOT NULL DEFAULT false,
  payout_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id text PRIMARY KEY,
  org_id text,
  branch_id text,
  kind text NOT NULL,
  UNIQUE (branch_id, kind)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id bigserial PRIMARY KEY,
  idem_key text NOT NULL UNIQUE,
  kind text NOT NULL,
  payment_id text,
  meta jsonb,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS postings (
  id bigserial PRIMARY KEY,
  entry_id bigint NOT NULL REFERENCES journal_entries(id),
  account_id text NOT NULL REFERENCES accounts(id),
  amount bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS postings_account_idx ON postings(account_id);

CREATE TABLE IF NOT EXISTS payments (
  id text PRIMARY KEY,
  provider_tx_id text NOT NULL UNIQUE,
  org_id text,
  branch_id text,
  method text NOT NULL,
  reference text,
  purpose text,
  payer_phone text,
  amount_paid bigint NOT NULL,
  net bigint NOT NULL DEFAULT 0,
  platform_fee bigint NOT NULL DEFAULT 0,
  psp_cost bigint NOT NULL DEFAULT 0,
  stage text NOT NULL CHECK (stage IN ('pending','available','paid_out','suspense','reversed','refunded')),
  payout_id text,
  member_id text,
  project_id text,
  received_at timestamptz NOT NULL,
  hold_from timestamptz NOT NULL,
  reversed_at timestamptz,
  reversal_reason text
);
CREATE INDEX IF NOT EXISTS payments_branch_idx ON payments(branch_id, stage);

CREATE TABLE IF NOT EXISTS payouts (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  branch_id text NOT NULL,
  amount bigint NOT NULL,
  netted bigint NOT NULL DEFAULT 0,
  gross bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('created','confirmed','failed')),
  failure text,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS cash_entries (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  branch_id text NOT NULL,
  amount bigint NOT NULL,
  purpose text NOT NULL,
  note text,
  status text NOT NULL CHECK (status IN ('counted','approved','rejected')),
  counted_by text NOT NULL,
  approved_by text,
  fee bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  approved_at timestamptz
);

CREATE TABLE IF NOT EXISTS wallet_topups_ledger (
  provider_tx_id text PRIMARY KEY,
  wallet_id text NOT NULL,
  org_id text NOT NULL,
  amount bigint NOT NULL,
  created_at timestamptz NOT NULL
);

-- One chained, append-only event log (L104, L107). The "at" column is ISO text so the hash is reproducible.
CREATE TABLE IF NOT EXISTS audit_events (
  seq bigserial PRIMARY KEY,
  id text NOT NULL UNIQUE,
  chain text NOT NULL,
  at text NOT NULL,
  org_id text,
  branch_id text,
  actor_id text,
  actor_name text,
  actor_type text NOT NULL,
  action text NOT NULL,
  category text NOT NULL,
  entity text,
  entity_id text,
  summary text NOT NULL,
  changes jsonb,
  reason text,
  ip text,
  user_agent text,
  app text,
  request_id text,
  links jsonb,
  meta jsonb,
  prev_hash text,
  hash text NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_chain_idx ON audit_events(chain, seq);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events(entity, entity_id);
CREATE INDEX IF NOT EXISTS audit_events_org_idx ON audit_events(org_id, at);

CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_events_no_change ON audit_events;
CREATE TRIGGER audit_events_no_change BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events;
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();

-- Row-level security: the restricted app_user role only ever sees its own organisation's rows.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['branches','payments','payouts','cash_entries','audit_events'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = current_setting(''app.org_id'', true))', t);
  END LOOP;
END $$;
`;
