/** Application-side schema (people, roles, projects). Money lives in the ledger package. */
export const APP_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  phone text NOT NULL UNIQUE,
  name text NOT NULL,
  is_platform_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS households (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  name text NOT NULL
);

-- A membership links a person (global identity) to an organisation and a branch (L25, L29).
-- Dependents without a phone have no user_id and are managed by a guardian (L27).
CREATE TABLE IF NOT EXISTS memberships (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  branch_id text NOT NULL,
  user_id text,
  full_name text NOT NULL,
  phone text,
  member_number text NOT NULL,
  household_id text,
  relationship text,
  guardian_membership_id text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  joined_at timestamptz NOT NULL,
  closed_at timestamptz,
  UNIQUE (org_id, member_number)
);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships(user_id);

CREATE TABLE IF NOT EXISTS membership_history (
  id bigserial PRIMARY KEY,
  org_id text NOT NULL,
  membership_id text NOT NULL,
  event text NOT NULL,
  from_branch text,
  to_branch text,
  at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  name text NOT NULL,
  permissions jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS role_assignments (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  user_id text NOT NULL,
  role_id text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('org','region','branch')),
  scope_id text NOT NULL
);

CREATE TABLE IF NOT EXISTS transfers (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  to_org_id text NOT NULL,
  membership_id text NOT NULL,
  from_branch text NOT NULL,
  to_branch text NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected')),
  requested_by text,
  decided_by text,
  created_at timestamptz NOT NULL,
  decided_at timestamptz
);

CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  branch_id text NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  target bigint NOT NULL,
  deadline date,
  restricted boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at timestamptz NOT NULL,
  UNIQUE (branch_id, code)
);

CREATE TABLE IF NOT EXISTS pledges (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  project_id text NOT NULL,
  membership_id text NOT NULL,
  amount bigint NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS give_intents (
  id text PRIMARY KEY,
  provider_tx_id text UNIQUE,
  org_id text NOT NULL,
  branch_id text NOT NULL,
  purpose text NOT NULL,
  project_id text,
  phone text NOT NULL,
  method text NOT NULL,
  base_amount bigint NOT NULL,
  amount_paid bigint NOT NULL,
  fee jsonb NOT NULL,
  status text NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated','completed','failed')),
  payment_id text,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS reversal_requests (
  id text PRIMARY KEY,
  payment_id text NOT NULL,
  requested_by text NOT NULL,
  source text NOT NULL,
  message text,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','awaiting_second','approved','rejected','failed')),
  first_approver text,
  second_approver text,
  failure text,
  created_at timestamptz NOT NULL
);

-- KYC documents (L81). Files are stored base64 in this local build.
CREATE TABLE IF NOT EXISTS kyc_documents (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  branch_id text,
  type text NOT NULL CHECK (type IN ('registration_certificate','kra_pin','signatory_id','payout_proof')),
  filename text NOT NULL,
  mime text NOT NULL,
  size int NOT NULL,
  data text NOT NULL,
  note text,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')),
  reason text,
  submitted_by text NOT NULL,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL
);

-- Payout destination changes: owner requests, admin approves, then a cooling-off period (L88).
CREATE TABLE IF NOT EXISTS payout_change_requests (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  branch_id text NOT NULL,
  destination jsonb NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected','applied')),
  requested_by text NOT NULL,
  decided_by text,
  decided_at timestamptz,
  effective_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS sms_topups (
  id text PRIMARY KEY,
  provider_tx_id text UNIQUE,
  org_id text NOT NULL,
  amount bigint NOT NULL,
  phone text NOT NULL,
  status text NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated','completed')),
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS sms_messages (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  to_phone text NOT NULL,
  kind text NOT NULL,
  body text NOT NULL,
  cost bigint NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('sent','skipped_no_balance')),
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id text PRIMARY KEY,
  org_id text,
  user_id text NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL
);

-- Help content (L82 to L86). Chunked for full-text search now and embeddings later.
CREATE TABLE IF NOT EXISTS help_articles (
  id text PRIMARY KEY,
  title text NOT NULL,
  audiences jsonb NOT NULL,
  area text NOT NULL,
  tags jsonb NOT NULL,
  screens jsonb NOT NULL,
  lang text NOT NULL DEFAULT 'en',
  version int NOT NULL DEFAULT 1,
  body text NOT NULL
);
CREATE TABLE IF NOT EXISTS help_chunks (
  id text PRIMARY KEY,
  article_id text NOT NULL REFERENCES help_articles(id) ON DELETE CASCADE,
  ordinal int NOT NULL,
  heading text NOT NULL,
  text text NOT NULL,
  tsv tsvector NOT NULL
);
CREATE INDEX IF NOT EXISTS help_chunks_tsv_idx ON help_chunks USING gin(tsv);

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['households','memberships','membership_history','roles','role_assignments','projects','pledges','give_intents','kyc_documents','payout_change_requests','sms_topups','sms_messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = current_setting(''app.org_id'', true))', t);
  END LOOP;
END $$;
`;
