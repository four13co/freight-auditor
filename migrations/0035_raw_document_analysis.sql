-- Up Migration
CREATE TABLE raw_document_analysis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES client(id),
  source_document_id uuid NOT NULL REFERENCES source_document(id),
  provider text NOT NULL,
  api_version text NOT NULL,
  model_id text NOT NULL,
  operation_location text NOT NULL,
  response_hash char(64) NOT NULL,
  raw_response jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, provider, operation_location)
);
CREATE INDEX raw_document_analysis_source_idx
  ON raw_document_analysis (client_id, source_document_id, recorded_at DESC);
ALTER TABLE raw_document_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_document_analysis FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON raw_document_analysis
  USING (app_is_internal() OR client_id = ANY (app_current_client_ids()))
  WITH CHECK (app_is_internal() OR client_id = ANY (app_current_client_ids()));
GRANT SELECT, INSERT ON raw_document_analysis TO freight_app;

-- Down Migration
DROP TABLE IF EXISTS raw_document_analysis;
