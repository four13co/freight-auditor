/**
 * Nav sidebar matching the 1B Console mockup. "Dashboard" is the current
 * view (its red highlight isn't a dead link, it's active-state). Everything
 * else here has no real destination or filter behind it yet (86e2uutk8):
 * Discrepancies/Invoices/Audit log/Settings have no other route in this app,
 * and none of the three saved views maps onto an existing filter dimension
 * without inventing semantics the label doesn't actually mean ("Mine, over
 * $500" needs an assignee filter that doesn't exist; "Estes accessorials"
 * needs a charge-category filter, not just carrier; "Aging > 5 days" needs
 * an age filter that doesn't exist). Rather than wire a filter that doesn't
 * match its own label, or leave inert chrome that LOOKS clickable, these are
 * marked visibly non-interactive -- the same disabled/cursor-not-allowed/
 * "Coming soon" convention FindingsTable's bulk-action buttons already use.
 */
export function Sidebar() {
  return (
    <div className="flex w-[228px] flex-none flex-col bg-[#201e1d] text-[#f3f2f2]">
      <div className="flex h-16 flex-none items-center gap-2.5 border-b-2 border-[rgba(243,242,242,0.25)] px-[18px]">
        <div className="h-[22px] w-[22px] bg-[#ec3013]" />
        <div className="text-[15px] font-extrabold tracking-[-0.015em]">Freight Auditor</div>
      </div>

      <div className="flex flex-col py-[18px]">
        <div className="px-[18px] pb-2 text-[11px] font-extrabold uppercase tracking-[0.1em] text-[rgba(243,242,242,0.5)]">
          Audit
        </div>
        <div className="bg-[#ec3013] px-[18px] py-[9px] text-sm font-extrabold text-[#f3f2f2]">Dashboard</div>
        <button
          type="button"
          disabled
          title="Coming soon"
          className="flex cursor-not-allowed items-center justify-between px-[18px] py-[9px] text-left text-sm text-[rgba(243,242,242,0.85)] opacity-60"
        >
          <span>Discrepancies</span>
        </button>
        <button
          type="button"
          disabled
          title="Coming soon"
          className="flex cursor-not-allowed items-center justify-between px-[18px] py-[9px] text-left text-sm text-[rgba(243,242,242,0.85)] opacity-60"
        >
          <span>Invoices</span>
        </button>

        <div className="px-[18px] pb-2 pt-[22px] text-[11px] font-extrabold uppercase tracking-[0.1em] text-[rgba(243,242,242,0.5)]">
          Records
        </div>
        <button
          type="button"
          disabled
          title="Coming soon"
          className="cursor-not-allowed px-[18px] py-[9px] text-left text-sm text-[rgba(243,242,242,0.85)] opacity-60"
        >
          Audit log
        </button>
        <button
          type="button"
          disabled
          title="Coming soon"
          className="cursor-not-allowed px-[18px] py-[9px] text-left text-sm text-[rgba(243,242,242,0.85)] opacity-60"
        >
          Settings
        </button>

        <div className="mt-[22px] border-t-2 border-[rgba(243,242,242,0.25)] pt-3.5">
          <div className="px-[18px] pb-2 text-[11px] font-extrabold uppercase tracking-[0.1em] text-[rgba(243,242,242,0.5)]">
            Saved views
          </div>
          <button
            type="button"
            disabled
            title="Coming soon"
            className="cursor-not-allowed px-[18px] py-[7px] text-left text-[13px] text-[rgba(243,242,242,0.75)] opacity-60"
          >
            Mine, over $500
          </button>
          <button
            type="button"
            disabled
            title="Coming soon"
            className="cursor-not-allowed px-[18px] py-[7px] text-left text-[13px] text-[rgba(243,242,242,0.75)] opacity-60"
          >
            Estes accessorials
          </button>
          <button
            type="button"
            disabled
            title="Coming soon"
            className="cursor-not-allowed px-[18px] py-[7px] text-left text-[13px] text-[rgba(243,242,242,0.75)] opacity-60"
          >
            Aging &gt; 5 days
          </button>
        </div>
      </div>

      <div className="mt-auto flex flex-col gap-0.5 border-t-2 border-[rgba(243,242,242,0.25)] px-[18px] py-3.5">
        <span className="text-[13px] font-semibold">Dana Mercer</span>
        <span className="text-[11px] text-[rgba(243,242,242,0.55)]">Ops analyst · Four13</span>
      </div>
    </div>
  );
}
