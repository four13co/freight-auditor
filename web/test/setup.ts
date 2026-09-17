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

// jsdom doesn't implement matchMedia; ThemeProvider's "system" branch calls it
// on every mount, so leaving it unmocked throws in every test that renders App.
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList;
}

// Node 22+'s own experimental global `localStorage` shadows jsdom's real,
// working one (it's a getter that throws/returns undefined without
// --localstorage-file), so ThemeProvider's window.localStorage.getItem call
// fails in every test. Replace it with a real in-memory Storage on both
// globalThis and window before any test renders ThemeProvider.
function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
}

const memoryStorage = createMemoryStorage();
for (const target of [globalThis, window]) {
  Object.defineProperty(target, 'localStorage', {
    value: memoryStorage,
    configurable: true,
    writable: true,
  });
}
