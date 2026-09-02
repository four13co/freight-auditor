import { useEffect, useState } from 'react';
import { fetchClientRecoveryReport, type ClientRecoveryReportBucket } from '../lib/api.js';

function formatAmount(value: string, currency: string | null): string {
  const n = Number(value);
  const formatted = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${formatted} ${currency}` : formatted;
}

/**
 * Client-level recovery reporting (P5.C.2): the single-tenant analog of
 * PortfolioReport.tsx (P5.C.3). Unwired to nav -- same disclosure as its
 * P5.C siblings: the reporting UI shell/nav is a separate item's boundary.
 *
 * Self-fetching (mount-only, no props), mirroring PortfolioReport.tsx's
 * own shape exactly, minus the per-client column since this report is
 * already scoped to one tenant.
 */
export function ClientRecoveryReport() {
  const [buckets, setBuckets] = useState<ClientRecoveryReportBucket[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchClientRecoveryReport().then(
      (data) => { if (!cancelled) setBuckets(data); },
      () => { if (!cancelled) setError(true); },
    );
    return () => { cancelled = true; };
  }, []);

  return (
    <section data-testid="client-recovery-report" className="border border-[rgba(32,30,29,.3)] bg-[#f3f2f2] p-3">
      <h2 className="mb-2 text-sm font-extrabold">Recovery report</h2>

      {error && (
        <span data-testid="client-recovery-report-error" className="text-xs font-semibold text-[#7c1405]">
          Couldn&rsquo;t load recovery report.
        </span>
      )}

      {!error && buckets === null && (
        <span className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">Loading…</span>
      )}

      {!error && buckets !== null && buckets.length === 0 && (
        <span data-testid="client-recovery-report-empty" className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">
          No claims recorded yet.
        </span>
      )}

      {!error && buckets !== null && buckets.length > 0 && (
        <table data-testid="client-recovery-report-table" className="w-full text-xs">
          <thead>
            <tr className="border-b text-left">
              <th className="py-1 pr-2">Currency</th>
              <th className="py-1 pr-2">Claimed</th>
              <th className="py-1 pr-2">Recovered</th>
              <th className="py-1 pr-2">Outstanding</th>
              <th className="py-1 pr-2">Written off</th>
              <th className="py-1 pr-2">Denied</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.currency ?? ''} data-testid="client-recovery-report-row" className="border-t">
                <td className="py-1 pr-2 font-extrabold">{b.currency ?? '—'}</td>
                <td className="py-1 pr-2 tabular-nums">{formatAmount(b.claimed, b.currency)}</td>
                <td className="py-1 pr-2 tabular-nums">{formatAmount(b.recovered, b.currency)}</td>
                <td className="py-1 pr-2 tabular-nums">{formatAmount(b.outstanding, b.currency)}</td>
                <td className="py-1 pr-2 tabular-nums">{formatAmount(b.writtenOff, b.currency)}</td>
                <td className="py-1 pr-2 tabular-nums">{formatAmount(b.denied, b.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
