import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ClientScorecardView } from '../src/components/ClientScorecardView.js';
import type { ClientPortalAuditRunScorecard } from '../src/lib/api.js';

const AUDIT_RUN_ID = 'run-1';

const SCORECARD: ClientPortalAuditRunScorecard = {
  auditRunId: AUDIT_RUN_ID, invoiceId: 'inv-1', invoiceNumber: 'INV-100', outcome: 'SCORED',
  conformedCount: 10, varianceCount: 4, unassessableCount: 1, totalOvercharge: '1500.0000', totalUndercharge: '20.0000', currency: 'USD',
};

describe('ClientScorecardView (P6.B.1)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(SCORECARD), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the given audit run on mount and renders its row', async () => {
    render(<ClientScorecardView auditRunId={AUDIT_RUN_ID} />);

    expect(fetchMock).toHaveBeenCalledWith(`/api/portal/scorecard/${AUDIT_RUN_ID}`, expect.any(Object));

    await waitFor(() => expect(screen.getByTestId('client-scorecard-row')).toBeInTheDocument());
    expect(screen.getByText('INV-100')).toBeInTheDocument();
    expect(screen.getByText('1,500.00 USD')).toBeInTheDocument();
    expect(screen.getByText('20.00 USD')).toBeInTheDocument();
  });

  it('shows an empty-state message when the audit run has no scorecard row yet', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...SCORECARD, conformedCount: null }), { status: 200 }));
    render(<ClientScorecardView auditRunId={AUDIT_RUN_ID} />);
    await waitFor(() => expect(screen.getByTestId('client-scorecard-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('client-scorecard-table')).not.toBeInTheDocument();
  });

  it('shows an error message when the fetch fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    render(<ClientScorecardView auditRunId={AUDIT_RUN_ID} />);
    await waitFor(() => expect(screen.getByTestId('client-scorecard-error')).toBeInTheDocument());
  });

  it('shows an error message when the audit run is not found (404)', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    render(<ClientScorecardView auditRunId={AUDIT_RUN_ID} />);
    await waitFor(() => expect(screen.getByTestId('client-scorecard-error')).toBeInTheDocument());
  });

  it('shows a loading state before the fetch resolves', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ClientScorecardView auditRunId={AUDIT_RUN_ID} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('re-fetches when auditRunId changes', async () => {
    const { rerender } = render(<ClientScorecardView auditRunId={AUDIT_RUN_ID} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/portal/scorecard/${AUDIT_RUN_ID}`, expect.any(Object)));

    rerender(<ClientScorecardView auditRunId="run-2" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/portal/scorecard/run-2', expect.any(Object)));
  });
});
