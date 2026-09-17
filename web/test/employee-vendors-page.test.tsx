import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import VendorsPage from '@/pages/employee/VendorsPage';

/** See employee-grand-clients-page.test.tsx's comment: unique scope id per test avoids cross-test pollution of the shared in-memory store. */
let nextId = 0;
function freshGrandClient() {
  nextId += 1;
  return { id: `gc-${nextId}`, name: `Grand Client ${nextId}` };
}

let activeGrandClient: { id: string; name: string } | null = null;
vi.mock('@/providers/TenantProvider', () => ({
  useTenant: () => ({ activeGrandClient }),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <VendorsPage />
    </MemoryRouter>,
  );
}

describe('VendorsPage', () => {
  it('AC: prompts to select a Grand Client when none is active', () => {
    activeGrandClient = null;
    renderPage();
    expect(screen.getByText('Select a Grand Client to view its vendors.')).toBeInTheDocument();
  });

  it('AC: empty state when a Grand Client has no vendors yet', () => {
    activeGrandClient = freshGrandClient();
    renderPage();
    expect(screen.getByText(new RegExp(`No vendors yet for ${activeGrandClient.name}`))).toBeInTheDocument();
  });

  it('AC: CRUD operations work end-to-end (create with contact info, edit)', async () => {
    activeGrandClient = freshGrandClient();
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Create vendor' }));
    await user.type(screen.getByLabelText('Name'), 'Acme Trucking');
    await user.type(screen.getByLabelText('Contact info'), 'ops@acmetrucking.test');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(screen.getByText('Acme Trucking')).toBeInTheDocument();
    expect(screen.getByText('ops@acmetrucking.test')).toBeInTheDocument();

    const row = screen.getByText('Acme Trucking').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, 'Acme Trucking Co');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('Acme Trucking Co')).toBeInTheDocument();
  });

  it('AC: vendors shown are scoped to the selected Grand Client only', async () => {
    const gcA = freshGrandClient();
    const gcB = freshGrandClient();
    const user = userEvent.setup();

    activeGrandClient = gcA;
    const { unmount } = renderPage();
    await user.click(screen.getByRole('button', { name: 'Create vendor' }));
    await user.type(screen.getByLabelText('Name'), 'Only Under A');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    unmount();

    activeGrandClient = gcB;
    renderPage();

    expect(screen.queryByText('Only Under A')).not.toBeInTheDocument();
  });

  it('AC: Disable/Enable toggles this vendor status', async () => {
    activeGrandClient = freshGrandClient();
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Create vendor' }));
    await user.type(screen.getByLabelText('Name'), 'Acme Trucking');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    const row = screen.getByText('Acme Trucking').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Disable' }));

    expect(within(row).getByText('Disabled')).toBeInTheDocument();
  });
});
