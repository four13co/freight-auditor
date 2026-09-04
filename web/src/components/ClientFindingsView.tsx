import { useEffect, useState } from 'react';
import { fetchClientPortalFindings, type ClientPortalFindingRow } from '../lib/api.js';

function formatAmount(value: string | null): string {
  if (value === null) return '—';
  const n = Number(value);
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Client-facing findings list (P6.B.2). Unwired to nav -- same disclosure
 * as ClientInvoicesView.tsx's own P6.B.1 precedent: the portal UI
 * shell/nav that will mount this is a separate item's boundary (P6.A.1).
 *
 * Self-fetching (mount-only, no props), mirroring ClientInvoicesView.tsx's
 * own fetch-on-mount shape.
 */
export function ClientFindingsView() {
  const [findings, setFindings] = useState<ClientPortalFindingRow[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchClientPortalFindings().then(
      (data) => { if (!cancelled) setFindings(data); },
      () => { if (!cancelled) setError(true); },
    );
    return () => { cancelled = true; };
  }, []);

  return (
    <section data-testid="client-findings-view" className="border border-[rgba(32,30,29,.3)] bg-[#f3f2f2] p-3">
      <h2 className="mb-2 text-sm font-extrabold">Findings</h2>

      <div aria-live="polite" aria-busy={!error && findings === null} data-testid="client-findings-live-region">
        {error && (
          <span role="alert" data-testid="client-findings-error" className="text-xs font-semibold text-[#7c1405]">
            Couldn&rsquo;t load findings.
          </span>
        )}

        {!error && findings === null && (
          <span data-testid="client-findings-loading" className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">Loading…</span>
        )}

        {!error && findings !== null && findings.length === 0 && (
          <span role="status" data-testid="client-findings-empty" className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">
            No findings recorded yet.
          </span>
        )}

        {!error && findings !== null && findings.length > 0 && (
          <table data-testid="client-findings-table" className="w-full text-xs">
            <thead>
              <tr className="border-b text-left">
                <th className="py-1 pr-2">Invoice</th>
                <th className="py-1 pr-2">Carrier</th>
                <th className="py-1 pr-2">Billed</th>
                <th className="py-1 pr-2">Expected</th>
                <th className="py-1 pr-2">Variance</th>
                <th className="py-1 pr-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((f) => (
                <tr key={f.id} data-testid="client-findings-row" className="border-t">
                  <td className="py-1 pr-2 font-extrabold">{f.invoiceNumber ?? '—'}</td>
                  <td className="py-1 pr-2">{f.carrierName ?? '—'}</td>
                  <td className="py-1 pr-2 tabular-nums">{formatAmount(f.billed)}</td>
                  <td className="py-1 pr-2 tabular-nums">{formatAmount(f.expected)}</td>
                  <td className="py-1 pr-2 tabular-nums">{formatAmount(f.varianceAmount)}</td>
                  <td className="py-1 pr-2">{f.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
