import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ClientClaimView } from '../src/components/ClientClaimView.js';
import type { ClientPortalClaimDetail } from '../src/lib/api.js';

const CLAIM_ID = 'claim-1';

const CLAIM: ClientPortalClaimDetail = {
  id: CLAIM_ID, disputeId: 'd-1', amountClaimed: '100.0000', currency: 'USD', status: 'open',
  openedAt: '2026-08-01T00:00:00Z', agingDeadlineAt: null, cumulativeRecovered: '50.0000',
  recoveryEvents: [
    { id: 'r-1', amountRecovered: '30.0000', currency: 'USD', varianceFindingId: 'f-1', recordedAt: '2026-08-15T00:00:00Z' },
    { id: 'r-2', amountRecovered: '20.0000', currency: 'USD', varianceFindingId: 'f-1', recordedAt: '2026-08-20T00:00:00Z' },
  ],
};

describe('ClientClaimView (P6.B.4)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(CLAIM), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows an explicit empty state and fetches nothing when no claim is selected', () => {
    render(<ClientClaimView claimId={null} />);
    expect(screen.getByTestId('client-claim-empty')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches the given claim on mount and renders its detail and recovery events', async () => {
    render(<ClientClaimView claimId={CLAIM_ID} />);

    expect(fetchMock).toHaveBeenCalledWith(`/api/portal/claims/${CLAIM_ID}`, expect.any(Object));

    await waitFor(() => expect(screen.getByTestId('client-claim-content')).toBeInTheDocument());
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(screen.getByText('100.00 USD')).toBeInTheDocument();
    expect(screen.getByText('50.00 USD')).toBeInTheDocument();
    expect(screen.getAllByTestId('client-claim-recovery-event-row')).toHaveLength(2);
  });

  it('shows an explicit empty state for a claim with no recovery events yet', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...CLAIM, recoveryEvents: [], cumulativeRecovered: '0.0000' }), { status: 200 }));
    render(<ClientClaimView claimId={CLAIM_ID} />);
    await waitFor(() => expect(screen.getByTestId('client-claim-recovery-events-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('client-claim-recovery-events-table')).not.toBeInTheDocument();
  });

  it('shows an error message when the fetch fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    render(<ClientClaimView claimId={CLAIM_ID} />);
    await waitFor(() => expect(screen.getByTestId('client-claim-error')).toBeInTheDocument());
  });

  it('shows an error message when the claim is not found (404) -- cross-tenant/nonexistent both surface here', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    render(<ClientClaimView claimId={CLAIM_ID} />);
    await waitFor(() => expect(screen.getByTestId('client-claim-error')).toBeInTheDocument());
  });

  it('shows a loading state before the fetch resolves', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ClientClaimView claimId={CLAIM_ID} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('re-fetches when claimId changes, and clears back to empty when it becomes null', async () => {
    const { rerender } = render(<ClientClaimView claimId={CLAIM_ID} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/portal/claims/${CLAIM_ID}`, expect.any(Object)));

    rerender(<ClientClaimView claimId="claim-2" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/portal/claims/claim-2', expect.any(Object)));

    rerender(<ClientClaimView claimId={null} />);
    expect(screen.getByTestId('client-claim-empty')).toBeInTheDocument();
  });
});
