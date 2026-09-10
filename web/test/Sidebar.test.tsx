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
    for (const label of ['Discrepancies', 'Invoices', 'Audit log', 'Settings', 'Mine, over $500', 'Estes accessorials']) {
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
});
