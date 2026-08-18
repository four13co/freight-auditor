import { useMemo, useState } from 'react';
import type { FindingRow, FindingsSortDir, FindingsSortKey } from '../lib/api.js';
import { formatMoney, formatVariance, formatAge } from '../lib/format.js';
import { getStatusDisplay } from '../lib/status-display.js';
import { FindingDetail } from './FindingDetail.js';
import { WRITABLE_VARIANCE_STATUSES } from '../../../src/shared/variance-status.js';

// 86e2v892h: values derive from the shared source (matches app.ts's
// WRITABLE_STATUS_VALUES and FindingDetail.tsx's WRITABLE_STATUSES) so the
// three can't silently drift apart. Labels stay hand-written here -- they
// don't match a mechanical title-case of the raw value (e.g. "In review",
// not "In Review"), so deriving them would change visible UI text.
const STATUS_FILTER_LABELS: Record<(typeof WRITABLE_VARIANCE_STATUSES)[number], string> = {
  open: 'Open',
  in_review: 'In review',
  queued_for_dispute: 'Queued for dispute',
  disputed: 'Disputed',
  closed: 'Closed',
};

interface FindingsTableProps {
  rows: FindingRow[];
  carrierFilter: string;
  statusFilter: string;
  minAmountFilter: string;
  onCarrierFilterChange: (value: string) => void;
  onStatusFilterChange: (value: string) => void;
  onMinAmountFilterChange: (value: string) => void;
  /** 86e2v1xyr: bubbled up from the drawer after a successful status PATCH, so the caller (Dashboard) can patch its own row list without a full refetch. */
  onRowStatusChange?: (id: string, status: string) => void;
  // 86e2v251e: sort is now server-driven (Dashboard.tsx owns the state and
  // re-fetches) -- `rows` arrives pre-sorted, so this component only needs
  // the current sort (to render the ↑/↓ arrow) and a callback for clicks,
  // not the sort logic itself.
  sort: { key: FindingsSortKey; dir: FindingsSortDir } | null;
  onSortChange: (key: FindingsSortKey) => void;
}

// The mockup's table has 9 columns including "Finding" (a rule description,
// e.g. "Duplicate invoice for the same PRO") and "lane" (part of "Carrier /
// lane"). "lane" is still omitted: list-findings.ts's own comment says it
// was deliberately left out (transport_document.document's jsonb path for
// it is undocumented) -- no ETA on that one. "Finding" is now populated by
// FindingRow.ruleDescription (86e2up8c8 AC1, PR #54), rendered here as its
// own column matching the mockup's placement exactly: right after Invoice,
// flexible width (1fr in the mockup) so it absorbs the row's remaining
// space rather than a fixed px like the other columns. Age fills the slot
// the mockup gives "lane" alongside Carrier, since createdAt is available
// and the mockup shows an age-like value there too.
const COLUMNS = '36px 106px 1fr 138px 96px 96px 104px 88px 104px';

export function FindingsTable({
  rows,
  carrierFilter,
  statusFilter,
  minAmountFilter,
  onCarrierFilterChange,
  onStatusFilterChange,
  onMinAmountFilterChange,
  onRowStatusChange,
  sort,
  onSortChange,
}: FindingsTableProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailRow, setDetailRow] = useState<FindingRow | null>(null);
  // 86e2uuw7t: named so a future filter dimension has one obvious place to
  // extend rather than an inline condition that's easy to leave stale after
  // a disjoint-file merge. 86e2uv490 is exactly that: minAmountFilter (added
  // by 86e2uuw7k) was missing here, so a tenant with only min-amount set and
  // zero matching rows saw "No findings yet." instead of the filtered
  // message -- the same bug this boolean exists to prevent, one dimension over.
  const hasActiveFilter = carrierFilter !== '' || statusFilter !== '' || minAmountFilter !== '';

  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  const selectedTotal = useMemo(
    () => selectedRows.reduce((sum, r) => sum + (r.varianceAmount ? Number(r.varianceAmount) : 0), 0),
    [selectedRows],
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden border border-[rgba(32,30,29,0.4)] bg-[#f3f2f2] shadow-[0_1px_2px_rgba(45,43,43,0.14)]">
      <div className="flex items-center gap-3 border-b-2 border-[rgba(32,30,29,0.4)] px-5 py-3.5">
        <span className="text-xl font-extrabold tracking-[-0.015em] text-[#201e1d]">Worth a look first</span>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex h-[30px] items-center gap-1.5 border border-[rgba(32,30,29,0.4)] px-2.5 text-xs text-[#201e1d]">
            Carrier:
            <input
              aria-label="Carrier filter"
              value={carrierFilter}
              onChange={(e) => onCarrierFilterChange(e.target.value)}
              placeholder="All"
              className="w-20 bg-transparent outline-none placeholder:text-[rgba(32,30,29,0.5)]"
            />
          </label>
          <label className="flex h-[30px] items-center gap-1.5 border border-[rgba(32,30,29,0.4)] px-2.5 text-xs text-[#201e1d]">
            Status:
            <select
              aria-label="Status filter"
              value={statusFilter}
              onChange={(e) => onStatusFilterChange(e.target.value)}
              className="bg-transparent outline-none"
            >
              <option value="">All</option>
              {WRITABLE_VARIANCE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {STATUS_FILTER_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex h-[30px] items-center gap-1.5 border border-[rgba(32,30,29,0.4)] px-2.5 text-xs text-[#201e1d]">
            Min amount:
            <input
              type="number"
              inputMode="decimal"
              aria-label="Minimum amount filter"
              value={minAmountFilter}
              onChange={(e) => onMinAmountFilterChange(e.target.value)}
              placeholder="Any"
              className="w-16 bg-transparent outline-none placeholder:text-[rgba(32,30,29,0.5)]"
            />
          </label>
        </div>
      </div>

      {selectedRows.length > 0 && (
        <div className="flex items-center gap-3.5 border-b border-[rgba(32,30,29,0.2)] bg-[#ffe0d9] px-5 py-2.5">
          <span className="text-[13px] font-extrabold text-[#7c1405]">
            {/* 86e2v250p: selected.size (the raw Set) doesn't shrink when a
                filter change removes a selected row from `rows` -- only
                selectedRows (rows re-filtered against the current `rows`
                prop, same derivation selectedTotal already uses) stays in
                sync with what's actually still selected AND visible. */}
            {selectedRows.length} selected · {formatMoney(selectedTotal.toFixed(4))}
          </span>
          <div className="ml-auto flex gap-2">
            {/* Bulk actions have no backing write endpoint yet (86e2u7j1y No-gos) --
                visible per the design, disabled with a "coming soon" affordance. */}
            <button
              type="button"
              disabled
              title="Coming soon"
              className="flex h-[30px] cursor-not-allowed items-center bg-[#ec3013] px-3 text-[13px] font-extrabold text-[#f3f2f2] opacity-60"
            >
              Open disputes
            </button>
            <button
              type="button"
              disabled
              title="Coming soon"
              className="flex h-[30px] cursor-not-allowed items-center border border-[rgba(32,30,29,0.4)] px-3 text-[13px] font-extrabold text-[#201e1d] opacity-60"
            >
              Assign
            </button>
            <button
              type="button"
              disabled
              title="Coming soon"
              className="flex h-[30px] cursor-not-allowed items-center border border-[rgba(32,30,29,0.4)] px-3 text-[13px] font-extrabold text-[#201e1d] opacity-60"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div
        className="grid h-9 flex-none items-center gap-0 border-b-2 border-[rgba(32,30,29,0.4)] bg-[#eae9e9] px-5 text-[11px] font-extrabold uppercase tracking-[0.08em] text-[rgba(32,30,29,0.55)]"
        style={{ gridTemplateColumns: COLUMNS }}
      >
        <div />
        <div>Invoice</div>
        <div>Finding</div>
        <div>Carrier</div>
        <div className="text-right">Billed</div>
        <div className="text-right">Expected</div>
        <button
          type="button"
          onClick={() => onSortChange('variance')}
          className="text-right font-extrabold uppercase tracking-[0.08em] text-[rgba(32,30,29,0.55)]"
        >
          Variance{sort?.key === 'variance' ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
        </button>
        <button
          type="button"
          onClick={() => onSortChange('age')}
          className="text-right font-extrabold uppercase tracking-[0.08em] text-[rgba(32,30,29,0.55)]"
        >
          Age{sort?.key === 'age' ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
        </button>
        <div className="text-right">Status</div>
      </div>

      <div className="flex-1 overflow-auto" data-testid="findings-rows" aria-label="Findings">
        {rows.length === 0 ? (
          hasActiveFilter ? (
            <div className="px-5 py-8 text-center text-sm text-[rgba(32,30,29,0.55)]">No findings match these filters.</div>
          ) : (
            <div data-testid="empty-no-findings-yet" className="px-5 py-8 text-center text-sm text-[rgba(32,30,29,0.55)]">
              No findings yet.
            </div>
          )
        ) : (
          rows.map((row) => {
            const display = getStatusDisplay(row);
            return (
              <div
                key={row.id}
                data-testid="finding-row"
                onClick={() => setDetailRow(row)}
                className="grid cursor-pointer items-center gap-0 border-b border-[rgba(32,30,29,0.14)] px-5 py-2.5"
                style={{ gridTemplateColumns: COLUMNS }}
              >
                <div>
                  <input
                    type="checkbox"
                    aria-label={`Select finding ${row.invoiceNumber ?? row.id}`}
                    checked={selected.has(row.id)}
                    onChange={() => toggle(row.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="h-3.5 w-3.5"
                  />
                </div>
                <div className="text-[13px] font-semibold tabular-nums text-[#201e1d]">{row.invoiceNumber ?? '—'}</div>
                <div className="pr-4 text-[14px] font-semibold tracking-[-0.005em] text-[#201e1d]">
                  {row.ruleDescription ?? '—'}
                </div>
                <div className="text-[13px] text-[#201e1d]">{row.carrierName ?? '—'}</div>
                <div className="text-right text-[13px] tabular-nums text-[#201e1d]">{formatMoney(row.billed)}</div>
                <div className="text-right text-[13px] tabular-nums text-[rgba(32,30,29,0.6)]">
                  {formatMoney(row.expected)}
                </div>
                <div className="text-right text-sm font-extrabold tabular-nums text-[#201e1d]">
                  {formatVariance(row.varianceAmount)}
                </div>
                <div className="text-right text-xs tabular-nums text-[rgba(32,30,29,0.6)]">{formatAge(row.createdAt)}</div>
                <div className="flex justify-end">
                  <span
                    className="px-1.5 py-0.5 text-[11px] font-extrabold uppercase tracking-[0.04em]"
                    style={{ background: display.tagBg, color: display.tagFg }}
                  >
                    {display.label}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
      {detailRow && (
        <FindingDetail
          row={detailRow}
          onClose={() => setDetailRow(null)}
          onStatusChange={(id, status) => {
            setDetailRow((prev) => (prev && prev.id === id ? { ...prev, status } : prev));
            onRowStatusChange?.(id, status);
          }}
        />
      )}
    </div>
  );
}
