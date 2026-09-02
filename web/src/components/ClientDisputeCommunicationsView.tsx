import { useEffect, useState } from 'react';
import { fetchClientPortalDisputeCommunications, type ClientPortalDisputeCommRow } from '../lib/api.js';

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Client-facing dispute communication log (P6.B.3), newest-first (matching
 * listClientDisputeCommunications' own order). Unwired to nav -- same
 * disclosure as ClientFindingEvidenceView.tsx's own P6.B.2 precedent.
 *
 * Takes a nullable `disputeId` prop for the same reason as
 * ClientDisputeDetailView.tsx -- "no dispute selected yet" is its own
 * explicit empty state, distinct from "dispute selected but has zero
 * communications yet" (also an explicit empty state, per AC4, but reached
 * only after a real fetch).
 */
export function ClientDisputeCommunicationsView({ disputeId }: { disputeId: string | null }) {
  const [comms, setComms] = useState<ClientPortalDisputeCommRow[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (disputeId === null) {
      setComms(null);
      setError(false);
      return;
    }
    let cancelled = false;
    setComms(null);
    setError(false);
    fetchClientPortalDisputeCommunications(disputeId).then(
      (data) => { if (!cancelled) setComms(data); },
      () => { if (!cancelled) setError(true); },
    );
    return () => { cancelled = true; };
  }, [disputeId]);

  return (
    <section data-testid="client-dispute-communications-view" className="border border-[rgba(32,30,29,.3)] bg-[#f3f2f2] p-3">
      <h2 className="mb-2 text-sm font-extrabold">Communications</h2>

      {disputeId === null && (
        <span data-testid="client-dispute-communications-not-selected" className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">
          Select a dispute to view its communications.
        </span>
      )}

      {disputeId !== null && error && (
        <span data-testid="client-dispute-communications-error" className="text-xs font-semibold text-[#7c1405]">
          Couldn&rsquo;t load communications.
        </span>
      )}

      {disputeId !== null && !error && comms === null && (
        <span className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">Loading…</span>
      )}

      {disputeId !== null && !error && comms !== null && comms.length === 0 && (
        <span data-testid="client-dispute-communications-empty" className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">
          No communications recorded yet.
        </span>
      )}

      {disputeId !== null && !error && comms !== null && comms.length > 0 && (
        <table data-testid="client-dispute-communications-table" className="w-full text-xs">
          <thead>
            <tr className="border-b text-left">
              <th className="py-1 pr-2">Direction</th>
              <th className="py-1 pr-2">Message</th>
              <th className="py-1 pr-2">Date</th>
            </tr>
          </thead>
          <tbody>
            {comms.map((c) => (
              <tr key={c.id} data-testid="client-dispute-communications-row" className="border-t">
                <td className="py-1 pr-2">{c.direction}</td>
                <td className="py-1 pr-2">{c.body ?? '—'}</td>
                <td className="py-1 pr-2 tabular-nums">{formatDate(c.recordedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
