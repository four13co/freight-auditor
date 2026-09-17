import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { RequireAuth } from '@/components/require-auth';

const useAuthMock = vi.fn();
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => useAuthMock(),
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<div>login page</div>} />
        <Route element={<RequireAuth />}>
          <Route path="/" element={<div>protected home</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireAuth', () => {
  it('renders nothing while auth is still loading', () => {
    useAuthMock.mockReturnValue({ isAuthenticated: false, isLoading: true });
    renderAt('/');
    expect(screen.queryByText('protected home')).not.toBeInTheDocument();
    expect(screen.queryByText('login page')).not.toBeInTheDocument();
  });

  it('redirects to /login when unauthenticated', () => {
    useAuthMock.mockReturnValue({ isAuthenticated: false, isLoading: false });
    renderAt('/');
    expect(screen.getByText('login page')).toBeInTheDocument();
  });

  it('renders the protected route when authenticated', () => {
    useAuthMock.mockReturnValue({ isAuthenticated: true, isLoading: false });
    renderAt('/');
    expect(screen.getByText('protected home')).toBeInTheDocument();
  });
});
