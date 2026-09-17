import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import GrandClientsPage from '@/pages/client/GrandClientsPage';

/** Fresh own-client-id per test, same convention as employee-grand-clients-page.test.tsx: avoids cross-test pollution of the shared in-memory store. */
let ownClientId = '';
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    getOwnClientId: () => ownClientId,
  };
});

let nextId = 0;
function freshOwnClientId() {
  nextId += 1;
  return `client-page-own-${nextId}`;
}

describe('client GrandClientsPage', () => {
  it('AC: empty state when this client has no Grand Clients yet', () => {
    ownClientId = freshOwnClientId();
    render(<GrandClientsPage />);
    expect(screen.getByText('No Grand Clients yet.')).toBeInTheDocument();
  });

  it('AC: CRUD operations work via the store (create, edit)', async () => {
    ownClientId = freshOwnClientId();
    const user = userEvent.setup();
    render(<GrandClientsPage />);

    await user.click(screen.getByRole('button', { name: 'Create Grand Client' }));
    await user.type(screen.getByLabelText('Name'), 'Northwind Region');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(screen.getByText('Northwind Region')).toBeInTheDocument();

    const row = screen.getByText('Northwind Region').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    expect(nameInput.value).toBe('Northwind Region');
    await user.clear(nameInput);
    await user.type(nameInput, 'Northwind');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('Northwind')).toBeInTheDocument();
  });

  it("AC: shows only this client's own Grand Clients", async () => {
    const clientA = freshOwnClientId();
    const clientB = freshOwnClientId();
    const user = userEvent.setup();

    ownClientId = clientA;
    const { unmount } = render(<GrandClientsPage />);
    await user.click(screen.getByRole('button', { name: 'Create Grand Client' }));
    await user.type(screen.getByLabelText('Name'), 'Only Under A');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByText('Only Under A')).toBeInTheDocument();
    unmount();

    ownClientId = clientB;
    render(<GrandClientsPage />);

    expect(screen.queryByText('Only Under A')).not.toBeInTheDocument();
    expect(screen.getByText('No Grand Clients yet.')).toBeInTheDocument();
  });

  it('AC: Disable/Enable toggles this Grand Client status', async () => {
    ownClientId = freshOwnClientId();
    const user = userEvent.setup();
    render(<GrandClientsPage />);
    await user.click(screen.getByRole('button', { name: 'Create Grand Client' }));
    await user.type(screen.getByLabelText('Name'), 'Northwind Region');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    const row = screen.getByText('Northwind Region').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Disable' }));

    expect(within(row).getByText('Disabled')).toBeInTheDocument();
  });
});
