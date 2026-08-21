import { describe, it, expect } from 'vitest';
import { stubCategorize, STUB_CROSSWALK } from '../../src/modules/ingestion/stub-crosswalk.js';

/**
 * 86e2xcnja: direct unit coverage of the shared stub crosswalk -- the one
 * place ingest-invoice.ts, edi-golden.ts, and seed-fullstack-e2e-fixture.mjs
 * now all import from instead of redefining. Small and self-contained, but
 * worth its own direct test: neither call site's own test suite exercised
 * the undefined-code branch directly (all three real invocations pass a
 * concrete code), so that branch showed 0% in an earlier coverage run.
 */
describe('stubCategorize', () => {
  it('resolves every known code in STUB_CROSSWALK', () => {
    for (const [code, category] of Object.entries(STUB_CROSSWALK)) {
      expect(stubCategorize(code)).toBe(category);
    }
  });

  it('returns undefined for an unknown code', () => {
    expect(stubCategorize('999')).toBeUndefined();
  });

  it('returns undefined when code itself is undefined, without touching STUB_CROSSWALK', () => {
    expect(stubCategorize(undefined)).toBeUndefined();
  });
});
