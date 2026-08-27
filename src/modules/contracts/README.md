# contracts module

Contract ingestion and AI-assisted verification boundaries.

`VersionedAnthropicProvider` is the sole reusable structured-generation boundary for contract-rubric prompts. Callers must provide an immutable prompt version, pinned model configuration, source-document SHA-256, untrusted evidence, and a strict Zod output schema. The adapter returns provider/message/token provenance and a deterministic request key; it does not persist, activate, or evaluate rules.
