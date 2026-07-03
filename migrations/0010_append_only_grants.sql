-- Up Migration
-- ---------------------------------------------------------------------------
-- 0010: privilege model (Master Spec §11, §1.5).
--
-- The app connects as `freight_app`. Append-only at the financial boundary is
-- enforced by GRANTING ONLY INSERT + SELECT on the ledger tables — there is no
-- UPDATE/DELETE grant to exploit. "Edits" are new versions/rows (§1.5).
-- Everything else (operational/config/mutable-summary tables) gets full CRUD.
--
-- Superusers ignore grants, so these bind only under `freight_app` — which is
-- exactly the role the app uses and the tests assert against.
-- ---------------------------------------------------------------------------

-- Schema + sequence usage.
GRANT USAGE ON SCHEMA public TO freight_app;

DO $$
DECLARE
  t text;
  -- The append-only financial boundary (§11 verbatim list) + the version/ledger
  -- tables that must never be mutated in place.
  append_only text[] := ARRAY[
    'audit_event', 'external_value', 'rubric_version', 'criterion_version',
    'rule_version', 'promotion_event', 'human_override', 'resolution_conflict',
    'gate_failure', 'charge_finding', 'dispute_comm', 'recovery_event',
    'payment_gate_decision', 'finding_status_event', 'contract_version',
    'extraction_field',
    -- also immutable by nature:
    'source_document', 'raw_edi_document', 'computation_trace', 'criterion_alias'
  ];
  all_tables text[];
  mutable text;
BEGIN
  -- 1. Append-only tables: INSERT + SELECT only.
  FOREACH t IN ARRAY append_only LOOP
    EXECUTE format('GRANT SELECT, INSERT ON %I TO freight_app;', t);
  END LOOP;

  -- 2. Every other base table in public (except the migration bookkeeping):
  --    full CRUD for the app role.
  SELECT array_agg(tablename)
    INTO all_tables
    FROM pg_tables
   WHERE schemaname = 'public'
     AND tablename <> 'pgmigrations'
     AND tablename <> ALL (append_only);

  IF all_tables IS NOT NULL THEN
    FOREACH mutable IN ARRAY all_tables LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO freight_app;', mutable);
    END LOOP;
  END IF;
END
$$;

-- Down Migration
DO $$
DECLARE
  t text;
  all_tables text[];
BEGIN
  SELECT array_agg(tablename) INTO all_tables
    FROM pg_tables
   WHERE schemaname = 'public' AND tablename <> 'pgmigrations';
  IF all_tables IS NOT NULL THEN
    FOREACH t IN ARRAY all_tables LOOP
      EXECUTE format('REVOKE ALL ON %I FROM freight_app;', t);
    END LOOP;
  END IF;
  REVOKE USAGE ON SCHEMA public FROM freight_app;
END
$$;
