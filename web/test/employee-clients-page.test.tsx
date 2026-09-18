import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import ClientsPage from '@/pages/employee/ClientsPage';

/**
 * The in-memory hierarchy store (in-memory-hierarchy-store.ts) is a
 * module-level singleton keyed by scope, deliberately shared across the
 * whole session (see that module's own doc comment). That means it's also
 * shared across test cases in this file, so each test uses its own unique
 * client id as its scope key -- avoids one test's writes leaking into
 * another's assertions without needing a test-only reset hook on
 * production code.
 */
let nextId = 0;
function freshClient() {
  nextId += 1;
  return { id: `client-${nextId}`, name: `Client ${nextId}` };
}

const setActiveGrandClientMock = vi.fn();
let activeClient: { id: string; name: string } | null = null;
vi.mock('@/providers/TenantProvider', () => ({
  useTenant: () => ({ activeClient, setActiveGrandClient: setActiveGrandClientMock }),
}));

beforeEach(() => {
  setActiveGrandClientMock.mockReset();
});

function renderPage() {
  return render(
    <MemoryRouter>
      <ClientsPage />
    </MemoryRouter>,
  );
}

describe('ClientsPage', () => {
  it('AC: prompts for a client when none is selected', () => {
    activeClient = null;
    renderPage();
    expect(screen.getByText(/Select a client/)).toBeInTheDocument();
  });

  it('AC: shows an empty state scoped to the active client', () => {
    activeClient = freshClient();
    renderPage();
    expect(screen.getByText(`Clients for ${activeClient.name}`)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`No clients yet for ${activeClient.name}`))).toBeInTheDocument();
  });

  it('AC: CRUD operations work end-to-end (create, edit)', async () => {
    activeClient = freshClient();
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Create Client' }));
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

  it('AC: Clients shown are scoped to the selected (Account-tenant) Client only', async () => {
    const clientA = freshClient();
    const clientB = freshClient();
    const user = userEvent.setup();

    activeClient = clientA;
    const { unmount } = renderPage();
    await user.click(screen.getByRole('button', { name: 'Create Client' }));
    await user.type(screen.getByLabelText('Name'), 'Only Under A');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByText('Only Under A')).toBeInTheDocument();
    unmount();

    activeClient = clientB;
    renderPage();

    expect(screen.queryByText('Only Under A')).not.toBeInTheDocument();
    expect(screen.getByText(new RegExp(`No clients yet for ${clientB.name}`))).toBeInTheDocument();
  });

  it('AC: navigation to Vendors carries the Client context', async () => {
    activeClient = freshClient();
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Create Client' }));
    await user.type(screen.getByLabelText('Name'), 'Northwind Region');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await user.click(screen.getByText('Northwind Region'));

    expect(setActiveGrandClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Northwind Region' }),
    );
  });

  it('AC: Disable/Enable toggles this Client status', async () => {
    activeClient = freshClient();
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Create Client' }));
    await user.type(screen.getByLabelText('Name'), 'Northwind Region');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    const row = screen.getByText('Northwind Region').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Disable' }));

    expect(within(row).getByText('Disabled')).toBeInTheDocument();
  });
});
