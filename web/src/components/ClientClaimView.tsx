import { useEffect, useState } from 'react';
import { fetchClientPortalClaim, type ClientPortalClaimDetail } from '../lib/api.js';
import { useFocusOnReady } from '../lib/use-focus-on-ready.js';

function formatAmount(value: string, currency: string | null): string {
  const n = Number(value);
  const formatted = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${formatted} ${currency}` : formatted;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Client-facing claim detail + recovery-event history (P6.B.4). Unwired to
 * nav -- same disclosure as ClientDisputeDetailView.tsx's own P6.B.3
 * precedent.
 *
 * Takes a nullable `claimId` prop for the same reason as
 * ClientDisputeDetailView.tsx / ClientFindingEvidenceView.tsx -- "no claim
 * selected yet" is its own explicit empty state.
 */
export function ClientClaimView({ claimId }: { claimId: string | null }) {
  const [claim, setClaim] = useState<ClientPortalClaimDetail | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (claimId === null) {
      setClaim(null);
      setError(false);
      return;
    }
    let cancelled = false;
    setClaim(null);
    setError(false);
    fetchClientPortalClaim(claimId).then(
      (data) => { if (!cancelled) setClaim(data); },
      () => { if (!cancelled) setError(true); },
    );
    return () => { cancelled = true; };
  }, [claimId]);

  const ready = claimId !== null && (claim !== null || error);
  const readyRef = useFocusOnReady<HTMLDivElement>(ready);

  return (
    <section data-testid="client-claim-view" className="border border-[rgba(32,30,29,.3)] bg-[#f3f2f2] p-3">
      <h2 className="mb-2 text-sm font-extrabold">Claim</h2>

      <div aria-live="polite" aria-busy={claimId !== null && !error && claim === null} data-testid="client-claim-live-region">
        {claimId === null && (
          <span role="status" data-testid="client-claim-empty" className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">
            Select a claim to view its detail.
          </span>
        )}

        {claimId !== null && error && (
          <div ref={readyRef} tabIndex={-1} role="alert" data-testid="client-claim-error" className="text-xs font-semibold text-[#7c1405]">
            Couldn&rsquo;t load claim.
          </div>
        )}

        {claimId !== null && !error && claim === null && (
          <span data-testid="client-claim-loading" className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">Loading…</span>
        )}

        {claimId !== null && !error && claim !== null && (
          <div ref={readyRef} tabIndex={-1} data-testid="client-claim-content" className="text-xs">
            <div className="flex gap-2">
              <span className="font-extrabold">Status</span>
              <span>{claim.status}</span>
            </div>
            <div className="flex gap-2">
              <span className="font-extrabold">Amount claimed</span>
              <span>{formatAmount(claim.amountClaimed, claim.currency)}</span>
            </div>
            <div className="flex gap-2">
              <span className="font-extrabold">Cumulative recovered</span>
              <span>{formatAmount(claim.cumulativeRecovered, claim.currency)}</span>
            </div>

            {claim.recoveryEvents.length === 0 && (
              <span role="status" data-testid="client-claim-recovery-events-empty" className="mt-2 block text-xs font-semibold text-[rgba(32,30,29,0.65)]">
                No recovery events recorded yet.
              </span>
            )}

            {claim.recoveryEvents.length > 0 && (
              <table data-testid="client-claim-recovery-events-table" className="mt-2 w-full text-xs">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-1 pr-2">Recovered</th>
                    <th className="py-1 pr-2">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {claim.recoveryEvents.map((event) => (
                    <tr key={event.id} data-testid="client-claim-recovery-event-row" className="border-t">
                      <td className="py-1 pr-2 tabular-nums">{formatAmount(event.amountRecovered, event.currency)}</td>
                      <td className="py-1 pr-2 tabular-nums">{formatDate(event.recordedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
