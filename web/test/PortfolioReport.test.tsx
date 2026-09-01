import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PortfolioReport } from '../src/components/PortfolioReport.js';
import type { CrossClientPortfolioBucket } from '../src/lib/api.js';

const BUCKETS: CrossClientPortfolioBucket[] = [
  {
    clientId: 'c1', clientName: 'Acme Freight', currency: 'USD',
    claimed: '500.0000', recovered: '200.0000', outstanding: '300.0000', writtenOff: '0.0000', denied: '0.0000',
    nullCurrencyRecovered: '0.0000', mismatchedCurrencyRecovered: '0.0000', reconciles: true,
  },
  {
    clientId: 'c2', clientName: 'Borealis Logistics', currency: 'CAD',
    claimed: '900.0000', recovered: '900.0000', outstanding: '0.0000', writtenOff: '0.0000', denied: '0.0000',
    nullCurrencyRecovered: '0.0000', mismatchedCurrencyRecovered: '0.0000', reconciles: true,
  },
];

describe('PortfolioReport (P5.C.3)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ buckets: BUCKETS }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches on mount and renders one row per (client, currency) bucket', async () => {
    render(<PortfolioReport />);

    expect(fetchMock).toHaveBeenCalledWith('/api/portfolio/cross-client-recovery', expect.any(Object));

    await waitFor(() => expect(screen.getAllByTestId('portfolio-report-row')).toHaveLength(2));
    expect(screen.getByText('Acme Freight')).toBeInTheDocument();
    expect(screen.getByText('Borealis Logistics')).toBeInTheDocument();
    expect(screen.getByText('300.00 USD')).toBeInTheDocument();
    expect(screen.getAllByText('900.00 CAD').length).toBeGreaterThan(0);
  });

  it('shows an empty-state message when no claims exist across any client', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ buckets: [] }), { status: 200 }));
    render(<PortfolioReport />);
    await waitFor(() => expect(screen.getByTestId('portfolio-report-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('portfolio-report-table')).not.toBeInTheDocument();
  });

  it('shows an error message when the fetch fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    render(<PortfolioReport />);
    await waitFor(() => expect(screen.getByTestId('portfolio-report-error')).toBeInTheDocument());
  });

  it('shows a loading state before the fetch resolves', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<PortfolioReport />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});
