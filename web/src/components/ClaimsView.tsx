import { useCallback, useEffect, useState } from 'react';
import { fetchClaims, type ClaimListRow } from '../lib/api.js';
import { formatMoney } from '../lib/format.js';
import { titleCase } from '../lib/status-display.js';
import { ClaimDetail } from './ClaimDetail.js';

const PAGE_SIZE = 50;

function formatDate(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * 86e387qpv: internal-analyst-facing claims list -- gives ClaimDetail.tsx
 * (P5.B.5, real and tested but never mounted anywhere) a real caller.
 * Loading/error/empty/pagination shape mirrors InvoicesView.tsx/
 * AuditLogView.tsx exactly (offset/limit, has-more-from-full-page signal).
 * Row click opens ClaimDetail as a drawer, same pattern as FindingsTable's
 * own row-click -> detail-drawer wiring.
 */
export function ClaimsView() {
  const [rows, setRows] = useState<ClaimListRow[] | null>(null);
  const [error, setError] = useState(false);
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(false);
    setRows(null);
    fetchClaims({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }).then(
      (result) => setRows(result),
      () => setError(true),
    );
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const hasMore = rows !== null && rows.length === PAGE_SIZE;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
      <div className="flex items-center gap-3 border-b-2 border-[rgba(32,30,29,0.4)] px-5 py-3.5">
        <span className="text-xl font-extrabold tracking-[-0.015em] text-[#201e1d]">Claims</span>
      </div>

      {error && (
        <div
          data-testid="claims-error"
          role="alert"
          className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-[rgba(32,30,29,0.75)]"
        >
          <span>Something went wrong loading claims.</span>
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
        <div data-testid="claims-loading" className="flex flex-1 items-center justify-center text-sm text-[rgba(32,30,29,0.6)]">
          Loading…
        </div>
      )}

      {!error && rows !== null && rows.length === 0 && (
        <div data-testid="claims-empty" role="status" className="flex flex-1 items-center justify-center text-sm text-[rgba(32,30,29,0.6)]">
          No claims yet.
        </div>
      )}

      {!error && rows !== null && rows.length > 0 && (
        <>
          <table data-testid="claims-table" className="w-full text-sm">
            <thead>
              <tr className="border-b border-[rgba(32,30,29,0.15)] text-left">
                <th className="py-2 pr-4">Claim</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4 text-right">Amount claimed</th>
                <th className="py-2 pr-4">Opened</th>
                <th className="py-2 pr-4">Aging deadline</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  data-testid="claim-row"
                  onClick={() => setSelectedId(row.id)}
                  className="cursor-pointer border-t border-[rgba(32,30,29,0.1)]"
                >
                  <td className="py-2 pr-4 font-semibold tabular-nums">{row.id.slice(0, 8)}</td>
                  <td className="py-2 pr-4">{titleCase(row.status)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{formatMoney(row.amountClaimed)}</td>
                  <td className="py-2 pr-4">{formatDate(row.openedAt)}</td>
                  <td className="py-2 pr-4">{formatDate(row.agingDeadlineAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="flex gap-2">
            <button
              type="button"
              data-testid="claims-prev"
              className="border border-[rgba(32,30,29,0.4)] px-3 py-1.5 text-[13px] font-semibold disabled:opacity-40"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </button>
            <button
              type="button"
              data-testid="claims-next"
              className="border border-[rgba(32,30,29,0.4)] px-3 py-1.5 text-[13px] font-semibold disabled:opacity-40"
              disabled={!hasMore}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}

      {selectedId && <ClaimDetail claimId={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}
