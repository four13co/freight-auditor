-- Up Migration
-- ---------------------------------------------------------------------------
-- 0011: minimal contract-rate data model (Master Spec §6.4, Phase 2 slice).
--
-- The full rate model (§6.4: rate_rule/rate_table/rate_cell, Match->Compute->
-- Constrain->Cite) is deferred -- this is the minimal slice needed for one
-- working CONTRACT-tier criterion (86e25te91): one contracted rate per
-- (contract, charge category), starting with LINEHAUL. Extensible (more
-- categories can be added as rows, no schema change), but not the full
-- axis-keyed rate_cell model. Mirrors contract_clause's citation style.
-- ---------------------------------------------------------------------------

CREATE TABLE contract_rate (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL REFERENCES client(id),
  contract_version_id uuid NOT NULL REFERENCES contract_version(id),
  category            text NOT NULL,             -- canonical charge category, e.g. 'LINEHAUL'
  rate                numeric(18,4) NOT NULL,
  currency            char(3) NOT NULL,
  clause_id           uuid REFERENCES contract_clause(id),  -- citation, if one is linked
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_version_id, category)
);
CREATE INDEX contract_rate_client_idx ON contract_rate (client_id, contract_version_id);

-- This table lands after 0010's dynamic full-CRUD grant already ran, so grant
-- explicitly here (mutable config table, not append-only -- rates can be
-- corrected, unlike the financial-boundary ledger tables in 0010's list).
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_rate TO freight_app;

-- Down Migration
REVOKE ALL ON contract_rate FROM freight_app;
DROP TABLE IF EXISTS contract_rate;
