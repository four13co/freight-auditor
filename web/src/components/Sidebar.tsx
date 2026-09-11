/**
 * Nav sidebar matching the 1B Console mockup. "Dashboard" is the current
 * view (its red highlight isn't a dead link, it's active-state).
 * Discrepancies/Invoices/Audit log/Settings have no other route in this app
 * (86e2uutk8). All three saved views ("Mine, over $500", "Estes
 * accessorials", "Aging > 5 days") are now real filtered links.
 */
import type { ReactNode } from 'react';
import type { Branding } from '../lib/api.js';
import { BrandMark } from './BrandMark.js';

/**
 * 86e37r2rm: a real, routed nav item (as opposed to the still-disabled
 * placeholder buttons below) -- a plain `<a>`, not react-router's NavLink,
 * for the same reason 86e37r2rb chose one for "Dashboard": Sidebar.test.tsx
 * renders `<Sidebar />` standalone with no Router ancestor, and NavLink
 * throws outside one. `currentPath` (passed down by whatever has Router
 * context -- Dashboard.tsx via useLocation) drives the same active-state
 * styling "Dashboard" already had, now conditional instead of permanent.
 */
function NavAnchor({ href, path, currentPath, children }: { href: string; path: string; currentPath: string; children: ReactNode }) {
  const active = currentPath === path;
  return (
    <a
      href={href}
      data-testid={active ? 'sidebar-active-item' : undefined}
      className={`border-l-2 px-[16px] py-[9px] text-sm font-medium ${
        active ? 'bg-sidebar-active text-sidebar-fg' : 'border-transparent text-sidebar-fg-85'
      }`}
      style={active ? { borderLeftColor: 'var(--brand-primary, #ec3013)' } : undefined}
    >
      {children}
    </a>
  );
}

/**
 * 86e320pkc: the logo swatch and "Dashboard" active-item background are this
 * chrome's own branding surface -- BrandMark swaps the swatch for a
 * Customer's logo when configured, and the active background reads
 * --brand-primary (App.tsx sets it once branding resolves) with a CSS
 * fallback to the platform's own red, so an unbranded visit renders
 * pixel-identical to before.
 *
 * 86e37r2rb: "Dashboard" is now a real `<a href="#/">` (Dashboard.tsx wraps
 * its content in a HashRouter), not a plain `<a>`-via-react-router NavLink --
 * a real anchor keeps this component renderable standalone with no Router
 * ancestor, exactly as Sidebar.test.tsx already does.
 *
 * 86e37r2rm: "Discrepancies" is the first follow-up to get the same
 * treatment (see NavAnchor above) -- active styling is now conditional on
 * `currentPath` rather than permanent, since there are two real routes.
 * `currentPath` defaults to "/" so every existing standalone
 * `render(<Sidebar />)` call (no Router, no prop) still sees "Dashboard" as
 * the active item, unchanged.
 */
export function Sidebar({ branding, currentPath = '/' }: { branding?: Branding | null; currentPath?: string } = {}) {
  return (
    <div className="flex w-[228px] flex-none flex-col bg-sidebar-bg text-sidebar-fg">
      <div
        data-testid="sidebar-header"
        className="flex h-16 flex-none items-center gap-2.5 border-b border-sidebar-border px-[18px]"
      >
        <BrandMark branding={branding} />
        <div className="text-[15px] font-extrabold tracking-[-0.015em]" style={{ color: 'var(--brand-secondary, #f3f2f2)' }}>
          Freight Auditor
        </div>
      </div>

      <div className="flex flex-col py-[18px]">
        <div className="px-[18px] pb-2 text-[11px] font-extrabold uppercase tracking-[0.1em] text-sidebar-fg-50">
          Audit
        </div>
        <NavAnchor href="#/" path="/" currentPath={currentPath}>
          Dashboard
        </NavAnchor>
        <NavAnchor href="#/discrepancies" path="/discrepancies" currentPath={currentPath}>
          Discrepancies
        </NavAnchor>
        <NavAnchor href="#/invoices" path="/invoices" currentPath={currentPath}>
          Invoices
        </NavAnchor>

        <div className="px-[18px] pb-2 pt-[22px] text-[11px] font-extrabold uppercase tracking-[0.1em] text-sidebar-fg-50">
          Records
        </div>
        <NavAnchor href="#/audit-log" path="/audit-log" currentPath={currentPath}>
          Audit log
        </NavAnchor>
        <NavAnchor href="#/settings" path="/settings" currentPath={currentPath}>
          Settings
        </NavAnchor>

        <div className="mt-[22px] border-t border-sidebar-border pt-3.5">
          <div className="px-[18px] pb-2 text-[11px] font-extrabold uppercase tracking-[0.1em] text-sidebar-fg-50">
            Saved views
          </div>
          <a
            href="#/discrepancies?assignee=me&minAmount=500"
            className="flex w-full items-center px-[18px] py-[7px] text-left text-[13px] text-sidebar-fg-75"
          >
            Mine, over $500
          </a>
          <a
            href="#/discrepancies?carrier=Estes&category=accessorial"
            className="flex w-full items-center px-[18px] py-[7px] text-left text-[13px] text-sidebar-fg-75"
          >
            Estes accessorials
          </a>
          <a
            href="#/discrepancies?minAgeDays=5"
            className="flex w-full items-center px-[18px] py-[7px] text-left text-[13px] text-sidebar-fg-75"
          >
            Aging &gt; 5 days
          </a>
        </div>
      </div>

      <div
        data-testid="sidebar-footer"
        className="mt-auto flex flex-col gap-0.5 border-t border-sidebar-border px-[18px] py-3.5"
      >
        <span className="text-[13px] font-semibold">Dana Mercer</span>
        <span className="text-[11px] text-sidebar-fg-55">Ops analyst · Four13</span>
      </div>
    </div>
  );
}
