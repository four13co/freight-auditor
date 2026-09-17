import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from '@/App';

describe('App', () => {
  it('renders the app name via the @/ path alias', () => {
    render(<App />);
    expect(screen.getByText('Freight Auditor')).toBeInTheDocument();
  });

  it('applies Tailwind utility classes to the root element', () => {
    render(<App />);
    const main = screen.getByRole('main');
    expect(main).toHaveClass('mx-auto', 'flex', 'min-h-screen', 'max-w-2xl');
  });

  it('renders the shadcn/ui smoke test surface: Card, Button, Input, Table', () => {
    render(<App />);
    expect(screen.getByText('shadcn/ui smoke test')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Primary action' })).toBeInTheDocument();
    expect(screen.getByLabelText('Carrier')).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('SH-1001')).toBeInTheDocument();
  });
});
