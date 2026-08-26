-- Up Migration
CREATE TABLE external_publication (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id           uuid NOT NULL REFERENCES external_source(id),
  publication_version text NOT NULL,
  published_at        timestamptz NOT NULL,
  content_hash        char(64),
  source_document_id  uuid REFERENCES source_document(id),
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, publication_version)
);

ALTER TABLE external_value ADD COLUMN publication_id uuid REFERENCES external_publication(id);
ALTER TABLE external_value DROP CONSTRAINT external_value_source_id_axis_key_published_for_key;
CREATE UNIQUE INDEX external_value_publication_key_idx
  ON external_value (publication_id, axis_key, published_for) WHERE publication_id IS NOT NULL;
CREATE UNIQUE INDEX external_value_legacy_key_idx
  ON external_value (source_id, axis_key, published_for) WHERE publication_id IS NULL;

CREATE TABLE audit_external_value_pin (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         uuid NOT NULL REFERENCES client(id),
  audit_run_id      uuid NOT NULL REFERENCES audit_run(id) ON DELETE CASCADE,
  external_value_id uuid NOT NULL REFERENCES external_value(id),
  publication_id    uuid REFERENCES external_publication(id),
  resolver_version  text NOT NULL,
  axis_key          jsonb NOT NULL,
  published_for     date NOT NULL,
  value             numeric(18,6) NOT NULL,
  pinned_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (audit_run_id, external_value_id)
);
CREATE INDEX audit_external_value_pin_run_idx ON audit_external_value_pin (client_id, audit_run_id);
SELECT apply_tenant_rls('audit_external_value_pin', 'client_id');

REVOKE UPDATE, DELETE, TRUNCATE ON external_publication, audit_external_value_pin FROM freight_app;
GRANT SELECT, INSERT ON external_publication, audit_external_value_pin TO freight_app;

-- Down Migration
REVOKE ALL ON external_publication, audit_external_value_pin FROM freight_app;
DROP TABLE audit_external_value_pin;
DROP INDEX external_value_legacy_key_idx;
DROP INDEX external_value_publication_key_idx;
ALTER TABLE external_value DROP COLUMN publication_id;
ALTER TABLE external_value ADD UNIQUE (source_id, axis_key, published_for);
DROP TABLE external_publication;
