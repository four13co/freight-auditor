import { act, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import VendorUsersPage from '@/pages/client/VendorUsersPage';
import { useScopedEntities } from '@/lib/in-memory-hierarchy-store';

/** Same fresh-scope-per-test convention as employee-vendors-page.test.tsx. */
let nextId = 0;
function freshGrandClient() {
  nextId += 1;
  return { id: `gc-vendor-user-page-${nextId}`, name: `Grand Client ${nextId}` };
}

/** Seeds a real Vendor entity (as Employee's VendorsPage / the eventual Client Vendors page would create) into the shared `grandClient:<id>` scope this page's vendor picker reads from. */
function seedVendor(grandClientId: string, name: string) {
  const { result } = renderHook(() => useScopedEntities(`grandClient:${grandClientId}`));
  act(() => result.current.create({ name }));
}

let activeGrandClient: { id: string; name: string } | null = null;
vi.mock('@/providers/TenantProvider', () => ({
  useTenant: () => ({ activeGrandClient, setActiveGrandClient: () => {} }),
}));

function renderPage() {
  return render(<VendorUsersPage />);
}

describe('VendorUsersPage', () => {
  it('AC: prompts to select a Grand Client when none is active', () => {
    activeGrandClient = null;
    renderPage();
    expect(screen.getByText('Select a Grand Client to view its vendor users.')).toBeInTheDocument();
  });

  it('AC: prompts to add a vendor first when the Grand Client has none', () => {
    activeGrandClient = freshGrandClient();
    renderPage();
    expect(screen.getByText(new RegExp(`No vendors yet for ${activeGrandClient.name}`))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite vendor user' })).toBeDisabled();
  });

  it('AC: invite/edit flows work end-to-end, scoped by vendor', async () => {
    activeGrandClient = freshGrandClient();
    seedVendor(activeGrandClient.id, 'Acme Trucking');
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Invite vendor user' }));
    await user.type(screen.getByLabelText('Name'), 'Val Vendor');
    await user.type(screen.getByLabelText('Email'), 'val@acmetrucking.test');
    await user.selectOptions(screen.getByLabelText('Vendor'), 'Acme Trucking');
    await user.click(screen.getByRole('button', { name: 'Invite' }));

    expect(screen.getByText('Val Vendor')).toBeInTheDocument();
    const row = screen.getByText('Val Vendor').closest('tr')!;
    expect(within(row).getByText('Acme Trucking')).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, 'Val Renamed');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('Val Renamed')).toBeInTheDocument();
  });

  it('AC: can filter by vendor', async () => {
    activeGrandClient = freshGrandClient();
    seedVendor(activeGrandClient.id, 'Acme Trucking');
    seedVendor(activeGrandClient.id, 'Beacon Freight');
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Invite vendor user' }));
    await user.type(screen.getByLabelText('Name'), 'Acme User');
    await user.type(screen.getByLabelText('Email'), 'acme-user@test.example');
    await user.selectOptions(screen.getByLabelText('Vendor'), 'Acme Trucking');
    await user.click(screen.getByRole('button', { name: 'Invite' }));

    await user.click(screen.getByRole('button', { name: 'Invite vendor user' }));
    await user.type(screen.getByLabelText('Name'), 'Beacon User');
    await user.type(screen.getByLabelText('Email'), 'beacon-user@test.example');
    await user.selectOptions(screen.getByLabelText('Vendor'), 'Beacon Freight');
    await user.click(screen.getByRole('button', { name: 'Invite' }));

    expect(screen.getByText('Acme User')).toBeInTheDocument();
    expect(screen.getByText('Beacon User')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Filter by vendor'), 'Acme Trucking');

    expect(screen.getByText('Acme User')).toBeInTheDocument();
    expect(screen.queryByText('Beacon User')).not.toBeInTheDocument();
  });

  it('AC: vendor users shown are scoped to the selected Grand Client only', async () => {
    const gcA = freshGrandClient();
    const gcB = freshGrandClient();
    seedVendor(gcA.id, 'Acme Trucking');
    const user = userEvent.setup();

    activeGrandClient = gcA;
    const { unmount } = renderPage();
    await user.click(screen.getByRole('button', { name: 'Invite vendor user' }));
    await user.type(screen.getByLabelText('Name'), 'Only Under A');
    await user.type(screen.getByLabelText('Email'), 'a@test.example');
    await user.selectOptions(screen.getByLabelText('Vendor'), 'Acme Trucking');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    unmount();

    activeGrandClient = gcB;
    renderPage();

    expect(screen.queryByText('Only Under A')).not.toBeInTheDocument();
  });
});
