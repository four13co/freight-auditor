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
});
