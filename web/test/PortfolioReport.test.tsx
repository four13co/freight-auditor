import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PortfolioReport } from '../src/components/PortfolioReport.js';
import type { ClientPortfolioBucketRow } from '../src/lib/api.js';

const BUCKETS: ClientPortfolioBucketRow[] = [
  {
    clientId: 'client-a', clientName: 'Client A', currency: 'USD',
    claimed: '1000.0000', recovered: '600.0000', outstanding: '400.0000', writtenOff: '0.0000', denied: '0.0000',
    nullCurrencyRecovered: '0.0000', mismatchedCurrencyRecovered: '0.0000', reconciles: true,
  },
  {
    clientId: 'client-b', clientName: 'Client B', currency: 'CAD',
    claimed: '300.0000', recovered: '0.0000', outstanding: '0.0000', writtenOff: '0.0000', denied: '300.0000',
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

  it('fetches and renders one row per (client, currency) bucket', async () => {
    render(<PortfolioReport />);

    expect(fetchMock).toHaveBeenCalledWith('/api/portfolio/cross-client-recovery', expect.any(Object));

    await waitFor(() => expect(screen.getByTestId('portfolio-report-table')).toBeInTheDocument());
    expect(screen.getAllByTestId('portfolio-report-row')).toHaveLength(2);
    expect(screen.getByText('Client A')).toBeInTheDocument();
    expect(screen.getByText('Client B')).toBeInTheDocument();
    expect(screen.getByText('$1,000.00')).toBeInTheDocument();
    expect(screen.getAllByText('$300.00')).toHaveLength(2); // client B's claimed AND denied both equal 300
  });

  it('shows a loading state before the fetch resolves', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<PortfolioReport />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows an empty-portfolio message when there are no claims anywhere', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ buckets: [] }), { status: 200 }));
    render(<PortfolioReport />);
    await waitFor(() => expect(screen.getByText('No claims across any client yet.')).toBeInTheDocument());
  });

  it('shows an error message when the fetch fails (e.g. a non-internal caller gets 403)', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    render(<PortfolioReport />);
    await waitFor(() => expect(screen.getByText(/Couldn.t load the portfolio report/)).toBeInTheDocument());
  });

  it('flags a bucket that does not reconcile', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      buckets: [{ ...BUCKETS[0], reconciles: false }],
    }), { status: 200 }));
    render(<PortfolioReport />);
    await waitFor(() => expect(screen.getByTitle('Reported totals for this bucket do not reconcile')).toBeInTheDocument());
  });
});
