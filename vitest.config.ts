import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.{test,e2e.test}.ts'],
    env: {
      NODE_ENV: 'test',
    },
  },
});
