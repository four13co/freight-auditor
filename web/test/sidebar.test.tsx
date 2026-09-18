import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Sidebar } from '@/components/navigation/Sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';

const useAuthMock = vi.fn();
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => useAuthMock(),
}));

function renderSidebar({ collapsed = false, path = '/employee/home' } = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TooltipProvider>
        <Sidebar collapsed={collapsed} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe('Sidebar', () => {
  it('AC: each role sees only their nav items', () => {
    useAuthMock.mockReturnValue({ role: 'vendor' });
    renderSidebar({ path: '/vendor/home' });

    expect(screen.getByRole('link', { name: /home/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /users/i })).toBeInTheDocument();
    expect(screen.queryByText('Rules & Rates')).not.toBeInTheDocument();
    expect(screen.queryByText('Accounts')).not.toBeInTheDocument();
  });

  it('AC: the active route is visually highlighted', () => {
    useAuthMock.mockReturnValue({ role: 'employee' });
    renderSidebar({ path: '/employee/users' });

    expect(screen.getByRole('link', { name: /users/i })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /home/i })).not.toHaveAttribute('aria-current');
  });

  it('AC: nested Accounts → Clients → Vendors collapses/expands', async () => {
    const user = userEvent.setup();
    useAuthMock.mockReturnValue({ role: 'employee' });
    renderSidebar({ path: '/employee/home' });

    // Not on an active descendant route -- starts collapsed.
    expect(screen.queryByRole('link', { name: 'Clients' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /expand accounts/i }));
    expect(screen.getByRole('link', { name: 'Clients' })).toBeInTheDocument();
  });

  it('AC: a nested route auto-expands its ancestor group', () => {
    useAuthMock.mockReturnValue({ role: 'employee' });
    renderSidebar({ path: '/employee/accounts/clients' });

    expect(screen.getByRole('link', { name: 'Clients' })).toHaveAttribute('aria-current', 'page');
  });

  it('AC: renders only icons when collapsed (labels hidden, tooltip available)', () => {
    useAuthMock.mockReturnValue({ role: 'vendor' });
    renderSidebar({ collapsed: true, path: '/vendor/home' });

    expect(screen.queryByText('Home')).not.toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });
});
