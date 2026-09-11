import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sidebar } from '../src/components/Sidebar.js';

describe('Sidebar', () => {
  it('AC2: renders the default platform swatch, not a Customer logo, when no branding is configured', () => {
    render(<Sidebar />);
    expect(screen.getByTestId('brand-mark-default')).toBeInTheDocument();
    expect(screen.queryByTestId('brand-mark-logo')).not.toBeInTheDocument();
    expect(screen.getByText('Freight Auditor')).toBeInTheDocument();
  });

  it("AC1: renders the Customer's logo instead of the platform swatch when branding is configured", () => {
    render(
      <Sidebar
        branding={{ branded: true, logoUrl: 'https://cdn.example.com/bank-a/logo.png', primaryColor: '#111111', secondaryColor: '#222222' }}
      />,
    );
    expect(screen.getByTestId('brand-mark-logo')).toHaveAttribute('src', 'https://cdn.example.com/bank-a/logo.png');
    expect(screen.queryByTestId('brand-mark-default')).not.toBeInTheDocument();
  });

  it('86e36xk28 AC2: the header bottom border and footer top border are 1px (no border-b-2/border-t-2)', () => {
    render(<Sidebar />);
    const header = screen.getByTestId('sidebar-header');
    expect(header).not.toHaveClass('border-b-2');
    expect(header).toHaveClass('border-b');

    const footer = screen.getByTestId('sidebar-footer');
    expect(footer).not.toHaveClass('border-t-2');
    expect(footer).toHaveClass('border-t');
  });

  it('86e36xk28 AC3: nav item and saved-view labels no longer carry font-extrabold', () => {
    render(<Sidebar />);
    expect(screen.getByTestId('sidebar-active-item')).not.toHaveClass('font-extrabold');
    // 86e37r2rm/86e37r2rv/86e37r2rt/86e37r2t4/86e37r2t6/86e37r2t7/86e37r2t8:
    // "Discrepancies", "Audit log", "Invoices", "Settings", "Mine, over
    // $500", "Aging > 5 days", and "Estes accessorials" are now real <a>s,
    // not <button>s -- checked via .closest('a') below, same guarantee,
    // updated selector for the new DOM shape.
    for (const label of [
      'Discrepancies',
      'Audit log',
      'Invoices',
      'Settings',
      'Mine, over $500',
      'Aging > 5 days',
      'Estes accessorials',
    ]) {
      expect(screen.getByText(label).closest('a')).not.toHaveClass('font-extrabold');
    }
  });

  it('86e36xk28 AC4: the active "Dashboard" row no longer sets a full opaque brand-color background fill', () => {
    render(<Sidebar />);
    const active = screen.getByTestId('sidebar-active-item');
    expect(active.style.backgroundColor).not.toBe('var(--brand-primary, #ec3013)');
    expect(active.className).not.toMatch(/\bbg-sidebar-bg\b/);
  });

  it('86e36xk28 AC5: the active row accent still resolves through var(--brand-primary, ...) when branding overrides it', () => {
    render(<Sidebar branding={{ branded: true, logoUrl: 'https://cdn.example.com/bank-a/logo.png', primaryColor: '#111111', secondaryColor: '#222222' }} />);
    const active = screen.getByTestId('sidebar-active-item');
    expect(active.style.borderLeftColor).toBe('var(--brand-primary, #ec3013)');
  });

  it('86e37r2rm AC2: "Discrepancies" is a real link, not disabled, cursor-not-allowed, or Soon-badged', () => {
    render(<Sidebar />);
    const link = screen.getByText('Discrepancies').closest('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', '#/discrepancies');
    expect(link).not.toHaveAttribute('disabled');
    expect(link?.className).not.toMatch(/cursor-not-allowed/);
    expect(link?.querySelector('span')).toBeNull();
  });

  it('86e37r2rm: "Dashboard" stays the active item by default (currentPath prop omitted)', () => {
    render(<Sidebar />);
    const active = screen.getByTestId('sidebar-active-item');
    expect(active).toHaveTextContent('Dashboard');
  });

  it('86e37r2rm: "Discrepancies" becomes the active item when currentPath is /discrepancies, and Dashboard is no longer active', () => {
    render(<Sidebar currentPath="/discrepancies" />);
    const active = screen.getByTestId('sidebar-active-item');
    expect(active).toHaveTextContent('Discrepancies');
    expect(screen.getByText('Dashboard')).not.toHaveClass('bg-sidebar-active');
  });

  it('86e37r2rv AC4: "Audit log" is a real link, not disabled, cursor-not-allowed, or Soon-badged', () => {
    render(<Sidebar />);
    const link = screen.getByText('Audit log').closest('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', '#/audit-log');
    expect(link).not.toHaveAttribute('disabled');
    expect(link?.className).not.toMatch(/cursor-not-allowed/);
    expect(link?.querySelector('span')).toBeNull();
  });

  it('86e37r2rv: "Audit log" becomes the active item when currentPath is /audit-log, and Dashboard is no longer active', () => {
    render(<Sidebar currentPath="/audit-log" />);
    const active = screen.getByTestId('sidebar-active-item');
    expect(active).toHaveTextContent('Audit log');
    expect(screen.getByText('Dashboard')).not.toHaveClass('bg-sidebar-active');
  });

  it('86e37r2rt AC4: "Invoices" is a real link, not disabled, cursor-not-allowed, or Soon-badged', () => {
    render(<Sidebar />);
    const link = screen.getByText('Invoices').closest('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', '#/invoices');
    expect(link).not.toHaveAttribute('disabled');
    expect(link?.className).not.toMatch(/cursor-not-allowed/);
    expect(link?.querySelector('span')).toBeNull();
  });

  it('86e37r2rt: "Invoices" becomes the active item when currentPath is /invoices, and Dashboard is no longer active', () => {
    render(<Sidebar currentPath="/invoices" />);
    const active = screen.getByTestId('sidebar-active-item');
    expect(active).toHaveTextContent('Invoices');
    expect(screen.getByText('Dashboard')).not.toHaveClass('bg-sidebar-active');
  });

  it('86e37r2t8 AC6: "Mine, over $500" is a real link to the assignee+minAmount preset, not disabled, cursor-not-allowed, or Soon-badged', () => {
    render(<Sidebar />);
    const link = screen.getByText('Mine, over $500').closest('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', '#/discrepancies?assignee=me&minAmount=500');
    expect(link).not.toHaveAttribute('disabled');
    expect(link?.className).not.toMatch(/cursor-not-allowed/);
    expect(link?.querySelector('span')).toBeNull();
  });

  it('86e37r2t4 AC5: "Settings" is a real link, not disabled, cursor-not-allowed, or Soon-badged', () => {
    render(<Sidebar />);
    const link = screen.getByText('Settings').closest('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', '#/settings');
    expect(link).not.toHaveAttribute('disabled');
    expect(link?.className).not.toMatch(/cursor-not-allowed/);
    expect(link?.querySelector('span')).toBeNull();
  });

  it('86e37r2t7 AC4: "Estes accessorials" is a real link to the carrier+category preset, not disabled, cursor-not-allowed, or Soon-badged', () => {
    render(<Sidebar />);
    const link = screen.getByText('Estes accessorials').closest('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', '#/discrepancies?carrier=Estes&category=accessorial');
    expect(link).not.toHaveAttribute('disabled');
    expect(link?.className).not.toMatch(/cursor-not-allowed/);
    expect(link?.querySelector('span')).toBeNull();
  });

  it('86e37r2t4: "Settings" becomes the active item when currentPath is /settings, and Dashboard is no longer active', () => {
    render(<Sidebar currentPath="/settings" />);
    const active = screen.getByTestId('sidebar-active-item');
    expect(active).toHaveTextContent('Settings');
    expect(screen.getByText('Dashboard')).not.toHaveClass('bg-sidebar-active');
  });

  it('86e37r2t6 AC4: "Aging > 5 days" is a real link to the minAgeDays preset, not disabled, cursor-not-allowed, or Soon-badged', () => {
    render(<Sidebar />);
    const link = screen.getByText('Aging > 5 days').closest('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', '#/discrepancies?minAgeDays=5');
    expect(link).not.toHaveAttribute('disabled');
    expect(link?.className).not.toMatch(/cursor-not-allowed/);
    expect(link?.querySelector('span')).toBeNull();
  });
});
