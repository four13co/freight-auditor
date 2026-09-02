import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ClientDisputeDetailView } from '../src/components/ClientDisputeDetailView.js';
import type { ClientPortalDisputeDetail } from '../src/lib/api.js';

const DISPUTE_ID = 'd-1';

const DISPUTE: ClientPortalDisputeDetail = {
  id: DISPUTE_ID, carrierId: 'car-1', status: 'draft', amountClaimed: '500.0000', currency: 'USD',
  createdAt: '2026-01-15T00:00:00Z',
  lines: [{ id: 'line-1', varianceFindingId: 'f-1', amount: '500.0000', currency: 'USD' }],
};

describe('ClientDisputeDetailView (P6.B.3)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(DISPUTE), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows an explicit empty state and fetches nothing when no dispute is selected', () => {
    render(<ClientDisputeDetailView disputeId={null} />);
    expect(screen.getByTestId('client-dispute-detail-empty')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches the given dispute on mount and renders its detail and lines', async () => {
    render(<ClientDisputeDetailView disputeId={DISPUTE_ID} />);

    expect(fetchMock).toHaveBeenCalledWith(`/api/portal/disputes/${DISPUTE_ID}`, expect.any(Object));

    await waitFor(() => expect(screen.getByTestId('client-dispute-detail-content')).toBeInTheDocument());
    expect(screen.getByText('draft')).toBeInTheDocument();
    expect(screen.getAllByText('500.00 USD')).toHaveLength(2); // amount claimed + the one line
    expect(screen.getAllByTestId('client-dispute-detail-line-row')).toHaveLength(1);
  });

  it('shows an explicit empty state for a dispute with no lines yet', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...DISPUTE, lines: [] }), { status: 200 }));
    render(<ClientDisputeDetailView disputeId={DISPUTE_ID} />);
    await waitFor(() => expect(screen.getByTestId('client-dispute-detail-lines-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('client-dispute-detail-lines')).not.toBeInTheDocument();
  });

  it('shows an error message when the fetch fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    render(<ClientDisputeDetailView disputeId={DISPUTE_ID} />);
    await waitFor(() => expect(screen.getByTestId('client-dispute-detail-error')).toBeInTheDocument());
  });

  it('shows an error message when the dispute is not found (404) -- cross-tenant/nonexistent both surface here', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    render(<ClientDisputeDetailView disputeId={DISPUTE_ID} />);
    await waitFor(() => expect(screen.getByTestId('client-dispute-detail-error')).toBeInTheDocument());
  });

  it('shows a loading state before the fetch resolves', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ClientDisputeDetailView disputeId={DISPUTE_ID} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('re-fetches when disputeId changes, and clears back to empty when it becomes null', async () => {
    const { rerender } = render(<ClientDisputeDetailView disputeId={DISPUTE_ID} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/portal/disputes/${DISPUTE_ID}`, expect.any(Object)));

    rerender(<ClientDisputeDetailView disputeId="d-2" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/portal/disputes/d-2', expect.any(Object)));

    rerender(<ClientDisputeDetailView disputeId={null} />);
    expect(screen.getByTestId('client-dispute-detail-empty')).toBeInTheDocument();
  });
});
