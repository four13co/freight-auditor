import type { ExtractedInvoice, ExtractInvoiceFromTextImpl } from './pdf-extract.js';

/**
 * 86e36yj9d AC3: the Uploads section's e2e coverage requires a REAL browser
 * upload (Playwright's `setInputFiles`) to actually reach POST
 * /api/portal/invoice-drafts and have the review form populate from the
 * response -- unlike invoice-draft-confirm/reject.fullstack.spec.ts's own
 * precedent (seed the draft in-process via createInvoiceDraft's extractImpl
 * parameter, entirely bypassing HTTP for that one step), there is no
 * non-HTTP path here: proving the browser's own upload request IS the point
 * of AC3. defaultExtractInvoiceFromText (pdf-extract.ts) calls the real
 * Anthropic API with no seam reachable from outside the process -- the exact
 * gap that module's own header comment already names ("no test in this
 * repo's suite exercises this real implementation end to end... unproven
 * until someone runs it with a real key"), and this repo's CI carries no
 * ANTHROPIC_API_KEY today.
 *
 * Same shape as tenant-auth.ts's DEV_AUTH_HEADERS / auth-routes.ts's
 * PUBLIC_SIGNUP_ENABLED: an explicit, non-default env flag opens a
 * deterministic test double, hard-refused in production. Scoped to ONLY
 * portal-invoice-upload-routes.ts's own createInvoiceDraft call site --
 * invoice-drafts-routes.ts (the internal /api/invoice-drafts route) is
 * untouched, so invoice-draft-confirm/reject.fullstack.spec.ts stay exactly
 * as they were.
 */
const STUB_CARRIER_ENV = 'PORTAL_UPLOAD_EXTRACTION_STUB_CARRIER';

/** Reads `INVOICE_NUMBER:<value>` out of the uploaded PDF's own text, so a spec can pin a known invoice number without a second seam. */
function readInvoiceNumberMarker(pdfText: string): string | undefined {
  return /INVOICE_NUMBER:(\S+)/.exec(pdfText)?.[1];
}

export function resolvePortalUploadExtractionImpl(
  env: Record<string, string | undefined> = process.env,
): ExtractInvoiceFromTextImpl | undefined {
  const carrierName = env[STUB_CARRIER_ENV];
  if (!carrierName) return undefined;
  if (env.NODE_ENV === 'production') {
    throw new Error(`${STUB_CARRIER_ENV} must not be set in production`);
  }
  return async (pdfText: string): Promise<ExtractedInvoice> => ({
    carrierName,
    invoiceNumber: readInvoiceNumberMarker(pdfText) ?? 'INV-PORTAL-STUB',
    headerCurrency: 'USD',
    declaredTotal: '500.0000',
    charges: [{ code: '400', category: 'LINEHAUL', amount: '500.0000', currency: 'USD' }],
    extractable: true,
  });
}
