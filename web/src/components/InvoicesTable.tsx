import type { InvoiceRow } from '../lib/api.js';
import { formatMoney, formatAge } from '../lib/format.js';

interface InvoicesTableProps {
  rows: InvoiceRow[];
  carrierFilter: string;
  statusFilter: string;
  onCarrierFilterChange: (value: string) => void;
  onStatusFilterChange: (value: string) => void;
}

// invoice #, carrier, transaction set, billed total, status, age -- the six
// columns the item's Solution names, in that order. The grid's own gap-3
// (below) is load-bearing here, not cosmetic -- with gap-0 (FindingsTable's
// value, fine there since its columns are narrower text), a value like
// "$5,940.20reconciled" visually ran the Billed total and Status cells
// together with no gap between them.
const COLUMNS = '110px 1fr 110px 120px 110px 64px';

/**
 * 86e37r2rt: the internal-analyst invoice list table, backing the /invoices
 * route. Same carrier/status filter UI pattern FindingsTable already
 * establishes (label + input/select, aria-labeled), deliberately simpler
 * than FindingsTable itself -- no row detail drawer, no bulk-select, no
 * server-driven sort -- this item's own appetite (M) and Rabbit holes scope
 * this to a list, not a second FindingsTable-sized surface.
 */
export function InvoicesTable({ rows, carrierFilter, statusFilter, onCarrierFilterChange, onStatusFilterChange }: InvoicesTableProps) {
  const hasActiveFilter = carrierFilter !== '' || statusFilter !== '';

  return (
    <div className="flex flex-1 flex-col overflow-hidden border border-[rgba(32,30,29,0.4)] bg-[#f3f2f2] shadow-[0_1px_2px_rgba(45,43,43,0.14)]">
      <div className="flex items-center gap-3 border-b-2 border-[rgba(32,30,29,0.4)] px-5 py-3.5">
        <span className="text-xl font-extrabold tracking-[-0.015em] text-[#201e1d]">Invoices</span>
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
            <input
              aria-label="Status filter"
              value={statusFilter}
              onChange={(e) => onStatusFilterChange(e.target.value)}
              placeholder="All"
              className="w-20 bg-transparent outline-none placeholder:text-[rgba(32,30,29,0.5)]"
            />
          </label>
        </div>
      </div>

      <div
        className="grid h-9 flex-none items-center gap-3 border-b-2 border-[rgba(32,30,29,0.4)] bg-[#eae9e9] px-5 text-[11px] font-extrabold uppercase tracking-[0.08em] text-[rgba(32,30,29,0.55)]"
        style={{ gridTemplateColumns: COLUMNS }}
      >
        <div>Invoice</div>
        <div>Carrier</div>
        <div>Transaction set</div>
        <div className="text-right">Billed total</div>
        <div>Status</div>
        <div className="text-right">Age</div>
      </div>

      <div className="flex-1 overflow-auto" data-testid="invoices-rows" aria-label="Invoices">
        {rows.length === 0 ? (
          hasActiveFilter ? (
            <div className="px-5 py-8 text-center text-sm text-[rgba(32,30,29,0.55)]">No invoices match these filters.</div>
          ) : (
            <div data-testid="empty-no-invoices-yet" className="px-5 py-8 text-center text-sm text-[rgba(32,30,29,0.55)]">
              No invoices yet.
            </div>
          )
        ) : (
          rows.map((row) => (
            <div
              key={row.id}
              data-testid="invoice-row"
              className="grid items-center gap-3 border-b border-[rgba(32,30,29,0.14)] px-5 py-2.5"
              style={{ gridTemplateColumns: COLUMNS }}
            >
              <div className="text-[13px] font-semibold tabular-nums text-[#201e1d]">{row.invoiceNumber ?? '—'}</div>
              <div className="text-[13px] text-[#201e1d]">{row.carrierName ?? '—'}</div>
              <div className="text-[13px] tabular-nums text-[#201e1d]">{row.transactionSet}</div>
              <div className="text-right text-[13px] tabular-nums text-[#201e1d]">{formatMoney(row.billedTotal)}</div>
              <div className="text-[13px] text-[#201e1d]">{row.status}</div>
              <div className="text-right text-xs tabular-nums text-[rgba(32,30,29,0.6)]">{formatAge(row.createdAt)}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
