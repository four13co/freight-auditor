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

// jsdom implements neither (86e3a6r8z/9c/ak: the first tests in this suite to
// actually open a @base-ui/react Menu/Popover or mount cmdk's <Command>).
// Menu/Popover interactions check `hasPointerCapture` before opening and
// silently no-op without it; cmdk's list virtualization needs a
// ResizeObserver constructor to exist at all.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!('ResizeObserver' in globalThis)) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
