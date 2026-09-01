import { useEffect, useState } from 'react';
import { fetchCrossClientPortfolioReport, type ClientPortfolioBucketRow } from '../lib/api.js';
import { formatMoney } from '../lib/format.js';

/**
 * Cross-client portfolio reporting (P5.C.3): an internal analyst's
 * claimed/recovered/outstanding/written-off/denied view across EVERY
 * client, bucketed by (client, currency) -- the analyst sibling of
 * PaymentApprovalQueue.tsx (a props-driven queue) and DisputeReview.tsx
 * (self-fetching on mount); this borrows the self-fetching shape since,
 * like a dispute drawer, there's no parent list to hand it rows.
 *
 * The API 403s any non-internal caller (registerInternalAnalystAuthPreHandler,
 * tenant-auth.ts) -- that failure surfaces through the same `error` state as
 * any other fetch failure, deliberately not distinguished in the UI: an
 * analyst reaching this view is assumed authorized, and a 403 here signals a
 * backend/session problem, not a normal "try a different filter" case.
 *
 * Unwired to any dashboard/nav route, same disclosure as RecoveryReport.tsx
 * (#246) and ClaimDetail.tsx/DisputeReview.tsx before it -- portal/dashboard
 * navigation wiring is P6 scope, not this task's.
 */
export function PortfolioReport() {
  const [buckets, setBuckets] = useState<ClientPortfolioBucketRow[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchCrossClientPortfolioReport().then(
      (data) => { if (!cancelled) setBuckets(data); },
      () => { if (!cancelled) setError(true); },
    );
    return () => { cancelled = true; };
  }, []);

  return (
    <section data-testid="portfolio-report" className="border border-[rgba(32,30,29,.3)] bg-[#f3f2f2] p-3">
      <h2 className="mb-2 text-sm font-extrabold">Portfolio recovery, by client</h2>

      {error && (
        <span className="text-xs font-semibold text-[#7c1405]">Couldn&rsquo;t load the portfolio report.</span>
      )}

      {!error && buckets === null && (
        <span className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">Loading…</span>
      )}

      {!error && buckets !== null && buckets.length === 0 && (
        <span className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">No claims across any client yet.</span>
      )}

      {!error && buckets !== null && buckets.length > 0 && (
        <table data-testid="portfolio-report-table" className="w-full text-xs">
          <thead>
            <tr className="text-left text-[11px] font-extrabold uppercase tracking-[0.08em] text-[rgba(32,30,29,0.55)]">
              <th className="py-1 pr-2">Client</th>
              <th className="py-1 pr-2">Currency</th>
              <th className="py-1 pr-2">Claimed</th>
              <th className="py-1 pr-2">Recovered</th>
              <th className="py-1 pr-2">Outstanding</th>
              <th className="py-1 pr-2">Written off</th>
              <th className="py-1 pr-2">Denied</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket) => (
              <tr
                key={`${bucket.clientId}::${bucket.currency ?? ''}`}
                data-testid="portfolio-report-row"
                className="border-t"
              >
                <td className="py-1 pr-2 font-extrabold">{bucket.clientName}</td>
                <td className="py-1 pr-2">{bucket.currency ?? '—'}</td>
                <td className="py-1 pr-2 tabular-nums">{formatMoney(bucket.claimed)}</td>
                <td className="py-1 pr-2 tabular-nums">{formatMoney(bucket.recovered)}</td>
                <td className="py-1 pr-2 tabular-nums">{formatMoney(bucket.outstanding)}</td>
                <td className="py-1 pr-2 tabular-nums">{formatMoney(bucket.writtenOff)}</td>
                <td className="py-1 pr-2 tabular-nums">{formatMoney(bucket.denied)}</td>
                {!bucket.reconciles && (
                  <td className="py-1 pr-2 font-extrabold text-[#7c1405]" title="Reported totals for this bucket do not reconcile">
                    ⚠
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
