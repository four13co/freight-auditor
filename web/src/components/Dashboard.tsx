import { useCallback, useEffect, useState } from 'react';
import { Sidebar } from './Sidebar.js';
import { Header } from './Header.js';
import { KpiRow } from './KpiRow.js';
import { FindingsTable } from './FindingsTable.js';
import { fetchFindings, fetchFindingsSummary, type FindingRow, type FindingsSummary } from '../lib/api.js';

/**
 * A single combined status for both fetches (86e2urn2t) -- the item allows
 * either per-fetch or combined state, and combined is simpler at this
 * appetite. Both fetches previously discarded their errors silently
 * (.catch(() => setX(defaultValue))), which made a failed request render
 * pixel-identical to a genuinely empty tenant -- FindingsTable's own empty
 * state ("No findings match these filters.") is correct for the latter and
 * stays untouched; this only changes what Dashboard shows BEFORE reaching
 * that point.
 */
type LoadStatus = 'loading' | 'error' | 'ready';

export function Dashboard() {
  const [summary, setSummary] = useState<FindingsSummary | null>(null);
  const [rows, setRows] = useState<FindingRow[]>([]);
  const [carrierFilter, setCarrierFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [status, setStatus] = useState<LoadStatus>('loading');

  const load = useCallback(() => {
    setStatus('loading');
    Promise.all([
      fetchFindingsSummary(),
      fetchFindings({ carrier: carrierFilter || undefined, status: statusFilter || undefined }),
    ]).then(
      ([summaryResult, rowsResult]) => {
        setSummary(summaryResult);
        setRows(rowsResult);
        setStatus('ready');
      },
      () => {
        setStatus('error');
      },
    );
  }, [carrierFilter, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex h-screen w-full bg-[#eae9e9] text-[#201e1d]">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header />
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-6">
          {status === 'loading' && (
            <div data-testid="dashboard-loading" className="flex flex-1 items-center justify-center text-sm text-[rgba(32,30,29,0.6)]">
              Loading…
            </div>
          )}
          {status === 'error' && (
            <div
              data-testid="dashboard-error"
              className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-[rgba(32,30,29,0.75)]"
            >
              <span>Something went wrong loading the dashboard.</span>
              <button
                type="button"
                onClick={load}
                className="h-9 border border-[rgba(32,30,29,0.4)] px-4 text-[13px] font-extrabold"
              >
                Retry
              </button>
            </div>
          )}
          {status === 'ready' && (
            <>
              {summary && <KpiRow summary={summary} />}
              <FindingsTable
                rows={rows}
                carrierFilter={carrierFilter}
                statusFilter={statusFilter}
                onCarrierFilterChange={setCarrierFilter}
                onStatusFilterChange={setStatusFilter}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
