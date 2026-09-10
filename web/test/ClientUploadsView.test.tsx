import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClientUploadsView } from '../src/components/ClientUploadsView.js';

/**
 * 86e36yj9d: the client-portal Uploads section's Invoice-type flow. Hits
 * /api/portal/invoice-drafts* (mirrors ClientClaimDocumentsView.test.tsx's
 * own global-fetch-mock convention) -- the real HTTP round trip against a
 * real client_admin session is proven by
 * web/test/e2e-fullstack-auth/uploads-invoice.fullstack.spec.ts.
 */
const DRAFT_RESPONSE = {
  id: 'draft-1',
  status: 'extracted',
  extractedPayload: {
    transactionSet: 'PDF',
    parserVersion: 'pdf-llm-v1',
    invoiceNumber: 'INV-1',
    headerCurrency: 'USD',
    charges: [{ code: 'LHL', category: 'linehaul', quarantined: false, amount: '150.00', currency: 'USD' }],
    quarantinedCodes: [],
  },
  carrierCandidates: [{ carrierId: 'carrier-1', name: 'Acme Freight Co' }],
};

async function selectInvoiceType() {
  await userEvent.click(screen.getByTestId('upload-document-type-invoice'));
}

async function uploadFixturePdf() {
  const file = new File([new Uint8Array([1, 2, 3])], 'invoice.pdf', { type: 'application/pdf' });
  const input = screen.getByTestId('invoice-upload-input');
  await userEvent.upload(input, file);
  await userEvent.click(screen.getByTestId('invoice-upload-submit'));
}

describe('ClientUploadsView (86e36yj9d)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('AC1: shows Invoice as an available document type, with no upload flow until it is selected', () => {
    render(<ClientUploadsView />);
    expect(screen.getByTestId('upload-document-type-invoice')).toBeInTheDocument();
    expect(screen.queryByTestId('invoice-upload-flow')).not.toBeInTheDocument();
  });

  it('selecting Invoice reveals the upload flow', async () => {
    render(<ClientUploadsView />);
    await selectInvoiceType();
    expect(screen.getByTestId('invoice-upload-flow')).toBeInTheDocument();
  });

  it('AC3: uploading a PDF renders the extracted fields in an editable review form', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(DRAFT_RESPONSE), { status: 201 }));
    render(<ClientUploadsView />);
    await selectInvoiceType();
    await uploadFixturePdf();

    await waitFor(() => expect(screen.getByTestId('invoice-review-form')).toBeInTheDocument());
    expect(screen.getByTestId('invoice-review-invoice-number')).toHaveValue('INV-1');
    expect(screen.getByTestId('invoice-review-charge-amount')).toHaveValue('150.00');
    expect(screen.getByTestId('invoice-review-carrier')).toHaveValue('carrier-1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/portal/invoice-drafts');
    expect(init).toMatchObject({ method: 'POST', headers: expect.objectContaining({ 'content-type': 'application/pdf' }) });
  });

  it('AC4: confirming the reviewed draft creates a real audit run and shows a success state', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(DRAFT_RESPONSE), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ auditRunId: 'run-1' }), { status: 201 }));
    render(<ClientUploadsView />);
    await selectInvoiceType();
    await uploadFixturePdf();
    await waitFor(() => expect(screen.getByTestId('invoice-review-form')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('invoice-review-confirm'));

    await waitFor(() => expect(screen.getByTestId('invoice-upload-success')).toBeInTheDocument());
    expect(screen.getByTestId('invoice-upload-success')).toHaveTextContent('run-1');
    const [confirmUrl, confirmInit] = fetchMock.mock.calls[1];
    expect(confirmUrl).toBe('/api/portal/invoice-drafts/draft-1/confirm');
    expect(JSON.parse(confirmInit.body).carrierId).toBe('carrier-1');
  });

  it('AC5: rejecting the reviewed draft creates no audit run and shows a rejected state', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(DRAFT_RESPONSE), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'draft-1', status: 'rejected' }), { status: 200 }));
    render(<ClientUploadsView />);
    await selectInvoiceType();
    await uploadFixturePdf();
    await waitFor(() => expect(screen.getByTestId('invoice-review-form')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('invoice-review-reject'));

    await waitFor(() => expect(screen.getByTestId('invoice-upload-rejected')).toBeInTheDocument());
    const [rejectUrl] = fetchMock.mock.calls[1];
    expect(rejectUrl).toBe('/api/portal/invoice-drafts/draft-1/reject');
  });

  it('shows an error message when the upload is rejected (e.g. an unextractable PDF)', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'LLM could not extract usable invoice data' }), { status: 422 }));
    render(<ClientUploadsView />);
    await selectInvoiceType();
    await uploadFixturePdf();

    await waitFor(() => expect(screen.getByTestId('invoice-upload-error')).toBeInTheDocument());
    expect(screen.getByTestId('invoice-upload-error')).toHaveTextContent(/could not extract/i);
    expect(screen.queryByTestId('invoice-review-form')).not.toBeInTheDocument();
  });
});
