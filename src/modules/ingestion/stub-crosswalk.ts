/**
 * 86e2xcnja: the one shared definition of the STUB charge-code crosswalk --
 * this is NOT the real DB-backed crosswalk (resolveChargeCode,
 * reference-data/crosswalk.ts), which has never been wired to any parser
 * call anywhere in this codebase (ingest-invoice.ts's own comment documents
 * that as a deliberate, separate, unscoped piece of work). This is the
 * minimal placeholder categorize map three call sites each redefined byte-
 * for-byte (or as an overlapping subset): ingest-invoice.ts's production
 * categorize callback, edi-golden.ts's test fixture, and
 * seed-fullstack-e2e-fixture.mjs's demo-data seed. LINEHAUL is the only
 * category CONTRACT.RATE_VARIANCE reads (fact-bundle.ts).
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
