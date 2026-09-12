import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClaimsView } from '../src/components/ClaimsView.js';
import type { ClaimListRow } from '../src/lib/api.js';

function claim(overrides: Partial<ClaimListRow>): ClaimListRow {
  return {
    id: '30000000-0000-4000-8000-000000000001',
    disputeId: '30000000-0000-4000-8000-000000000002',
    amountClaimed: '1876.4000',
    currency: 'USD',
    status: 'open',
    openedAt: '2026-08-01T00:00:00.000Z',
    agingDeadlineAt: '2026-08-15T00:00:00.000Z',
    ...overrides,
  };
}

const FULL_PAGE = Array.from({ length: 50 }, (_, i) =>
  claim({ id: `30000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}` }),
);

describe('ClaimsView (86e387qpv)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Fresh Response per call -- pagination re-fetches, and a Response body
    // can only be consumed once (same convention as InvoicesView.test.tsx).
    fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ claims: [] }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches on mount with the default page size and offset', async () => {
    render(<ClaimsView />);
    expect(fetchMock).toHaveBeenCalledWith('/api/claims?limit=50&offset=0', expect.any(Object));
    await waitFor(() => expect(screen.getByTestId('claims-empty')).toBeInTheDocument());
  });

  it('renders one row per claim, with claim/status/amount claimed/opened/aging deadline visible', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      claims: [
        claim({ id: 'aaaaaaaa-0000-4000-8000-000000000001', status: 'open', amountClaimed: '1876.4000' }),
        claim({ id: 'bbbbbbbb-0000-4000-8000-000000000002', status: 'resolved', amountClaimed: '250.0000', agingDeadlineAt: null }),
      ],
    }), { status: 200 }));
    render(<ClaimsView />);

    await waitFor(() => expect(screen.getAllByTestId('claim-row')).toHaveLength(2));
    expect(screen.getByText('aaaaaaaa')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('$1,876.40')).toBeInTheDocument();
    expect(screen.getByText('Resolved')).toBeInTheDocument();
    expect(screen.getByText('$250.00')).toBeInTheDocument();
    // null agingDeadlineAt renders as the shared "missing value" placeholder.
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows an empty-state message when no claims exist', async () => {
    render(<ClaimsView />);
    await waitFor(() => expect(screen.getByTestId('claims-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('claims-table')).not.toBeInTheDocument();
  });

  it('shows an error message when the fetch fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    render(<ClaimsView />);
    await waitFor(() => expect(screen.getByTestId('claims-error')).toBeInTheDocument());
  });

  it('shows a loading state before the fetch resolves', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ClaimsView />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('retries the load when Retry is clicked after an error', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    render(<ClaimsView />);
    await waitFor(() => expect(screen.getByTestId('claims-error')).toBeInTheDocument());

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ claims: [claim({})] }), { status: 200 }));
    await user.click(screen.getByText('Retry'));

    await waitFor(() => expect(screen.getAllByTestId('claim-row')).toHaveLength(1));
    expect(screen.queryByTestId('claims-error')).not.toBeInTheDocument();
  });

  it('disables Previous on the first page and Next when the page is not full', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ claims: [claim({})] }), { status: 200 }));
    render(<ClaimsView />);
    await waitFor(() => expect(screen.getByTestId('claims-prev')).toBeDisabled());
    expect(screen.getByTestId('claims-next')).toBeDisabled();
  });

  it('enables Next on a full page and advances offset on click', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ claims: FULL_PAGE }), { status: 200 })));
    render(<ClaimsView />);

    await waitFor(() => expect(screen.getByTestId('claims-next')).not.toBeDisabled());
    await user.click(screen.getByTestId('claims-next'));

    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/api/claims?limit=50&offset=50', expect.any(Object)));
    expect(screen.getByTestId('claims-prev')).not.toBeDisabled();
  });

  it('86e387qpv AC2: clicking a claim row opens the existing ClaimDetail drawer with that row\'s claimId', async () => {
    const user = userEvent.setup();
    const CLAIM_ID = '30000000-0000-4000-8000-000000000001';
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(`/api/claims/${CLAIM_ID}`)) {
        return Promise.resolve(new Response(JSON.stringify({
          ...claim({ id: CLAIM_ID }),
          recoveryEvents: [],
          cumulativeRecovered: '0.0000',
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ claims: [claim({ id: CLAIM_ID })] }), { status: 200 }));
    });
    render(<ClaimsView />);

    await waitFor(() => expect(screen.getAllByTestId('claim-row')).toHaveLength(1));
    await user.click(screen.getByTestId('claim-row'));

    await waitFor(() => expect(screen.getByTestId('claim-detail')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(`/api/claims/${CLAIM_ID}`, expect.any(Object));
  });

  it('86e387qpv: closing the ClaimDetail drawer (Escape) returns to the claims list with no drawer visible', async () => {
    const user = userEvent.setup();
    const CLAIM_ID = '30000000-0000-4000-8000-000000000001';
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(`/api/claims/${CLAIM_ID}`)) {
        return Promise.resolve(new Response(JSON.stringify({
          ...claim({ id: CLAIM_ID }),
          recoveryEvents: [],
          cumulativeRecovered: '0.0000',
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ claims: [claim({ id: CLAIM_ID })] }), { status: 200 }));
    });
    render(<ClaimsView />);

    await waitFor(() => expect(screen.getAllByTestId('claim-row')).toHaveLength(1));
    await user.click(screen.getByTestId('claim-row'));
    await waitFor(() => expect(screen.getByTestId('claim-detail')).toBeInTheDocument());

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('claim-detail')).not.toBeInTheDocument());
  });
});
