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
  ACCOUNT_ID_STORAGE_KEY: 'freight-auditor:account-id',
  fetchActorContext: vi.fn().mockResolvedValue({ isInternal: false, role: null, accountName: null }),
  fetchAndStoreAccountId: vi.fn().mockResolvedValue(undefined),
  fetchClients: vi.fn().mockResolvedValue([]),
  // RulesRatesPage (86e3a6rg1) references these at module scope (RULE_ACTIONS) --
  // this test never navigates there, but the module import chain still needs
  // every export it touches to exist on the mock.
  ratifyRule: vi.fn(),
  activateRule: vi.fn(),
  deprecateRule: vi.fn(),
  quarantineRule: vi.fn(),
  fetchRules: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
  fetchRuleDetail: vi.fn().mockResolvedValue(null),
  fetchContractVersions: vi.fn().mockResolvedValue([]),
  fetchContractRates: vi.fn().mockResolvedValue([]),
  createContractRate: vi.fn(),
  updateContractRate: vi.fn(),
  deleteContractRate: vi.fn(),
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

    expect(screen.getByText(/Good (morning|afternoon|evening), Dev/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('AC: dev-mode headers work for local development (bypasses the real session check)', () => {
    devHeaderPathActiveMock.mockReturnValue(true);
    useSessionMock.mockReturnValue({ data: null, isPending: false });

    renderAt('/');

    expect(screen.getByText(/Good (morning|afternoon|evening), Dev/)).toBeInTheDocument();
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

    expect(screen.getByText(/Good (morning|afternoon|evening), Dev/)).toBeInTheDocument();
  });

  it('AC (86e3a6rbe): Employee role renders its own home screen, not the shared placeholder', () => {
    devHeaderPathActiveMock.mockReturnValue(true); // dev-header path == employee

    renderAt('/employee/home');

    expect(screen.getByText('Recent activity')).toBeInTheDocument();
    expect(screen.getByText('Quick actions')).toBeInTheDocument();
    expect(screen.queryByText('shadcn/ui smoke test')).not.toBeInTheDocument();
  });
});
