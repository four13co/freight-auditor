# rate-engine module

`generate-expected-charges.ts` creates canonical expected-side financial
evidence. `align-tier1-charges.ts` performs only deterministic one-to-one
category/currency alignment; missing and many-to-one candidates are explicit
unassessable issues for higher tiers rather than guessed by input order.
`attribute-grouped-variance.ts` aggregates explicit group or invoice member
sets and retains every contributing billed and expected identifier.
`persist-charge-alignment.ts` writes an attribution's result to the
`charge_alignment` / `charge_alignment_member` tables.

**Deferred (86e32tg5q): not yet wired into a real audit run.** These four
files are tested (unit + DB) but have zero callers outside their own tests —
no route or job constructs an `ExpectedChargeSpec[]` and drives them. This is
deliberate, not an oversight: `generateExpectedCharges` expects per-charge
`ExpectedChargeSpec`s keyed by `rateCellId`/`clauseId`, i.e. a full
rate-cell/clause decomposition of a contract. The real ingestion path
(`ingest-invoice.ts`) doesn't produce that yet — it resolves only a single
flat `LINEHAUL` rate via `rate-lookup.ts` and feeds it straight into
`evaluate-invoice.ts`'s rubric model, which has no concept of rate cells,
clauses, or tier-1/tier-2 alignment.

**What unblocks it:** a contract data model with rate cells and clauses
(so `ExpectedChargeSpec.rateCellId`/`clauseId` have something real to point
at), plus an ingestion-side step that expands a contract into per-category
`ExpectedChargeSpec`s and billed-side `BilledChargeForAlignment`s for the
current audit run, then calls this pipeline and persists the result via
`persistChargeAlignment`. Until that upstream contract-structure work lands,
wiring this in would mean inventing fake rate-cell/clause ids at the call
site — worse than leaving it disclosed and unwired.
