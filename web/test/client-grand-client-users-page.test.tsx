import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import GrandClientUsersPage from '@/pages/client/GrandClientUsersPage';

/** Same fresh-scope-per-test convention as employee-vendors-page.test.tsx: avoids cross-test pollution of the shared in-memory store. */
let nextId = 0;
function freshGrandClient() {
  nextId += 1;
  return { id: `gc-user-page-${nextId}`, name: `Grand Client ${nextId}` };
}

let activeGrandClient: { id: string; name: string } | null = null;
vi.mock('@/providers/TenantProvider', () => ({
  useTenant: () => ({ activeGrandClient, setActiveGrandClient: () => {} }),
}));

function renderPage() {
  return render(<GrandClientUsersPage />);
}

describe('GrandClientUsersPage', () => {
  it('AC: prompts to select a Grand Client when none is active', () => {
    activeGrandClient = null;
    renderPage();
    expect(screen.getByText('Select a Grand Client to view its users.')).toBeInTheDocument();
  });

  it('AC: empty state when a Grand Client has no users yet', () => {
    activeGrandClient = freshGrandClient();
    renderPage();
    expect(screen.getByText(new RegExp(`No users yet for ${activeGrandClient.name}`))).toBeInTheDocument();
  });

  it('AC: invite/edit flows work end-to-end', async () => {
    activeGrandClient = freshGrandClient();
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Invite user' }));
    await user.type(screen.getByLabelText('Name'), 'Dana Admin');
    await user.type(screen.getByLabelText('Email'), 'dana@acme.test');
    await user.selectOptions(screen.getByLabelText('Role'), 'admin');
    await user.click(screen.getByRole('button', { name: 'Invite' }));

    expect(screen.getByText('Dana Admin')).toBeInTheDocument();
    expect(screen.getByText('dana@acme.test')).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();

    const row = screen.getByText('Dana Admin').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, 'Dana Renamed');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('Dana Renamed')).toBeInTheDocument();
  });

  it('AC: users shown are scoped to the selected Grand Client only', async () => {
    const gcA = freshGrandClient();
    const gcB = freshGrandClient();
    const user = userEvent.setup();

    activeGrandClient = gcA;
    const { unmount } = renderPage();
    await user.click(screen.getByRole('button', { name: 'Invite user' }));
    await user.type(screen.getByLabelText('Name'), 'Only Under A');
    await user.type(screen.getByLabelText('Email'), 'a@acme.test');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    unmount();

    activeGrandClient = gcB;
    renderPage();

    expect(screen.queryByText('Only Under A')).not.toBeInTheDocument();
  });

  it('AC: row actions (Disable/Enable, Remove) work correctly', async () => {
    activeGrandClient = freshGrandClient();
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Invite user' }));
    await user.type(screen.getByLabelText('Name'), 'Dana Admin');
    await user.type(screen.getByLabelText('Email'), 'dana@acme.test');
    await user.click(screen.getByRole('button', { name: 'Invite' }));

    const row = screen.getByText('Dana Admin').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Disable' }));
    expect(within(row).getByText('Disabled')).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Remove' }));
    expect(screen.queryByText('Dana Admin')).not.toBeInTheDocument();
  });
});
