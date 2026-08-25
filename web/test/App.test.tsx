import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * 86e2v1bdj AC1/AC5: an unauthenticated user must see a login form, not the
 * dashboard or tenant data -- and the existing DEV_AUTH_HEADERS e2e path
 * (86e2uv4p0's suite) must keep working unaffected by this gating existing.
 * App.tsx's gate is: import.meta.env.DEV (the existing dev-header path,
 * unaffected -- api.ts's authHeaders() already only fires in this mode) OR a
 * real better-auth session via useSession() shows the Dashboard; otherwise
 * LoginForm. useSession is mocked here (a component test, not an e2e) --
 * the real round-trip against a real session is proven in
 * web/test/e2e-fullstack-auth/real-session.fullstack.spec.ts.
 *
 * 86e2wb92b: fetch is mocked globally for this suite -- the real-session
 * path now fires fetchAndStoreClientId() (GET /api/auth/memberships) before
 * rendering Dashboard, so any test exercising that path needs a resolvable
 * fetch or the effect's promise never settles.
 */
const useSessionMock = vi.fn();
vi.mock('../src/lib/auth-client.js', () => ({
  useSession: () => useSessionMock(),
}));

vi.mock('../src/components/Dashboard.js', () => ({
  Dashboard: () => <div data-testid="dashboard-stub">dashboard</div>,
}));

describe('App (session gate)', () => {
  const originalDev = import.meta.env.DEV;
  const originalFetch = global.fetch;

  beforeEach(() => {
    useSessionMock.mockReset();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ clientIds: ['c1'] }),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.stubEnv('DEV', originalDev);
    vi.unstubAllEnvs();
    global.fetch = originalFetch;
    sessionStorage.clear();
  });

  it('AC1: shows the login form, not the dashboard, when there is no session and not in dev mode', async () => {
    vi.stubEnv('DEV', false);
    useSessionMock.mockReturnValue({ data: null, isPending: false });
    const { default: App } = await import('../src/App.js');
    render(<App />);
    expect(screen.getByRole('heading', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-stub')).not.toBeInTheDocument();
  });

  it('AC4: shows the dashboard when a real session exists, once the client_id lookup resolves', async () => {
    vi.stubEnv('DEV', false);
    useSessionMock.mockReturnValue({
      data: { user: { id: 'u1', email: 'a@example.com' } },
      isPending: false,
    });
    const { default: App } = await import('../src/App.js');
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('dashboard-stub')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: /sign in/i })).not.toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith('/api/auth/memberships');
  });

  it('86e2wb92b: shows neither the login form nor the dashboard while the client_id lookup is still in flight', async () => {
    vi.stubEnv('DEV', false);
    useSessionMock.mockReturnValue({
      data: { user: { id: 'u1', email: 'a@example.com' } },
      isPending: false,
    });
    let resolveFetch: (value: unknown) => void = () => {};
    global.fetch = vi.fn().mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; })) as unknown as typeof fetch;
    const { default: App } = await import('../src/App.js');
    render(<App />);

    expect(screen.queryByTestId('dashboard-stub')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /sign in/i })).not.toBeInTheDocument();

    resolveFetch({ ok: true, json: async () => ({ clientIds: ['c1'] }) });
    await waitFor(() => expect(screen.getByTestId('dashboard-stub')).toBeInTheDocument());
  });

  it('does not gate the dashboard behind a session in dev mode (DEV_AUTH_HEADERS e2e path, 86e2uv4p0 must keep passing)', async () => {
    vi.stubEnv('DEV', true);
    useSessionMock.mockReturnValue({ data: null, isPending: false });
    const { default: App } = await import('../src/App.js');
    render(<App />);
    expect(screen.getByTestId('dashboard-stub')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /sign in/i })).not.toBeInTheDocument();
  });

  it('does not gate the dashboard behind a session when VITE_DEV_AUTH_HEADERS=1, even outside dev mode (CI web-fullstack build, must stay coherent with api.ts authHeaders())', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_DEV_AUTH_HEADERS', '1');
    useSessionMock.mockReturnValue({ data: null, isPending: false });
    const { default: App } = await import('../src/App.js');
    render(<App />);
    expect(screen.getByTestId('dashboard-stub')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /sign in/i })).not.toBeInTheDocument();
  });

  it('shows neither the login form nor the dashboard while the session check is pending, to avoid a login-form flash for an already-logged-in user', async () => {
    vi.stubEnv('DEV', false);
    useSessionMock.mockReturnValue({ data: null, isPending: true });
    const { default: App } = await import('../src/App.js');
    render(<App />);
    expect(screen.queryByTestId('dashboard-stub')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /sign in/i })).not.toBeInTheDocument();
  });
});
