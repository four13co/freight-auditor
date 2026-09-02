import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PortalApp } from '../src/components/PortalApp.js';

/**
 * 86e2zfjmb: the client portal shell + navigation itself (App.tsx's own
 * tests cover WHICH actors land here, not what's rendered once they do).
 */
describe('PortalApp', () => {
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

  it('AC3: navigating to a nav section with no content view built yet shows its own placeholder, never a blank screen', async () => {
    render(<PortalApp />);

    await userEvent.click(screen.getByRole('link', { name: 'Invoices' }));

    expect(screen.getByTestId('portal-placeholder')).toBeVisible();
    expect(screen.getByTestId('portal-placeholder')).toHaveTextContent(/invoices.*coming soon/i);
  });

  it('AC3: every nav section renders its own labeled placeholder', async () => {
    render(<PortalApp />);
    const user = userEvent.setup();

    for (const label of ['Findings', 'Disputes', 'Claims & Recovery', 'Audit log']) {
      await user.click(screen.getByRole('link', { name: label }));
      expect(screen.getByTestId('portal-placeholder')).toHaveTextContent(new RegExp(`${label}.*coming soon`, 'i'));
    }
  });
});
