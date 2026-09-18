import { act, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import VendorUsersPage from '@/pages/account/VendorUsersPage';
import { useScopedEntities } from '@/lib/in-memory-hierarchy-store';

/** Same fresh-scope-per-test convention as employee-vendors-page.test.tsx. */
let nextId = 0;
function freshClient() {
  nextId += 1;
  return { id: `gc-vendor-user-page-${nextId}`, name: `Client ${nextId}` };
}

/** Seeds a real Vendor entity (as Employee's VendorsPage / the eventual Client Vendors page would create) into the shared `client:<id>` scope this page's vendor picker reads from. */
function seedVendor(clientId: string, name: string) {
  const { result } = renderHook(() => useScopedEntities(`client:${clientId}`));
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
  it('AC: prompts to select a Client when none is active', () => {
    activeGrandClient = null;
    renderPage();
    expect(screen.getByText('Select a Client to view its vendor users.')).toBeInTheDocument();
  });

  it('AC: prompts to add a vendor first when the Client has none', () => {
    activeGrandClient = freshClient();
    renderPage();
    expect(screen.getByText(new RegExp(`No vendors yet for ${activeGrandClient.name}`))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite vendor user' })).toBeDisabled();
  });

  it('AC: invite/edit flows work end-to-end, scoped by vendor', async () => {
    activeGrandClient = freshClient();
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
    activeGrandClient = freshClient();
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

  it('AC: vendor users shown are scoped to the selected Client only', async () => {
    const gcA = freshClient();
    const gcB = freshClient();
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
