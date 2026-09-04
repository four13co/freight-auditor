import { useEffect, useState } from 'react';
import { fetchClientPortalClaimDocuments, type ClientPortalClaimDocumentRef } from '../lib/api.js';
import { useFocusOnReady } from '../lib/use-focus-on-ready.js';

/**
 * Client-facing claim evidence/document references (P6.B.4) -- reference
 * metadata only (id, sha256, storage reference), never raw bytes inline
 * (this task's own Rabbit holes). Unwired to nav -- same disclosure as
 * ClientClaimView.tsx's own precedent.
 *
 * Takes a nullable `claimId` prop for the same reason as
 * ClientClaimView.tsx -- "no claim selected yet" is its own explicit empty
 * state, distinct from "claim selected but resolves zero documents yet".
 */
export function ClientClaimDocumentsView({ claimId }: { claimId: string | null }) {
  const [documents, setDocuments] = useState<ClientPortalClaimDocumentRef[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (claimId === null) {
      setDocuments(null);
      setError(false);
      return;
    }
    let cancelled = false;
    setDocuments(null);
    setError(false);
    fetchClientPortalClaimDocuments(claimId).then(
      (data) => { if (!cancelled) setDocuments(data); },
      () => { if (!cancelled) setError(true); },
    );
    return () => { cancelled = true; };
  }, [claimId]);

  const ready = claimId !== null && (documents !== null || error);
  const readyRef = useFocusOnReady<HTMLDivElement>(ready);

  return (
    <section data-testid="client-claim-documents-view" className="border border-[rgba(32,30,29,.3)] bg-[#f3f2f2] p-3">
      <h2 className="mb-2 text-sm font-extrabold">Documents</h2>

      <div aria-live="polite" aria-busy={claimId !== null && !error && documents === null} data-testid="client-claim-documents-live-region">
        {claimId === null && (
          <span role="status" data-testid="client-claim-documents-not-selected" className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">
            Select a claim to view its documents.
          </span>
        )}

        {claimId !== null && error && (
          <div ref={readyRef} tabIndex={-1} role="alert" data-testid="client-claim-documents-error" className="text-xs font-semibold text-[#7c1405]">
            Couldn&rsquo;t load documents.
          </div>
        )}

        {claimId !== null && !error && documents === null && (
          <span data-testid="client-claim-documents-loading" className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">Loading…</span>
        )}

        {claimId !== null && !error && documents !== null && documents.length === 0 && (
          <span ref={readyRef} tabIndex={-1} role="status" data-testid="client-claim-documents-empty" className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">
            No documents recorded yet.
          </span>
        )}

        {claimId !== null && !error && documents !== null && documents.length > 0 && (
          <div ref={readyRef} tabIndex={-1} data-testid="client-claim-documents-content">
            <table data-testid="client-claim-documents-table" className="w-full text-xs">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-1 pr-2">Document</th>
                  <th className="py-1 pr-2">SHA-256</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => (
                  <tr key={doc.id} data-testid="client-claim-documents-row" className="border-t">
                    <td className="py-1 pr-2">{doc.storageUri}</td>
                    <td className="py-1 pr-2 font-mono">{doc.sha256.slice(0, 12)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
