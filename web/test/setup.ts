import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// @testing-library/react's auto-cleanup registration relies on a global
// afterEach (vitest's `globals: true`), which this config deliberately
// doesn't enable (explicit imports keep test files self-contained) -- so
// unmount explicitly here instead, or every test after the first accumulates
// the previous render's DOM.
afterEach(() => {
  cleanup();
});
