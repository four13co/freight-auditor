import { useEffect, useState } from 'react';
import { fetchPortalOverview } from '../lib/api.js';

/**
 * Client portal shell + navigation (P6.A.1). The chrome external Customer
 * users (client_admin/client_viewer, P6.A.2/3 -- not built yet) will land
 * in; the actual content views it links to (invoices, findings, disputes,
 * claims, audit log -- P6.B.1/2/3/4/6) don't exist yet either, so every nav
 * entry is a visibly non-interactive "Coming soon" placeholder, reusing
 * Sidebar.tsx's existing disabled/cursor-not-allowed/SoonBadge convention
 * rather than inventing a second one.
 *
 * Standalone and self-fetching, following PortfolioReport.tsx/RecoveryReport.tsx's
 * precedent for a new surface that isn't wired into App.tsx's render tree
 * yet -- App.tsx gates the internal analyst Dashboard specifically, and this
 * repo has no router to hang a second top-level surface off of (a rabbit
 * hole this item's own notes flag as out of scope: don't introduce a second
 * notion of tenant OR a routing layer neither existing surface uses).
 *
 * Fetches /api/portal/overview on mount to prove the shell resolves through
 * the SAME tenant identity every other tenant route uses (db/tenant-context.ts's
 * RLS-bound TenantContext) -- not a parallel client concept.
 */
const SOON_BADGE_CLASS =
  'px-1 py-px text-[9px] font-extrabold uppercase tracking-[0.04em] bg-[rgba(243,242,242,0.16)] text-[rgba(243,242,242,0.75)]';

function SoonBadge() {
  return <span className={SOON_BADGE_CLASS}>Soon</span>;
}

function NavPlaceholder({ label }: { label: string }) {
  return (
    <button
      type="button"
      disabled
      title="Coming soon"
      data-testid="portal-nav-item"
      className="flex cursor-not-allowed items-center justify-between px-[18px] py-[9px] text-left text-sm text-[rgba(243,242,242,0.85)] opacity-60"
    >
      <span>{label}</span>
      <SoonBadge />
    </button>
  );
}

const NAV_ITEMS = [
  'Invoices & scorecards',
  'Findings & evidence',
  'Disputes & communications',
  'Claims & recovery',
  'Audit log',
];

export function PortalShell() {
  const [clientName, setClientName] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchPortalOverview().then(
      (overview) => { if (!cancelled) setClientName(overview.clientName); },
      () => { if (!cancelled) setError(true); },
    );
    return () => { cancelled = true; };
  }, []);

  return (
    <div data-testid="portal-shell" className="flex h-screen">
      <div className="flex w-[228px] flex-none flex-col bg-[#201e1d] text-[#f3f2f2]">
        <div className="flex h-16 flex-none items-center gap-2.5 border-b-2 border-[rgba(243,242,242,0.25)] px-[18px]">
          <div className="h-[22px] w-[22px] bg-[#ec3013]" />
          <div className="text-[15px] font-extrabold tracking-[-0.015em]">Freight Auditor</div>
        </div>
        <div className="flex flex-col py-[18px]">
          <div className="bg-[#ec3013] px-[18px] py-[9px] text-sm font-extrabold text-[#f3f2f2]">Overview</div>
          {NAV_ITEMS.map((label) => (
            <NavPlaceholder key={label} label={label} />
          ))}
        </div>
      </div>

      <div className="flex flex-1 flex-col">
        <div className="flex h-16 flex-none items-center border-b-2 border-[rgba(32,30,29,0.4)] bg-[#f8f4f4] px-6">
          {error && (
            <span data-testid="portal-shell-error" className="text-[15px] font-extrabold text-[#7c1405]">
              Couldn&rsquo;t load your portal.
            </span>
          )}
          {!error && clientName === null && (
            <span data-testid="portal-shell-loading" className="text-[15px] font-extrabold text-[rgba(32,30,29,0.65)]">
              Loading…
            </span>
          )}
          {!error && clientName !== null && (
            <span data-testid="portal-shell-greeting" className="text-[17px] font-extrabold tracking-[-0.015em] text-[#201e1d]">
              Welcome, {clientName}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
