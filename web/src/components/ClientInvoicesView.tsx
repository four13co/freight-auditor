import { useEffect, useState } from 'react';
import { fetchClientPortalInvoices, type ClientPortalInvoiceRow } from '../lib/api.js';

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Client-facing invoice list (P6.B.1). Unwired to nav -- same disclosure as
 * PortfolioReport.tsx's own P5.C siblings: the portal UI shell/nav that
 * will mount this is a separate item's boundary (P6.A.1).
 *
 * Self-fetching (mount-only, no props) since nothing wires data into it,
 * mirroring PortfolioReport.tsx's own fetch-on-mount shape.
 */
export function ClientInvoicesView() {
  const [invoices, setInvoices] = useState<ClientPortalInvoiceRow[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchClientPortalInvoices().then(
      (data) => { if (!cancelled) setInvoices(data); },
      () => { if (!cancelled) setError(true); },
    );
    return () => { cancelled = true; };
  }, []);

  return (
    <section data-testid="client-invoices-view" className="border border-[rgba(32,30,29,.3)] bg-[#f3f2f2] p-3">
      <h2 className="mb-2 text-sm font-extrabold">Invoices</h2>

      <div aria-live="polite" aria-busy={!error && invoices === null} data-testid="client-invoices-live-region">
        {error && (
          <span role="alert" data-testid="client-invoices-error" className="text-xs font-semibold text-[#7c1405]">
            Couldn&rsquo;t load invoices.
          </span>
        )}

        {!error && invoices === null && (
          <span data-testid="client-invoices-loading" className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">Loading…</span>
        )}

        {!error && invoices !== null && invoices.length === 0 && (
          <span role="status" data-testid="client-invoices-empty" className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">
            No invoices recorded yet.
          </span>
        )}

        {!error && invoices !== null && invoices.length > 0 && (
          <table data-testid="client-invoices-table" className="w-full text-xs">
            <thead>
              <tr className="border-b text-left">
                <th className="py-1 pr-2">Invoice #</th>
                <th className="py-1 pr-2">Carrier</th>
                <th className="py-1 pr-2">Currency</th>
                <th className="py-1 pr-2">Status</th>
                <th className="py-1 pr-2">Date</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} data-testid="client-invoices-row" className="border-t">
                  <td className="py-1 pr-2 font-extrabold">{inv.invoiceNumber ?? '—'}</td>
                  <td className="py-1 pr-2">{inv.carrierName ?? '—'}</td>
                  <td className="py-1 pr-2">{inv.currency ?? '—'}</td>
                  <td className="py-1 pr-2">{inv.status}</td>
                  <td className="py-1 pr-2 tabular-nums">{formatDate(inv.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
