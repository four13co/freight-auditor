# contracts module

Contract ingestion and AI-assisted verification boundaries.

`VersionedAnthropicProvider` is the sole reusable structured-generation boundary for contract-rubric prompts. Callers must provide an immutable prompt version, pinned model configuration, source-document SHA-256, untrusted evidence, and a strict Zod output schema. The adapter returns provider/message/token provenance and a deterministic request key; it does not persist, activate, or evaluate rules.

`normalizeContractClauses` uses prompt `contract-clause-normalization/1` and schema `clause-normalization/1` to turn verified extracted clauses into cited semantic proposals or explicit abstentions. Its schema intentionally has no rule AST, lifecycle state, expected-charge, variance, or calculated-total fields.

`generateProposedCriteria` uses prompt/schema `contract-proposed-criteria/1` and `proposed-criteria/1`. It accepts only a constrained subset of the owned interpreter AST over allowlisted, pre-resolved facts; rejects arithmetic, money, code, lifecycle, and unknown-fact output; verifies clause/citation grounding; then canonicalizes and hashes every proposal as `PROPOSED`.

`requireProposalCitations` is the explicit fail-closed gate before proposal enrichment or downstream handling. It requires exact source citation coverage for every referenced normalized clause and emits stable, deterministically ordered rejection records for absent, unknown, abstained, partially covered, or foreign evidence.

`rejectModelMoneyAuthority` recursively rejects arithmetic ASTs, money literals, and authoritative financial-result fields before strict proposal parsing. Source-stated monetary text remains evidence only; calculations stay exclusively in owned deterministic engine code.

`persistContractRuleProposals` stores proposal-only, tenant-scoped immutable records pinned to a verified contract version, extraction/verification hashes, exact AST/input hashes, provider/model/prompt/message/request provenance, analyst, and real contract-clause/citation junctions. Exact retries are idempotent and audited; these records are not executable `rule_version`s.

`backtestContractRuleProposals` requires one deterministic corpus for every proposal in a verified contract version, evaluates only the persisted AST with the owned interpreter, and stores append-only case inputs, expected/actual verdicts, evaluated trees, and hashes. Missing/foreign proposals, duplicate cases, unexpected facts, changed ASTs, and conflicting retries fail closed; this records evidence only and cannot activate a proposal.

`listContractRuleProposalPreviews` assembles the read-only review projection consumed by the contract-rubric preview UI: proposal AST and provenance pins, cited clauses, the latest immutable backtest, and a deterministic diff against an ACTIVE criterion with the same stable key when one exists. Tenant RLS remains the authorization boundary and the endpoint exposes no lifecycle mutation.

`acceptContractRuleProposal` is the human-gated PROPOSED-to-SHADOW boundary. It requires the tenant proposal and an exact passing backtest pinned to the same proposal/AST hashes, creates one proposal-derived `AI_DOCS` SHADOW rule version, and records immutable acceptance plus audit evidence. Exact retries resolve the same records; failed, stale, foreign, or conflicting evidence fails closed, and the database constraint forbids proposal-derived ACTIVE versions.

`ratifyContractRuleProposal` is the only proposal-derived SHADOW-to-ACTIVE/FIRM boundary. It requires a tenant acceptance whose pinned corpus still passed, records the ratifying human and rationale directly on the immutable ACTIVE version, links promotion evidence to the proposal backtest, and writes append-only ratification/audit rows. Database checks forbid proposal-derived ACTIVE versions without all of those human and evidence pins.

`analyzeAmendmentImpact` diffs the clauses of a `contract_amendment`'s `supersedes_version_id`/`new_version_id` pair by `clause_ref`, classifies each difference as `ADDED`/`REMOVED`/`CHANGED`, and resolves every `ACTIVE` `rule_version` tied to a changed old clause.

`retireAmendedRules` consumes that impact list and transitions each affected rule version to `DEPRECATED` via the owned `transitionRuleLifecycle` lifecycle boundary, inserting a `PROPOSED` replacement rule version (carrying `contractAmendmentId` provenance) for every `CHANGED` clause that has a new clause to point at. Exact retries resolve the same deprecation/replacement rows via `ON CONFLICT`.

`rerunDiscoveryForAmendment` wraps `retireAmendedRules` and re-runs the P3.D discovery detectors (`detectUnassessableTriggers`, `detectUnknownChargeCodeTriggers`, `detectSuspiciousPassTriggers`) against every audit run whose findings or gate failures cited one of the now-superseded rule versions, so anomalies get re-detected under the amended contract terms. Idempotent: retrying for the same amendment re-derives the same affected audit runs and creates zero duplicate rule versions or triggers.

**Deferred (86e32tg60): not yet wired into a real amendment-recording flow.** `analyzeAmendmentImpact`/`retireAmendedRules`/`rerunDiscoveryForAmendment` are tested end-to-end (unit + DB — the DB test drives a real `contract_amendment` row through deprecation, replacement, and trigger creation) but have zero callers outside their own tests. This is disclosed rather than silently missing, matching `rate-engine/README.md`'s "Deferred" pattern for the same reason: no route or job constructs the input they need. Specifically, no code anywhere in `src/` inserts into `contract_amendment` — `src/server/contracts-routes.ts` has no amendment endpoint, `src/jobs/contracts.ts`'s `JOB_NAMES` has no amendment-related job, and `finalizeContractVersion` (above) verifies a new contract version without ever recording that it supersedes an earlier one.

**What unblocks it:** an amendment-recording capability — an API endpoint or a step at contract-version finalization that, given a tenant's assertion that one verified contract version supersedes another, validates both versions belong to the same contract, writes the `contract_amendment` row (`supersedes_version_id`/`new_version_id`/`effective_date`), and records an audit event — then calls `rerunDiscoveryForAmendment` with the resulting `amendmentId`. That is its own product capability (tenant authz, cross-version validation, and likely human-gating to match this repo's hold-then-approve posture), not a wiring fix, so it is deliberately out of this de-slop item's scope.
