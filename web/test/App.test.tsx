import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from '@/App';

describe('App scaffold', () => {
  it('renders the app name via the @/ path alias', () => {
    render(<App />);
    expect(screen.getByText('Freight Auditor')).toBeInTheDocument();
  });

  it('applies Tailwind utility classes to the root element', () => {
    render(<App />);
    const main = screen.getByRole('main');
    expect(main).toHaveClass('flex', 'min-h-screen', 'items-center', 'justify-center');
  });
});
