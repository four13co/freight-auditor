import { useEffect, useState } from 'react';
import { fetchRecoveryReport, type RecoveryReportBucket } from '../lib/api.js';
import { formatMoney } from '../lib/format.js';

/**
 * Client-facing recovery report (P5.C.2): the tenant's own view of their
 * overall claimed/recovered/outstanding/written-off/denied position, one
 * row per currency. Self-fetching on mount, following FindingDetail.tsx's
 * pattern -- no parent-provided data, since this is a standalone summary
 * view rather than a per-entity drawer.
 */
export function RecoveryReport() {
  const [buckets, setBuckets] = useState<RecoveryReportBucket[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchRecoveryReport().then(
      (data) => { if (!cancelled) setBuckets(data); },
      () => { if (!cancelled) setError(true); },
    );
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return (
      <div data-testid="recovery-report" className="p-5">
        <span className="text-xs font-semibold text-[#7c1405]">Couldn&rsquo;t load recovery report.</span>
      </div>
    );
  }

  if (buckets === null) {
    return (
      <div data-testid="recovery-report" className="p-5">
        <span className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">Loading…</span>
      </div>
    );
  }

  if (buckets.length === 0) {
    return (
      <div data-testid="recovery-report" className="p-5">
        <span className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">No claims yet.</span>
      </div>
    );
  }

  return (
    <div data-testid="recovery-report" className="flex flex-col gap-3 p-5">
      {buckets.map((bucket) => (
        <div
          key={bucket.currency ?? 'unknown'}
          data-testid="recovery-report-bucket"
          className="grid grid-cols-3 gap-2 border border-[rgba(32,30,29,0.3)] p-3 text-center text-xs"
        >
          <div className="col-span-3 text-left text-[11px] font-extrabold uppercase tracking-[0.08em] text-[rgba(32,30,29,0.55)]">
            {bucket.currency ?? 'Unknown currency'}
            {!bucket.reconciles && (
              <span data-testid="reconciliation-warning" className="ml-2 text-[#7c1405]">
                Does not reconcile
              </span>
            )}
          </div>
          <div><strong>{formatMoney(bucket.claimed)}</strong><br />Claimed</div>
          <div><strong>{formatMoney(bucket.recovered)}</strong><br />Recovered</div>
          <div><strong>{formatMoney(bucket.outstanding)}</strong><br />Outstanding</div>
          <div><strong>{formatMoney(bucket.writtenOff)}</strong><br />Written off</div>
          <div><strong>{formatMoney(bucket.denied)}</strong><br />Denied</div>
        </div>
      ))}
    </div>
  );
}
