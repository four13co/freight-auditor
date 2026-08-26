-- Up Migration
ALTER TABLE rule_version ADD COLUMN predecessor_rule_version_id uuid REFERENCES rule_version(id);
CREATE UNIQUE INDEX rule_version_lifecycle_transition_idx
  ON rule_version (predecessor_rule_version_id, lifecycle_state) WHERE predecessor_rule_version_id IS NOT NULL;
CREATE UNIQUE INDEX promotion_event_transition_idx ON promotion_event (rule_version_id, from_lifecycle, to_lifecycle);

-- Down Migration
DROP INDEX IF EXISTS promotion_event_transition_idx;
DROP INDEX IF EXISTS rule_version_lifecycle_transition_idx;
ALTER TABLE rule_version DROP COLUMN IF EXISTS predecessor_rule_version_id;
