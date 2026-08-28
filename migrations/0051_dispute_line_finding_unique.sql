-- Up Migration
-- P4.C.2: prevent the same variance_finding from being included on more
-- than one dispute_line. A partial unique index is the structural
-- enforcement point -- fetch-time status filtering (status='accepted')
-- only prevents the common case, not a concurrent-insert race between two
-- transactions that both read the finding as accepted before either
-- commits, nor a future status transition back to 'accepted' (e.g. a
-- rejected-dispute rework flow, not yet built).
CREATE UNIQUE INDEX dispute_line_finding_unique_idx
  ON dispute_line (client_id, variance_finding_id)
  WHERE variance_finding_id IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS dispute_line_finding_unique_idx;
