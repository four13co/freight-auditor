import { describe, it, expect } from 'vitest';
import { resolvePortalUploadExtractionImpl } from '../../src/modules/ingestion/portal-upload-extraction-stub.js';

/**
 * 86e36yj9d rebuild (Coverage Gate FAIL on PR #364): readInvoiceNumberMarker
 * was previously exercised only through the fullstack-auth e2e specs (real
 * browser upload), which the vitest Coverage Gate doesn't instrument. These
 * unit tests drive both branches directly through the exported
 * resolvePortalUploadExtractionImpl.
 */
describe('resolvePortalUploadExtractionImpl', () => {
  it('returns undefined when the stub-carrier env var is unset', () => {
    expect(resolvePortalUploadExtractionImpl({})).toBeUndefined();
  });

  it('throws when the stub-carrier env var is set in production', () => {
    expect(() =>
      resolvePortalUploadExtractionImpl({ PORTAL_UPLOAD_EXTRACTION_STUB_CARRIER: 'Acme', NODE_ENV: 'production' }),
    ).toThrow(/must not be set in production/);
  });

  it('uses the INVOICE_NUMBER marker from the PDF text when present', async () => {
    const impl = resolvePortalUploadExtractionImpl({ PORTAL_UPLOAD_EXTRACTION_STUB_CARRIER: 'Acme Freight' });
    expect(impl).toBeDefined();

    const result = await impl!('some preamble INVOICE_NUMBER:INV-9001 trailing text');

    expect(result.invoiceNumber).toBe('INV-9001');
    expect(result.carrierName).toBe('Acme Freight');
  });

  it('falls back to INV-PORTAL-STUB when no marker is present in the PDF text', async () => {
    const impl = resolvePortalUploadExtractionImpl({ PORTAL_UPLOAD_EXTRACTION_STUB_CARRIER: 'Acme Freight' });
    expect(impl).toBeDefined();

    const result = await impl!('plain text with no marker at all');

    expect(result.invoiceNumber).toBe('INV-PORTAL-STUB');
  });
});
