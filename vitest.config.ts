import { defineConfig } from 'vitest/config';

// DB tests (test/db/**, *.db.test.ts) require a live Postgres via DATABASE_URL
// and are run explicitly by `npm run test:db`. The default `npm test` excludes
// them so the unit/e2e suite stays runnable with no database.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.{test,e2e.test}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'test/db/**'],
    env: {
      NODE_ENV: 'test',
    },
    coverage: {
      provider: 'v8',
      // `all: false` (the default): scope is exactly the files the default suite imports,
      // not every source file on disk. src/server/*, src/db/*, and several src/modules/*
      // files are never imported by this suite (they need a live Postgres / running
      // server, exercised only by test/db/** and test:db) — enabling `all` would pull
      // those in as 0%-covered and crater the percentage against files this gate can't
      // deterministically exercise. Settle scope here; change it only alongside a
      // re-measured threshold (86e2u72u2 rabbit hole).
      exclude: [
        '**/node_modules/**', '**/dist/**', 'test/**', '**/*.d.ts', '**/*.config.ts',
        // 86e2v17u9: app.ts now transitively imports the real ingest chain
        // (audit-runs-routes.ts -> ingest-invoice.ts -> persist.ts,
        // object-store.ts, source-document.ts, rate-lookup.ts,
        // resolve-criterion-ids.ts) so these modules entered the unit
        // suite's import graph and started counting as 0%-covered here --
        // an accident of the import graph, not a policy change. None of
        // these are unit-testable without a live Postgres; they're fully
        // covered by test:db (127 tests, including this item's own 8 ACs
        // against the real route). Excluding them restates the config's own
        // stated intent above (DB-only modules don't crater this gate) for
        // modules that only became reachable through this item's new route.
        'src/modules/evaluator/persist.ts',
        'src/modules/evaluator/resolve-criterion-ids.ts',
        'src/modules/reference-data/object-store.ts',
        'src/modules/reference-data/source-document.ts',
        'src/modules/rate-engine/rate-lookup.ts',
        // 86e2xb911: same accident-of-import-graph story as 86e2v17u9 above --
        // app.ts now also registers invoice-drafts-routes.ts, which transitively
        // imports invoice-draft.ts and carrier-match.ts (both need a live
        // Postgres; fully covered by test:db, not unit-testable here).
        'src/modules/ingestion/invoice-draft.ts',
        'src/modules/ingestion/carrier-match.ts',
        'src/server/invoice-drafts-routes.ts',
        // Evidence/governance handlers are DB transaction boundaries. Their
        // pure query/services and validation contracts have focused unit
        // coverage; authenticated RLS execution belongs to test:db, matching
        // invoice-drafts-routes above rather than distorting this unit gate
        // based on how many Fastify handler closures a module registers.
        'src/server/evidence-routes.ts',
        'src/server/rule-governance-routes.ts',
        // Contract uploads have focused request tests plus real Postgres/RLS
        // coverage in test:db. The handler entered this unit gate only through
        // app.ts; its transaction boundary follows the same policy as the
        // evidence/governance handlers above. R2 itself has a deterministic
        // provider-contract suite with an injected SDK client.
        'src/server/contracts-routes.ts',
        // Clarification answer persistence is a row-locking Postgres transaction
        // boundary covered by test/db. The request schema and Fastify route have
        // focused unit tests; importing app.ts must not count this DB-only module
        // as untested unit code merely because the route registers it.
        'src/modules/contracts/clarification-answers.ts',
        'src/modules/contracts/persist-extraction-field-correction.ts',
        'src/modules/contracts/finalize-contract-version.ts',
        // P3.C.8: read-only Postgres projection behind rule-governance-routes;
        // its joins, tenant RLS, latest-backtest selection, and diff mapping
        // are exercised against migrated Postgres in test/db, matching the
        // DB transaction-boundary exclusions above.
        'src/modules/contracts/list-contract-rule-proposal-previews.ts',
        'src/modules/contracts/accept-contract-rule-proposal.ts',
        'src/modules/contracts/ratify-contract-rule-proposal.ts',
        'src/modules/discovery/detect-unassessable-triggers.ts',
        'src/modules/discovery/detect-unknown-charge-code-triggers.ts',
        'src/modules/discovery/detect-extraction-quality-triggers.ts',
        'src/modules/discovery/detect-suspicious-pass-triggers.ts',
        // pdf-extract.ts's PDF-text-extraction step (extractInvoiceFromPdf) IS
        // unit-tested for real against real generated PDF bytes with an
        // injected LLM impl (test/unit/pdf-extract.test.ts, 6 tests) -- only
        // defaultExtractInvoiceFromText (the real Anthropic call) is excluded
        // in spirit here; there's no real key to call it with in this suite,
        // same category as rollback-deploy.mjs's real-CapRover-call bodies
        // above. File-level exclude (this repo's only available granularity
        // for that, matching the existing entries in this list) rather than
        // an inline ignore comment, which has no precedent in this codebase.
        'src/modules/ingestion/pdf-extract.ts',
      ],
      reporter: ['text', 'json-summary'],
      // Floor ratcheted up in this same PR (86e2u72u2) to match the coverage this
      // change adds: interpreter.ts logic/verdict/approx paths, and the
      // guard-protected-db.mjs / rollback-deploy.mjs main() CLI bodies (previously
      // 0%-covered outside a skipIf(!DATABASE_URL) e2e job). Measured post-change:
      // 87.96/85.14/92.1/90.55 — set a few points below to avoid pinning to the
      // exact fraction and blocking on ordinary future churn.
      thresholds: {
        statements: 85,
        branches: 82,
        functions: 90,
        lines: 88,
      },
    },
  },
});
