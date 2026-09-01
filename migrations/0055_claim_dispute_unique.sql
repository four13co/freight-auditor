-- Up Migration
-- P5.A.1: a real uniqueness floor so createClaimFromDispute's idempotent
-- create (INSERT ... ON CONFLICT DO NOTHING + re-read fallback) can't be
-- raced into duplicate claim rows for the same dispute under concurrent
-- retries -- the gap #165's review closure found in the unconstrained
-- SELECT-then-INSERT version.
CREATE UNIQUE INDEX claim_dispute_unique_idx ON claim (client_id, dispute_id) WHERE dispute_id IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS claim_dispute_unique_idx;
