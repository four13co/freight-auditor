import { useEffect, useState } from 'react';
import { fetchClientPortalDispute, type ClientPortalDisputeDetail } from '../lib/api.js';

function formatAmount(value: string | null, currency: string | null): string {
  if (value === null) return '—';
  const n = Number(value);
  const formatted = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${formatted} ${currency}` : formatted;
}

/**
 * Client-facing dispute detail (P6.B.3). Unwired to nav -- same disclosure
 * as ClientFindingEvidenceView.tsx's own P6.B.2 precedent.
 *
 * Takes a nullable `disputeId` prop, same reasoning as
 * ClientFindingEvidenceView.tsx: this view is meant to be driven by a row
 * selected elsewhere in the portal (a future dispute list/nav-wiring task),
 * so "no dispute selected yet" is AC4's own explicit empty state, distinct
 * from loading/error.
 */
export function ClientDisputeDetailView({ disputeId }: { disputeId: string | null }) {
  const [dispute, setDispute] = useState<ClientPortalDisputeDetail | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (disputeId === null) {
      setDispute(null);
      setError(false);
      return;
    }
    let cancelled = false;
    setDispute(null);
    setError(false);
    fetchClientPortalDispute(disputeId).then(
      (data) => { if (!cancelled) setDispute(data); },
      () => { if (!cancelled) setError(true); },
    );
    return () => { cancelled = true; };
  }, [disputeId]);

  return (
    <section data-testid="client-dispute-detail-view" className="border border-[rgba(32,30,29,.3)] bg-[#f3f2f2] p-3">
      <h2 className="mb-2 text-sm font-extrabold">Dispute</h2>

      {disputeId === null && (
        <span data-testid="client-dispute-detail-empty" className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">
          Select a dispute to view its detail.
        </span>
      )}

      {disputeId !== null && error && (
        <span data-testid="client-dispute-detail-error" className="text-xs font-semibold text-[#7c1405]">
          Couldn&rsquo;t load dispute.
        </span>
      )}

      {disputeId !== null && !error && dispute === null && (
        <span className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">Loading…</span>
      )}

      {disputeId !== null && !error && dispute !== null && (
        <div data-testid="client-dispute-detail-content" className="text-xs">
          <div className="flex gap-2">
            <span className="font-extrabold">Status</span>
            <span>{dispute.status}</span>
          </div>
          <div className="flex gap-2">
            <span className="font-extrabold">Amount claimed</span>
            <span>{formatAmount(dispute.amountClaimed, dispute.currency)}</span>
          </div>
          {dispute.lines.length === 0 && (
            <span data-testid="client-dispute-detail-lines-empty" className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">
              No lines recorded yet.
            </span>
          )}
          {dispute.lines.length > 0 && (
            <table data-testid="client-dispute-detail-lines" className="mt-2 w-full text-xs">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-1 pr-2">Line</th>
                  <th className="py-1 pr-2">Amount</th>
                </tr>
              </thead>
              <tbody>
                {dispute.lines.map((line) => (
                  <tr key={line.id} data-testid="client-dispute-detail-line-row" className="border-t">
                    <td className="py-1 pr-2">{line.id}</td>
                    <td className="py-1 pr-2 tabular-nums">{formatAmount(line.amount, line.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
