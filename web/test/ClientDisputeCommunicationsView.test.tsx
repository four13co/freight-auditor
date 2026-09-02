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
});
