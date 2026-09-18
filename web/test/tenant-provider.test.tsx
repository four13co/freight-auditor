import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TenantProvider, useTenant } from '@/providers/TenantProvider';

const useAuthMock = vi.fn();
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => useAuthMock(),
}));

const fetchClientsMock = vi.fn();
vi.mock('@/lib/api', () => ({
  CLIENT_ID_STORAGE_KEY: 'freight-auditor:client-id',
  fetchClients: () => fetchClientsMock(),
}));

const useScopedEntitiesMock = vi.fn();
vi.mock('@/lib/in-memory-hierarchy-store', () => ({
  useScopedEntities: (scopeKey: string | null) => useScopedEntitiesMock(scopeKey),
}));

function Probe() {
  const { options, activeClient, activeGrandClient, isLoading } = useTenant();
  if (isLoading) return <span>loading</span>;
  const active = activeClient ?? activeGrandClient;
  return <span>{active ? active.name : `none (${options.length})`}</span>;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  fetchClientsMock.mockReset();
  useScopedEntitiesMock.mockReset();
  useScopedEntitiesMock.mockReturnValue({ entities: [] });
});

describe('TenantProvider', () => {
  it("AC: Employee's tenant list comes from the backend, first tenant pre-selected", async () => {
    useAuthMock.mockReturnValue({ role: 'employee' });
    fetchClientsMock.mockResolvedValue([
      { id: 'c1', name: 'Acme Freight' },
      { id: 'c2', name: 'Beacon Logistics' },
    ]);

    render(
      <TenantProvider>
        <Probe />
      </TenantProvider>,
    );

    await waitFor(() => expect(screen.getByText('Acme Freight')).toBeInTheDocument());
  });

  it('AC: graceful handling of the Account role with zero Clients in the store', async () => {
    useAuthMock.mockReturnValue({ role: 'account' });
    sessionStorage.setItem('freight-auditor:client-id', 'own-client-1');
    useScopedEntitiesMock.mockReturnValue({ entities: [] });

    render(
      <TenantProvider>
        <Probe />
      </TenantProvider>,
    );

    await waitFor(() => expect(fetchClientsMock).not.toHaveBeenCalled());
    expect(screen.getByText('none (0)')).toBeInTheDocument();
  });

  it('AC: Account role selects from their own Clients, sourced from in-memory-hierarchy-store scoped to their own client id, first pre-selected', async () => {
    useAuthMock.mockReturnValue({ role: 'account' });
    sessionStorage.setItem('freight-auditor:client-id', 'own-client-1');
    useScopedEntitiesMock.mockImplementation((scopeKey: string | null) => {
      expect(scopeKey).toBe('client:own-client-1');
      return {
        entities: [
          { id: 'gc1', name: 'Client One', status: 'active', createdAt: '2026-01-01' },
          { id: 'gc2', name: 'Client Two', status: 'active', createdAt: '2026-01-02' },
        ],
      };
    });

    render(
      <TenantProvider>
        <Probe />
      </TenantProvider>,
    );

    await waitFor(() => expect(screen.getByText('Client One')).toBeInTheDocument());
  });

  it("AC: the Account role's Client selection persists across a remount (localStorage)", async () => {
    useAuthMock.mockReturnValue({ role: 'account' });
    sessionStorage.setItem('freight-auditor:client-id', 'own-client-1');
    useScopedEntitiesMock.mockReturnValue({
      entities: [
        { id: 'gc1', name: 'Client One', status: 'active', createdAt: '2026-01-01' },
        { id: 'gc2', name: 'Client Two', status: 'active', createdAt: '2026-01-02' },
      ],
    });
    localStorage.setItem('freight-auditor:active-grand-client', JSON.stringify('gc2'));

    render(
      <TenantProvider>
        <Probe />
      </TenantProvider>,
    );

    await waitFor(() => expect(screen.getByText('Client Two')).toBeInTheDocument());
  });

  it('AC: selection persists across a remount (localStorage)', async () => {
    useAuthMock.mockReturnValue({ role: 'employee' });
    fetchClientsMock.mockResolvedValue([
      { id: 'c1', name: 'Acme Freight' },
      { id: 'c2', name: 'Beacon Logistics' },
    ]);

    localStorage.setItem('freight-auditor:active-client', JSON.stringify('c2'));

    render(
      <TenantProvider>
        <Probe />
      </TenantProvider>,
    );

    await waitFor(() => expect(screen.getByText('Beacon Logistics')).toBeInTheDocument());
  });
});
