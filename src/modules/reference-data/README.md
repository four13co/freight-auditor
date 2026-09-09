# reference-data module

`external-value-resolver.ts` defines `ExternalResolverRegistry`, a stable
source-code routing boundary for pluggable external-value resolvers.
`eia-fuel-index-resolver.ts`, `mileage-resolver.ts`, and
`ocean-index-resolver.ts` each resolve an already-ingested publication
(EIA weekly diesel, licensed PC*Miler mileage, ocean BAF/GRI/PSS) for a
given axis key and business date, replaying what was known as of a given
cutoff for audit-time determinism. `nmfc-license-gate.ts` is a
deny-by-default decorator that blocks resolution unless NMFC licensing is
explicitly configured. `external-value-store.ts` persists the underlying
`external_publication` / `external_value` rows these resolvers read.

**Deferred (86e367rab): zero production callers repo-wide.**
`EiaFuelIndexResolver`, `MileageResolver`, `OceanIndexResolver`,
`NmfcLicenseGate`, and `ExternalResolverRegistry` are exercised only by
their own unit tests — no route or job constructs an `ExternalValueRequest`
and drives them, matching `rate-engine`'s own deferred-and-disclosed
precedent rather than an oversight.

**What unblocks it:** an audit-time consumer that needs a licensed
external value at evaluation time — e.g. a fuel-surcharge line resolved
against the EIA diesel index, or a linehaul rate cross-checked against a
licensed mileage lookup — calling `ExternalResolverRegistry.resolve()` with
the appropriate `sourceCode`/`axisKey`/`publishedFor` (and, when replaying
a past audit run, `recordedAsOf`). No such consumer exists yet:
`rate-lookup.ts` resolves contract rates directly and has no concept of an
external-source axis key. Wiring this in before that consumer exists would
mean inventing a fake axis key at the call site — worse than leaving it
disclosed and unwired.
