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
 *
 * 86e2uv1ry: opacity-60 alone was confirmed (live, not just in code) to be
 * imperceptible against the dark sidebar background next to the surrounding
 * muted-gray nav items -- the ONLY prior signal was the title tooltip, which
 * requires a deliberate hover most viewers won't make. Each disabled entry
 * now also carries a visible "Soon" badge (the SoonBadge below), reusing the
 * app's existing pill/tag visual language (FindingsTable/FindingDetail's
 * status tags) so it reads as an established UI pattern, not a one-off.
 */
import type { Branding } from '../lib/api.js';
import { BrandMark } from './BrandMark.js';

const SOON_BADGE_CLASS =
  'px-1 py-px text-[9px] font-extrabold uppercase tracking-[0.04em] bg-[rgba(243,242,242,0.16)] text-[rgba(243,242,242,0.75)]';

function SoonBadge() {
  return <span className={SOON_BADGE_CLASS}>Soon</span>;
}

/**
 * 86e320pkc: the logo swatch and "Dashboard" active-item background are this
 * chrome's own branding surface -- BrandMark swaps the swatch for a
 * Customer's logo when configured, and the active background reads
 * --brand-primary (App.tsx sets it once branding resolves) with a CSS
 * fallback to the platform's own red, so an unbranded visit renders
 * pixel-identical to before.
 */
export function Sidebar({ branding }: { branding?: Branding | null } = {}) {
  return (
    <div className="flex w-[228px] flex-none flex-col bg-[#201e1d] text-[#f3f2f2]">
      <div className="flex h-16 flex-none items-center gap-2.5 border-b-2 border-[rgba(243,242,242,0.25)] px-[18px]">
        <BrandMark branding={branding} />
        <div className="text-[15px] font-extrabold tracking-[-0.015em]" style={{ color: 'var(--brand-secondary, #f3f2f2)' }}>
          Freight Auditor
        </div>
      </div>

      <div className="flex flex-col py-[18px]">
        <div className="px-[18px] pb-2 text-[11px] font-extrabold uppercase tracking-[0.1em] text-[rgba(243,242,242,0.5)]">
          Audit
        </div>
        <div
          className="px-[18px] py-[9px] text-sm font-extrabold text-[#f3f2f2]"
          style={{ backgroundColor: 'var(--brand-primary, #ec3013)' }}
        >
          Dashboard
        </div>
        <button
          type="button"
          disabled
          title="Coming soon"
          className="flex cursor-not-allowed items-center justify-between px-[18px] py-[9px] text-left text-sm text-[rgba(243,242,242,0.85)] opacity-60"
        >
          <span>Discrepancies</span>
          <SoonBadge />
        </button>
        <button
          type="button"
          disabled
          title="Coming soon"
          className="flex cursor-not-allowed items-center justify-between px-[18px] py-[9px] text-left text-sm text-[rgba(243,242,242,0.85)] opacity-60"
        >
          <span>Invoices</span>
          <SoonBadge />
        </button>

        <div className="px-[18px] pb-2 pt-[22px] text-[11px] font-extrabold uppercase tracking-[0.1em] text-[rgba(243,242,242,0.5)]">
          Records
        </div>
        <button
          type="button"
          disabled
          title="Coming soon"
          className="flex cursor-not-allowed items-center justify-between px-[18px] py-[9px] text-left text-sm text-[rgba(243,242,242,0.85)] opacity-60"
        >
          <span>Audit log</span>
          <SoonBadge />
        </button>
        <button
          type="button"
          disabled
          title="Coming soon"
          className="flex cursor-not-allowed items-center justify-between px-[18px] py-[9px] text-left text-sm text-[rgba(243,242,242,0.85)] opacity-60"
        >
          <span>Settings</span>
          <SoonBadge />
        </button>

        <div className="mt-[22px] border-t-2 border-[rgba(243,242,242,0.25)] pt-3.5">
          <div className="px-[18px] pb-2 text-[11px] font-extrabold uppercase tracking-[0.1em] text-[rgba(243,242,242,0.5)]">
            Saved views
          </div>
          <button
            type="button"
            disabled
            title="Coming soon"
            className="flex w-full cursor-not-allowed items-center justify-between px-[18px] py-[7px] text-left text-[13px] text-[rgba(243,242,242,0.75)] opacity-60"
          >
            <span>Mine, over $500</span>
            <SoonBadge />
          </button>
          <button
            type="button"
            disabled
            title="Coming soon"
            className="flex w-full cursor-not-allowed items-center justify-between px-[18px] py-[7px] text-left text-[13px] text-[rgba(243,242,242,0.75)] opacity-60"
          >
            <span>Estes accessorials</span>
            <SoonBadge />
          </button>
          <button
            type="button"
            disabled
            title="Coming soon"
            className="flex w-full cursor-not-allowed items-center justify-between px-[18px] py-[7px] text-left text-[13px] text-[rgba(243,242,242,0.75)] opacity-60"
          >
            <span>Aging &gt; 5 days</span>
            <SoonBadge />
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
