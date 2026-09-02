import { useEffect, useState } from 'react';
import { fetchClientPortalAuditLog, type ClientPortalAuditEventRow } from '../lib/api.js';

const PAGE_SIZE = 50;

/**
 * Client-facing audit-log browser (P6.B.6). Unwired to nav -- same
 * disclosure as ClientFindingsView.tsx's own precedent: the portal UI
 * shell/nav that will mount this is a separate item's boundary (P6.A.1).
 *
 * Self-fetching, mount-and-page-change, mirroring ClientFindingsView.tsx's
 * own fetch-on-mount shape. `has-more` is inferred from a full page
 * (events.length === PAGE_SIZE), the same signal list-findings.ts's own
 * pagination consumers use elsewhere on this surface -- no separate count
 * query.
 */
export function ClientAuditLogView() {
  const [page, setPage] = useState(0);
  const [events, setEvents] = useState<ClientPortalAuditEventRow[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setError(false);
    fetchClientPortalAuditLog(PAGE_SIZE, page * PAGE_SIZE).then(
      (data) => { if (!cancelled) setEvents(data.events); },
      () => { if (!cancelled) setError(true); },
    );
    return () => { cancelled = true; };
  }, [page]);

  const hasMore = events !== null && events.length === PAGE_SIZE;

  return (
    <section data-testid="client-audit-log-view" className="border border-[rgba(32,30,29,.3)] bg-[#f3f2f2] p-3">
      <h2 className="mb-2 text-sm font-extrabold">Audit log</h2>

      {error && (
        <span data-testid="client-audit-log-error" className="text-xs font-semibold text-[#7c1405]">
          Couldn&rsquo;t load the audit log.
        </span>
      )}

      {!error && events === null && (
        <span className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">Loading…</span>
      )}

      {!error && events !== null && events.length === 0 && (
        <span data-testid="client-audit-log-empty" className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">
          No audit events recorded yet.
        </span>
      )}

      {!error && events !== null && events.length > 0 && (
        <>
          <table data-testid="client-audit-log-table" className="w-full text-xs">
            <thead>
              <tr className="border-b text-left">
                <th className="py-1 pr-2">Recorded</th>
                <th className="py-1 pr-2">Entity</th>
                <th className="py-1 pr-2">Event</th>
                <th className="py-1 pr-2">Actor</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} data-testid="client-audit-log-row" className="border-t">
                  <td className="py-1 pr-2 tabular-nums">{new Date(e.recordedAt).toLocaleString()}</td>
                  <td className="py-1 pr-2 font-extrabold">{e.entity}</td>
                  <td className="py-1 pr-2">{e.event}</td>
                  <td className="py-1 pr-2" data-testid="client-audit-log-actor-kind">{e.actorKind}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-2 flex gap-2">
            <button
              type="button"
              data-testid="client-audit-log-prev"
              className="border border-[rgba(32,30,29,.3)] px-2 py-1 text-xs font-semibold disabled:opacity-40"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </button>
            <button
              type="button"
              data-testid="client-audit-log-next"
              className="border border-[rgba(32,30,29,.3)] px-2 py-1 text-xs font-semibold disabled:opacity-40"
              disabled={!hasMore}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </section>
  );
}
