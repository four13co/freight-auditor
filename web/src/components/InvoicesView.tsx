import { useCallback, useEffect, useState } from 'react';
import { fetchInvoices, type InvoiceRow } from '../lib/api.js';
import { formatMoney, formatAge } from '../lib/format.js';

const PAGE_SIZE = 50;

/**
 * 86e37r2rt: internal-analyst-facing invoice list -- the second "Soon"-badged
 * Sidebar item to get a real page (86e37r2rm's Discrepancies was the first).
 * Carrier/status filters mirror FindingsTable.tsx's own filter markup;
 * limit/offset pagination mirrors AuditLogView.tsx's loading/error/retry/
 * prev-next shape, since this endpoint pages the same way
 * (GET /api/gate-failures's limit/offset convention) rather than
 * GET /api/findings' single-page-with-sort shape.
 */
export function InvoicesView() {
  const [rows, setRows] = useState<InvoiceRow[] | null>(null);
  const [error, setError] = useState(false);
  const [carrierFilter, setCarrierFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(0);

  const load = useCallback(() => {
    setError(false);
    setRows(null);
    fetchInvoices({
      carrier: carrierFilter || undefined,
      status: statusFilter || undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }).then(
      (result) => setRows(result),
      () => setError(true),
    );
  }, [carrierFilter, statusFilter, page]);

  useEffect(() => {
    load();
  }, [load]);

  const hasActiveFilter = carrierFilter !== '' || statusFilter !== '';
  const hasMore = rows !== null && rows.length === PAGE_SIZE;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
      <div className="flex items-center gap-3 border-b-2 border-[rgba(32,30,29,0.4)] px-5 py-3.5">
        <span className="text-xl font-extrabold tracking-[-0.015em] text-[#201e1d]">Invoices</span>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex h-[30px] items-center gap-1.5 border border-[rgba(32,30,29,0.4)] px-2.5 text-xs text-[#201e1d]">
            Carrier:
            <input
              aria-label="Carrier filter"
              value={carrierFilter}
              onChange={(e) => {
                setPage(0);
                setCarrierFilter(e.target.value);
              }}
              placeholder="All"
              className="w-20 bg-transparent outline-none placeholder:text-[rgba(32,30,29,0.5)]"
            />
          </label>
          <label className="flex h-[30px] items-center gap-1.5 border border-[rgba(32,30,29,0.4)] px-2.5 text-xs text-[#201e1d]">
            Status:
            <input
              aria-label="Status filter"
              value={statusFilter}
              onChange={(e) => {
                setPage(0);
                setStatusFilter(e.target.value);
              }}
              placeholder="All"
              className="w-24 bg-transparent outline-none placeholder:text-[rgba(32,30,29,0.5)]"
            />
          </label>
        </div>
      </div>

      {error && (
        <div
          data-testid="invoices-error"
          role="alert"
          className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-[rgba(32,30,29,0.75)]"
        >
          <span>Something went wrong loading invoices.</span>
          <button
            type="button"
            onClick={load}
            className="h-9 border border-[rgba(32,30,29,0.4)] px-4 text-[13px] font-extrabold"
          >
            Retry
          </button>
        </div>
      )}

      {!error && rows === null && (
        <div data-testid="invoices-loading" className="flex flex-1 items-center justify-center text-sm text-[rgba(32,30,29,0.6)]">
          Loading…
        </div>
      )}

      {!error && rows !== null && rows.length === 0 && (
        <div data-testid="invoices-empty" role="status" className="flex flex-1 items-center justify-center text-sm text-[rgba(32,30,29,0.6)]">
          {hasActiveFilter ? 'No invoices match these filters.' : 'No invoices yet.'}
        </div>
      )}

      {!error && rows !== null && rows.length > 0 && (
        <>
          <table data-testid="invoices-table" className="w-full text-sm">
            <thead>
              <tr className="border-b border-[rgba(32,30,29,0.15)] text-left">
                <th className="py-2 pr-4">Invoice #</th>
                <th className="py-2 pr-4">Carrier</th>
                <th className="py-2 pr-4">Transaction set</th>
                <th className="py-2 pr-4 text-right">Billed total</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4 text-right">Age</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-testid="invoice-row" className="border-t border-[rgba(32,30,29,0.1)]">
                  <td className="py-2 pr-4 tabular-nums">{row.invoiceNumber ?? '—'}</td>
                  <td className="py-2 pr-4">{row.carrierName ?? '—'}</td>
                  <td className="py-2 pr-4">{row.transactionSet}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{formatMoney(row.billedTotal)}</td>
                  <td className="py-2 pr-4">{row.status}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{formatAge(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="flex gap-2">
            <button
              type="button"
              data-testid="invoices-prev"
              className="border border-[rgba(32,30,29,0.4)] px-3 py-1.5 text-[13px] font-semibold disabled:opacity-40"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </button>
            <button
              type="button"
              data-testid="invoices-next"
              className="border border-[rgba(32,30,29,0.4)] px-3 py-1.5 text-[13px] font-semibold disabled:opacity-40"
              disabled={!hasMore}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
