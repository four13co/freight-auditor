import type { ExtractInvoiceFromTextImpl } from '../modules/ingestion/pdf-extract.js';

/**
 * Must match scripts/seed-fullstack-e2e-fixture.mjs's FIXTURE_CARRIER_NAME
 * exactly -- not re-imported from there (that script lives outside src/'s
 * tsconfig.build.json rootDir) -- so matchCarrierName (carrier-match.ts)
 * resolves this draft's carrier unambiguously against the fixture carrier
 * that seed:e2e-fullstack-fixture already creates for DEV_CLIENT_ID (a
 * prerequisite step this suite's CI job already runs), rather than the
 * e2e test needing to guess/supply a carrier UUID of its own.
 */
const FIXTURE_CARRIER_NAME = 'E2E Fullstack Carrier';

/**
 * 86e36yj9d: a deterministic stand-in for defaultExtractInvoiceFromText
 * (pdf-extract.ts), used ONLY by index.ts's E2E_FAKE_INVOICE_EXTRACTION
 * flag -- never imported by production route/module code. Exists because
 * the real implementation calls the live Anthropic API (pdf-extract.ts's own
 * header comment: "no test in this repo's suite exercises this real
 * implementation end to end"), and the client-portal Uploads e2e suite
 * (web/test/e2e-fullstack-auth) drives a real browser through a real HTTP
 * upload, so it has no module-mocking seam available the way a vitest
 * unit/db test does -- it needs the running server itself to return a
 * canned result. Ignores the actual PDF text; any non-empty PDF uploaded
 * against a server booted with the flag set gets this same fixed payload.
 */
export const fakeExtractInvoiceFromText: ExtractInvoiceFromTextImpl = async () => ({
  carrierName: FIXTURE_CARRIER_NAME,
  invoiceNumber: 'INV-E2E-001',
  headerCurrency: 'USD',
  declaredTotal: '150.00',
  charges: [
    {
      code: 'LHL',
      category: 'linehaul',
      amount: '150.00',
      currency: 'USD',
      rawDescription: 'Linehaul charge',
    },
  ],
  extractable: true,
});
