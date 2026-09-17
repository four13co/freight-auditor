import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '@/app-routes';
import { AuthProvider } from '@/providers/auth-provider';
import { TenantProvider } from '@/providers/TenantProvider';

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
  fetchClients: vi.fn().mockResolvedValue([]),
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <TenantProvider>
          <AppRoutes />
        </TenantProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('AppRoutes', () => {
  it('AC: unauthenticated users are redirected to /login', () => {
    devHeaderPathActiveMock.mockReturnValue(false);
    useSessionMock.mockReturnValue({ data: null, isPending: false });

    renderAt('/');

    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('AC: authenticated users are redirected away from /login to home', () => {
    devHeaderPathActiveMock.mockReturnValue(true); // dev-header path == always authenticated
    useSessionMock.mockReturnValue({ data: null, isPending: false });

    renderAt('/login');

    expect(screen.getByText('shadcn/ui smoke test')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('AC: dev-mode headers work for local development (bypasses the real session check)', () => {
    devHeaderPathActiveMock.mockReturnValue(true);
    useSessionMock.mockReturnValue({ data: null, isPending: false });

    renderAt('/');

    expect(screen.getByText(/Signed in as Dev Dashboard User \(employee\)/)).toBeInTheDocument();
  });

  it.each(['/login', '/forgot-username', '/forgot-password', '/reset-password'])(
    'AC (86e3a6r5p): %s renders inside the shared AuthLayout',
    (path) => {
      devHeaderPathActiveMock.mockReturnValue(false);
      useSessionMock.mockReturnValue({ data: null, isPending: false });

      renderAt(path);

      // AuthLayout's wordmark -- proves the route is nested under it, not
      // rendering standalone.
      expect(screen.getByText('Freight Auditor')).toBeInTheDocument();
    },
  );

  it('AC (86e3a6r8z/9c): a nav placeholder route renders inside AppLayout', () => {
    devHeaderPathActiveMock.mockReturnValue(true); // dev-header path == employee

    renderAt('/employee/rules-rates');

    expect(screen.getByRole('heading', { name: 'Rules & Rates' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
  });

  it("AC: a role can't reach another role's route by URL -- bounced home", () => {
    devHeaderPathActiveMock.mockReturnValue(true); // dev-header path == employee

    renderAt('/vendor/home');

    expect(screen.getByText(/Signed in as Dev Dashboard User \(employee\)/)).toBeInTheDocument();
  });
});
