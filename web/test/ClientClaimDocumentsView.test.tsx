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

  // 86e2zfjx3 AC1: the loading container is aria-busy and wrapped in a persistent aria-live region.
  it('marks the loading state aria-busy inside an aria-live="polite" region', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ClientClaimDocumentsView claimId={CLAIM_ID} />);
    const region = screen.getByTestId('client-claim-documents-live-region');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toContainElement(screen.getByTestId('client-claim-documents-loading'));
  });

  // 86e2zfjx3 AC2: the error container is role="alert".
  it('marks the error message role="alert"', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    render(<ClientClaimDocumentsView claimId={CLAIM_ID} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveAttribute('data-testid', 'client-claim-documents-error');
  });

  // 86e2zfjx3 AC3: both empty-state flavors (no-selection, and a selected claim resolving zero documents) are role="status".
  it('marks the not-selected state role="status"', () => {
    render(<ClientClaimDocumentsView claimId={null} />);
    expect(screen.getByRole('status')).toHaveAttribute('data-testid', 'client-claim-documents-not-selected');
  });

  it('marks the empty-state message role="status"', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ documents: [] }), { status: 200 }));
    render(<ClientClaimDocumentsView claimId={CLAIM_ID} />);
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveAttribute('data-testid', 'client-claim-documents-empty');
  });

  it('clears aria-busy once the fetch resolves', async () => {
    render(<ClientClaimDocumentsView claimId={CLAIM_ID} />);
    await waitFor(() => expect(screen.getByTestId('client-claim-documents-live-region')).toHaveAttribute('aria-busy', 'false'));
  });

  // 86e2zfjx3 AC4: covered via RTL, not Playwright -- see the PR body's Uncertainties.
  it('moves focus to the newly-rendered content once a selected claim finishes loading', async () => {
    const { rerender } = render(<ClientClaimDocumentsView claimId={null} />);
    rerender(<ClientClaimDocumentsView claimId={CLAIM_ID} />);

    await waitFor(() => expect(screen.getByTestId('client-claim-documents-content')).toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('client-claim-documents-content')));
  });
});
