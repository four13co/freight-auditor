import { useEffect, useState } from 'react';
import { fetchClientPortalFindingEvidence, type ClientPortalFindingEvidence } from '../lib/api.js';

/**
 * Client-facing finding evidence/defensibility-chain detail (P6.B.2).
 * Unwired to nav -- same disclosure as ClientScorecardView.tsx's own
 * P6.B.1 precedent.
 *
 * Takes `findingId` as a nullable prop rather than a required one --
 * unlike ClientScorecardView.tsx (which is always mounted against a
 * specific auditRunId once reachable), this view is meant to be driven by
 * a row selected from ClientFindingsView, so "no finding selected yet" is
 * a real, distinct state from "fetch failed" or "still loading" -- it
 * renders the same explicit-empty-state contract this task's AC4 requires,
 * before any fetch is even attempted.
 */
export function ClientFindingEvidenceView({ findingId }: { findingId: string | null }) {
  const [chain, setChain] = useState<ClientPortalFindingEvidence | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (findingId === null) {
      setChain(null);
      setError(false);
      return;
    }
    let cancelled = false;
    setChain(null);
    setError(false);
    fetchClientPortalFindingEvidence(findingId).then(
      (data) => { if (!cancelled) setChain(data); },
      () => { if (!cancelled) setError(true); },
    );
    return () => { cancelled = true; };
  }, [findingId]);

  return (
    <section data-testid="client-finding-evidence-view" className="border border-[rgba(32,30,29,.3)] bg-[#f3f2f2] p-3">
      <h2 className="mb-2 text-sm font-extrabold">Finding evidence</h2>

      {findingId === null && (
        <span data-testid="client-finding-evidence-empty" className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">
          Select a finding to view its evidence chain.
        </span>
      )}

      {findingId !== null && error && (
        <span data-testid="client-finding-evidence-error" className="text-xs font-semibold text-[#7c1405]">
          Couldn&rsquo;t load evidence.
        </span>
      )}

      {findingId !== null && !error && chain === null && (
        <span className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">Loading…</span>
      )}

      {findingId !== null && !error && chain !== null && (
        <dl data-testid="client-finding-evidence-detail" className="text-xs">
          <div className="flex gap-2">
            <dt className="font-extrabold">Rule</dt>
            <dd>{chain.criterion.key}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-extrabold">Clause</dt>
            <dd>{chain.clause ? chain.clause.reference : '—'}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-extrabold">Rate cell</dt>
            <dd>{chain.rateCell ? chain.rateCell.reference : '—'}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-extrabold">Transport document</dt>
            <dd>{chain.transportDocument ? chain.transportDocument.number : '—'}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
