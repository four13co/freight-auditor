import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ClientClaimDocumentsView } from '../src/components/ClientClaimDocumentsView.js';
import type { ClientPortalClaimDocumentRef } from '../src/lib/api.js';

const CLAIM_ID = 'claim-1';

const DOCS: ClientPortalClaimDocumentRef[] = [
  { id: 'doc-1', sha256: 'a'.repeat(64), storageUri: 'r2://doc-1' },
];

describe('ClientClaimDocumentsView (P6.B.4)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ documents: DOCS }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows an explicit not-selected state and fetches nothing when no claim is selected', () => {
    render(<ClientClaimDocumentsView claimId={null} />);
    expect(screen.getByTestId('client-claim-documents-not-selected')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches on mount and renders one row per document', async () => {
    render(<ClientClaimDocumentsView claimId={CLAIM_ID} />);

    expect(fetchMock).toHaveBeenCalledWith(`/api/portal/claims/${CLAIM_ID}/documents`, expect.any(Object));

    await waitFor(() => expect(screen.getAllByTestId('client-claim-documents-row')).toHaveLength(1));
    expect(screen.getByText('r2://doc-1')).toBeInTheDocument();
  });

  it('shows an empty-state message when the claim resolves no documents yet', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ documents: [] }), { status: 200 }));
    render(<ClientClaimDocumentsView claimId={CLAIM_ID} />);
    await waitFor(() => expect(screen.getByTestId('client-claim-documents-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('client-claim-documents-table')).not.toBeInTheDocument();
  });

  it('shows an error message when the fetch fails', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    render(<ClientClaimDocumentsView claimId={CLAIM_ID} />);
    await waitFor(() => expect(screen.getByTestId('client-claim-documents-error')).toBeInTheDocument());
  });

  it('shows an error message when the claim is not found (404)', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    render(<ClientClaimDocumentsView claimId={CLAIM_ID} />);
    await waitFor(() => expect(screen.getByTestId('client-claim-documents-error')).toBeInTheDocument());
  });

  it('shows a loading state before the fetch resolves', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ClientClaimDocumentsView claimId={CLAIM_ID} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});
