# audit-ledger module

The append-only `audit_event` ledger and the audit-run replay machinery
built on top of it.

- `write-audit-event.ts` is the single write path every other module calls
  to record an `audit_event` row — deterministic IDs
  (`deterministicAuditEventId`) make every call site idempotent, and a
  `Date` reaching the `detail` payload is coerced to an ISO string here so
  callers never need to remember `.toISOString()` themselves. Called from
  across the codebase (claims, disputes, findings, payments, rule
  governance) and from `src/jobs/job-dispatcher.ts`.
- `read-audit-evidence.ts` is the read side: rubric-snapshot and
  resolution-conflict lookups for a given audit run, reachable via
  `src/server/evidence-routes.ts`.
- `replay-audit-run.ts` + `replay-manifest.ts` re-run a past audit run's
  evaluation deterministically against its recorded manifest (contract
  facts, rubric version, resolved values) to verify the original result is
  reproducible — reachable via `src/server/audit-runs-routes.ts`'s replay
  endpoint.
- `security-events.ts` is a thin `writeAuditEvent` wrapper for
  security-relevant events (e.g. auth), reachable via
  `src/server/auth-routes.ts`.

All of the above is real, tested, production-wired logic — nothing in this
module is deferred.
