import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TenantAdminView } from '../src/components/TenantAdminView.js';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ tenants: [] }), { status: 200 })));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 86e38rdnm: tenant list + create form (Tenant Admin UI, first subsurface). */
describe('TenantAdminView', () => {
  it('fetches tenants on mount and renders the empty state', async () => {
    render(<TenantAdminView />);
    expect(fetchMock).toHaveBeenCalledWith('/api/internal/tenants', expect.any(Object));
    await waitFor(() => expect(screen.getByTestId('tenants-empty')).toBeInTheDocument());
  });

  it('renders one row per tenant, name/slug/status visible', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      tenants: [{ id: 't1', name: 'Acme', slug: 'acme', isActive: true, createdAt: '2026-01-01T00:00:00Z' }],
    }), { status: 200 }));
    render(<TenantAdminView />);

    await waitFor(() => expect(screen.getAllByTestId('tenant-row')).toHaveLength(1));
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('acme')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('AC1: submitting the create-tenant form POSTs and reloads the list', async () => {
    const user = userEvent.setup();
    render(<TenantAdminView />);
    await waitFor(() => expect(screen.getByTestId('tenants-empty')).toBeInTheDocument());

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 't1', name: 'Acme', slug: 'acme', isActive: true }), { status: 201 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      tenants: [{ id: 't1', name: 'Acme', slug: 'acme', isActive: true, createdAt: '2026-01-01T00:00:00Z' }],
    }), { status: 200 }));

    await user.type(screen.getByLabelText('Tenant name'), 'Acme');
    await user.type(screen.getByLabelText('Tenant slug'), 'acme');
    await user.click(screen.getByRole('button', { name: /create tenant/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/internal/tenants', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
    })));
    await waitFor(() => expect(screen.getAllByTestId('tenant-row')).toHaveLength(1));
  });

  it('rejects submission client-side when name or slug is blank', async () => {
    const user = userEvent.setup();
    render(<TenantAdminView />);
    await waitFor(() => expect(screen.getByTestId('tenants-empty')).toBeInTheDocument());
    fetchMock.mockClear();

    await user.click(screen.getByRole('button', { name: /create tenant/i }));

    expect(screen.getByTestId('tenant-create-error')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a create error when the slug is already in use (409)', async () => {
    const user = userEvent.setup();
    render(<TenantAdminView />);
    await waitFor(() => expect(screen.getByTestId('tenants-empty')).toBeInTheDocument());

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'conflict' }), { status: 409 }));

    await user.type(screen.getByLabelText('Tenant name'), 'Acme');
    await user.type(screen.getByLabelText('Tenant slug'), 'acme');
    await user.click(screen.getByRole('button', { name: /create tenant/i }));

    await waitFor(() => expect(screen.getByTestId('tenant-create-error')).toBeInTheDocument());
  });
});
