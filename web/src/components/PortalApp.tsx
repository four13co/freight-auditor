import { useState } from 'react';
import { HashRouter, NavLink, Route, Routes } from 'react-router-dom';
import type { Branding } from '../lib/api.js';
import { BrandMark } from './BrandMark.js';
import { ClientInvoicesView } from './ClientInvoicesView.js';
import { ClientScorecardView } from './ClientScorecardView.js';
import { ClientFindingsView } from './ClientFindingsView.js';
import { ClientFindingEvidenceView } from './ClientFindingEvidenceView.js';
import { ClientDisputeDetailView } from './ClientDisputeDetailView.js';
import { ClientDisputeCommunicationsView } from './ClientDisputeCommunicationsView.js';
import { ClientClaimView } from './ClientClaimView.js';
import { ClientClaimDocumentsView } from './ClientClaimDocumentsView.js';
import { ClientRecoveryReport } from './ClientRecoveryReport.js';
import { ClientAuditLogView } from './ClientAuditLogView.js';

/**
 * Client portal shell + navigation (P6.A.1). The chrome portal members
 * (client_viewer/client_admin) land in once App.tsx routes a real,
 * non-internal session here. 86e34cfpd wired the 10 B.1-B.6 content views
 * (built, RTL-tested, but previously unmounted -- 86e2zfjx3) into the 5
 * named routes below; only the wildcard "*" route still renders the
 * ComingSoon placeholder, reusing Sidebar.tsx's existing dark-sidebar/
 * red-active-state visual language rather than inventing a second one.
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

/**
 * 86e34cfpd: none of the 10 views' own backends expose a list-of-disputes /
 * list-of-claims / list-of-audit-runs endpoint to drive a real row-click
 * selection flow (ClientFindingsView and ClientInvoicesView are the only
 * list views among the 10, and neither takes a selection callback -- the
 * No-gos forbid changing their internal logic). This minimal id-entry form
 * is the smallest faithful seam that makes the nullable-id views reachable
 * at all without inventing new list UI/API out of this task's routing-only
 * scope; a real row-driven picker is a follow-up once a list endpoint
 * exists.
 */
function IdPicker({ label, testId, onSelect }: { label: string; testId: string; onSelect: (id: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <form
      data-testid={testId}
      className="mb-2 flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = value.trim();
        if (trimmed) onSelect(trimmed);
      }}
    >
      <label className="flex flex-col text-xs font-semibold">
        {label}
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="border border-[rgba(32,30,29,.3)] px-2 py-1 text-xs font-normal"
        />
      </label>
      <button type="submit" className="border border-[rgba(32,30,29,.3)] px-2 py-1 text-xs font-semibold">
        View
      </button>
    </form>
  );
}

function InvoicesSection() {
  const [auditRunId, setAuditRunId] = useState<string | null>(null);
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-auto p-3">
      <ClientInvoicesView />
      <IdPicker label="Audit run ID" testId="portal-scorecard-picker" onSelect={setAuditRunId} />
      {auditRunId !== null ? (
        <ClientScorecardView auditRunId={auditRunId} />
      ) : (
        <span role="status" data-testid="client-scorecard-not-selected" className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">
          Select an audit run to view its scorecard.
        </span>
      )}
    </div>
  );
}

function FindingsSection() {
  const [findingId, setFindingId] = useState<string | null>(null);
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-auto p-3">
      <ClientFindingsView />
      <IdPicker label="Finding ID" testId="portal-finding-evidence-picker" onSelect={setFindingId} />
      <ClientFindingEvidenceView findingId={findingId} />
    </div>
  );
}

function DisputesSection() {
  const [disputeId, setDisputeId] = useState<string | null>(null);
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-auto p-3">
      <IdPicker label="Dispute ID" testId="portal-dispute-picker" onSelect={setDisputeId} />
      <ClientDisputeDetailView disputeId={disputeId} />
      <ClientDisputeCommunicationsView disputeId={disputeId} />
    </div>
  );
}

function ClaimsSection() {
  const [claimId, setClaimId] = useState<string | null>(null);
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-auto p-3">
      <IdPicker label="Claim ID" testId="portal-claim-picker" onSelect={setClaimId} />
      <ClientClaimView claimId={claimId} />
      <ClientClaimDocumentsView claimId={claimId} />
      <ClientRecoveryReport />
    </div>
  );
}

function AuditLogSection() {
  return (
    <div className="flex flex-1 flex-col overflow-auto p-3">
      <ClientAuditLogView />
    </div>
  );
}

function PortalShellInner({ branding }: { branding?: Branding | null }) {
  return (
    <div data-testid="portal-shell" className="flex h-screen">
      <PortalNav branding={branding} />
      <div className="flex flex-1 flex-col">
        <Routes>
          <Route path="/invoices" element={<InvoicesSection />} />
          <Route path="/findings" element={<FindingsSection />} />
          <Route path="/disputes" element={<DisputesSection />} />
          <Route path="/claims" element={<ClaimsSection />} />
          <Route path="/audit-log" element={<AuditLogSection />} />
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
