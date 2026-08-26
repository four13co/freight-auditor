import { defineConfig } from 'vitest/config';

// DB-integration tests: require DATABASE_URL pointing at a live (ephemeral,
// local) Postgres with migrations already applied. Invoked by `npm run test:db`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/db/**/*.db.test.ts'],
    env: {
      NODE_ENV: 'test',
    },
    globalSetup: ['./test/db/global-setup.ts'],
    // DB tests share a schema; keep them serial to avoid cross-test contention.
    fileParallelism: false,
  },
});
