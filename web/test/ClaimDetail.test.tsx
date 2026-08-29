import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ClaimDetail } from '../src/components/ClaimDetail.js';
import type { ClaimDetail as ClaimDetailData } from '../src/lib/api.js';

const CLAIM_ID = '30000000-0000-4000-8000-000000000001';

const CLAIM: ClaimDetailData = {
  id: CLAIM_ID,
  disputeId: '30000000-0000-4000-8000-000000000002',
  amountClaimed: '1876.4000',
  currency: 'USD',
  status: 'open',
  openedAt: '2026-08-01T00:00:00.000Z',
  agingDeadlineAt: '2026-08-15T00:00:00.000Z',
  recoveryEvents: [
    {
      id: '30000000-0000-4000-8000-000000000003',
      amountRecovered: '500.0000',
      currency: 'USD',
      varianceFindingId: '30000000-0000-4000-8000-000000000004',
      recordedAt: '2026-08-05T00:00:00.000Z',
    },
  ],
  cumulativeRecovered: '650.0000',
};

describe('ClaimDetail (P5.B.5)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(CLAIM), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches and renders the claim detail plus its recovery history', async () => {
    render(<ClaimDetail claimId={CLAIM_ID} onClose={() => {}} />);

    expect(fetchMock).toHaveBeenCalledWith(`/api/claims/${CLAIM_ID}`, expect.any(Object));

    await waitFor(() => expect(screen.getByTestId('claim-detail')).toBeInTheDocument());
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('$1,876.40')).toBeInTheDocument();
    expect(screen.getByText('$650.00')).toBeInTheDocument();
    expect(screen.getByText('$500.00')).toBeInTheDocument();
  });

  it('renders one recovery-event row per event in the history', async () => {
    render(<ClaimDetail claimId={CLAIM_ID} onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId('recovery-event')).toHaveLength(1));
  });

  it('shows an empty-state message when there are no recovery events yet', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...CLAIM, recoveryEvents: [], cumulativeRecovered: '0.0000' }), { status: 200 }));
    render(<ClaimDetail claimId={CLAIM_ID} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('No recovery events yet.')).toBeInTheDocument());
    expect(screen.queryByTestId('recovery-event')).not.toBeInTheDocument();
  });

  it('shows an error message when the fetch fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    render(<ClaimDetail claimId={CLAIM_ID} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Couldn.t load claim/)).toBeInTheDocument());
  });

  it('re-fetches when claimId changes', async () => {
    const { rerender } = render(<ClaimDetail claimId={CLAIM_ID} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('claim-detail')).toBeInTheDocument());

    const otherId = '30000000-0000-4000-8000-000000000099';
    rerender(<ClaimDetail claimId={otherId} onClose={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/claims/${otherId}`, expect.any(Object)));
  });

  it('renders a null aging deadline as an em dash', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...CLAIM, agingDeadlineAt: null }), { status: 200 }));
    render(<ClaimDetail claimId={CLAIM_ID} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('claim-detail')).toBeInTheDocument());
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
