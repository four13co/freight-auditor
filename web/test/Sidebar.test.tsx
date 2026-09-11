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
    // 86e37r2rm/86e37r2rt: "Discrepancies" and "Invoices" are now real <a>s,
    // not <button>s -- checked via .closest('a') below, same guarantee,
    // updated selector for the new DOM shape. The other 4 still-disabled
    // items are unaffected.
    expect(screen.getByText('Discrepancies').closest('a')).not.toHaveClass('font-extrabold');
    expect(screen.getByText('Invoices').closest('a')).not.toHaveClass('font-extrabold');
    for (const label of ['Audit log', 'Settings', 'Mine, over $500', 'Estes accessorials']) {
      expect(screen.getByText(label).closest('button')).not.toHaveClass('font-extrabold');
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
});
