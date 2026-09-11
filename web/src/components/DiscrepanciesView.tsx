import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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
 *
 * 86e37r2t8: carrier/minAmount also seed from the URL's query string on
 * mount -- the "Mine, over $500" sidebar saved view is a plain link to
 * /discrepancies?assignee=me&minAmount=500 (no client-side state passed
 * between components), so this is the only place that link's query string
 * can be read back into actual filter state. `assignee` itself is fixed
 * ("me" or absent, per this item's own Rabbit holes -- self-assign/unassign
 * only, no arbitrary-user filtering), read once and never exposed to
 * FindingsTable's controlled filter UI, unlike carrier/minAmount which stay
 * editable afterward.
 *
 * 86e37r2t6/86e37r2t7: carrier/minAgeDays/category also seed from the URL's
 * query string on mount -- the "Aging > 5 days" and "Estes accessorials"
 * sidebar saved views are plain links to /discrepancies?... (no client-side
 * state passed between components), so this is the only place that link's
 * query string can be read back into an actual filter. Fixed presets, not
 * user-editable (per each item's own Rabbit holes), so minAgeDays/category
 * are read once and never exposed to FindingsTable's controlled filter UI.
 */
export function DiscrepanciesView() {
  const [searchParams] = useSearchParams();
  const [rows, setRows] = useState<FindingRow[]>([]);
  const [carrierFilter, setCarrierFilter] = useState(() => searchParams.get('carrier') ?? '');
  const [statusFilter, setStatusFilter] = useState('');
  const [minAmountFilter, setMinAmountFilter] = useState(() => searchParams.get('minAmount') ?? '');
  const [assignedToMe] = useState(() => searchParams.get('assignee') === 'me');
  const [minAgeDaysFilter] = useState(() => {
    const raw = searchParams.get('minAgeDays');
    return raw ? Number(raw) : undefined;
  });
  const [categoryFilter] = useState(() => searchParams.get('category') ?? '');
  const [sort, setSort] = useState<{ key: FindingsSortKey; dir: FindingsSortDir } | null>(null);
  const [status, setStatus] = useState<LoadStatus>('loading');

  const load = useCallback(() => {
    setStatus('loading');
    fetchFindings({
      carrier: carrierFilter || undefined,
      status: statusFilter || undefined,
      minAmount: minAmountFilter || undefined,
      assignee: assignedToMe ? 'me' : undefined,
      minAgeDays: minAgeDaysFilter,
      category: categoryFilter || undefined,
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
  }, [carrierFilter, statusFilter, minAmountFilter, assignedToMe, minAgeDaysFilter, categoryFilter, sort]);

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
          onRowAssignChange={(id, assignedToUserId) =>
            setRows((prev) => prev.map((r) => (r.id === id ? { ...r, assignedToUserId } : r)))
          }
          sort={sort}
          onSortChange={toggleSort}
        />
      )}
    </div>
  );
}
