/**
 * Header greeting bar. Search/Export/New-audit-run have no backing endpoints
 * for v1 (86e2uv1r6): previously plain <div>s styled as fully interactive
 * controls, which is a worse failure mode than a disabled control -- typing
 * into the "search" div produced zero response (no cursor, no typed text,
 * nothing) because it wasn't a real input and couldn't receive focus. In a
 * live demo that reads as the product being broken, not "not yet built."
 * Now real disabled form elements, matching FindingsTable's existing
 * disabled/cursor-not-allowed/"Coming soon" bulk-action-button convention.
 */
export function Header() {
  return (
    <div className="flex h-16 flex-none items-center gap-4 border-b-2 border-[rgba(32,30,29,0.4)] bg-[#f8f4f4] px-6">
      <div className="flex flex-col leading-tight">
        <span className="text-[17px] font-extrabold tracking-[-0.015em] text-[#201e1d]">Good morning, Dana</span>
      </div>
      <div className="ml-auto flex items-center gap-2.5">
        <input
          type="text"
          disabled
          title="Coming soon"
          placeholder="Search invoice, PRO, or claim ID"
          className="h-9 min-w-[260px] cursor-not-allowed border border-[rgba(32,30,29,0.4)] bg-[#f3f2f2] px-3.5 text-[13px] text-[rgba(32,30,29,0.75)] opacity-60 placeholder:text-[rgba(32,30,29,0.75)]"
        />
        <button
          type="button"
          disabled
          title="Coming soon"
          className="flex h-9 cursor-not-allowed items-center border border-[rgba(32,30,29,0.4)] bg-[#f3f2f2] px-3.5 text-sm font-extrabold text-[#201e1d] opacity-60"
        >
          Export
        </button>
        <button
          type="button"
          disabled
          title="Coming soon"
          className="flex h-9 cursor-not-allowed items-center bg-[#ec3013] px-3.5 text-sm font-extrabold text-[#f3f2f2] opacity-60"
        >
          New audit run
        </button>
      </div>
    </div>
  );
}
