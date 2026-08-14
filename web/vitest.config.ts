import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Component/unit tests for web/ (jsdom + React Testing Library). Kept
// separate from the root vitest.config.ts deliberately -- the root config's
// default: false coverage scope only covers .ts files it can deterministically
// exercise (86e2u72u2's rabbit hole), and widening it to include web/src/**
// would pull a whole new low-coverage surface into that gate's denominator.
// This is its own config + its own CI job (86e2u7j1y), mirroring the
// test:db / vitest.db.config.ts / db-tests precedent (86e2uhn2x).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.tsx'],
    setupFiles: ['./test/setup.ts'],
    passWithNoTests: true,
  },
});
