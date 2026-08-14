/** Static nav sidebar matching the 1B Console mockup. Saved views are static text for v1. */
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
        <div className="flex items-center justify-between px-[18px] py-[9px] text-sm text-[rgba(243,242,242,0.85)]">
          <span>Discrepancies</span>
        </div>
        <div className="flex items-center justify-between px-[18px] py-[9px] text-sm text-[rgba(243,242,242,0.85)]">
          <span>Invoices</span>
        </div>

        <div className="px-[18px] pb-2 pt-[22px] text-[11px] font-extrabold uppercase tracking-[0.1em] text-[rgba(243,242,242,0.5)]">
          Records
        </div>
        <div className="px-[18px] py-[9px] text-sm text-[rgba(243,242,242,0.85)]">Audit log</div>
        <div className="px-[18px] py-[9px] text-sm text-[rgba(243,242,242,0.85)]">Settings</div>

        <div className="mt-[22px] border-t-2 border-[rgba(243,242,242,0.25)] pt-3.5">
          <div className="px-[18px] pb-2 text-[11px] font-extrabold uppercase tracking-[0.1em] text-[rgba(243,242,242,0.5)]">
            Saved views
          </div>
          <div className="px-[18px] py-[7px] text-[13px] text-[rgba(243,242,242,0.75)]">Mine, over $500</div>
          <div className="px-[18px] py-[7px] text-[13px] text-[rgba(243,242,242,0.75)]">Estes accessorials</div>
          <div className="px-[18px] py-[7px] text-[13px] text-[rgba(243,242,242,0.75)]">Aging &gt; 5 days</div>
        </div>
      </div>

      <div className="mt-auto flex flex-col gap-0.5 border-t-2 border-[rgba(243,242,242,0.25)] px-[18px] py-3.5">
        <span className="text-[13px] font-semibold">Dana Mercer</span>
        <span className="text-[11px] text-[rgba(243,242,242,0.55)]">Ops analyst · Four13</span>
      </div>
    </div>
  );
}
