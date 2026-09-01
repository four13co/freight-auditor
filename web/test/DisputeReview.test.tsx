import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DisputeReview } from '../src/components/DisputeReview.js';
import type { DisputeDetail } from '../src/lib/api.js';

const DISPUTE_ID = '70000000-0000-4000-8000-000000000001';

const DISPUTE: DisputeDetail = {
  id: DISPUTE_ID,
  carrierId: 'carrier-1',
  status: 'draft',
  amountClaimed: '500.0000',
  currency: 'USD',
  createdAt: '2026-08-01T00:00:00.000Z',
  lines: [{ id: 'line-1', varianceFindingId: null, amount: '500.0000', currency: 'USD' }],
};

describe('DisputeReview (P4.C.6)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(DISPUTE), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches and renders the dispute detail plus its lines', async () => {
    render(<DisputeReview disputeId={DISPUTE_ID} onClose={() => {}} />);

    expect(fetchMock).toHaveBeenCalledWith(`/api/disputes/${DISPUTE_ID}`, expect.any(Object));

    await waitFor(() => expect(screen.getByTestId('dispute-review')).toBeInTheDocument());
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getAllByText('$500.00')).toHaveLength(2);
    expect(screen.getAllByTestId('dispute-line')).toHaveLength(1);
  });

  it('approves a draft dispute and reflects the new status without a page reload', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/approve')) return Promise.resolve(new Response(JSON.stringify({ disputeId: DISPUTE_ID, status: 'sent' }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify(DISPUTE), { status: 200 }));
    });

    render(<DisputeReview disputeId={DISPUTE_ID} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve for delivery' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Approve for delivery' }));

    await waitFor(() => expect(screen.getByText('Sent')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(`/api/disputes/${DISPUTE_ID}/approve`, expect.objectContaining({ method: 'POST' }));
  });

  it('calls onApproved after a successful approval', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/approve')) return Promise.resolve(new Response(JSON.stringify({ disputeId: DISPUTE_ID, status: 'sent' }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify(DISPUTE), { status: 200 }));
    });
    const onApproved = vi.fn();
    render(<DisputeReview disputeId={DISPUTE_ID} onClose={() => {}} onApproved={onApproved} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve for delivery' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Approve for delivery' }));
    await waitFor(() => expect(onApproved).toHaveBeenCalledWith(DISPUTE_ID, 'sent'));
  });

  it('shows an error and does not change status when approval fails', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/approve')) return Promise.resolve(new Response(null, { status: 409 }));
      return Promise.resolve(new Response(JSON.stringify(DISPUTE), { status: 200 }));
    });

    render(<DisputeReview disputeId={DISPUTE_ID} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve for delivery' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Approve for delivery' }));

    await waitFor(() => expect(screen.getByText(/Couldn.t approve dispute/)).toBeInTheDocument());
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  it('disables approval for a dispute that is already sent', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...DISPUTE, status: 'sent' }), { status: 200 }));
    render(<DisputeReview disputeId={DISPUTE_ID} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approved' })).toBeDisabled());
  });

  it('shows an error message when the fetch fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    render(<DisputeReview disputeId={DISPUTE_ID} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Couldn.t load dispute/)).toBeInTheDocument());
  });
});
