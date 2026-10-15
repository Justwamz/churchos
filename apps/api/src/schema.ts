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

-- Notice board, events and group walls (L133 to L139). Times are ISO text so they compare directly.
CREATE TABLE IF NOT EXISTS notices (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  branch_id text,
  title text NOT NULL,
  body text NOT NULL,
  audience jsonb NOT NULL,
  pinned boolean NOT NULL DEFAULT false,
  publish_at text NOT NULL,
  expires_at text,
  notify boolean NOT NULL DEFAULT false,
  notified boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('published','archived')),
  created_by text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  branch_id text,
  title text NOT NULL,
  description text,
  location text,
  starts_at text NOT NULL,
  ends_at text,
  audience jsonb NOT NULL,
  rsvp boolean NOT NULL DEFAULT false,
  capacity int,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
  cancel_reason text,
  reminder_sent boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS event_rsvps (
  event_id text NOT NULL,
  user_id text NOT NULL,
  org_id text NOT NULL,
  name text NOT NULL,
  response text NOT NULL CHECK (response IN ('going','not_going')),
  guests int NOT NULL DEFAULT 0,
  updated_at text NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
ALTER TABLE groups ADD COLUMN IF NOT EXISTS join_policy text NOT NULL DEFAULT 'invite';
ALTER TABLE groups ADD COLUMN IF NOT EXISTS posting text NOT NULL DEFAULT 'members';
CREATE TABLE IF NOT EXISTS group_posts (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  group_id text NOT NULL,
  author_id text NOT NULL,
  author_name text NOT NULL,
  kind text NOT NULL DEFAULT 'post' CHECK (kind IN ('post','announcement')),
  body text NOT NULL,
  pinned boolean NOT NULL DEFAULT false,
  created_at text NOT NULL,
  deleted_at text,
  deleted_by text
);
CREATE INDEX IF NOT EXISTS group_posts_idx ON group_posts(group_id, created_at);
CREATE TABLE IF NOT EXISTS group_comments (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  group_id text NOT NULL,
  post_id text NOT NULL,
  author_id text NOT NULL,
  author_name text NOT NULL,
  body text NOT NULL,
  created_at text NOT NULL,
  deleted_at text,
  deleted_by text
);
CREATE TABLE IF NOT EXISTS group_join_requests (
  group_id text NOT NULL,
  user_id text NOT NULL,
  org_id text NOT NULL,
  membership_id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','withdrawn')),
  decided_by text,
  decided_at text,
  created_at text NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

-- Resources and bookings (L140 to L148). Times are ISO text so they compare directly.
CREATE TABLE IF NOT EXISTS resources (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  branch_id text,
  kind text NOT NULL CHECK (kind IN ('person','place','thing')),
  name text NOT NULL,
  description text,
  capacity int,
  owner_user_id text,
  slot_minutes int NOT NULL DEFAULT 60,
  max_minutes int,
  hours jsonb NOT NULL,
  min_notice_hours int NOT NULL DEFAULT 24,
  max_advance_days int NOT NULL DEFAULT 90,
  approval text NOT NULL DEFAULT 'manual' CHECK (approval IN ('auto','manual')),
  price bigint,
  price_per text NOT NULL DEFAULT 'booking' CHECK (price_per IN ('booking','hour')),
  active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS resource_blocks (
  id text PRIMARY KEY,
  resource_id text NOT NULL,
  org_id text NOT NULL,
  starts_at text NOT NULL,
  ends_at text NOT NULL,
  reason text,
  created_by text NOT NULL,
  removed_at text
);
CREATE TABLE IF NOT EXISTS bookings (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  org_id text NOT NULL,
  branch_id text,
  requester_id text NOT NULL,
  requester_name text NOT NULL,
  title text NOT NULL,
  note text,
  attendees int,
  starts_at text NOT NULL,
  ends_at text NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','awaiting_payment','confirmed','declined','cancelled','completed','no_show','lapsed')),
  price bigint,
  payment_id text,
  reason text,
  hold_until text,
  reminder_sent boolean NOT NULL DEFAULT false,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS booking_items (
  booking_id text NOT NULL,
  resource_id text NOT NULL,
  org_id text NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','declined')),
  decided_by text,
  decided_at text,
  reason text,
  PRIMARY KEY (booking_id, resource_id)
);
CREATE INDEX IF NOT EXISTS booking_items_resource_idx ON booking_items(resource_id);

-- The church shop (L155 to L163). Times are ISO text so they compare directly.
CREATE TABLE IF NOT EXISTS shop_items (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  branch_id text NOT NULL,
  code text,
  name text NOT NULL,
  category text,
  price bigint NOT NULL,
  cost bigint,
  low_stock int NOT NULL DEFAULT 5,
  active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_items_code_idx ON shop_items(branch_id, lower(code)) WHERE code IS NOT NULL;
CREATE TABLE IF NOT EXISTS shop_movements (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  branch_id text NOT NULL,
  item_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('received','sold','returned','released','adjusted','written_off')),
  qty int NOT NULL,
  unit_cost bigint,
  sale_id text,
  reason text,
  created_by text NOT NULL,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS shop_movements_item_idx ON shop_movements(item_id);
DROP TRIGGER IF EXISTS shop_movements_no_change ON shop_movements;
CREATE TRIGGER shop_movements_no_change BEFORE UPDATE OR DELETE ON shop_movements FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
CREATE TABLE IF NOT EXISTS shop_sales (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  receipt_no text NOT NULL,
  org_id text NOT NULL,
  branch_id text NOT NULL,
  buyer_name text,
  buyer_membership_id text,
  buyer_phone text,
  method text NOT NULL,
  status text NOT NULL CHECK (status IN ('completed','awaiting_payment','voided','lapsed')),
  total bigint NOT NULL,
  provider_tx_id text,
  payment_id text,
  hold_until text,
  void_reason text,
  voided_by text,
  voided_at text,
  sold_by text NOT NULL,
  created_at text NOT NULL,
  completed_at text
);
CREATE TABLE IF NOT EXISTS shop_sale_lines (
  sale_id text NOT NULL,
  item_id text NOT NULL,
  name text NOT NULL,
  qty int NOT NULL,
  unit_price bigint NOT NULL,
  unit_cost bigint,
  PRIMARY KEY (sale_id, item_id)
);
CREATE TABLE IF NOT EXISTS shop_tills (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  branch_id text NOT NULL,
  day text NOT NULL,
  expected bigint NOT NULL,
  counted bigint NOT NULL,
  note text,
  cash_entry_id text,
  counted_by text NOT NULL,
  created_at text NOT NULL,
  UNIQUE (branch_id, day)
);

-- Buying from the shop in the member app (L164 to L169).
ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS image_mime text;
ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS image_data text;
ALTER TABLE shop_sales ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'till';
ALTER TABLE shop_sales ADD COLUMN IF NOT EXISTS fulfilment text;
ALTER TABLE shop_sales ADD COLUMN IF NOT EXISTS advert_id text;
ALTER TABLE shop_sales ADD COLUMN IF NOT EXISTS buyer_user_id text;
ALTER TABLE shop_sales ADD COLUMN IF NOT EXISTS ready_at text;
ALTER TABLE shop_sales ADD COLUMN IF NOT EXISTS collected_at text;
ALTER TABLE adverts ADD COLUMN IF NOT EXISTS action jsonb;

-- Event tickets (L170 to L178).
ALTER TABLE events ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS ticketed boolean NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS poster_mime text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS poster_data text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS poster_w int;
ALTER TABLE events ADD COLUMN IF NOT EXISTS poster_h int;
ALTER TABLE events ADD COLUMN IF NOT EXISTS ticket_reminder_sent boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS ticket_types (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  event_id text NOT NULL,
  name text NOT NULL,
  description text,
  price bigint NOT NULL DEFAULT 0,
  quantity int NOT NULL,
  per_order_max int NOT NULL DEFAULT 10,
  sales_start text,
  sales_end text,
  active boolean NOT NULL DEFAULT true,
  sort int NOT NULL DEFAULT 0,
  created_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_orders (
  id text PRIMARY KEY,
  secret text NOT NULL UNIQUE,
  code text NOT NULL UNIQUE,
  org_id text NOT NULL,
  branch_id text,
  event_id text NOT NULL,
  buyer_name text NOT NULL,
  buyer_email text,
  buyer_phone text,
  buyer_user_id text,
  buyer_membership_id text,
  method text,
  status text NOT NULL CHECK (status IN ('awaiting_payment','paid','lapsed','cancelled')),
  subtotal bigint NOT NULL,
  service_fee bigint NOT NULL DEFAULT 0,
  total bigint NOT NULL,
  provider_tx_id text,
  payment_id text,
  hold_until text,
  advert_id text,
  created_at text NOT NULL,
  paid_at text
);
CREATE TABLE IF NOT EXISTS ticket_order_lines (
  order_id text NOT NULL,
  type_id text NOT NULL,
  type_name text NOT NULL,
  qty int NOT NULL,
  unit_price bigint NOT NULL,
  PRIMARY KEY (order_id, type_id)
);
CREATE TABLE IF NOT EXISTS tickets (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  event_id text NOT NULL,
  order_id text NOT NULL,
  type_id text NOT NULL,
  type_name text NOT NULL,
  serial text NOT NULL UNIQUE,
  token text NOT NULL UNIQUE,
  holder_name text NOT NULL,
  status text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','used','cancelled')),
  checked_in_at text,
  checked_in_by text,
  cancelled_by text,
  cancel_reason text,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS tickets_event_idx ON tickets(event_id);

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
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS html text;

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
  FOREACH t IN ARRAY ARRAY['households','memberships','guardians','org_settings','membership_history','roles','role_assignments','projects','pledges','give_intents','kyc_documents','payout_change_requests','wallets','sender_requests','adverts','advert_seen','ticket_types','ticket_orders','tickets','shop_items','shop_movements','shop_sales','shop_tills','resources','resource_blocks','bookings','booking_items','notices','events','event_rsvps','group_posts','group_comments','group_join_requests','integration_settings','branch_integrations','wallet_topups','sms_messages','groups','group_members','messages','certificate_templates','branch_profiles','sacramental_records','record_issues','entity_versions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = current_setting(''app.org_id'', true))', t);
  END LOOP;
END $$;
`;
