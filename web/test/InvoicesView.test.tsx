import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InvoicesView } from '../src/components/InvoicesView.js';
import type { InvoiceRow } from '../src/lib/api.js';

function invoice(overrides: Partial<InvoiceRow>): InvoiceRow {
  return {
    id: 'inv-1', invoiceNumber: 'INV-1', carrierName: 'Acme', transactionSet: '210',
    status: 'ingested', currency: 'USD', createdAt: '2026-01-15T00:00:00Z', billedTotal: '100.0000',
    ...overrides,
  };
}

const FULL_PAGE = Array.from({ length: 50 }, (_, i) => invoice({ id: `inv-${i}` }));

describe('InvoicesView (86e37r2rt)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // 86e37r2rt: a fresh Response per call (not a single shared instance) --
    // the carrier/status filter inputs below re-fetch on every keystroke
    // (no debounce, same as FindingsTable/DiscrepanciesView's own filters),
    // and a Response body can only be consumed once.
    fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ invoices: [] }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches on mount with the default page size and offset', async () => {
    render(<InvoicesView />);
    expect(fetchMock).toHaveBeenCalledWith('/api/invoices?limit=50&offset=0', expect.any(Object));
    await waitFor(() => expect(screen.getByTestId('invoices-empty')).toBeInTheDocument());
  });

  it('renders one row per invoice, with invoice #/carrier/transaction set/billed total/status/age visible', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      invoices: [
        invoice({ id: 'inv-1', invoiceNumber: 'INV-1', carrierName: 'Acme', billedTotal: '125.5000' }),
        invoice({ id: 'inv-2', invoiceNumber: 'INV-2', carrierName: 'Estes', billedTotal: null }),
      ],
    }), { status: 200 }));
    render(<InvoicesView />);

    await waitFor(() => expect(screen.getAllByTestId('invoice-row')).toHaveLength(2));
    expect(screen.getByText('INV-1')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('$125.50')).toBeInTheDocument();
    expect(screen.getByText('INV-2')).toBeInTheDocument();
    expect(screen.getByText('Estes')).toBeInTheDocument();
    // billedTotal null renders as the shared "missing value" placeholder (formatMoney).
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows an empty-state message when no invoices exist', async () => {
    render(<InvoicesView />);
    await waitFor(() => expect(screen.getByTestId('invoices-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('invoices-table')).not.toBeInTheDocument();
  });

  it('shows an error message when the fetch fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    render(<InvoicesView />);
    await waitFor(() => expect(screen.getByTestId('invoices-error')).toBeInTheDocument());
  });

  it('shows a loading state before the fetch resolves', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<InvoicesView />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('retries the load when Retry is clicked after an error', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    render(<InvoicesView />);
    await waitFor(() => expect(screen.getByTestId('invoices-error')).toBeInTheDocument());

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ invoices: [invoice({})] }), { status: 200 }));
    await user.click(screen.getByText('Retry'));

    await waitFor(() => expect(screen.getAllByTestId('invoice-row')).toHaveLength(1));
    expect(screen.queryByTestId('invoices-error')).not.toBeInTheDocument();
  });

  it('disables Previous on the first page and Next when the page is not full', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ invoices: [invoice({})] }), { status: 200 }));
    render(<InvoicesView />);
    await waitFor(() => expect(screen.getByTestId('invoices-prev')).toBeDisabled());
    expect(screen.getByTestId('invoices-next')).toBeDisabled();
  });

  it('enables Next on a full page and advances offset on click', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ invoices: FULL_PAGE }), { status: 200 })));
    render(<InvoicesView />);

    await waitFor(() => expect(screen.getByTestId('invoices-next')).not.toBeDisabled());
    await user.click(screen.getByTestId('invoices-next'));

    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/api/invoices?limit=50&offset=50', expect.any(Object)));
    expect(screen.getByTestId('invoices-prev')).not.toBeDisabled();
  });

  it('re-fetches with the carrier filter applied, resetting to page 0', async () => {
    const user = userEvent.setup();
    render(<InvoicesView />);
    await waitFor(() => expect(screen.getByTestId('invoices-empty')).toBeInTheDocument());
    fetchMock.mockClear();

    await user.type(screen.getByLabelText('Carrier filter'), 'Acme');
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/api/invoices?carrier=Acme&limit=50&offset=0', expect.any(Object)));
  });

  it('re-fetches with the status filter applied, resetting to page 0', async () => {
    const user = userEvent.setup();
    render(<InvoicesView />);
    await waitFor(() => expect(screen.getByTestId('invoices-empty')).toBeInTheDocument());
    fetchMock.mockClear();

    await user.type(screen.getByLabelText('Status filter'), 'ingested');
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/api/invoices?status=ingested&limit=50&offset=0', expect.any(Object)));
  });

  it('shows the filtered empty-state message when a filter narrows to zero rows', async () => {
    const user = userEvent.setup();
    render(<InvoicesView />);
    await waitFor(() => expect(screen.getByTestId('invoices-empty')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Carrier filter'), 'Nonexistent');
    await waitFor(() => expect(screen.getByTestId('invoices-empty')).toHaveTextContent('No invoices match these filters.'));
  });
});
