/**
 * Request-scoped row-level security (AZ-20, slice 38). Run once after APP_SCHEMA on every start; idempotent and additive.
 *
 * - `churchos_app` is the low-privilege role the request layer switches to (see packages/ledger/src/db.ts, `dbScope`).
 * - Every table with an `org_id` gets RLS enabled and FORCED, with one policy `tenant_isolation`: a row is visible and writable when
 *   `app.bypass = 'on'` (platform, system, keyed-by-secret paths) or its org_id is in the comma list in `app.org_id`.
 *   Tables whose org_id may be NULL by design (platform accounts, notifications addressed to a person) let NULL rows through;
 *   payments, audit events and the email outbox keep NULL rows (suspense, platform events, system mail) for bypass only.
 * - Child tables that had no org_id get one, backfilled from the parent, and a trigger that fills it on insert, so no handler changes.
 * - New tables are covered automatically on the next start (the loop reads the catalogue).
 */
export const RLS_SQL = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'churchos_app') THEN CREATE ROLE churchos_app; END IF;
END $$;

CREATE OR REPLACE FUNCTION app_org_ok(o text) RETURNS boolean LANGUAGE sql STABLE AS $f$
  SELECT current_setting('app.bypass', true) = 'on'
      OR (o IS NOT NULL AND o = ANY (string_to_array(NULLIF(current_setting('app.org_id', true), ''), ',')))
$f$;

-- Fills org_id on a child row from its parent. SECURITY DEFINER so the lookup does not depend on the caller's scope.
CREATE OR REPLACE FUNCTION fill_org_from_parent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
DECLARE o text;
BEGIN
  IF NEW.org_id IS NULL THEN
    EXECUTE format('SELECT org_id FROM %I WHERE id = $1', TG_ARGV[0]) INTO o USING to_jsonb(NEW) ->> TG_ARGV[1];
    NEW.org_id := o;
  END IF;
  RETURN NEW;
END;
$f$;

DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('anonymous_gifts','give_intents','intent_id'),
    ('birthday_wishes','memberships','membership_id'),
    ('held_payments','payments','payment_id'),
    ('message_recipients','messages','message_id'),
    ('prayer_owners','prayer_requests','prayer_id'),
    ('prayer_prays','prayer_requests','prayer_id'),
    ('suggestion_owners','suggestions','suggestion_id'),
    ('reversal_requests','payments','payment_id'),
    ('refund_attempts','payments','payment_id'),
    ('shop_sale_lines','shop_sales','sale_id'),
    ('ticket_order_lines','ticket_orders','order_id')
  ) AS v(t, parent, fk) LOOP
    IF to_regclass(c.t) IS NULL OR to_regclass(c.parent) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS org_id text', c.t);
    EXECUTE format('UPDATE %I x SET org_id = p.org_id FROM %I p WHERE x.org_id IS NULL AND p.id = x.%I', c.t, c.parent, c.fk);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (org_id)', c.t || '_org_idx', c.t);
    EXECUTE format('DROP TRIGGER IF EXISTS fill_org ON %I', c.t);
    EXECUTE format('CREATE TRIGGER fill_org BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION fill_org_from_parent(%L, %L)', c.t, c.parent, c.fk);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO churchos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO churchos_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_user;

DO $$ DECLARE t record; expr text; BEGIN
  FOR t IN
    SELECT c.relname AS name, a.attnotnull AS notnull
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped
    WHERE c.relkind = 'r'
  LOOP
    expr := 'app_org_ok(org_id)';
    IF t.name = 'transfers' THEN expr := 'app_org_ok(org_id) OR app_org_ok(to_org_id)';
    ELSIF NOT t.notnull AND t.name IN ('accounts','notifications','legal_acceptances') THEN expr := 'org_id IS NULL OR app_org_ok(org_id)';
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t.name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (%s)', t.name, expr);
    -- System mail has no church. Anyone may queue it; only bypass (or its own church) may read it.
    EXECUTE format('DROP POLICY IF EXISTS system_insert ON %I', t.name);
    IF t.name = 'email_outbox' THEN EXECUTE format('CREATE POLICY system_insert ON %I FOR INSERT WITH CHECK (org_id IS NULL)', t.name); END IF;
  END LOOP;
END $$;
`;
