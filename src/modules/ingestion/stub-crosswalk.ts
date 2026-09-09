/**
 * 86e2xcnja: the one shared definition of the STUB charge-code crosswalk --
 * this is NOT the real DB-backed crosswalk (resolveChargeCode,
 * reference-data/crosswalk.ts). 86e32tg6n wired resolveChargeCode into
 * production: ingest-invoice.ts's resolveCategorizer now calls it directly
 * for every EDI document it parses, and this stub map has zero production
 * call sites left (verified via grep) -- it's used only by
 * test/unit/stub-crosswalk.test.ts, test/fixtures/edi-golden.ts, and
 * scripts/seed-fullstack-e2e-fixture.mjs's demo-data seed. LINEHAUL is the
 * only category CONTRACT.RATE_VARIANCE reads (fact-bundle.ts).
 *
 * Named distinctly from "crosswalk" (the real DB-backed concept) so nothing
 * reads this as production charge-code resolution logic.
 */
export const STUB_CROSSWALK: Record<string, string> = {
  '400': 'LINEHAUL',
  '405': 'FUEL',
  '500': 'OCEAN_FREIGHT',
  '510': 'DOC_FEE',
};

/** A Categorize-shaped function (charge-fact.ts) backed by STUB_CROSSWALK. */
export function stubCategorize(code: string | undefined): string | undefined {
  return code === undefined ? undefined : STUB_CROSSWALK[code];
}
