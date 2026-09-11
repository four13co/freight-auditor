import { useCallback, useEffect, useState } from 'react';
import { InvoicesTable } from './InvoicesTable.js';
import { fetchInvoices, type InvoiceRow } from '../lib/api.js';

type LoadStatus = 'loading' | 'error' | 'ready';

/**
 * 86e37r2rt: dedicated full-page view for the /invoices route -- mirrors
 * DiscrepanciesView.tsx's own shape (86e37r2rm) exactly: a plain fetch +
 * table, no KPI row or queues. carrier/status filters re-fetch on change,
 * same as DiscrepanciesView.
 */
export function InvoicesView() {
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [carrierFilter, setCarrierFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [status, setStatus] = useState<LoadStatus>('loading');

  const load = useCallback(() => {
    setStatus('loading');
    fetchInvoices({
      carrier: carrierFilter || undefined,
      status: statusFilter || undefined,
    }).then(
      (rowsResult) => {
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
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
      {status === 'loading' && (
        <div data-testid="invoices-loading" className="flex flex-1 items-center justify-center text-sm text-[rgba(32,30,29,0.6)]">
          Loading…
        </div>
      )}
      {status === 'error' && (
        <div
          data-testid="invoices-error"
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
      {status === 'ready' && (
        <InvoicesTable
          rows={rows}
          carrierFilter={carrierFilter}
          statusFilter={statusFilter}
          onCarrierFilterChange={setCarrierFilter}
          onStatusFilterChange={setStatusFilter}
        />
      )}
    </div>
  );
}
