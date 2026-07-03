-- Up Migration
-- ---------------------------------------------------------------------------
-- 0004: carriers, charge-code crosswalk, immutable source documents,
-- and the external-index cache (Master Spec §6.2, §6.4).
--
-- The crosswalk (§6.2) maps a carrier's raw charge codes to canonical
-- categories. Precedence (most specific wins):
--   client+carrier+code > carrier+code > carrier+pattern > global
-- Global rows have client_id IS NULL (shared read-only catalog, §6.10).
-- ---------------------------------------------------------------------------

CREATE TABLE carrier (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  carrier_type  carrier_type,
  scac_code     char(4),
  iata_code     text,
  fmc_license   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX carrier_scac_idx ON carrier (scac_code) WHERE scac_code IS NOT NULL;

CREATE TABLE carrier_charge_code (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  carrier_id        uuid NOT NULL REFERENCES carrier(id),
  code              text NOT NULL,
  description       text,
  canonical_category text,
  UNIQUE (carrier_id, code)
);

-- Crosswalk. client_id NULL = global catalog row (readable by all tenants).
-- carrier_id NULL = applies across carriers. source_pattern for fuzzy/free-text.
CREATE TABLE charge_code_crosswalk (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          uuid REFERENCES client(id),          -- NULL = global
  carrier_id         uuid REFERENCES carrier(id),         -- NULL = any carrier
  source_code        text,
  source_pattern     text,
  canonical_category text NOT NULL,
  -- precedence_rank materializes the §6.2 precedence so resolution is a simple
  -- ORDER BY precedence_rank DESC LIMIT 1: 4=client+carrier+code, 3=carrier+code,
  -- 2=carrier+pattern, 1=global. Kept as a stored column (a hot filter, §1.5).
  precedence_rank    smallint NOT NULL,
  effective_start    date,
  effective_end      date,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crosswalk_code_or_pattern CHECK (source_code IS NOT NULL OR source_pattern IS NOT NULL)
);
CREATE INDEX crosswalk_client_carrier_idx ON charge_code_crosswalk (client_id, carrier_id, precedence_rank DESC);
CREATE INDEX crosswalk_lookup_idx ON charge_code_crosswalk (carrier_id, source_code) WHERE source_code IS NOT NULL;

-- Immutable source document store (§6.3, §6.9). sha256 content-addressed;
-- re-storing identical bytes is idempotent via the unique hash.
CREATE TABLE source_document (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid REFERENCES client(id),   -- NULL for shared/global docs
  sha256       char(64) NOT NULL,
  content_type text,
  byte_size    bigint,
  storage_uri  text NOT NULL,                 -- object-storage pointer (S3-compatible/local)
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sha256)
);
CREATE INDEX source_document_client_idx ON source_document (client_id);

-- External-index cache (§6.4): the value AS PUBLISHED that week (never today's).
-- external_value is append-only (§11) — grants applied in 0010.
CREATE TABLE external_source (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,           -- e.g. EIA_DIESEL, PC_MILER, NMFC
  description text
);

CREATE TABLE external_value (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     uuid NOT NULL REFERENCES external_source(id),
  axis_key      jsonb NOT NULL,               -- e.g. {"region":"PADD1","week_of":"2026-03-02"}
  value         numeric(18,6) NOT NULL,
  published_for date NOT NULL,                 -- the business week/day this value is FOR
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, axis_key, published_for)
);
CREATE INDEX external_value_source_idx ON external_value (source_id, published_for);

-- Down Migration
DROP TABLE IF EXISTS external_value;
DROP TABLE IF EXISTS external_source;
DROP TABLE IF EXISTS source_document;
DROP TABLE IF EXISTS charge_code_crosswalk;
DROP TABLE IF EXISTS carrier_charge_code;
DROP TABLE IF EXISTS carrier;
