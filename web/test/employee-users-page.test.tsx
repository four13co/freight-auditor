import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import UsersPage from '@/pages/employee/UsersPage';

const fetchAllUsersMock = vi.fn();
const fetchTenantSummariesMock = vi.fn();
const createTenantMemberMock = vi.fn();
const deleteTenantMemberMock = vi.fn();
const updateTenantMemberMock = vi.fn();

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    fetchAllUsers: () => fetchAllUsersMock(),
    fetchTenantSummaries: () => fetchTenantSummariesMock(),
    createTenantMember: (...args: unknown[]) => createTenantMemberMock(...args),
    deleteTenantMember: (...args: unknown[]) => deleteTenantMemberMock(...args),
    updateTenantMember: (...args: unknown[]) => updateTenantMemberMock(...args),
  };
});

const TENANTS = [
  { id: 't1', name: 'Acme Freight', slug: 'acme', isActive: true, createdAt: '2026-01-01T00:00:00Z' },
  { id: 't2', name: 'Beacon Logistics', slug: 'beacon', isActive: false, createdAt: '2026-02-01T00:00:00Z' },
];

const USERS = [
  {
    membershipId: 'm1',
    userId: 'u1',
    email: 'dana@acme.test',
    fullName: 'Dana Admin',
    role: 'account_admin' as const,
    tenantId: 't1',
    tenantName: 'Acme Freight',
    isActive: true,
    createdAt: '2026-03-01T00:00:00Z',
  },
  {
    membershipId: 'm2',
    userId: 'u2',
    email: 'alex@fa.test',
    fullName: 'Alex Analyst',
    role: 'analyst' as const,
    tenantId: 't2',
    tenantName: 'Beacon Logistics',
    isActive: false,
    createdAt: '2026-03-05T00:00:00Z',
  },
];

beforeEach(() => {
  fetchAllUsersMock.mockReset().mockResolvedValue(USERS);
  fetchTenantSummariesMock.mockReset().mockResolvedValue(TENANTS);
  createTenantMemberMock.mockReset().mockResolvedValue({ ok: true });
  deleteTenantMemberMock.mockReset().mockResolvedValue(true);
  updateTenantMemberMock.mockReset().mockResolvedValue({ ok: true });
});

describe('UsersPage', () => {
  it('AC: table loads users aggregated across tenants', async () => {
    render(<UsersPage />);

    await waitFor(() => expect(screen.getByText('dana@acme.test')).toBeInTheDocument());
    expect(screen.getByText('alex@fa.test')).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Acme Freight')).toBeInTheDocument();
    expect(within(table).getByText('Beacon Logistics')).toBeInTheDocument();
  });

  it('AC: filters narrow results by role', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText('dana@acme.test')).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Filter by role'), 'analyst');

    expect(screen.queryByText('dana@acme.test')).not.toBeInTheDocument();
    expect(screen.getByText('alex@fa.test')).toBeInTheDocument();
  });

  it('AC: filters narrow results by tenant', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText('dana@acme.test')).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Filter by tenant'), 'Acme Freight');

    expect(screen.getByText('dana@acme.test')).toBeInTheDocument();
    expect(screen.queryByText('alex@fa.test')).not.toBeInTheDocument();
  });

  it('AC: filters narrow results by status', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText('dana@acme.test')).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Filter by status'), 'disabled');

    expect(screen.queryByText('dana@acme.test')).not.toBeInTheDocument();
    expect(screen.getByText('alex@fa.test')).toBeInTheDocument();
  });

  it('AC: search works on name and email', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText('dana@acme.test')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Search by name or email…'), 'alex');

    expect(screen.queryByText('dana@acme.test')).not.toBeInTheDocument();
    expect(screen.getByText('alex@fa.test')).toBeInTheDocument();
  });

  it('AC: create user flow works end-to-end via the API', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText('dana@acme.test')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Create user' }));
    await user.type(screen.getByLabelText('Email'), 'new@acme.test');
    await user.selectOptions(screen.getByLabelText('Tenant'), 'Acme Freight');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(createTenantMemberMock).toHaveBeenCalledWith('t1', {
        email: 'new@acme.test',
        fullName: null,
        role: 'analyst',
      }),
    );
    expect(fetchAllUsersMock).toHaveBeenCalledTimes(2);
  });

  it('AC: create surfaces a server-side error instead of silently closing', async () => {
    createTenantMemberMock.mockResolvedValue({ ok: false, error: 'this user is already a member of this tenant' });
    const user = userEvent.setup();
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText('dana@acme.test')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Create user' }));
    await user.type(screen.getByLabelText('Email'), 'dana@acme.test');
    await user.selectOptions(screen.getByLabelText('Tenant'), 'Acme Freight');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createTenantMemberMock).toHaveBeenCalled());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it("AC: row actions execute correctly (Remove calls the API and drops the row)", async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText('dana@acme.test')).toBeInTheDocument());

    const row = screen.getByText('dana@acme.test').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Remove' }));

    expect(deleteTenantMemberMock).toHaveBeenCalledWith('t1', 'm1');
    await waitFor(() => expect(screen.queryByText('dana@acme.test')).not.toBeInTheDocument());
  });

  it('AC: responsive table scrolls horizontally (overflow-x-auto container)', async () => {
    const { container } = render(<UsersPage />);
    await waitFor(() => expect(screen.getByText('dana@acme.test')).toBeInTheDocument());

    expect(container.querySelector('[data-slot="table-container"].overflow-x-auto')).not.toBeNull();
  });

  it('AC: status column reads membership.isActive, not the tenant\'s own isActive', async () => {
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText('dana@acme.test')).toBeInTheDocument());

    // dana's tenant (Acme Freight) is active, but her own membership isn't --
    // the Status column must reflect the membership, not silently proxy the
    // tenant the way it used to (86e3a7d57).
    const danaRow = screen.getByText('dana@acme.test').closest('tr')!;
    expect(within(danaRow).getByText('Active')).toBeInTheDocument();

    // alex's tenant (Beacon Logistics) is disabled, but his own membership is
    // active -- same proof in the other direction.
    const alexRow = screen.getByText('alex@fa.test').closest('tr')!;
    expect(within(alexRow).getByText('Disabled')).toBeInTheDocument();
  });

  it('AC: edit role calls the PATCH endpoint and reflects the result', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText('dana@acme.test')).toBeInTheDocument());

    fetchAllUsersMock.mockResolvedValueOnce([{ ...USERS[0], role: 'analyst' as const }, USERS[1]]);

    const row = screen.getByText('dana@acme.test').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Edit role' }));
    await user.selectOptions(screen.getByLabelText('Role'), 'analyst');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateTenantMemberMock).toHaveBeenCalledWith('t1', 'm1', { role: 'analyst' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => {
      const updatedRow = screen.getByText('dana@acme.test').closest('tr')!;
      expect(within(updatedRow).getByText('Employee (Analyst)')).toBeInTheDocument();
    });
  });

  it('AC: enable/disable toggle calls the PATCH endpoint and reflects the result', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText('dana@acme.test')).toBeInTheDocument());

    fetchAllUsersMock.mockResolvedValueOnce([{ ...USERS[0], isActive: false }, USERS[1]]);

    const row = screen.getByText('dana@acme.test').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Disable' }));

    expect(updateTenantMemberMock).toHaveBeenCalledWith('t1', 'm1', { isActive: false });
    await waitFor(() => {
      const updatedRow = screen.getByText('dana@acme.test').closest('tr')!;
      expect(within(updatedRow).getByText('Disabled')).toBeInTheDocument();
      expect(within(updatedRow).getByRole('button', { name: 'Enable' })).toBeInTheDocument();
    });
  });

  it('AC: edit role surfaces a server-side error instead of silently closing', async () => {
    updateTenantMemberMock.mockResolvedValue({ ok: false, error: 'invalid role' });
    const user = userEvent.setup();
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText('dana@acme.test')).toBeInTheDocument());

    const row = screen.getByText('dana@acme.test').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Edit role' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateTenantMemberMock).toHaveBeenCalled());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
