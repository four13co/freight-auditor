import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClientUploadsView } from '../src/components/ClientUploadsView.js';
import type { PortalInvoiceDraft } from '../src/lib/api.js';

const EXTRACTED_DRAFT: PortalInvoiceDraft = {
  id: 'draft-1',
  status: 'extracted',
  extractedPayload: {
    transactionSet: 'PDF',
    parserVersion: 'pdf-llm-v1',
    invoiceNumber: 'INV-100',
    headerCurrency: 'USD',
    charges: [{ code: '400', category: 'LINEHAUL', amount: '500.0000', currency: 'USD', quarantined: false }],
    quarantinedCodes: [],
  },
  carrierCandidates: [],
};

const NEEDS_CARRIER_DRAFT: PortalInvoiceDraft = {
  ...EXTRACTED_DRAFT,
  id: 'draft-2',
  status: 'needs_carrier_review',
  carrierCandidates: [{ carrierId: 'carrier-1', name: 'Acme Freight' }, { carrierId: 'carrier-2', name: 'Beta Logistics' }],
};

function pdfFile(name = 'invoice.pdf'): File {
  return new File(['%PDF-fake-bytes'], name, { type: 'application/pdf' });
}

const CONTRACT_UPLOAD_RESULT = {
  contractId: 'contract-1', contractVersionId: 'version-1', sourceDocumentId: 'doc-1', sha256: 'abc', created: true,
};

/**
 * 86e36yj9d: component-level coverage of the Uploads section's document-type
 * selector + invoice upload/review/confirm/reject flow, fetch mocked (same
 * pattern as ClientInvoicesView.test.tsx) so this runs with no real network
 * or backend.
 */
describe('ClientUploadsView', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a document-type selector listing Invoice and Contract, with Invoice pre-selected', () => {
    render(<ClientUploadsView />);
    expect(screen.getByTestId('client-uploads-view')).toBeInTheDocument();
    const items = screen.getAllByTestId('uploads-document-type-item');
    expect(items.map((el) => el.textContent)).toEqual(['Invoice', 'Contract']);
    expect(items[0]).toHaveAttribute('aria-pressed', 'true');
    expect(items[1]).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('invoice-upload-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('contract-upload-panel')).not.toBeInTheDocument();
  });

  it('switches to the Contract panel when Contract is selected', async () => {
    render(<ClientUploadsView />);
    const items = screen.getAllByTestId('uploads-document-type-item');
    await userEvent.click(items[1]!);

    expect(screen.getByTestId('contract-upload-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('invoice-upload-panel')).not.toBeInTheDocument();
    expect(items[1]).toHaveAttribute('aria-pressed', 'true');
  });

  it('uploads a PDF and renders the extracted fields in an editable review form', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(EXTRACTED_DRAFT), { status: 201 }));
    render(<ClientUploadsView />);

    await userEvent.upload(screen.getByTestId('invoice-upload-input'), pdfFile());

    await waitFor(() => expect(screen.getByTestId('invoice-review-form')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith('/api/portal/invoice-drafts', expect.objectContaining({ method: 'POST' }));
    expect(screen.getByTestId('invoice-review-invoice-number')).toHaveValue('INV-100');
    expect(screen.getByTestId('invoice-review-header-currency')).toHaveValue('USD');
    expect(screen.getByLabelText('Charge 1 amount')).toHaveValue('500.0000');
  });

  it('shows an upload error and no review form when the upload fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 422 }));
    render(<ClientUploadsView />);

    await userEvent.upload(screen.getByTestId('invoice-upload-input'), pdfFile());

    await waitFor(() => expect(screen.getByTestId('invoice-upload-error')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveAttribute('data-testid', 'invoice-upload-error');
    expect(screen.queryByTestId('invoice-review-form')).not.toBeInTheDocument();
  });

  it('confirms a corrected draft and shows the resulting audit run', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(EXTRACTED_DRAFT), { status: 201 }));
    render(<ClientUploadsView />);
    await userEvent.upload(screen.getByTestId('invoice-upload-input'), pdfFile());
    await waitFor(() => expect(screen.getByTestId('invoice-review-form')).toBeInTheDocument());

    await userEvent.clear(screen.getByTestId('invoice-review-invoice-number'));
    await userEvent.type(screen.getByTestId('invoice-review-invoice-number'), 'INV-101');

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ auditRunId: 'run-9' }), { status: 201 }));
    await userEvent.click(screen.getByTestId('invoice-confirm-button'));

    await waitFor(() => expect(screen.getByTestId('invoice-confirmed-status')).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('run-9');
    const confirmCall = fetchMock.mock.calls.find(([url]) => url === '/api/portal/invoice-drafts/draft-1/confirm');
    expect(confirmCall).toBeDefined();
    const body = JSON.parse((confirmCall![1] as RequestInit).body as string);
    expect(body.correctedPayload.invoiceNumber).toBe('INV-101');
  });

  it('rejects a draft and shows the rejected state, never calling confirm', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(EXTRACTED_DRAFT), { status: 201 }));
    render(<ClientUploadsView />);
    await userEvent.upload(screen.getByTestId('invoice-upload-input'), pdfFile());
    await waitFor(() => expect(screen.getByTestId('invoice-review-form')).toBeInTheDocument());

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'draft-1', status: 'rejected' }), { status: 200 }));
    await userEvent.click(screen.getByTestId('invoice-reject-button'));

    await waitFor(() => expect(screen.getByTestId('invoice-rejected-status')).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalledWith('/api/portal/invoice-drafts/draft-1/confirm', expect.anything());
  });

  it('requires a carrier selection before confirm is enabled when the draft needs carrier review', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(NEEDS_CARRIER_DRAFT), { status: 201 }));
    render(<ClientUploadsView />);
    await userEvent.upload(screen.getByTestId('invoice-upload-input'), pdfFile());
    await waitFor(() => expect(screen.getByTestId('invoice-review-form')).toBeInTheDocument());

    expect(screen.getByTestId('invoice-confirm-button')).toBeDisabled();
    await userEvent.selectOptions(screen.getByTestId('invoice-review-carrier-select'), 'carrier-1');
    expect(screen.getByTestId('invoice-confirm-button')).toBeEnabled();
  });
});

/**
 * 86e36yrne: component-level coverage of the Contract document type's own
 * metadata form + upload flow -- required-field validation (AC4) and the
 * happy-path submit, fetch mocked same as the Invoice suite above.
 */
describe('ClientUploadsView: Contract type', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function selectContractType() {
    render(<ClientUploadsView />);
    await userEvent.click(screen.getAllByTestId('uploads-document-type-item')[1]!);
  }

  async function fillValidForm() {
    await userEvent.type(screen.getByTestId('contract-upload-carrier-input'), '11111111-1111-1111-1111-111111111111');
    await userEvent.type(screen.getByTestId('contract-upload-name-input'), 'Acme MSA');
    await userEvent.type(screen.getByTestId('contract-upload-valid-from-input'), '2026-01-01');
    await userEvent.upload(screen.getByTestId('contract-upload-input'), pdfFile('contract.pdf'));
  }

  it('rejects submit with no file selected and never calls fetch', async () => {
    await selectContractType();
    await userEvent.type(screen.getByTestId('contract-upload-carrier-input'), '11111111-1111-1111-1111-111111111111');
    await userEvent.type(screen.getByTestId('contract-upload-name-input'), 'Acme MSA');
    await userEvent.type(screen.getByTestId('contract-upload-valid-from-input'), '2026-01-01');

    await userEvent.click(screen.getByTestId('contract-upload-submit-button'));

    expect(screen.getByTestId('contract-upload-error')).toHaveTextContent(/select a pdf or xlsx file/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects submit with a malformed carrier id and never calls fetch', async () => {
    await selectContractType();
    await userEvent.type(screen.getByTestId('contract-upload-carrier-input'), 'not-a-uuid');
    await userEvent.type(screen.getByTestId('contract-upload-name-input'), 'Acme MSA');
    await userEvent.type(screen.getByTestId('contract-upload-valid-from-input'), '2026-01-01');
    await userEvent.upload(screen.getByTestId('contract-upload-input'), pdfFile('contract.pdf'));

    await userEvent.click(screen.getByTestId('contract-upload-submit-button'));

    expect(screen.getByTestId('contract-upload-error')).toHaveTextContent(/valid carrier id/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects submit with a missing contract name and never calls fetch', async () => {
    await selectContractType();
    await userEvent.type(screen.getByTestId('contract-upload-carrier-input'), '11111111-1111-1111-1111-111111111111');
    await userEvent.type(screen.getByTestId('contract-upload-valid-from-input'), '2026-01-01');
    await userEvent.upload(screen.getByTestId('contract-upload-input'), pdfFile('contract.pdf'));

    await userEvent.click(screen.getByTestId('contract-upload-submit-button'));

    expect(screen.getByTestId('contract-upload-error')).toHaveTextContent(/contract name is required/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects submit with a missing valid-from date and never calls fetch', async () => {
    await selectContractType();
    await userEvent.type(screen.getByTestId('contract-upload-carrier-input'), '11111111-1111-1111-1111-111111111111');
    await userEvent.type(screen.getByTestId('contract-upload-name-input'), 'Acme MSA');
    await userEvent.upload(screen.getByTestId('contract-upload-input'), pdfFile('contract.pdf'));

    await userEvent.click(screen.getByTestId('contract-upload-submit-button'));

    expect(screen.getByTestId('contract-upload-error')).toHaveTextContent(/valid-from date is required/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects submit when valid-to is not after valid-from and never calls fetch', async () => {
    await selectContractType();
    await userEvent.type(screen.getByTestId('contract-upload-carrier-input'), '11111111-1111-1111-1111-111111111111');
    await userEvent.type(screen.getByTestId('contract-upload-name-input'), 'Acme MSA');
    await userEvent.type(screen.getByTestId('contract-upload-valid-from-input'), '2026-01-01');
    await userEvent.type(screen.getByTestId('contract-upload-valid-to-input'), '2025-01-01');
    await userEvent.upload(screen.getByTestId('contract-upload-input'), pdfFile('contract.pdf'));

    await userEvent.click(screen.getByTestId('contract-upload-submit-button'));

    expect(screen.getByTestId('contract-upload-error')).toHaveTextContent(/valid-to date must be after/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('submits a complete form and shows the created contract id', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(CONTRACT_UPLOAD_RESULT), { status: 201 }));
    await selectContractType();
    await fillValidForm();

    await userEvent.click(screen.getByTestId('contract-upload-submit-button'));

    await waitFor(() => expect(screen.getByTestId('contract-upload-success')).toBeInTheDocument());
    expect(screen.getByTestId('contract-upload-success')).toHaveTextContent('contract-1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/^\/api\/portal\/contracts\?/);
    expect(String(url)).toContain('carrier_id=11111111-1111-1111-1111-111111111111');
    expect(String(url)).toContain('name=Acme+MSA');
    expect(String(url)).toContain('valid_from=2026-01-01');
    expect((init as RequestInit).method).toBe('POST');
  });

  it('shows an error and no success state when the upload request fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 409 }));
    await selectContractType();
    await fillValidForm();

    await userEvent.click(screen.getByTestId('contract-upload-submit-button'));

    await waitFor(() => expect(screen.getByTestId('contract-upload-error')).toBeInTheDocument());
    expect(screen.queryByTestId('contract-upload-success')).not.toBeInTheDocument();
  });
});
