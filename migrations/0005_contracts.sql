-- Up Migration
-- ---------------------------------------------------------------------------
-- 0005: contracts, versions, amendments, clauses (Master Spec §6.3).
--
-- contract_version is append-only (§11, grants in 0010) AND bitemporally
-- effective-dated. The GiST EXCLUDE constraint guarantees exactly one
-- applicable version per (contract, ship-date) — the temporal-resolution
-- invariant (§1.6). btree_gist (0001) lets us mix uuid equality with
-- daterange overlap in one exclusion.
-- ---------------------------------------------------------------------------

CREATE TABLE contract (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES client(id),
  carrier_id  uuid NOT NULL REFERENCES carrier(id),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contract_client_idx ON contract (client_id, carrier_id);

CREATE TABLE contract_version (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES client(id),
  contract_id   uuid NOT NULL REFERENCES contract(id),
  version_label text,
  -- business-time validity: [valid_from, valid_to). valid_to NULL = open-ended,
  -- normalized to 'infinity' inside the daterange for the exclusion.
  valid_from    date NOT NULL,
  valid_to      date,
  source_document_id uuid REFERENCES source_document(id),
  recorded_at   timestamptz NOT NULL DEFAULT now(),   -- system-time (bitemporal)
  -- One applicable version per (contract, ship-date): no two versions of the
  -- same contract may have overlapping business-time ranges.
  CONSTRAINT contract_version_no_overlap
    EXCLUDE USING gist (
      contract_id WITH =,
      daterange(valid_from, valid_to, '[)') WITH &&
    )
);
CREATE INDEX contract_version_client_idx ON contract_version (client_id, contract_id);

CREATE TABLE contract_amendment (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL REFERENCES client(id),
  contract_id         uuid NOT NULL REFERENCES contract(id),
  supersedes_version_id uuid REFERENCES contract_version(id),
  new_version_id      uuid REFERENCES contract_version(id),
  effective_date      date NOT NULL,
  summary             text,
  recorded_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contract_amendment_client_idx ON contract_amendment (client_id, contract_id);

-- Clause: the citation primitive. Provenance points here (§1.8, §8).
CREATE TABLE contract_clause (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL REFERENCES client(id),
  contract_version_id uuid NOT NULL REFERENCES contract_version(id),
  clause_ref          text NOT NULL,          -- e.g. "4.2"
  text_excerpt        text,
  page_ref            text,
  UNIQUE (contract_version_id, clause_ref)
);
CREATE INDEX contract_clause_client_idx ON contract_clause (client_id, contract_version_id);

-- Down Migration
DROP TABLE IF EXISTS contract_clause;
DROP TABLE IF EXISTS contract_amendment;
DROP TABLE IF EXISTS contract_version;
DROP TABLE IF EXISTS contract;
