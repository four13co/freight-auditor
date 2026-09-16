import { useState } from 'react';
import { fetchAuditLog, type AuditLogEventRow } from '../lib/api.js';
import { useClientPortalResource } from '../lib/use-client-portal-resource.js';

const PAGE_SIZE = 50;

/**
 * 86e37r2rv: internal-analyst-facing audit log, the cross-client
 * counterpart to ClientAuditLogView.tsx (client portal) -- same paginated
 * shape (event, entity, actor, timestamp), same has-more-from-full-page
 * pagination signal, pointed at /api/internal/audit-log instead. Fetches
 * on mount and on page change via the shared useClientPortalResource hook
 * (86e39qa7c), same as ClientAuditLogView.tsx -- it isn't portal-only.
 */
export function AuditLogView() {
  const [page, setPage] = useState(0);
  const { data: events, error, reload } = useClientPortalResource<AuditLogEventRow[]>(
    () => fetchAuditLog(PAGE_SIZE, page * PAGE_SIZE).then((data) => data.events),
    [page],
  );

  const hasMore = events !== null && events.length === PAGE_SIZE;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
      {error && (
        <div
          data-testid="audit-log-error"
          role="alert"
          className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-[rgba(32,30,29,0.75)]"
        >
          <span>Something went wrong loading the audit log.</span>
          <button
            type="button"
            onClick={reload}
            className="h-9 border border-[rgba(32,30,29,0.4)] px-4 text-[13px] font-extrabold"
          >
            Retry
          </button>
        </div>
      )}

      {!error && events === null && (
        <div data-testid="audit-log-loading" className="flex flex-1 items-center justify-center text-sm text-[rgba(32,30,29,0.6)]">
          Loading…
        </div>
      )}

      {!error && events !== null && events.length === 0 && (
        <div data-testid="audit-log-empty" role="status" className="flex flex-1 items-center justify-center text-sm text-[rgba(32,30,29,0.6)]">
          No audit events recorded yet.
        </div>
      )}

      {!error && events !== null && events.length > 0 && (
        <>
          <table data-testid="audit-log-table" className="w-full text-sm">
            <thead>
              <tr className="border-b border-[rgba(32,30,29,0.15)] text-left">
                <th className="py-2 pr-4">Recorded</th>
                <th className="py-2 pr-4">Entity</th>
                <th className="py-2 pr-4">Event</th>
                <th className="py-2 pr-4">Actor</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} data-testid="audit-log-row" className="border-t border-[rgba(32,30,29,0.1)]">
                  <td className="py-2 pr-4 tabular-nums">{new Date(e.recordedAt).toLocaleString()}</td>
                  <td className="py-2 pr-4 font-semibold">{e.entity}</td>
                  <td className="py-2 pr-4">{e.event}</td>
                  <td className="py-2 pr-4" data-testid="audit-log-actor-kind">{e.actorKind}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="flex gap-2">
            <button
              type="button"
              data-testid="audit-log-prev"
              className="border border-[rgba(32,30,29,0.4)] px-3 py-1.5 text-[13px] font-semibold disabled:opacity-40"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </button>
            <button
              type="button"
              data-testid="audit-log-next"
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
