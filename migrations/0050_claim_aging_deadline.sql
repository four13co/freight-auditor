-- Up Migration
-- P5.B.1: aging deadline for a claim -- the point by which follow-up
-- (P5.B.2) or escalation (P5.B.3) should act if the claim is still open.
-- Nullable: a claim opened before this column existed, or one whose
-- deadline hasn't been set yet, has no deadline rather than a fabricated
-- default -- additive per this repo's schema convention.
--
-- Migration number 0050: 0045-0049 are reserved by PRs #157/#160/#161/
-- #163/#169 (open, unmerged as of this migration).
ALTER TABLE claim ADD COLUMN aging_deadline_at timestamptz;
CREATE INDEX claim_aging_deadline_idx ON claim (client_id, aging_deadline_at) WHERE aging_deadline_at IS NOT NULL;

-- claim is already granted full CRUD (not on 0010's append-only list), so
-- no grant change is needed for this new column.

-- Down Migration
DROP INDEX IF EXISTS claim_aging_deadline_idx;
ALTER TABLE claim DROP COLUMN IF EXISTS aging_deadline_at;
