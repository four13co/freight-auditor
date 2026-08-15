import { useMemo, useState } from 'react';
import type { FindingRow } from '../lib/api.js';
import { formatMoney, formatVariance, formatAge } from '../lib/format.js';
import { getStatusDisplay } from '../lib/status-display.js';
import { FindingDetail } from './FindingDetail.js';

interface FindingsTableProps {
  rows: FindingRow[];
  carrierFilter: string;
  statusFilter: string;
  onCarrierFilterChange: (value: string) => void;
  onStatusFilterChange: (value: string) => void;
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
  onCarrierFilterChange,
  onStatusFilterChange,
}: FindingsTableProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailRow, setDetailRow] = useState<FindingRow | null>(null);
  const [sort, setSort] = useState<{ key: 'variance' | 'age'; dir: 'asc' | 'desc' } | null>(null);

  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  const selectedTotal = useMemo(
    () => selectedRows.reduce((sum, r) => sum + (r.varianceAmount ? Number(r.varianceAmount) : 0), 0),
    [selectedRows],
  );

  // 86e2uuw63: money fields are decimal-precision strings -- Number(...) for
  // numeric comparison, never the default lexicographic Array.sort (same
  // defect class PR #43 flagged for a different field). createdAt is
  // ISO-8601 so a plain string compare is already chronological. Nulls
  // (varianceAmount is nullable on FindingRow) always sort last, in either
  // direction, so their position doesn't flip when the arrow is clicked.
  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const dirMult = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sort.key === 'variance') {
        if (a.varianceAmount === null && b.varianceAmount === null) return 0;
        if (a.varianceAmount === null) return 1;
        if (b.varianceAmount === null) return -1;
        return (Number(a.varianceAmount) - Number(b.varianceAmount)) * dirMult;
      }
      return a.createdAt < b.createdAt ? -1 * dirMult : a.createdAt > b.createdAt ? 1 * dirMult : 0;
    });
  }, [rows, sort]);

  function toggleSort(key: 'variance' | 'age') {
    setSort((prev) => {
      if (prev?.key === key) return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
      return { key, dir: 'asc' };
    });
  }

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
              <option value="open">Open</option>
              <option value="in_review">In review</option>
              <option value="queued_for_dispute">Queued for dispute</option>
              <option value="disputed">Disputed</option>
              <option value="closed">Closed</option>
            </select>
          </label>
        </div>
      </div>

      {selected.size > 0 && (
        <div className="flex items-center gap-3.5 border-b border-[rgba(32,30,29,0.2)] bg-[#ffe0d9] px-5 py-2.5">
          <span className="text-[13px] font-extrabold text-[#7c1405]">
            {selected.size} selected · {formatMoney(selectedTotal.toFixed(4))}
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
          onClick={() => toggleSort('variance')}
          className="text-right font-extrabold uppercase tracking-[0.08em] text-[rgba(32,30,29,0.55)]"
        >
          Variance{sort?.key === 'variance' ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
        </button>
        <button
          type="button"
          onClick={() => toggleSort('age')}
          className="text-right font-extrabold uppercase tracking-[0.08em] text-[rgba(32,30,29,0.55)]"
        >
          Age{sort?.key === 'age' ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
        </button>
        <div className="text-right">Status</div>
      </div>

      <div className="flex-1 overflow-auto" data-testid="findings-rows" aria-label="Findings">
        {rows.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-[rgba(32,30,29,0.55)]">No findings match these filters.</div>
        ) : (
          sortedRows.map((row) => {
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
      {detailRow && <FindingDetail row={detailRow} onClose={() => setDetailRow(null)} />}
    </div>
  );
}
