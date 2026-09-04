import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ClientDisputeCommunicationsView } from '../src/components/ClientDisputeCommunicationsView.js';
import type { ClientPortalDisputeCommRow } from '../src/lib/api.js';

const DISPUTE_ID = 'd-1';

const COMMS: ClientPortalDisputeCommRow[] = [
  { id: 'c-2', direction: 'outbound', body: 'Delivery to carrier initiated.', recordedAt: '2026-09-01T00:00:00Z' },
  { id: 'c-1', direction: 'inbound', body: null, recordedAt: '2026-08-31T00:00:00Z' },
];

describe('ClientDisputeCommunicationsView (P6.B.3)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ communications: COMMS }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows an explicit not-selected state and fetches nothing when no dispute is selected', () => {
    render(<ClientDisputeCommunicationsView disputeId={null} />);
    expect(screen.getByTestId('client-dispute-communications-not-selected')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches on mount and renders one row per communication, newest first per the API order', async () => {
    render(<ClientDisputeCommunicationsView disputeId={DISPUTE_ID} />);

    expect(fetchMock).toHaveBeenCalledWith(`/api/portal/disputes/${DISPUTE_ID}/communications`, expect.any(Object));

    await waitFor(() => expect(screen.getAllByTestId('client-dispute-communications-row')).toHaveLength(2));
    expect(screen.getByText('Delivery to carrier initiated.')).toBeInTheDocument();
  });

  it('renders a dash for a null body rather than blank', async () => {
    render(<ClientDisputeCommunicationsView disputeId={DISPUTE_ID} />);
    await waitFor(() => expect(screen.getAllByTestId('client-dispute-communications-row')).toHaveLength(2));
    const rows = screen.getAllByTestId('client-dispute-communications-row');
    expect(rows[1]!.textContent).toContain('—');
  });

  it('shows an empty-state message when the dispute has no communications yet', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ communications: [] }), { status: 200 }));
    render(<ClientDisputeCommunicationsView disputeId={DISPUTE_ID} />);
    await waitFor(() => expect(screen.getByTestId('client-dispute-communications-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('client-dispute-communications-table')).not.toBeInTheDocument();
  });

  it('shows an error message when the fetch fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    render(<ClientDisputeCommunicationsView disputeId={DISPUTE_ID} />);
    await waitFor(() => expect(screen.getByTestId('client-dispute-communications-error')).toBeInTheDocument());
  });

  it('shows an error message when the dispute is not found (404)', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    render(<ClientDisputeCommunicationsView disputeId={DISPUTE_ID} />);
    await waitFor(() => expect(screen.getByTestId('client-dispute-communications-error')).toBeInTheDocument());
  });

  it('shows a loading state before the fetch resolves', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ClientDisputeCommunicationsView disputeId={DISPUTE_ID} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  // 86e2zfjx3 AC1: the loading container is aria-busy and wrapped in a persistent aria-live region.
  it('marks the loading state aria-busy inside an aria-live="polite" region', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ClientDisputeCommunicationsView disputeId={DISPUTE_ID} />);
    const region = screen.getByTestId('client-dispute-communications-live-region');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toContainElement(screen.getByTestId('client-dispute-communications-loading'));
  });

  // 86e2zfjx3 AC2: the error container is role="alert".
  it('marks the error message role="alert"', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    render(<ClientDisputeCommunicationsView disputeId={DISPUTE_ID} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveAttribute('data-testid', 'client-dispute-communications-error');
  });

  // 86e2zfjx3 AC3: both empty-state flavors (no-selection, and a selected dispute with zero comms) are role="status".
  it('marks the not-selected state role="status"', () => {
    render(<ClientDisputeCommunicationsView disputeId={null} />);
    expect(screen.getByRole('status')).toHaveAttribute('data-testid', 'client-dispute-communications-not-selected');
  });

  it('marks the empty-state message role="status"', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ communications: [] }), { status: 200 }));
    render(<ClientDisputeCommunicationsView disputeId={DISPUTE_ID} />);
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveAttribute('data-testid', 'client-dispute-communications-empty');
  });

  it('clears aria-busy once the fetch resolves', async () => {
    render(<ClientDisputeCommunicationsView disputeId={DISPUTE_ID} />);
    await waitFor(() => expect(screen.getByTestId('client-dispute-communications-live-region')).toHaveAttribute('aria-busy', 'false'));
  });

  // 86e2zfjx3 AC4: covered via RTL, not Playwright -- see the PR body's Uncertainties.
  it('moves focus to the newly-rendered content once a selected dispute finishes loading', async () => {
    const { rerender } = render(<ClientDisputeCommunicationsView disputeId={null} />);
    rerender(<ClientDisputeCommunicationsView disputeId={DISPUTE_ID} />);

    await waitFor(() => expect(screen.getByTestId('client-dispute-communications-content')).toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('client-dispute-communications-content')));
  });
});
