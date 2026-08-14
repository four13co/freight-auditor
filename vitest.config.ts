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
      exclude: ['**/node_modules/**', '**/dist/**', 'test/**', '**/*.d.ts', '**/*.config.ts'],
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
