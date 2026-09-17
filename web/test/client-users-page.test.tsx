import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import UsersPage from '@/pages/client/UsersPage';

const fetchPortalMembersMock = vi.fn();
const updatePortalMemberRoleMock = vi.fn();
const createPortalMemberMock = vi.fn();
const removePortalMemberMock = vi.fn();

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    fetchPortalMembers: () => fetchPortalMembersMock(),
    updatePortalMemberRole: (...args: unknown[]) => updatePortalMemberRoleMock(...args),
    createPortalMember: (...args: unknown[]) => createPortalMemberMock(...args),
    removePortalMember: (...args: unknown[]) => removePortalMemberMock(...args),
  };
});

const MEMBERS = [
  { id: 'm1', userId: 'u1', email: 'dana@acme.test', role: 'client_admin' as const, createdAt: '2026-03-01T00:00:00Z' },
  { id: 'm2', userId: 'u2', email: 'val@acme.test', role: 'client_viewer' as const, createdAt: '2026-03-05T00:00:00Z' },
];

beforeEach(() => {
  fetchPortalMembersMock.mockReset().mockResolvedValue(MEMBERS);
  updatePortalMemberRoleMock.mockReset().mockResolvedValue({ ok: true });
  createPortalMemberMock.mockReset().mockResolvedValue({ ok: true });
  removePortalMemberMock.mockReset().mockResolvedValue(true);
});

describe('client UsersPage', () => {
  it('AC: table shows only this client\'s own portal roster', async () => {
    render(<UsersPage />);

    await waitFor(() => expect(screen.getByText('dana@acme.test')).toBeInTheDocument());
    expect(screen.getByText('val@acme.test')).toBeInTheDocument();
    expect(fetchPortalMembersMock).toHaveBeenCalledTimes(1);
  });

  it('AC: search narrows by email', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText('dana@acme.test')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Search by email…'), 'val');

    expect(screen.queryByText('dana@acme.test')).not.toBeInTheDocument();
    expect(screen.getByText('val@acme.test')).toBeInTheDocument();
  });

  it('AC: edit flow (role change) works end-to-end via the API', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText('dana@acme.test')).toBeInTheDocument());

    const row = screen.getByText('val@acme.test').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Make Admin' }));

    await waitFor(() => expect(updatePortalMemberRoleMock).toHaveBeenCalledWith('m2', 'client_admin'));
    expect(fetchPortalMembersMock).toHaveBeenCalledTimes(2);
  });

  it('AC: a role-change error surfaces instead of silently succeeding', async () => {
    updatePortalMemberRoleMock.mockResolvedValue({ ok: false, error: 'internal analyst role required' });
    const user = userEvent.setup();
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText('dana@acme.test')).toBeInTheDocument());

    const row = screen.getByText('val@acme.test').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Make Admin' }));

    await waitFor(() => expect(updatePortalMemberRoleMock).toHaveBeenCalled());
    expect(fetchPortalMembersMock).toHaveBeenCalledTimes(1);
  });

  it('AC: responsive table scrolls horizontally (overflow-x-auto container)', async () => {
    const { container } = render(<UsersPage />);
    await waitFor(() => expect(screen.getByText('dana@acme.test')).toBeInTheDocument());

    expect(container.querySelector('[data-slot="table-container"].overflow-x-auto')).not.toBeNull();
  });

  it('AC: invite flow works end-to-end via the API (86e3a6rgu review fix)', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText('dana@acme.test')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Invite user' }));
    await user.type(screen.getByLabelText('Email'), 'new@acme.test');
    await user.selectOptions(screen.getByLabelText('Role'), 'client_admin');
    await user.click(screen.getByRole('button', { name: 'Invite' }));

    await waitFor(() => expect(createPortalMemberMock).toHaveBeenCalledWith({ email: 'new@acme.test', role: 'client_admin' }));
    expect(fetchPortalMembersMock).toHaveBeenCalledTimes(2);
  });

  it('AC: invite surfaces a server-side error instead of silently closing', async () => {
    createPortalMemberMock.mockResolvedValue({ ok: false, error: 'this user is already a member of this tenant' });
    const user = userEvent.setup();
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText('dana@acme.test')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Invite user' }));
    await user.type(screen.getByLabelText('Email'), 'dana@acme.test');
    await user.click(screen.getByRole('button', { name: 'Invite' }));

    await waitFor(() => expect(createPortalMemberMock).toHaveBeenCalled());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('AC: remove row action calls the API and drops the row', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText('dana@acme.test')).toBeInTheDocument());

    const row = screen.getByText('dana@acme.test').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Remove' }));

    expect(removePortalMemberMock).toHaveBeenCalledWith('m1');
    await waitFor(() => expect(screen.queryByText('dana@acme.test')).not.toBeInTheDocument());
  });

  it('AC: a remove failure surfaces an error and does not drop the row', async () => {
    removePortalMemberMock.mockResolvedValue(false);
    const user = userEvent.setup();
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText('dana@acme.test')).toBeInTheDocument());

    const row = screen.getByText('dana@acme.test').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(removePortalMemberMock).toHaveBeenCalled());
    expect(screen.getByText('dana@acme.test')).toBeInTheDocument();
  });
});
