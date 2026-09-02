-- Up Migration
-- ---------------------------------------------------------------------------
-- 0074: format-only CHECK on every currency char(3) column, so a malformed
-- or lowercase code (e.g. 'usd', 'US', '12A') can no longer be written and
-- silently break the currency-equality checks in validatePartialRecovery,
-- validateClaimResolution, checkCurrencyConsistency, and
-- validateClaimableDispute (all of which already assume ISO-4217-shaped
-- values per the app-level comment at src/modules/ingestion/charge-fact.ts:23).
--
-- Deliberately format-only (3 uppercase letters), not a real ISO-4217
-- registry lookup — 86e2zfjkk's stated scope. No existing row can violate
-- this: every writer in src/ already writes uppercase 3-letter codes
-- (e.g. 'USD'), so this is a pure additive guard, not a backfill.
-- ---------------------------------------------------------------------------
ALTER TABLE invoice                 ADD CONSTRAINT invoice_currency_format_chk               CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE charge_fact             ADD CONSTRAINT charge_fact_currency_format_chk           CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE expected_charge         ADD CONSTRAINT expected_charge_currency_format_chk       CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE charge_finding          ADD CONSTRAINT charge_finding_currency_format_chk        CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE variance_finding        ADD CONSTRAINT variance_finding_currency_format_chk      CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE scorecard               ADD CONSTRAINT scorecard_currency_format_chk             CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE dispute                 ADD CONSTRAINT dispute_currency_format_chk               CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE dispute_line            ADD CONSTRAINT dispute_line_currency_format_chk          CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE payment_gate_decision   ADD CONSTRAINT payment_gate_decision_currency_format_chk CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE claim                   ADD CONSTRAINT claim_currency_format_chk                 CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE recovery_event          ADD CONSTRAINT recovery_event_currency_format_chk        CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE contract_rate           ADD CONSTRAINT contract_rate_currency_format_chk         CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE charge_alignment        ADD CONSTRAINT charge_alignment_currency_format_chk      CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE rate_cell               ADD CONSTRAINT rate_cell_currency_format_chk             CHECK (currency ~ '^[A-Z]{3}$');

-- Down Migration
ALTER TABLE rate_cell               DROP CONSTRAINT rate_cell_currency_format_chk;
ALTER TABLE charge_alignment        DROP CONSTRAINT charge_alignment_currency_format_chk;
ALTER TABLE contract_rate           DROP CONSTRAINT contract_rate_currency_format_chk;
ALTER TABLE recovery_event          DROP CONSTRAINT recovery_event_currency_format_chk;
ALTER TABLE claim                   DROP CONSTRAINT claim_currency_format_chk;
ALTER TABLE payment_gate_decision   DROP CONSTRAINT payment_gate_decision_currency_format_chk;
ALTER TABLE dispute_line            DROP CONSTRAINT dispute_line_currency_format_chk;
ALTER TABLE dispute                 DROP CONSTRAINT dispute_currency_format_chk;
ALTER TABLE scorecard               DROP CONSTRAINT scorecard_currency_format_chk;
ALTER TABLE variance_finding        DROP CONSTRAINT variance_finding_currency_format_chk;
ALTER TABLE charge_finding          DROP CONSTRAINT charge_finding_currency_format_chk;
ALTER TABLE expected_charge         DROP CONSTRAINT expected_charge_currency_format_chk;
ALTER TABLE charge_fact             DROP CONSTRAINT charge_fact_currency_format_chk;
ALTER TABLE invoice                 DROP CONSTRAINT invoice_currency_format_chk;
