/** Application-side schema (people, roles, projects). Money lives in the ledger package. */
export const APP_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  phone text NOT NULL UNIQUE,
  name text NOT NULL,
  email text,
  email_verified boolean NOT NULL DEFAULT false,
  is_platform_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL
);

-- A household only groups people (L92, L95). It has no name: its label is derived from its members.
CREATE TABLE IF NOT EXISTS households (
  id text PRIMARY KEY,
  org_id text NOT NULL
);

-- A membership links a person (global identity) to an organisation and a branch (L25, L29).
-- Children have no own phone or user account. Their contact phones are their guardians' phones (L94).
CREATE TABLE IF NOT EXISTS memberships (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  branch_id text NOT NULL,
  user_id text,
  full_name text NOT NULL,
  phone text,
  member_number text NOT NULL,
  household_id text,
  is_primary_contact boolean NOT NULL DEFAULT false,
  category text NOT NULL DEFAULT 'adult' CHECK (category IN ('adult','child')),
  dob text,
  sex text CHECK (sex IN ('male','female')),
  consent_at timestamptz,
  consent_by text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  joined_at timestamptz NOT NULL,
  closed_at timestamptz,
  UNIQUE (org_id, member_number)
);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships(user_id);

-- Guardian links survive household changes (L95).
CREATE TABLE IF NOT EXISTS guardians (
  child_id text NOT NULL,
  guardian_id text NOT NULL,
  org_id text NOT NULL,
  PRIMARY KEY (child_id, guardian_id)
);

CREATE TABLE IF NOT EXISTS org_settings (
  org_id text PRIMARY KEY,
  member_number_pattern text NOT NULL DEFAULT 'M{SEQ:5}',
  member_number_next int NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS birthday_wishes (
  membership_id text NOT NULL,
  year int NOT NULL,
  PRIMARY KEY (membership_id, year)
);

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

-- Messaging wallets (L112, L113). branch_id NULL is the organisation-level wallet. One per channel and scope.
CREATE TABLE IF NOT EXISTS wallets (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  branch_id text,
  channel text NOT NULL CHECK (channel IN ('sms','whatsapp')),
  code text NOT NULL,
  low_threshold bigint NOT NULL,
  state text NOT NULL DEFAULT 'ok' CHECK (state IN ('ok','low','empty')),
  created_at timestamptz NOT NULL,
  UNIQUE (channel, code)
);
CREATE UNIQUE INDEX IF NOT EXISTS wallets_scope_idx ON wallets (org_id, COALESCE(branch_id, ''), channel);

CREATE TABLE IF NOT EXISTS integration_settings (
  org_id text PRIMARY KEY,
  wallet_mode text NOT NULL DEFAULT 'shared' CHECK (wallet_mode IN ('shared','per_branch')),
  sms_sender_id text,
  whatsapp_display_name text,
  whatsapp_number text,
  alert_emails jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS branch_integrations (
  branch_id text PRIMARY KEY,
  org_id text NOT NULL,
  sms_sender_id text,
  whatsapp_number text
);

-- A person's own choices about church messages (L119). Keyed by phone because a person is one identity across churches.
CREATE TABLE IF NOT EXISTS contact_prefs (
  phone text PRIMARY KEY,
  whatsapp_opt_in boolean NOT NULL DEFAULT false,
  sms_opt_out boolean NOT NULL DEFAULT false,
  source text NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by text
);

CREATE TABLE IF NOT EXISTS wallet_topups (
  id text PRIMARY KEY,
  wallet_id text NOT NULL,
  org_id text NOT NULL,
  amount bigint NOT NULL,
  method text NOT NULL CHECK (method IN ('mpesa','card')),
  phone text,
  provider_tx_id text UNIQUE,
  status text NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated','completed')),
  created_by text,
  created_at timestamptz NOT NULL
);

-- Groups (L122). Members and leaders are people already registered in the church.
CREATE TABLE IF NOT EXISTS groups (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  branch_id text,
  name text NOT NULL,
  description text,
  created_by text,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id text NOT NULL,
  membership_id text NOT NULL,
  org_id text NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('leader','member')),
  added_at timestamptz NOT NULL,
  PRIMARY KEY (group_id, membership_id)
);

-- Messages and what happened to each recipient. Recipient rows hold no phone numbers (L118, L109).
CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  branch_id text,
  sender_id text NOT NULL,
  sender_name text,
  source text NOT NULL CHECK (source IN ('staff','group_leader')),
  group_id text,
  audience jsonb NOT NULL,
  channels jsonb NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  status text NOT NULL CHECK (status IN ('scheduled','sending','sent','cancelled','failed')),
  scheduled_at text,
  sent_at text,
  cancelled_at text,
  summary jsonb,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_due_idx ON messages(status, scheduled_at);

CREATE TABLE IF NOT EXISTS message_recipients (
  message_id text NOT NULL,
  membership_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('inapp','sms','whatsapp')),
  status text NOT NULL,
  cost bigint NOT NULL DEFAULT 0,
  wallet_id text,
  PRIMARY KEY (message_id, membership_id, channel)
);

-- Tariffs: volume bands per channel, versioned, assigned per church (L124, L125).
CREATE TABLE IF NOT EXISTS tariffs (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tariffs_one_default ON tariffs (is_default) WHERE is_default;
CREATE TABLE IF NOT EXISTS tariff_versions (
  id text PRIMARY KEY,
  tariff_id text NOT NULL,
  version int NOT NULL,
  effective_from text NOT NULL,
  bands jsonb NOT NULL,
  note text,
  created_by text,
  created_at timestamptz NOT NULL,
  UNIQUE (tariff_id, version)
);
DROP TRIGGER IF EXISTS tariff_versions_no_change ON tariff_versions;
CREATE TRIGGER tariff_versions_no_change BEFORE UPDATE OR DELETE ON tariff_versions FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
CREATE TABLE IF NOT EXISTS org_tariffs (
  org_id text PRIMARY KEY,
  tariff_id text NOT NULL
);
CREATE TABLE IF NOT EXISTS message_usage (
  org_id text NOT NULL,
  channel text NOT NULL,
  month text NOT NULL,
  units bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, channel, month)
);

-- Sender names and WhatsApp numbers a church asks for. They are used only once a platform admin approves (L128).
CREATE TABLE IF NOT EXISTS sender_requests (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  branch_id text,
  kind text NOT NULL CHECK (kind IN ('sms_sender','whatsapp_number','whatsapp_display')),
  value text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn')),
  reason text,
  requested_by text NOT NULL,
  decided_by text,
  decided_at text,
  created_at text NOT NULL
);

-- Adverts for the member app's home slider (L130 to L132). Times are ISO text so they compare directly.
CREATE TABLE IF NOT EXISTS adverts (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  org_id text NOT NULL,
  branch_id text,
  title text NOT NULL,
  body text,
  link_url text,
  image_mime text NOT NULL,
  image_data text NOT NULL,
  width int NOT NULL,
  height int NOT NULL,
  audience jsonb NOT NULL,
  starts_at text NOT NULL,
  ends_at text,
  advertiser_name text,
  advertiser_contact text,
  price bigint,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','awaiting_payment','approved','paused','ended','rejected','taken_down')),
  payment_id text,
  created_by text NOT NULL,
  submitted_by text,
  decided_by text,
  decided_at text,
  reason text,
  taken_down_by text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
-- One row per member, advert, day and kind, so a member opening the app ten times counts once (L132).
CREATE TABLE IF NOT EXISTS advert_seen (
  advert_id text NOT NULL,
  org_id text NOT NULL,
  user_id text NOT NULL,
  day text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('view','tap')),
  PRIMARY KEY (advert_id, user_id, day, kind)
);

-- One pending confirmation code per person (L123).
CREATE TABLE IF NOT EXISTS email_codes (
  user_id text PRIMARY KEY,
  email text NOT NULL,
  code text NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  expires_at text NOT NULL,
  sent_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS email_outbox (
  id text PRIMARY KEY,
  org_id text,
  to_email text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL,
  error text,
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
  message_id text,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL
);
-- A child has no sign-in of their own: their in-app messages sit in a guardian's inbox, marked "For <child>" (L125).
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS member_id text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS for_name text;

-- Certificates and sacramental records (L98 to L103).
CREATE TABLE IF NOT EXISTS certificate_templates (
  org_id text PRIMARY KEY,
  config jsonb NOT NULL,
  logo_mime text,
  logo_data text,
  updated_by text,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS branch_profiles (
  branch_id text PRIMARY KEY,
  org_id text NOT NULL,
  address text,
  town text,
  phone text,
  email text
);

CREATE TABLE IF NOT EXISTS sacramental_records (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  branch_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('baptism','marriage')),
  membership_id text,
  subject_name text NOT NULL,
  event_date text NOT NULL,
  place text NOT NULL,
  officiant text NOT NULL,
  register_number text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','rejected')),
  pending_changes jsonb,
  rejection_reason text,
  serial text UNIQUE,
  verify_key text,
  version int NOT NULL DEFAULT 1,
  file_name text,
  file_mime text,
  file_data text,
  created_by text NOT NULL,
  last_edited_by text NOT NULL,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS records_branch_idx ON sacramental_records(branch_id, status);

CREATE TABLE IF NOT EXISTS record_issues (
  id text PRIMARY KEY,
  record_id text NOT NULL,
  org_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('original','copy')),
  status text NOT NULL CHECK (status IN ('awaiting_payment','issued')),
  fee bigint NOT NULL DEFAULT 0,
  waived boolean NOT NULL DEFAULT false,
  waived_by text,
  requested_by text NOT NULL,
  payment_id text,
  created_at timestamptz NOT NULL
);

-- Version history (L105): append-only, like the audit log.
CREATE TABLE IF NOT EXISTS entity_versions (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  branch_id text,
  entity text NOT NULL,
  entity_id text NOT NULL,
  version int NOT NULL,
  snapshot jsonb NOT NULL,
  summary text NOT NULL,
  changed_by text,
  changed_by_name text,
  changed_at text NOT NULL,
  event_id text,
  UNIQUE (entity, entity_id, version)
);
CREATE INDEX IF NOT EXISTS entity_versions_org_idx ON entity_versions(org_id, changed_at);
DROP TRIGGER IF EXISTS entity_versions_no_change ON entity_versions;
CREATE TRIGGER entity_versions_no_change BEFORE UPDATE OR DELETE ON entity_versions FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

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
  FOREACH t IN ARRAY ARRAY['households','memberships','guardians','org_settings','membership_history','roles','role_assignments','projects','pledges','give_intents','kyc_documents','payout_change_requests','wallets','sender_requests','adverts','advert_seen','integration_settings','branch_integrations','wallet_topups','sms_messages','groups','group_members','messages','certificate_templates','branch_profiles','sacramental_records','record_issues','entity_versions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = current_setting(''app.org_id'', true))', t);
  END LOOP;
END $$;
`;
