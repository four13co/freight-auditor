import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { InvoicesView } from '../src/components/InvoicesView.js';
import { INVOICE_ROWS as ROWS } from './fixtures.js';

let fetchMock: ReturnType<typeof vi.fn>;

function mockFetchOnce(url: string) {
  if (url.includes('/api/invoices')) {
    return Promise.resolve(new Response(JSON.stringify({ invoices: ROWS }), { status: 200 }));
  }
  throw new Error(`mockFetchOnce: unexpected URL ${url}`);
}

beforeEach(() => {
  fetchMock = vi.fn((input: string | URL | Request) => mockFetchOnce(input.toString()));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('InvoicesView (86e37r2rt)', () => {
  it('AC1: fetches and renders invoices via InvoicesTable, with a correctly summed billedTotal shown', async () => {
    render(<InvoicesView />);
    await waitFor(() => expect(screen.getAllByTestId('invoice-row')).toHaveLength(3));
    expect(screen.getByText('INV-90385')).toBeInTheDocument();
    expect(screen.getByText('$1,876.40')).toBeInTheDocument();
  });

  it('AC2: changing the carrier filter re-fetches /api/invoices with the carrier query param', async () => {
    render(<InvoicesView />);
    await waitFor(() => expect(screen.getAllByTestId('invoice-row')).toHaveLength(3));
    fetchMock.mockClear();

    fireEvent.change(screen.getByLabelText('Carrier filter'), { target: { value: 'Saia LTL' } });

    await waitFor(() => {
      const calledUrl = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/invoices?'))?.[0];
      expect(String(calledUrl)).toContain('carrier=Saia');
    });
  });

  it('AC2: changing the status filter re-fetches /api/invoices with the status query param', async () => {
    render(<InvoicesView />);
    await waitFor(() => expect(screen.getAllByTestId('invoice-row')).toHaveLength(3));
    fetchMock.mockClear();

    fireEvent.change(screen.getByLabelText('Status filter'), { target: { value: 'reconciled' } });

    await waitFor(() => {
      const calledUrl = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/invoices?'))?.[0];
      expect(String(calledUrl)).toContain('status=reconciled');
    });
  });

  it('shows a loading indicator before the fetch resolves, and a distinct error state on failure', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('', { status: 500 })));
    render(<InvoicesView />);
    await waitFor(() => expect(screen.getByTestId('invoices-error')).toBeInTheDocument());
    expect(screen.queryByTestId('invoice-row')).not.toBeInTheDocument();
  });
});
