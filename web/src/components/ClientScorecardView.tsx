import { useEffect, useState } from 'react';
import { fetchClientPortalAuditRunScorecard, type ClientPortalAuditRunScorecard } from '../lib/api.js';

function formatAmount(value: string, currency: string | null): string {
  const n = Number(value);
  const formatted = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${formatted} ${currency}` : formatted;
}

/**
 * Client-facing single-audit-run scorecard (P6.B.1). Unwired to nav -- same
 * disclosure as PortfolioReport.tsx's own P5.C siblings: the portal UI
 * shell/nav that will mount this (and thread it a real auditRunId, e.g.
 * from a ClientInvoicesView row's own auditRunId) is a separate item's
 * boundary (P6.A.1).
 *
 * Takes auditRunId as a prop rather than self-fetching with no args --
 * unlike ClientRecoveryReport.tsx's single fixed per-client scope, a
 * scorecard is inherently per-run (GET /api/portal/scorecard/:auditRunId,
 * see get-client-audit-run-scorecard.ts's own header comment for why this
 * isn't a client-wide rollup). Still self-fetching on mount/prop-change,
 * same loading/error shape as the rest of this precedent.
 */
export function ClientScorecardView({ auditRunId }: { auditRunId: string }) {
  const [scorecard, setScorecard] = useState<ClientPortalAuditRunScorecard | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setScorecard(null);
    setError(false);
    fetchClientPortalAuditRunScorecard(auditRunId).then(
      (data) => { if (!cancelled) setScorecard(data); },
      () => { if (!cancelled) setError(true); },
    );
    return () => { cancelled = true; };
  }, [auditRunId]);

  return (
    <section data-testid="client-scorecard-view" className="border border-[rgba(32,30,29,.3)] bg-[#f3f2f2] p-3">
      <h2 className="mb-2 text-sm font-extrabold">Scorecard</h2>

      <div aria-live="polite" aria-busy={!error && scorecard === null} data-testid="client-scorecard-live-region">
        {error && (
          <span role="alert" data-testid="client-scorecard-error" className="text-xs font-semibold text-[#7c1405]">
            Couldn&rsquo;t load scorecard.
          </span>
        )}

        {!error && scorecard === null && (
          <span data-testid="client-scorecard-loading" className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">Loading…</span>
        )}

        {!error && scorecard !== null && scorecard.conformedCount === null && (
          <span role="status" data-testid="client-scorecard-empty" className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">
            No scorecard recorded for this audit run yet.
          </span>
        )}

        {!error && scorecard !== null && scorecard.conformedCount !== null && (
          <table data-testid="client-scorecard-table" className="w-full text-xs">
            <thead>
              <tr className="border-b text-left">
                <th className="py-1 pr-2">Invoice</th>
                <th className="py-1 pr-2">Conformed</th>
                <th className="py-1 pr-2">Variance</th>
                <th className="py-1 pr-2">Unassessable</th>
                <th className="py-1 pr-2">Overcharge</th>
                <th className="py-1 pr-2">Undercharge</th>
              </tr>
            </thead>
            <tbody>
              <tr data-testid="client-scorecard-row" className="border-t">
                <td className="py-1 pr-2 font-extrabold">{scorecard.invoiceNumber ?? '—'}</td>
                <td className="py-1 pr-2 tabular-nums">{scorecard.conformedCount}</td>
                <td className="py-1 pr-2 tabular-nums">{scorecard.varianceCount}</td>
                <td className="py-1 pr-2 tabular-nums">{scorecard.unassessableCount}</td>
                <td className="py-1 pr-2 tabular-nums">{formatAmount(scorecard.totalOvercharge!, scorecard.currency)}</td>
                <td className="py-1 pr-2 tabular-nums">{formatAmount(scorecard.totalUndercharge!, scorecard.currency)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
