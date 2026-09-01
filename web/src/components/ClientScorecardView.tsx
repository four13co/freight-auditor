import { useEffect, useState } from 'react';
import { fetchClientPortalScorecard, type ClientPortalScorecardBucket } from '../lib/api.js';

function formatAmount(value: string, currency: string | null): string {
  const n = Number(value);
  const formatted = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${formatted} ${currency}` : formatted;
}

/**
 * Client-facing scorecard summary (P6.B.1). Unwired to nav -- same
 * disclosure as PortfolioReport.tsx's own P5.C siblings: the portal UI
 * shell/nav that will mount this is a separate item's boundary (P6.A.1).
 *
 * Bucketed by currency, never blended (currency-safety, matching
 * get-client-scorecard-summary.ts's own header comment) -- a client billed
 * in multiple currencies sees one row per currency, not a single mixed
 * total.
 */
export function ClientScorecardView() {
  const [buckets, setBuckets] = useState<ClientPortalScorecardBucket[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchClientPortalScorecard().then(
      (data) => { if (!cancelled) setBuckets(data); },
      () => { if (!cancelled) setError(true); },
    );
    return () => { cancelled = true; };
  }, []);

  return (
    <section data-testid="client-scorecard-view" className="border border-[rgba(32,30,29,.3)] bg-[#f3f2f2] p-3">
      <h2 className="mb-2 text-sm font-extrabold">Scorecard</h2>

      {error && (
        <span data-testid="client-scorecard-error" className="text-xs font-semibold text-[#7c1405]">
          Couldn&rsquo;t load scorecard.
        </span>
      )}

      {!error && buckets === null && (
        <span className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">Loading…</span>
      )}

      {!error && buckets !== null && buckets.length === 0 && (
        <span data-testid="client-scorecard-empty" className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">
          No audit runs recorded yet.
        </span>
      )}

      {!error && buckets !== null && buckets.length > 0 && (
        <table data-testid="client-scorecard-table" className="w-full text-xs">
          <thead>
            <tr className="border-b text-left">
              <th className="py-1 pr-2">Currency</th>
              <th className="py-1 pr-2">Runs</th>
              <th className="py-1 pr-2">Conformed</th>
              <th className="py-1 pr-2">Variance</th>
              <th className="py-1 pr-2">Unassessable</th>
              <th className="py-1 pr-2">Overcharge</th>
              <th className="py-1 pr-2">Undercharge</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.currency ?? ''} data-testid="client-scorecard-row" className="border-t">
                <td className="py-1 pr-2 font-extrabold">{b.currency ?? '—'}</td>
                <td className="py-1 pr-2 tabular-nums">{b.runCount}</td>
                <td className="py-1 pr-2 tabular-nums">{b.conformedCount}</td>
                <td className="py-1 pr-2 tabular-nums">{b.varianceCount}</td>
                <td className="py-1 pr-2 tabular-nums">{b.unassessableCount}</td>
                <td className="py-1 pr-2 tabular-nums">{formatAmount(b.totalOvercharge, b.currency)}</td>
                <td className="py-1 pr-2 tabular-nums">{formatAmount(b.totalUndercharge, b.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
