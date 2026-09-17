import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TenantProvider, useTenant } from '@/providers/TenantProvider';

const useAuthMock = vi.fn();
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => useAuthMock(),
}));

const fetchClientsMock = vi.fn();
vi.mock('@/lib/api', () => ({
  fetchClients: () => fetchClientsMock(),
}));

function Probe() {
  const { options, activeClient, isLoading } = useTenant();
  if (isLoading) return <span>loading</span>;
  return <span>{activeClient ? activeClient.name : `none (${options.length})`}</span>;
}

beforeEach(() => {
  localStorage.clear();
  fetchClientsMock.mockReset();
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

  it('AC: a scoped role (no Grand Client backend yet) has no tenant options', async () => {
    useAuthMock.mockReturnValue({ role: 'client' });

    render(
      <TenantProvider>
        <Probe />
      </TenantProvider>,
    );

    await waitFor(() => expect(fetchClientsMock).not.toHaveBeenCalled());
    expect(screen.getByText('none (0)')).toBeInTheDocument();
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
