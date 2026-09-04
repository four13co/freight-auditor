import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PortalApp } from '../src/components/PortalApp.js';

/**
 * 86e2zfjmb: the client portal shell + navigation itself (App.tsx's own
 * tests cover WHICH actors land here, not what's rendered once they do).
 *
 * 86e34cfpd: every named view fetches on mount once wired to a real route,
 * so this suite stubs global fetch (mirroring every one of the 10 views'
 * own *.test.tsx precedent) -- rejecting uniformly is enough here since
 * these tests only assert which section renders, not its loaded content.
 */
describe('PortalApp', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('mocked')));
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

  it('AC3: the default landing route shows a placeholder empty state, never a blank screen', () => {
    render(<PortalApp />);

    expect(screen.getByTestId('portal-placeholder')).toBeInTheDocument();
    expect(screen.getByTestId('portal-placeholder')).toHaveTextContent(/coming soon/i);
  });

  /**
   * 86e34cfpd AC1: supersedes this suite's prior "every nav section shows
   * its own placeholder" coverage -- now that 86e2zfjx3's 10 views are
   * wired in, none of these 5 named sections has "no content view built
   * yet" to prove a placeholder for; a real view renders for every one
   * instead. The prior guarantee this replaced (no blank screen ever) is
   * still exercised here, just against the new expected content: only the
   * wildcard "*" route (covered above) still falls through to ComingSoon.
   */
  it('AC1: navigating to a nav section renders its real content view, never the placeholder', async () => {
    render(<PortalApp />);

    await userEvent.click(screen.getByRole('link', { name: 'Invoices' }));

    expect(screen.getByTestId('client-invoices-view')).toBeVisible();
    expect(screen.queryByTestId('portal-placeholder')).not.toBeInTheDocument();
  });

  it('AC1: every nav section renders its own real content view', async () => {
    render(<PortalApp />);
    const user = userEvent.setup();

    const expectedTestIdBySection: Record<string, string> = {
      Findings: 'client-findings-view',
      Disputes: 'client-dispute-detail-view',
      'Claims & Recovery': 'client-claim-view',
      'Audit log': 'client-audit-log-view',
    };

    for (const [label, testId] of Object.entries(expectedTestIdBySection)) {
      await user.click(screen.getByRole('link', { name: label }));
      expect(screen.getByTestId(testId)).toBeVisible();
      expect(screen.queryByTestId('portal-placeholder')).not.toBeInTheDocument();
    }
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
