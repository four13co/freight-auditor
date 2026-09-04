import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PortalApp } from '../src/components/PortalApp.js';

/**
 * 86e2zfjmb: the client portal shell + navigation itself (App.tsx's own
 * tests cover WHICH actors land here, not what's rendered once they do).
 */
describe('PortalApp', () => {
  // 86e34cfpd: every real view now mounted here self-fetches on mount/id
  // change. These tests only assert which container/testid is present, not
  // fetched content, so a rejected fetch (deterministic "error" branch for
  // every view, regardless of its own response shape) is enough -- avoids
  // a real network call from jsdom and avoids over-specifying each view's
  // own success-response contract, which its own component test already
  // covers.
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('AC2: renders the portal shell with a nav item for every B.1-B.7 section', () => {
    render(<PortalApp />);

    expect(screen.getByTestId('portal-shell')).toBeInTheDocument();
    const navItems = screen.getAllByTestId('portal-nav-item');
    expect(navItems.map((el) => el.textContent)).toEqual([
      'Invoices',
      'Findings',
      'Disputes',
      'Claims & Recovery',
      'Audit log',
    ]);
  });

  it('AC3: the default (unmatched) route still shows a placeholder empty state, never a blank screen', () => {
    render(<PortalApp />);

    expect(screen.getByTestId('portal-placeholder')).toBeInTheDocument();
    expect(screen.getByTestId('portal-placeholder')).toHaveTextContent(/overview.*coming soon/i);
  });

  // 86e34cfpd wired the 10 client-portal view components into these routes
  // (86e2zfjx3), replacing the ComingSoon placeholder each of them used to
  // show. This supersedes -- not silently drops -- the prior "every nav
  // section shows its own placeholder" coverage below: the same underlying
  // guarantee (a nav section never renders a blank screen) is still proven,
  // just against the real view container now that one exists.
  it('86e34cfpd: navigating to a nav section with a content view built renders the real view, never a blank screen', async () => {
    render(<PortalApp />);

    await userEvent.click(screen.getByRole('link', { name: 'Invoices' }));

    expect(screen.queryByTestId('portal-placeholder')).not.toBeInTheDocument();
    expect(screen.getByTestId('client-invoices-view')).toBeVisible();
  });

  it('86e34cfpd: every nav section renders its own real view container, never a blank screen', async () => {
    render(<PortalApp />);
    const user = userEvent.setup();

    const sectionsByNavLabel: Record<string, string> = {
      Findings: 'client-findings-view',
      Disputes: 'client-dispute-detail-view',
      'Claims & Recovery': 'client-claim-view',
      'Audit log': 'client-audit-log-view',
    };

    for (const [label, testId] of Object.entries(sectionsByNavLabel)) {
      await user.click(screen.getByRole('link', { name: label }));
      expect(screen.queryByTestId('portal-placeholder')).not.toBeInTheDocument();
      expect(screen.getByTestId(testId)).toBeVisible();
    }
  });

  // Regression test for PR #331's FAIL: ClientDisputeDetailView and
  // ClientDisputeCommunicationsView both call useFocusOnReady, so both
  // stealing focus at once from a single shared id was exactly the bug.
  // Submitting only the Dispute ID picker must never mount/ready the
  // Communications view.
  it('86e34cfpd: the Dispute ID picker only drives the detail view, not communications', async () => {
    render(<PortalApp />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('link', { name: 'Disputes' }));
    await user.type(screen.getByLabelText('Dispute ID'), 'd-1');
    await user.click(screen.getByTestId('portal-dispute-picker').querySelector('button')!);

    expect(screen.getByTestId('client-dispute-communications-not-selected')).toBeVisible();
  });

  it('86e320pkc AC2: renders the default platform swatch, not a Customer logo, when no branding is configured', () => {
    render(<PortalApp />);
    expect(screen.getByTestId('brand-mark-default')).toBeInTheDocument();
    expect(screen.queryByTestId('brand-mark-logo')).not.toBeInTheDocument();
  });

  it("86e320pkc AC1: renders the Customer's logo instead of the platform swatch when branding is configured", () => {
    render(
      <PortalApp
        branding={{ branded: true, logoUrl: 'https://cdn.example.com/bank-a/logo.png', primaryColor: '#111111', secondaryColor: '#222222' }}
      />,
    );
    expect(screen.getByTestId('brand-mark-logo')).toHaveAttribute('src', 'https://cdn.example.com/bank-a/logo.png');
    expect(screen.queryByTestId('brand-mark-default')).not.toBeInTheDocument();
  });
});
