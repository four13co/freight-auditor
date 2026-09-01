import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ClientScorecardView } from '../src/components/ClientScorecardView.js';
import type { ClientPortalScorecardBucket } from '../src/lib/api.js';

const BUCKETS: ClientPortalScorecardBucket[] = [
  { currency: 'USD', runCount: 3, conformedCount: 10, varianceCount: 4, unassessableCount: 1, totalOvercharge: '1500.0000', totalUndercharge: '20.0000' },
  { currency: 'CAD', runCount: 1, conformedCount: 2, varianceCount: 0, unassessableCount: 0, totalOvercharge: '0.0000', totalUndercharge: '0.0000' },
];

describe('ClientScorecardView (P6.B.1)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ buckets: BUCKETS }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches on mount and renders one row per currency bucket', async () => {
    render(<ClientScorecardView />);

    expect(fetchMock).toHaveBeenCalledWith('/api/portal/scorecard', expect.any(Object));

    await waitFor(() => expect(screen.getAllByTestId('client-scorecard-row')).toHaveLength(2));
    expect(screen.getByText('1,500.00 USD')).toBeInTheDocument();
    expect(screen.getAllByText('0.00 CAD').length).toBeGreaterThan(0);
  });

  it('keeps currencies in separate rows rather than a single blended total', async () => {
    render(<ClientScorecardView />);
    await waitFor(() => expect(screen.getAllByTestId('client-scorecard-row')).toHaveLength(2));
    expect(screen.getByText('USD')).toBeInTheDocument();
    expect(screen.getByText('CAD')).toBeInTheDocument();
  });

  it('shows an empty-state message when no audit runs exist', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ buckets: [] }), { status: 200 }));
    render(<ClientScorecardView />);
    await waitFor(() => expect(screen.getByTestId('client-scorecard-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('client-scorecard-table')).not.toBeInTheDocument();
  });

  it('shows an error message when the fetch fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    render(<ClientScorecardView />);
    await waitFor(() => expect(screen.getByTestId('client-scorecard-error')).toBeInTheDocument());
  });

  it('shows a loading state before the fetch resolves', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ClientScorecardView />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});
