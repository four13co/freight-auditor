/** Header greeting bar. Search/Export/New-audit-run are visually present but non-functional for v1 (no backing endpoints). */
export function Header() {
  return (
    <div className="flex h-16 flex-none items-center gap-4 border-b-2 border-[rgba(32,30,29,0.4)] bg-[#f8f4f4] px-6">
      <div className="flex flex-col leading-tight">
        <span className="text-[17px] font-extrabold tracking-[-0.015em] text-[#201e1d]">Good morning, Dana</span>
      </div>
      <div className="ml-auto flex items-center gap-2.5">
        <div className="flex h-9 min-w-[260px] items-center gap-2 border border-[rgba(32,30,29,0.4)] bg-[#f3f2f2] px-3.5 text-[13px] text-[rgba(32,30,29,0.75)]">
          Search invoice, PRO, or claim ID
        </div>
        <div className="flex h-9 items-center border border-[rgba(32,30,29,0.4)] bg-[#f3f2f2] px-3.5 text-sm font-extrabold text-[#201e1d]">
          Export
        </div>
        <div className="flex h-9 items-center bg-[#ec3013] px-3.5 text-sm font-extrabold text-[#f3f2f2]">
          New audit run
        </div>
      </div>
    </div>
  );
}
