import { useCallback, useEffect, useState } from 'react';
import { FindingsTable } from './FindingsTable.js';
import {
  fetchFindings,
  type FindingRow,
  type FindingsSortDir,
  type FindingsSortKey,
} from '../lib/api.js';

type LoadStatus = 'loading' | 'error' | 'ready';

/**
 * 86e37r2rm: dedicated full-page view for the /discrepancies route -- reuses
 * fetchFindings + FindingsTable exactly as Dashboard.tsx's own "/" route
 * does (same carrier/status/min-amount filters, same variance/age sort, no
 * new backend endpoint), just without the KPI row, queues, or
 * extraction-review/contract-preview panels that only belong on "/".
 * fetchFindingsSummary is deliberately not called here: nothing on this
 * page renders a KPI row, so there's no summary value to show.
 */
export function DiscrepanciesView() {
  const [rows, setRows] = useState<FindingRow[]>([]);
  const [carrierFilter, setCarrierFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [minAmountFilter, setMinAmountFilter] = useState('');
  const [sort, setSort] = useState<{ key: FindingsSortKey; dir: FindingsSortDir } | null>(null);
  const [status, setStatus] = useState<LoadStatus>('loading');

  const load = useCallback(() => {
    setStatus('loading');
    fetchFindings({
      carrier: carrierFilter || undefined,
      status: statusFilter || undefined,
      minAmount: minAmountFilter || undefined,
      sort: sort?.key,
      sortDir: sort?.dir,
    }).then(
      (rowsResult) => {
        setRows(rowsResult);
        setStatus('ready');
      },
      () => {
        setStatus('error');
      },
    );
  }, [carrierFilter, statusFilter, minAmountFilter, sort]);

  function toggleSort(key: FindingsSortKey) {
    setSort((prev) => {
      if (prev?.key === key) return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
      return { key, dir: 'asc' };
    });
  }

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
      {status === 'loading' && (
        <div data-testid="discrepancies-loading" className="flex flex-1 items-center justify-center text-sm text-[rgba(32,30,29,0.6)]">
          Loading…
        </div>
      )}
      {status === 'error' && (
        <div
          data-testid="discrepancies-error"
          className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-[rgba(32,30,29,0.75)]"
        >
          <span>Something went wrong loading discrepancies.</span>
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
        <FindingsTable
          rows={rows}
          carrierFilter={carrierFilter}
          statusFilter={statusFilter}
          minAmountFilter={minAmountFilter}
          onCarrierFilterChange={setCarrierFilter}
          onStatusFilterChange={setStatusFilter}
          onMinAmountFilterChange={setMinAmountFilter}
          onRowStatusChange={(id, newStatus) =>
            setRows((prev) => prev.map((r) => (r.id === id ? { ...r, status: newStatus } : r)))
          }
          sort={sort}
          onSortChange={toggleSort}
        />
      )}
    </div>
  );
}
