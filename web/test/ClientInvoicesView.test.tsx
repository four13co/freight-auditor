import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ClientInvoicesView } from '../src/components/ClientInvoicesView.js';
import type { ClientPortalInvoiceRow } from '../src/lib/api.js';

const INVOICES: ClientPortalInvoiceRow[] = [
  {
    id: 'inv-1', invoiceNumber: 'INV-100', carrierId: 'car-1', carrierName: 'Acme Freight',
    currency: 'USD', status: 'ingested', createdAt: '2026-01-15T00:00:00Z', auditRunId: 'run-1',
  },
  {
    id: 'inv-2', invoiceNumber: 'INV-200', carrierId: null, carrierName: null,
    currency: 'CAD', status: 'reviewed', createdAt: '2026-02-01T00:00:00Z', auditRunId: null,
  },
];

describe('ClientInvoicesView (P6.B.1)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ invoices: INVOICES }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches on mount and renders one row per invoice', async () => {
    render(<ClientInvoicesView />);

    expect(fetchMock).toHaveBeenCalledWith('/api/portal/invoices', expect.any(Object));

    await waitFor(() => expect(screen.getAllByTestId('client-invoices-row')).toHaveLength(2));
    expect(screen.getByText('INV-100')).toBeInTheDocument();
    expect(screen.getByText('Acme Freight')).toBeInTheDocument();
    expect(screen.getByText('INV-200')).toBeInTheDocument();
  });

  it('renders a dash for a null carrier name rather than blank', async () => {
    render(<ClientInvoicesView />);
    await waitFor(() => expect(screen.getAllByTestId('client-invoices-row')).toHaveLength(2));
    const row = screen.getByText('INV-200').closest('tr')!;
    expect(row.textContent).toContain('—');
  });

  it('shows an empty-state message when no invoices exist', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ invoices: [] }), { status: 200 }));
    render(<ClientInvoicesView />);
    await waitFor(() => expect(screen.getByTestId('client-invoices-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('client-invoices-table')).not.toBeInTheDocument();
  });

  it('shows an error message when the fetch fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    render(<ClientInvoicesView />);
    await waitFor(() => expect(screen.getByTestId('client-invoices-error')).toBeInTheDocument());
  });

  it('shows a loading state before the fetch resolves', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ClientInvoicesView />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});
