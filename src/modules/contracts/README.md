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
