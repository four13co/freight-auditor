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
  },
});
