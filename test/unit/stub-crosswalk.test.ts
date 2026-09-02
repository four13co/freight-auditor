import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stubCategorize, STUB_CROSSWALK } from '../../src/modules/ingestion/stub-crosswalk.js';

/**
 * 86e2xcnja: direct unit coverage of the shared stub crosswalk -- edi-golden.ts
 * and seed-fullstack-e2e-fixture.mjs import from this rather than redefining
 * it. Small and self-contained, but worth its own direct test: neither call
 * site's own test suite exercised the undefined-code branch directly (all
 * invocations pass a concrete code), so that branch showed 0% in an earlier
 * coverage run.
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

/**
 * 86e32tg6n AC2: ingest-invoice.ts must no longer import the stub -- production
 * categorization now goes through the real DB-backed crosswalk
 * (resolveChargeCode). A source-text check because the alternative (asserting
 * on categorization behavior) can't distinguish "stub demoted" from "stub still
 * imported but happens to agree with the crosswalk for this fixture's codes".
 */
describe('stub-crosswalk.ts is test-fixture-only', () => {
  it('is not imported by ingest-invoice.ts', () => {
    const ingestInvoiceSource = readFileSync(
      fileURLToPath(new URL('../../src/modules/ingestion/ingest-invoice.ts', import.meta.url)),
      'utf8',
    );
    expect(ingestInvoiceSource).not.toMatch(/from ['"].*stub-crosswalk/);
  });
});
