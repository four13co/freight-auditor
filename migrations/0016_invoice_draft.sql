-- Up Migration
-- ---------------------------------------------------------------------------
-- 0016: invoice_draft (86e2xb911) -- the PDF-upload draft/confirm flow's
-- storage home.
--
-- A draft is explicitly NOT an audit_run row (the item's AC1: extracting a
-- PDF must not create a real audit run), so it needs its own table rather
-- than reusing invoice/audit_run with a "draft" flag threaded through every
-- downstream query. The extraction + human-correction diff itself is NOT
-- duplicated here -- extraction_field (migration 0008) already exists for
-- exactly this purpose ("keeps the AI's value AND the human correction") and
-- has carried zero real callers until this item; this table only tracks the
-- draft's own lifecycle and payloads, and confirm-with-corrections writes the
-- diff into extraction_field per corrected field (see invoice-draft.ts).
--
-- extracted_payload is the raw LLM output, already shaped as a ParsedInvoice
-- (charge-fact.ts) so confirm can hand it to the existing evaluateInvoice/
-- persistAuditRun pipeline unchanged. corrected_payload is NULL until the
-- analyst corrects at least one field; confirm reads corrected_payload when
-- present, else extracted_payload (never merges partial corrections here --
-- the caller sends the full corrected document, matching how the route
-- receives it).
-- ---------------------------------------------------------------------------

CREATE TYPE invoice_draft_status AS ENUM (
  'extracted',            -- LLM extraction succeeded, awaiting analyst review
  'needs_carrier_review', -- extraction succeeded but carrier match is ambiguous
  'confirmed',             -- analyst confirmed; confirmed_audit_run_id is set
  'rejected'               -- analyst discarded the draft without confirming
);

CREATE TABLE invoice_draft (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             uuid NOT NULL REFERENCES client(id),
  source_document_id    uuid NOT NULL REFERENCES source_document(id),
  status                invoice_draft_status NOT NULL DEFAULT 'extracted',
  extracted_payload     jsonb NOT NULL,
  corrected_payload     jsonb,
  carrier_candidates    jsonb,          -- ambiguous carrier-name matches, [{carrierId, name, score}, ...]
  extraction_model      text NOT NULL,  -- model id used for extraction, e.g. "claude-opus-5"
  confirmed_audit_run_id uuid REFERENCES audit_run(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_draft_client_status_idx ON invoice_draft (client_id, status);
CREATE INDEX invoice_draft_source_document_idx ON invoice_draft (client_id, source_document_id);

SELECT apply_tenant_rls('invoice_draft', 'client_id');

GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_draft TO freight_app;

-- Down Migration
REVOKE ALL ON invoice_draft FROM freight_app;
DROP POLICY IF EXISTS tenant_isolation ON invoice_draft;
DROP TABLE IF EXISTS invoice_draft;
DROP TYPE IF EXISTS invoice_draft_status;
