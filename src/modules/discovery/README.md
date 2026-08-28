# discovery module

`detectUnassessableTriggers` deterministically converts persisted scoring and gate unassessable results into tenant-scoped append-only discovery evidence. Each trigger pins its original finding, audit run, criterion/rule version, evaluated-AST hash, and stable detail. Exact retries are idempotent; this boundary performs no AI call and cannot propose or activate rules.
