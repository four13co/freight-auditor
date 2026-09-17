import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '@/app-routes';
import { AuthProvider } from '@/providers/auth-provider';

const devHeaderPathActiveMock = vi.fn();
vi.mock('@/lib/dev-auth', () => ({
  devHeaderPathActive: () => devHeaderPathActiveMock(),
}));

const useSessionMock = vi.fn();
vi.mock('@/lib/auth-client', () => ({
  authClient: { signIn: { email: vi.fn() } },
  useSession: () => useSessionMock(),
  signOut: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  CLIENT_ID_STORAGE_KEY: 'freight-auditor:client-id',
  fetchActorContext: vi.fn().mockResolvedValue({ isInternal: false, role: null, clientName: null }),
  fetchAndStoreClientId: vi.fn().mockResolvedValue(undefined),
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('AppRoutes', () => {
  it('AC: unauthenticated users are redirected to /login', () => {
    devHeaderPathActiveMock.mockReturnValue(false);
    useSessionMock.mockReturnValue({ data: null, isPending: false });

    renderAt('/');

    expect(screen.getByText('Sign in')).toBeInTheDocument();
  });

  it('AC: authenticated users are redirected away from /login to home', () => {
    devHeaderPathActiveMock.mockReturnValue(true); // dev-header path == always authenticated
    useSessionMock.mockReturnValue({ data: null, isPending: false });

    renderAt('/login');

    expect(screen.getByText('shadcn/ui smoke test')).toBeInTheDocument();
    expect(screen.queryByText('Sign in')).not.toBeInTheDocument();
  });

  it('AC: dev-mode headers work for local development (bypasses the real session check)', () => {
    devHeaderPathActiveMock.mockReturnValue(true);
    useSessionMock.mockReturnValue({ data: null, isPending: false });

    renderAt('/');

    expect(screen.getByText(/Signed in as Dev Dashboard User \(employee\)/)).toBeInTheDocument();
  });
});
