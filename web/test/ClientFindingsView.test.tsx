import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ClientFindingsView } from '../src/components/ClientFindingsView.js';
import type { ClientPortalFindingRow } from '../src/lib/api.js';

const FINDINGS: ClientPortalFindingRow[] = [
  {
    id: 'f-1', auditRunId: 'run-1', invoiceId: 'inv-1', invoiceNumber: 'INV-100', carrierName: 'Acme Freight',
    billed: '1000.0000', expected: '900.0000', varianceAmount: '100.0000', direction: 'OVERCHARGE',
    status: 'open', createdAt: '2026-01-15T00:00:00Z', ruleDescription: 'Rate variance',
  },
  {
    id: 'f-2', auditRunId: 'run-2', invoiceId: 'inv-2', invoiceNumber: 'INV-200', carrierName: null,
    billed: null, expected: null, varianceAmount: null, direction: null,
    status: 'closed', createdAt: '2026-02-01T00:00:00Z', ruleDescription: null,
  },
];

describe('ClientFindingsView (P6.B.2)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ findings: FINDINGS }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches on mount and renders one row per finding', async () => {
    render(<ClientFindingsView />);

    expect(fetchMock).toHaveBeenCalledWith('/api/portal/findings', expect.any(Object));

    await waitFor(() => expect(screen.getAllByTestId('client-findings-row')).toHaveLength(2));
    expect(screen.getByText('INV-100')).toBeInTheDocument();
    expect(screen.getByText('Acme Freight')).toBeInTheDocument();
    expect(screen.getByText('INV-200')).toBeInTheDocument();
  });

  it('renders a dash for a null carrier name and null amounts rather than blank', async () => {
    render(<ClientFindingsView />);
    await waitFor(() => expect(screen.getAllByTestId('client-findings-row')).toHaveLength(2));
    const row = screen.getByText('INV-200').closest('tr')!;
    expect(row.textContent).toContain('—');
  });

  it('shows an empty-state message when no findings exist', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ findings: [] }), { status: 200 }));
    render(<ClientFindingsView />);
    await waitFor(() => expect(screen.getByTestId('client-findings-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('client-findings-table')).not.toBeInTheDocument();
  });

  it('shows an error message when the fetch fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    render(<ClientFindingsView />);
    await waitFor(() => expect(screen.getByTestId('client-findings-error')).toBeInTheDocument());
  });

  it('shows a loading state before the fetch resolves', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ClientFindingsView />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  // 86e2zfjx3 AC1: the loading container is aria-busy and wrapped in a persistent aria-live region.
  it('marks the loading state aria-busy inside an aria-live="polite" region', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ClientFindingsView />);
    const region = screen.getByTestId('client-findings-live-region');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toContainElement(screen.getByTestId('client-findings-loading'));
  });

  // 86e2zfjx3 AC2: the error container is role="alert".
  it('marks the error message role="alert"', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    render(<ClientFindingsView />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveAttribute('data-testid', 'client-findings-error');
  });

  // 86e2zfjx3 AC3: the empty container is role="status".
  it('marks the empty-state message role="status"', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ findings: [] }), { status: 200 }));
    render(<ClientFindingsView />);
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveAttribute('data-testid', 'client-findings-empty');
  });

  it('clears aria-busy once the fetch resolves', async () => {
    render(<ClientFindingsView />);
    await waitFor(() => expect(screen.getByTestId('client-findings-live-region')).toHaveAttribute('aria-busy', 'false'));
  });
});
