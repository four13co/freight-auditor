import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ClientFindingEvidenceView } from '../src/components/ClientFindingEvidenceView.js';
import type { ClientPortalFindingEvidence } from '../src/lib/api.js';

const FINDING_ID = 'f-1';

const CHAIN: ClientPortalFindingEvidence = {
  finding: { id: FINDING_ID, auditRunId: 'run-1', classification: 'variance', varianceAmount: '100.0000', currency: 'USD', evaluatedExpr: {} },
  criterion: { id: 'crit-1', key: 'CONTRACT.RATE_VARIANCE' },
  ruleVersion: { id: 'rv-1', astHash: 'hash' },
  clause: { id: 'cl-1', reference: '4.2', page: '7' },
  rateCell: { id: 'rc-1', reference: 'B12' },
  sourceDocument: { id: 'sd-1', sha256: 'sha', storageUri: 'r2://doc' },
  transportDocument: { id: 'td-1', number: 'BL1', type: 'BOL', sourceDocumentId: 'sd-1' },
  contributors: { billedChargeFactIds: [], expectedChargeIds: [] },
};

describe('ClientFindingEvidenceView (P6.B.2)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(CHAIN), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows an explicit empty state and fetches nothing when no finding is selected', () => {
    render(<ClientFindingEvidenceView findingId={null} />);
    expect(screen.getByTestId('client-finding-evidence-empty')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches the given finding on mount and renders its chain', async () => {
    render(<ClientFindingEvidenceView findingId={FINDING_ID} />);

    expect(fetchMock).toHaveBeenCalledWith(`/api/portal/findings/${FINDING_ID}/evidence`, expect.any(Object));

    await waitFor(() => expect(screen.getByTestId('client-finding-evidence-detail')).toBeInTheDocument());
    expect(screen.getByText('CONTRACT.RATE_VARIANCE')).toBeInTheDocument();
    expect(screen.getByText('4.2')).toBeInTheDocument();
    expect(screen.getByText('B12')).toBeInTheDocument();
    expect(screen.getByText('BL1')).toBeInTheDocument();
  });

  it('renders a dash for an absent clause/rate cell/transport document', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...CHAIN, clause: null, rateCell: null, transportDocument: null }), { status: 200 }));
    render(<ClientFindingEvidenceView findingId={FINDING_ID} />);
    await waitFor(() => expect(screen.getByTestId('client-finding-evidence-detail')).toBeInTheDocument());
    expect(screen.getAllByText('—')).toHaveLength(3);
  });

  it('shows an error message when the fetch fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    render(<ClientFindingEvidenceView findingId={FINDING_ID} />);
    await waitFor(() => expect(screen.getByTestId('client-finding-evidence-error')).toBeInTheDocument());
  });

  it('shows an error message when the finding is not found (404) -- cross-tenant/nonexistent both surface here', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    render(<ClientFindingEvidenceView findingId={FINDING_ID} />);
    await waitFor(() => expect(screen.getByTestId('client-finding-evidence-error')).toBeInTheDocument());
  });

  it('shows a loading state before the fetch resolves', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ClientFindingEvidenceView findingId={FINDING_ID} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('re-fetches when findingId changes, and clears back to empty when it becomes null', async () => {
    const { rerender } = render(<ClientFindingEvidenceView findingId={FINDING_ID} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/portal/findings/${FINDING_ID}/evidence`, expect.any(Object)));

    rerender(<ClientFindingEvidenceView findingId="f-2" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/portal/findings/f-2/evidence', expect.any(Object)));

    rerender(<ClientFindingEvidenceView findingId={null} />);
    expect(screen.getByTestId('client-finding-evidence-empty')).toBeInTheDocument();
  });
});
