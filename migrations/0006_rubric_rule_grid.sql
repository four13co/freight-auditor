-- Up Migration
-- ---------------------------------------------------------------------------
-- 0006: the rubric + criterion + rule grid (Master Spec §3, §6.6b) — the core.
--
-- Rubric → Criterion → Rule. The criterion is the stable unit of judgment
-- (identified cross-tier by criterion_key); rules harden/demote underneath it.
-- Override-matching + provenance attach at the criterion; hardness/lifecycle
-- at the rule. Version tables (criterion_version, rule_version, rubric_version)
-- are append-only (§11, grants in 0010) and bitemporal.
-- ---------------------------------------------------------------------------

-- ---- Criterion layer -------------------------------------------------------

CREATE TABLE criterion (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- criterion_key is the STABLE cross-tier identity — the linchpin of override
  -- matching (§14 #9, highest-risk). Governance (who mints keys) is DEFERRED;
  -- here it is a unique string + an append-only alias table for renames.
  criterion_key text NOT NULL UNIQUE,
  kind          criterion_kind NOT NULL,
  gate_severity text,                          -- meaningful when kind=GATING
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Append-only rename registry so a criterion_key can be re-pointed without a
-- destructive UPDATE (§14 #9 proposed mitigation).
CREATE TABLE criterion_alias (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  criterion_id  uuid NOT NULL REFERENCES criterion(id),
  alias_key     text NOT NULL UNIQUE,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE criterion_version (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  criterion_id        uuid NOT NULL REFERENCES criterion(id),
  unassessable_policy unassessable_policy NOT NULL DEFAULT 'TREAT_AS_UNASSESSABLE',
  description         text,
  valid_from          date NOT NULL DEFAULT CURRENT_DATE,
  valid_to            date,
  recorded_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX criterion_version_criterion_idx ON criterion_version (criterion_id, recorded_at DESC);

-- ---- Rule layer ------------------------------------------------------------

CREATE TABLE rule (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE,
  rule_type  rule_type NOT NULL,               -- STABLE for the life of the rule
  created_at timestamptz NOT NULL DEFAULT now()
);

-- rule_version: append-only, bitemporal. Carries the executable predicate AST
-- (never raw JS — §3.2), the hardness + lifecycle, expected inputs, provenance.
CREATE TABLE rule_version (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id          uuid NOT NULL REFERENCES rule(id),
  hardness         rule_hardness NOT NULL,
  lifecycle_state  rule_lifecycle NOT NULL DEFAULT 'PROPOSED',
  ast              jsonb NOT NULL,             -- declarative predicate AST
  ast_hash         char(64) NOT NULL,          -- dedup + snapshot pinning
  expected_inputs  jsonb NOT NULL DEFAULT '[]'::jsonb,
  emits            rule_emits NOT NULL,
  provenance       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- clause_id / human_override chain
  clause_id        uuid REFERENCES contract_clause(id), -- citation (§8): firm rule must cite
  valid_from       date NOT NULL DEFAULT CURRENT_DATE,
  valid_to         date,
  recorded_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rule_version_rule_idx ON rule_version (rule_id, recorded_at DESC);
CREATE INDEX rule_version_ast_hash_idx ON rule_version (ast_hash);
CREATE INDEX rule_version_lifecycle_idx ON rule_version (lifecycle_state);

-- Human-override canon (§1.2 HUMAN_INPUT / §7 #2). Append-only; trumps cascade.
CREATE TABLE human_override (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid REFERENCES client(id),  -- NULL = applies across tenants (rare)
  criterion_id     uuid REFERENCES criterion(id),
  case_fingerprint text NOT NULL,               -- mode/charge-type/lane-class/... (NOT $ amounts)
  asserted_value   jsonb NOT NULL,
  confirm_count    integer NOT NULL DEFAULT 0,
  reversal_count   integer NOT NULL DEFAULT 0,
  recorded_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX human_override_fingerprint_idx ON human_override (client_id, case_fingerprint);

-- Promotion ladder events (§4.1/§4.2). Append-only.
CREATE TABLE promotion_event (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_version_id uuid NOT NULL REFERENCES rule_version(id),
  from_hardness   rule_hardness,
  to_hardness     rule_hardness,
  from_lifecycle  rule_lifecycle,
  to_lifecycle    rule_lifecycle,
  direction       promotion_direction NOT NULL,
  backtest_run_id uuid,                          -- FK added in 0007 (audit_run) — soft ref
  rationale       text,
  recorded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX promotion_event_rule_version_idx ON promotion_event (rule_version_id, recorded_at DESC);

-- Promotion policy: thresholds per (client, rule_type). Config, mutable.
CREATE TABLE promotion_policy (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid REFERENCES client(id),      -- NULL = default policy
  rule_type     rule_type,
  n1_confirm    integer NOT NULL DEFAULT 3,       -- HUMAN_INPUT -> AI_CANON
  n2_confirm    integer NOT NULL DEFAULT 5,       -- AI_DOCS -> FIRM_RULE
  max_reversals integer NOT NULL DEFAULT 1,
  UNIQUE (client_id, rule_type)
);

-- ---- Rubric layer ----------------------------------------------------------

CREATE TABLE rubric (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tier              rubric_tier NOT NULL,
  scope_client_id   uuid REFERENCES client(id),    -- NULL for STANDARD (shared catalog)
  scope_contract_id uuid REFERENCES contract(id),  -- set for CONTRACT tier
  mode_filter       transport_mode[],              -- applicable modes
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- Tier invariants (§6.10): STANDARD has no client/contract scope; CLIENT has a
-- client but no contract; CONTRACT has both.
CREATE INDEX rubric_scope_idx ON rubric (scope_client_id, scope_contract_id);
ALTER TABLE rubric ADD CONSTRAINT rubric_tier_scope_chk CHECK (
  (tier = 'STANDARD' AND scope_client_id IS NULL AND scope_contract_id IS NULL) OR
  (tier = 'CLIENT'   AND scope_client_id IS NOT NULL AND scope_contract_id IS NULL) OR
  (tier = 'CONTRACT' AND scope_client_id IS NOT NULL AND scope_contract_id IS NOT NULL)
);

CREATE TABLE rubric_version (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rubric_id   uuid NOT NULL REFERENCES rubric(id),
  valid_from  date NOT NULL DEFAULT CURRENT_DATE,
  valid_to    date,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rubric_version_rubric_idx ON rubric_version (rubric_id, recorded_at DESC);

-- Membership matches by criterion_key (§3.0) — that is what lets tiers collapse.
CREATE TABLE criterion_membership (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rubric_version_id    uuid NOT NULL REFERENCES rubric_version(id),
  criterion_key        text NOT NULL,
  criterion_version_id uuid REFERENCES criterion_version(id),
  override_verb        override_verb NOT NULL DEFAULT 'INHERIT',
  override_payload     jsonb,
  eval_order           integer NOT NULL DEFAULT 0,
  UNIQUE (rubric_version_id, criterion_key)
);
CREATE INDEX criterion_membership_cascade_idx ON criterion_membership (rubric_version_id, criterion_key);

CREATE TABLE criterion_rule (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  criterion_version_id uuid NOT NULL REFERENCES criterion_version(id),
  rule_id              uuid NOT NULL REFERENCES rule(id),
  rule_pin             text NOT NULL DEFAULT '@active',  -- '@active' or a rule_version id
  role                 criterion_rule_role NOT NULL DEFAULT 'PRIMARY',
  combine              rule_combine NOT NULL DEFAULT 'FIRST_APPLICABLE',
  rank                 integer NOT NULL DEFAULT 0
);
CREATE INDEX criterion_rule_criterion_idx ON criterion_rule (criterion_version_id, rank);

-- The composed, content-hashed rubric an audit runs against (§3.0). Reproducible.
CREATE TABLE rubric_snapshot (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid REFERENCES client(id),    -- NULL only for pure-STANDARD snapshots
  content_hash     char(64) NOT NULL,
  resolved_doc     jsonb NOT NULL,                -- fully composed rubric, all rule_versions pinned
  resolver_version text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, content_hash)
);

-- Loud rejection of resolution conflicts (§3.0). Append-only.
CREATE TABLE resolution_conflict (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES client(id),
  criterion_key text,
  conflict_type text NOT NULL,                    -- e.g. NON_MONOTONE_TIGHTEN, EXEMPT_OF_HARD_GATE
  detail        jsonb,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS resolution_conflict;
DROP TABLE IF EXISTS rubric_snapshot;
DROP TABLE IF EXISTS criterion_rule;
DROP TABLE IF EXISTS criterion_membership;
DROP TABLE IF EXISTS rubric_version;
DROP TABLE IF EXISTS rubric;
DROP TABLE IF EXISTS promotion_policy;
DROP TABLE IF EXISTS promotion_event;
DROP TABLE IF EXISTS human_override;
DROP TABLE IF EXISTS rule_version;
DROP TABLE IF EXISTS rule;
DROP TABLE IF EXISTS criterion_version;
DROP TABLE IF EXISTS criterion_alias;
DROP TABLE IF EXISTS criterion;
