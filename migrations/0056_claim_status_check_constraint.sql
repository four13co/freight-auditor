-- Up Migration
-- Restricts claim.status to the vocabulary every call site already writes
-- (src/modules/claims/claim-status.ts): 'open' plus the three terminal
-- statuses. No existing row can violate this -- no code path in this repo
-- has ever written anything else -- so this is a pure additive guard, not
-- a backfill.
ALTER TABLE claim
  ADD CONSTRAINT claim_status_known_values
  CHECK (status IN ('open', 'recovered', 'denied', 'written_off'));

-- Down Migration
ALTER TABLE claim DROP CONSTRAINT claim_status_known_values;
