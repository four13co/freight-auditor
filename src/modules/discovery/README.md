# discovery module

Each detector deterministically converts evidence that already exists elsewhere in the ledger into tenant-scoped append-only `discovery_trigger` rows. None performs an AI call, proposes a rule, or activates/mutates anything outside `discovery_trigger` itself; exact retries are idempotent (unique per source row).

- `detectUnassessableTriggers` — scoring/gate `unassessable` results (`variance_finding`, `gate_failure`) for an audit run.
- `detectUnknownChargeCodeTriggers` — `charge_fact` rows on an audit run's invoice whose charge-code crosswalk lookup produced no canonical category (`category IS NULL`).
- `detectExtractionQualityTriggers` — `extraction_field` rows for a source document: `STRUCTURAL_ANOMALY` when the model produced no value at all, `LOW_CONFIDENCE` when it answered below threshold and no human correction has resolved it yet.
- `detectSuspiciousPassTriggers` — republishes an audit run's `coverage_marker` rows (a charge that passed despite missing fields the rubric needed).
