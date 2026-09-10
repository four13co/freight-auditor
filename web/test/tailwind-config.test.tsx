import { describe, it, expect } from 'vitest';

// tailwind.config.js is a plain JS file (no declaration file, and the project
// doesn't enable allowJs) -- @ts-expect-error scopes the missing-types
// suppression to just this import instead of widening tsconfig.
// @ts-expect-error tailwind.config.js has no type declarations
import tailwindConfig from '../tailwind.config.js';

describe('tailwind.config.js design tokens', () => {
  it('AC1: theme.extend defines a non-empty colors scale and a non-empty borderRadius scale', () => {
    const { colors, borderRadius } = tailwindConfig.theme.extend;

    expect(colors).toBeDefined();
    expect(typeof colors).toBe('object');
    expect(Object.keys(colors).length).toBeGreaterThan(0);

    expect(borderRadius).toBeDefined();
    expect(typeof borderRadius).toBe('object');
    expect(Object.keys(borderRadius).length).toBeGreaterThan(0);
  });
});
