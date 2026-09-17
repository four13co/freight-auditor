import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { RequireRole } from '@/components/require-role';

const useAuthMock = vi.fn();
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => useAuthMock(),
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<div>home</div>} />
        <Route element={<RequireRole roles={['employee']} />}>
          <Route path="/employee-only" element={<div>employee area</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireRole', () => {
  it('renders nothing while loading', () => {
    useAuthMock.mockReturnValue({ role: null, isLoading: true });
    renderAt('/employee-only');
    expect(screen.queryByText('employee area')).not.toBeInTheDocument();
    expect(screen.queryByText('home')).not.toBeInTheDocument();
  });

  it("redirects home when the user's role doesn't match", () => {
    useAuthMock.mockReturnValue({ role: 'client', isLoading: false });
    renderAt('/employee-only');
    expect(screen.getByText('home')).toBeInTheDocument();
  });

  it('renders the guarded route when the role matches', () => {
    useAuthMock.mockReturnValue({ role: 'employee', isLoading: false });
    renderAt('/employee-only');
    expect(screen.getByText('employee area')).toBeInTheDocument();
  });
});
