# claims module

The full claim lifecycle, from opening a claim off a resolved dispute
through recovery reconciliation.

- **Lifecycle (wired)**: `create-claim-from-dispute.ts` opens a claim
  (guarded by `validate-claimable-dispute.ts` and
  `detect-duplicate-claimed-finding.ts`), reachable via
  `src/server/claim-routes.ts`. `list-claims.ts` / `get-claim-detail.ts`
  (list/detail reads) are reachable via `src/server/claim-recovery-routes.ts`.
  `claim-status.ts` and `derive-claim-status.ts` are the shared
  terminal-status vocabulary (`CLAIM_TERMINAL_EVENTS`,
  `CLAIM_FOLLOW_UP_EVENT`) every other file in this module imports rather
  than re-declaring.
- **Aging (wired)**: `compute-claim-aging-deadline.ts` /
  `set-claim-aging-deadline.ts` set a claim's aging clock;
  `schedule-claim-aging-jobs.ts` schedules the scan job;
  `generate-claim-follow-up.ts` and `generate-claim-escalation.ts` fire once
  a deadline passes (with a grace period before escalation) — all reachable
  from `src/jobs/`. `list-claim-aging-queues.ts` is the queue view an
  analyst works from.
- **Portfolio reconciliation (wired)**: `reconcile-claim-buckets.ts` is the
  shared currency-bucketing/reconciliation math (86e32tg28).
  `reconcile-portfolio-totals.ts` (portfolio-wide, by currency) and
  `aggregate-cross-client-portfolio.ts` (cross-client) both reuse it and are
  reachable via `get-portfolio-reconciliation.ts`
  (`src/server/recovery-report-routes.ts`) and `get-cross-client-portfolio.ts`
  (`src/server/portfolio-routes.ts`) respectively.
- **Deferred: built, tested, zero production callers.** The rest of the
  module's write and reporting surface has no route or job calling it —
  only unit/DB tests invoke it:
  - `resolve-claim.ts` (close a claim as FULL_RECOVERY/DENIAL/WRITE_OFF, via
    `validate-claim-resolution.ts`) and `record-partial-recovery.ts` (record
    a partial recovery, via `validate-partial-recovery.ts` /
    `validate-recovery-amount-and-currency.ts`, which also enqueues a
    reconciliation export through `enqueue-reconciliation-export.ts`). A
    claim can be opened and listed but never closed or recovered against
    through this codebase's own API surface today.
  - `aggregate-carrier-recovery.ts` / `get-carrier-recovery-report.ts`
    (per-carrier+currency reconciliation — the sibling of the wired
    portfolio-wide and cross-client views above, minus a route).
  - `check-currency-consistency.ts` / `get-claim-currency-consistency.ts`
    (flags a claim whose claimed/recovered amounts mix currencies
    unexpectedly) and `check-recovery-traceability.ts` /
    `get-recovery-traceability.ts` (traces a recovered amount back to its
    originating recovery events).

  **What unblocks each:** a route surfacing it, same shape as the wired
  reconciliation views above — e.g. `POST /api/claims/:id/resolve` and
  `POST /api/claims/:id/recovery` for the lifecycle pair, and a
  `GET .../carrier-recovery` / `.../currency-consistency` /
  `.../recovery-traceability` route per reporting function.
