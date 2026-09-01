import { useEffect, useRef, useState } from 'react';
import {
  requestReconciliationExport,
  fetchReconciliationExportStatus,
  type ReconciliationExportStatus,
} from '../lib/api.js';
import { formatMoney } from '../lib/format.js';

const POLL_INTERVAL_MS = 2000;

/**
 * Asynchronous reconciliation export panel (P5.C.5): an analyst requests a
 * portfolio reconciliation export (getPortfolioReconciliation, P5.C.4) and
 * watches it move from pending -> completed/failed, self-polling the status
 * endpoint rather than blocking on a single long request -- the UI-side
 * half of the AC that made this async in the first place. Ships unwired to
 * nav for now, same disclosure as its siblings (RecoveryReport.tsx,
 * ClaimDetail.tsx, DisputeReview.tsx).
 */
export function ReconciliationExport() {
  const [status, setStatus] = useState<ReconciliationExportStatus | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState(false);
  const [pollError, setPollError] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current !== null) clearInterval(pollRef.current);
    };
  }, []);

  function stopPolling(): void {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function pollStatus(exportId: string): void {
    pollRef.current = setInterval(() => {
      void fetchReconciliationExportStatus(exportId).then(
        (row) => {
          setStatus(row);
          if (row.status === 'completed' || row.status === 'failed') stopPolling();
        },
        () => {
          setPollError(true);
          stopPolling();
        },
      );
    }, POLL_INTERVAL_MS);
  }

  function handleRequest(): void {
    setRequesting(true);
    setRequestError(false);
    setPollError(false);
    stopPolling();
    void requestReconciliationExport().then(
      (result) => {
        setStatus({ id: result.exportId, status: 'pending', result: null, error: null, requestedAt: new Date().toISOString(), completedAt: null });
        pollStatus(result.exportId);
      },
      () => setRequestError(true),
    ).finally(() => setRequesting(false));
  }

  return (
    <div data-testid="reconciliation-export" className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <span className="text-lg font-extrabold tracking-[-0.015em]">Reconciliation export</span>
        <button
          type="button"
          disabled={requesting || status?.status === 'pending' || status?.status === 'claimed'}
          onClick={handleRequest}
          className="h-8 border border-[#287a3d] px-3 text-xs font-extrabold disabled:opacity-60"
        >
          {status?.status === 'pending' || status?.status === 'claimed' ? 'Exporting…' : 'Request export'}
        </button>
      </div>

      {requestError && (
        <span className="text-xs font-semibold text-[#7c1405]">Couldn&rsquo;t request export. Try again.</span>
      )}
      {pollError && (
        <span className="text-xs font-semibold text-[#7c1405]">Lost track of the export&rsquo;s status. Try requesting again.</span>
      )}

      {status && (status.status === 'pending' || status.status === 'claimed') && (
        <span className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">Reconciling your portfolio…</span>
      )}

      {status?.status === 'failed' && (
        <span data-testid="reconciliation-export-error" className="text-xs font-semibold text-[#7c1405]">
          Export failed: {status.error ?? 'unknown error'}
        </span>
      )}

      {status?.status === 'completed' && status.result && (
        status.result.length === 0 ? (
          <span className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">No claims to reconcile.</span>
        ) : (
          <table data-testid="reconciliation-export-table" className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b-2 border-[rgba(32,30,29,0.4)] text-left">
                <th className="py-1 pr-3 font-extrabold uppercase tracking-[0.08em]">Currency</th>
                <th className="py-1 pr-3 font-extrabold uppercase tracking-[0.08em]">Claimed</th>
                <th className="py-1 pr-3 font-extrabold uppercase tracking-[0.08em]">Recovered</th>
                <th className="py-1 pr-3 font-extrabold uppercase tracking-[0.08em]">Outstanding</th>
                <th className="py-1 pr-3 font-extrabold uppercase tracking-[0.08em]">Reconciles</th>
              </tr>
            </thead>
            <tbody>
              {status.result.map((bucket) => (
                <tr key={bucket.currency} data-testid="reconciliation-export-row" className="border-b border-[rgba(32,30,29,0.2)]">
                  <td className="py-1 pr-3">{bucket.currency}</td>
                  <td className="py-1 pr-3">{formatMoney(bucket.claimed)}</td>
                  <td className="py-1 pr-3">{formatMoney(bucket.recovered)}</td>
                  <td className="py-1 pr-3">{formatMoney(bucket.outstanding)}</td>
                  <td className="py-1 pr-3">{bucket.reconciles ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </div>
  );
}
