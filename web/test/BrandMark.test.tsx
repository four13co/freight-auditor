import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrandMark } from '../src/components/BrandMark.js';

describe('BrandMark', () => {
  it('AC2: renders the default platform swatch (no <img>) when branding is unset', () => {
    render(<BrandMark />);
    expect(screen.getByTestId('brand-mark-default')).toBeInTheDocument();
    expect(screen.queryByTestId('brand-mark-logo')).not.toBeInTheDocument();
  });

  it('AC2: renders the default platform swatch when branding is explicitly unbranded', () => {
    render(<BrandMark branding={{ branded: false, logoUrl: null, primaryColor: null, secondaryColor: null }} />);
    expect(screen.getByTestId('brand-mark-default')).toBeInTheDocument();
    expect(screen.queryByTestId('brand-mark-logo')).not.toBeInTheDocument();
  });

  it('AC1: renders the Customer\'s logo image when branded', () => {
    render(
      <BrandMark
        branding={{ branded: true, logoUrl: 'https://cdn.example.com/bank-a/logo.png', primaryColor: '#111111', secondaryColor: null }}
      />,
    );
    const logo = screen.getByTestId('brand-mark-logo');
    expect(logo).toHaveAttribute('src', 'https://cdn.example.com/bank-a/logo.png');
    expect(screen.queryByTestId('brand-mark-default')).not.toBeInTheDocument();
  });
});
