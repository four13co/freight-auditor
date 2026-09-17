import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from '@/App';

describe('App', () => {
  it('renders the app name via the @/ path alias', () => {
    render(<App />);
    expect(screen.getByText('Freight Auditor')).toBeInTheDocument();
  });

  it('applies Tailwind utility classes to the root element', () => {
    // Proves the Tailwind pipeline actually applies real utility classes to
    // rendered output. Was asserted against home.tsx's own page frame
    // (86e3a6r40); that frame moved to AppLayout's <main> (86e3a6r8z) once
    // AppLayout became the page's sole <main> landmark -- same guarantee,
    // now anchored to the element that owns it.
    render(<App />);
    const main = screen.getByRole('main');
    expect(main).toHaveClass('flex-1', 'overflow-y-auto', 'p-6');
  });

  it('AC (86e3a6rbe): dev-mode default landing renders the Employee home screen', () => {
    render(<App />);
    expect(screen.getByText(/Good (morning|afternoon|evening), Dev/)).toBeInTheDocument();
    expect(screen.getByText('Recent activity')).toBeInTheDocument();
    expect(screen.getByText('Quick actions')).toBeInTheDocument();
  });
});
