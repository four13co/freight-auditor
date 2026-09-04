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

  // 86e2zfjx3 AC1: the loading container is aria-busy and wrapped in a persistent aria-live region.
  it('marks the loading state aria-busy inside an aria-live="polite" region', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ClientDisputeDetailView disputeId={DISPUTE_ID} />);
    const region = screen.getByTestId('client-dispute-detail-live-region');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toContainElement(screen.getByTestId('client-dispute-detail-loading'));
  });

  // 86e2zfjx3 AC2: the error container is role="alert".
  it('marks the error message role="alert"', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    render(<ClientDisputeDetailView disputeId={DISPUTE_ID} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveAttribute('data-testid', 'client-dispute-detail-error');
  });

  // 86e2zfjx3 AC3: both empty-state flavors (no-selection, and a selected dispute with no lines) are role="status".
  it('marks the no-selection state role="status"', () => {
    render(<ClientDisputeDetailView disputeId={null} />);
    expect(screen.getByRole('status')).toHaveAttribute('data-testid', 'client-dispute-detail-empty');
  });

  it('marks the lines-empty state role="status"', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...DISPUTE, lines: [] }), { status: 200 }));
    render(<ClientDisputeDetailView disputeId={DISPUTE_ID} />);
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveAttribute('data-testid', 'client-dispute-detail-lines-empty');
  });

  it('clears aria-busy once the fetch resolves', async () => {
    render(<ClientDisputeDetailView disputeId={DISPUTE_ID} />);
    await waitFor(() => expect(screen.getByTestId('client-dispute-detail-live-region')).toHaveAttribute('aria-busy', 'false'));
  });

  /**
   * 86e2zfjx3 AC4 -- the representative view named in the item's own AC text. Covered here via
   * RTL (rerender + document.activeElement), not a Playwright e2e: see the PR body's
   * Uncertainties for why (this view is unwired to any route; reaching it via page.goto()
   * would require wiring PortalApp.tsx, which is outside this task's 10 named files).
   */
  it('moves focus to the newly-rendered content once a selected dispute finishes loading', async () => {
    const { rerender } = render(<ClientDisputeDetailView disputeId={null} />);
    rerender(<ClientDisputeDetailView disputeId={DISPUTE_ID} />);

    await waitFor(() => expect(screen.getByTestId('client-dispute-detail-content')).toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('client-dispute-detail-content')));
  });

  it('moves focus to the error message when a selected dispute fails to load', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const { rerender } = render(<ClientDisputeDetailView disputeId={null} />);
    rerender(<ClientDisputeDetailView disputeId={DISPUTE_ID} />);

    await waitFor(() => expect(screen.getByTestId('client-dispute-detail-error')).toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('client-dispute-detail-error')));
  });

  /**
   * The item's AC describes "a user selects a dispute/claim/finding row" -- the real flow is a
   * second selection (id -> id2) while a dispute is already showing, not just null -> id.
   */
  it('moves focus again when a second dispute is selected while one is already showing', async () => {
    const { rerender } = render(<ClientDisputeDetailView disputeId={DISPUTE_ID} />);
    await waitFor(() => expect(screen.getByTestId('client-dispute-detail-content')).toBeInTheDocument());
    (screen.getByTestId('client-dispute-detail-content') as HTMLElement).blur();
    expect(document.activeElement).not.toBe(screen.getByTestId('client-dispute-detail-content'));

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...DISPUTE, id: 'd-2' }), { status: 200 }));
    rerender(<ClientDisputeDetailView disputeId="d-2" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/portal/disputes/d-2', expect.any(Object)));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('client-dispute-detail-content')));
  });

  it('does not steal focus while merely rendering the initial not-selected state', () => {
    render(<ClientDisputeDetailView disputeId={null} />);
    expect(document.activeElement).not.toBe(screen.getByTestId('client-dispute-detail-empty'));
  });
});
