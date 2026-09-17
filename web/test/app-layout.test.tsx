import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import AppLayout from '@/layouts/AppLayout';

const useAuthMock = vi.fn();
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => useAuthMock(),
}));

const useTenantMock = vi.fn();
vi.mock('@/providers/TenantProvider', () => ({
  useTenant: () => useTenantMock(),
}));

const baseUser = {
  id: 'u1',
  email: 'analyst@example.com',
  name: 'Ada Analyst',
  role: 'employee' as const,
  isInternal: true,
  clientName: null,
};

function renderLayout(path = '/employee/clients') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TooltipProvider>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/employee/clients" element={<div>Clients page</div>} />
          </Route>
        </Routes>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useAuthMock.mockReturnValue({ user: baseUser, role: 'employee', logout: vi.fn() });
  useTenantMock.mockReturnValue({ options: [], activeClient: null, setActiveClient: vi.fn(), isLoading: false });
});

describe('AppLayout', () => {
  it('AC: renders sidebar, header, breadcrumb, and the outlet content', () => {
    renderLayout();

    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(screen.getByText('Clients page')).toBeInTheDocument();
    expect(screen.getByText('Freight Auditor')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(nav).getByRole('link', { name: 'Clients' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'breadcrumb' })).toHaveTextContent('Clients');
  });

  it("AC: the header's user menu trigger is wired to the signed-in user", () => {
    // The popover's *content* (email/role/logout) is exercised via a real
    // browser in this PR's visual check, not here: @base-ui/react's
    // Menu/Popover open-on-click doesn't fire in jsdom (no real pointer
    // capture/positioning), a known gap for this primitive family in this
    // test environment, not something this task's own code controls.
    renderLayout();

    const trigger = screen.getByRole('button', { name: /ada analyst/i });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveTextContent('Ada Analyst');
  });

  it('AC: sidebar collapse state persists across a remount (localStorage)', async () => {
    const user = userEvent.setup();
    const { unmount } = renderLayout();

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(localStorage.getItem('freight-auditor:sidebar-collapsed')).toBe('true');

    unmount();
    renderLayout();
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
  });
});
