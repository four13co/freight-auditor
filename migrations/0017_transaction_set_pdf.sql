-- Up Migration
-- ---------------------------------------------------------------------------
-- 0017: add 'PDF' to the transaction_set enum (86e2xb911).
--
-- invoice.transaction_set is NOT NULL and, until now, constrained to the two
-- real X12 transaction sets ('210' motor, '310' ocean) -- both EDI-specific.
-- A PDF-derived invoice (confirmed from an invoice_draft, 0016) is neither;
-- mislabeling it as '210' would be a silent lie about its provenance (this
-- repo's own §10 rule: honest-missing beats guessed). Postgres enums only
-- support additive ALTER TYPE ... ADD VALUE, matching this repo's established
-- additive-schema convention (never rename/drop an existing value).
-- ---------------------------------------------------------------------------

ALTER TYPE transaction_set ADD VALUE 'PDF';

-- Down Migration
-- Postgres has no DROP VALUE for enums; a real rollback would require
-- rebuilding the type (rename old, create new, cast every column, drop old)
-- across invoice.transaction_set, source_document.transaction_set, and any
-- other consumer -- destructive and out of scope for a down migration this
-- repo has never needed for an enum-value addition before (0002 through 0015
-- never removed a value). Left as a documented no-op, consistent with the
-- irreversibility Postgres itself imposes here.
