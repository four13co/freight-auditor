import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '@/providers/auth-provider';

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

const fetchActorContextMock = vi.fn();
const fetchAndStoreClientIdMock = vi.fn();
vi.mock('@/lib/api', () => ({
  CLIENT_ID_STORAGE_KEY: 'freight-auditor:client-id',
  fetchActorContext: () => fetchActorContextMock(),
  fetchAndStoreClientId: () => fetchAndStoreClientIdMock(),
}));

function Probe() {
  const { user, role, isAuthenticated, isLoading } = useAuth();
  if (isLoading) return <span>loading</span>;
  if (!isAuthenticated) return <span>unauthenticated</span>;
  return (
    <span>
      authenticated as {user?.name} ({role})
    </span>
  );
}

describe('AuthProvider', () => {
  it('on the dev-header path, is immediately authenticated as the fixed dev employee user', () => {
    devHeaderPathActiveMock.mockReturnValue(true);
    useSessionMock.mockReturnValue({ data: null, isPending: false });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    expect(screen.getByText('authenticated as Dev Dashboard User (employee)')).toBeInTheDocument();
  });

  it('on the real-session path with no session, is unauthenticated once loading settles', () => {
    devHeaderPathActiveMock.mockReturnValue(false);
    useSessionMock.mockReturnValue({ data: null, isPending: false });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    expect(screen.getByText('unauthenticated')).toBeInTheDocument();
  });

  it('on the real-session path while the session is still resolving, reports loading', () => {
    devHeaderPathActiveMock.mockReturnValue(false);
    useSessionMock.mockReturnValue({ data: null, isPending: true });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    expect(screen.getByText('loading')).toBeInTheDocument();
  });

  it('on the real-session path with a resolved session, maps isInternal to the employee role', async () => {
    devHeaderPathActiveMock.mockReturnValue(false);
    useSessionMock.mockReturnValue({
      data: { user: { id: 'u1', email: 'analyst@example.com', name: 'Analyst One' } },
      isPending: false,
    });
    fetchAndStoreClientIdMock.mockResolvedValue(undefined);
    fetchActorContextMock.mockResolvedValue({ isInternal: true, role: 'analyst', clientName: null });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText('authenticated as Analyst One (employee)')).toBeInTheDocument(),
    );
  });

  it('maps a non-internal actor to the client role', async () => {
    devHeaderPathActiveMock.mockReturnValue(false);
    useSessionMock.mockReturnValue({
      data: { user: { id: 'u2', email: 'viewer@example.com', name: 'Portal Viewer' } },
      isPending: false,
    });
    fetchAndStoreClientIdMock.mockResolvedValue(undefined);
    fetchActorContextMock.mockResolvedValue({
      isInternal: false,
      role: 'client_viewer',
      clientName: 'Acme Co',
    });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText('authenticated as Portal Viewer (client)')).toBeInTheDocument(),
    );
  });
});
