import { HashRouter, NavLink, Route, Routes } from 'react-router-dom';
import type { Branding } from '../lib/api.js';
import { BrandMark } from './BrandMark.js';

/**
 * Client portal shell + navigation (P6.A.1). The chrome portal members
 * (client_viewer/client_admin) land in once App.tsx routes a real,
 * non-internal session here; the actual content views (Invoices, Findings,
 * Disputes, Claims & Recovery, Audit log -- B.1-B.6) don't exist yet, so
 * every route renders a placeholder empty state, reusing Sidebar.tsx's
 * existing dark-sidebar/red-active-state visual language rather than
 * inventing a second one.
 *
 * HashRouter, not BrowserRouter: static-routes.ts's @fastify/static mount
 * has no SPA catch-all fallback to index.html for an arbitrary path, and
 * adding one is a server-routing change this task's Solution doesn't call
 * for. HashRouter keeps every route under the single `/` path the server
 * already serves (`/#/invoices`, never a real `/invoices` request), so a
 * hard reload on any section works today with no backend change -- a real
 * catch-all + clean URLs is a reasonable follow-up once B.1-B.7 give these
 * routes actual content worth deep-linking to.
 */
const SOON_LABEL_CLASS = 'text-[15px] font-semibold text-[rgba(32,30,29,0.55)]';

interface NavItem {
  path: string;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { path: '/invoices', label: 'Invoices' },
  { path: '/findings', label: 'Findings' },
  { path: '/disputes', label: 'Disputes' },
  { path: '/claims', label: 'Claims & Recovery' },
  { path: '/audit-log', label: 'Audit log' },
];

function ComingSoon({ label }: { label: string }) {
  return (
    <div data-testid="portal-placeholder" className="flex flex-1 items-center justify-center">
      <span className={SOON_LABEL_CLASS}>{label} -- coming soon</span>
    </div>
  );
}

/**
 * 86e320pkc: this is one of the two surfaces "any user -- the Customer's own
 * users, a Grand Customer, or a Grand Vendor" actually lands on, per the
 * item's own framing -- BrandMark swaps the swatch for a Customer's logo
 * when configured, and the active nav background reads --brand-primary
 * (App.tsx sets it once branding resolves) with a CSS fallback to the
 * platform's own red, so an unbranded visit renders pixel-identical to
 * before.
 */
function PortalNav({ branding }: { branding?: Branding | null }) {
  return (
    <div className="flex w-[228px] flex-none flex-col bg-[#201e1d] text-[#f3f2f2]">
      <div className="flex h-16 flex-none items-center gap-2.5 border-b-2 border-[rgba(243,242,242,0.25)] px-[18px]">
        <BrandMark branding={branding} />
        <div className="text-[15px] font-extrabold tracking-[-0.015em]" style={{ color: 'var(--brand-secondary, #f3f2f2)' }}>
          Client Portal
        </div>
      </div>
      <div className="flex flex-col py-[18px]">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            data-testid="portal-nav-item"
            className={({ isActive }) =>
              `px-[18px] py-[9px] text-sm ${
                isActive ? 'font-extrabold text-[#f3f2f2]' : 'font-semibold text-[rgba(243,242,242,0.85)]'
              }`
            }
            style={({ isActive }) => (isActive ? { backgroundColor: 'var(--brand-primary, #ec3013)' } : undefined)}
          >
            {item.label}
          </NavLink>
        ))}
      </div>
    </div>
  );
}

function PortalShellInner({ branding }: { branding?: Branding | null }) {
  return (
    <div data-testid="portal-shell" className="flex h-screen">
      <PortalNav branding={branding} />
      <div className="flex flex-1 flex-col">
        <Routes>
          <Route path="/invoices" element={<ComingSoon label="Invoices" />} />
          <Route path="/findings" element={<ComingSoon label="Findings" />} />
          <Route path="/disputes" element={<ComingSoon label="Disputes" />} />
          <Route path="/claims" element={<ComingSoon label="Claims & Recovery" />} />
          <Route path="/audit-log" element={<ComingSoon label="Audit log" />} />
          <Route path="*" element={<ComingSoon label="Overview" />} />
        </Routes>
      </div>
    </div>
  );
}

export function PortalApp({ branding }: { branding?: Branding | null } = {}) {
  return (
    <HashRouter>
      <PortalShellInner branding={branding} />
    </HashRouter>
  );
}
