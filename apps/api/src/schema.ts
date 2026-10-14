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

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['households','memberships','membership_history','roles','role_assignments','projects','pledges','give_intents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = current_setting(''app.org_id'', true))', t);
  END LOOP;
END $$;
`;
