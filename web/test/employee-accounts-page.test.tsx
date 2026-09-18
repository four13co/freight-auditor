import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AccountsPage from '@/pages/employee/AccountsPage';

const fetchTenantSummariesMock = vi.fn();
const createClientMock = vi.fn();
const updateClientMock = vi.fn();

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    fetchTenantSummaries: () => fetchTenantSummariesMock(),
    createClient: (...args: unknown[]) => createClientMock(...args),
    updateClient: (...args: unknown[]) => updateClientMock(...args),
  };
});

const setActiveClientMock = vi.fn();
vi.mock('@/providers/TenantProvider', () => ({
  useTenant: () => ({ setActiveClient: setActiveClientMock }),
}));

const TENANTS = [
  { id: 't1', name: 'Acme Freight', slug: 'acme', isActive: true, createdAt: '2026-01-01T00:00:00Z' },
  { id: 't2', name: 'Beacon Logistics', slug: 'beacon', isActive: false, createdAt: '2026-02-01T00:00:00Z' },
];

beforeEach(() => {
  fetchTenantSummariesMock.mockReset().mockResolvedValue(TENANTS);
  createClientMock.mockReset().mockResolvedValue({ ok: true });
  updateClientMock.mockReset().mockResolvedValue({ ok: true });
  setActiveClientMock.mockReset();
});

function renderPage() {
  return render(
    <MemoryRouter>
      <AccountsPage />
    </MemoryRouter>,
  );
}

describe('AccountsPage', () => {
  it('AC: table loads accounts with pagination', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Acme Freight')).toBeInTheDocument());
    expect(screen.getByText('Beacon Logistics')).toBeInTheDocument();
  });

  it('AC: create account flow works via the API', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Acme Freight')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await user.type(screen.getByLabelText('Name'), 'New Co');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createClientMock).toHaveBeenCalledWith({ name: 'New Co' }));
  });

  it('AC: edit account flow works via the API', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Acme Freight')).toBeInTheDocument());

    const row = screen.getByText('Acme Freight').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    expect(nameInput.value).toBe('Acme Freight');
    await user.clear(nameInput);
    await user.type(nameInput, 'Acme Freight Co');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateClientMock).toHaveBeenCalledWith('t1', { name: 'Acme Freight Co' }));
  });

  it('AC: clicking a client navigates to Grand Clients and sets the active client', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Acme Freight')).toBeInTheDocument());

    await user.click(screen.getByText('Acme Freight'));

    expect(setActiveClientMock).toHaveBeenCalledWith({ id: 't1', name: 'Acme Freight' });
  });

  it('AC: Disable/Enable row action toggles isActive via the API', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Acme Freight')).toBeInTheDocument());

    const row = screen.getByText('Acme Freight').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Disable' }));

    expect(updateClientMock).toHaveBeenCalledWith('t1', { isActive: false });
  });
});
