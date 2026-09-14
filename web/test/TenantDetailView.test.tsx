import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TenantDetailView } from '../src/components/TenantDetailView.js';

const TENANT_ID = 't1';

function detailFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: TENANT_ID, name: 'Acme', slug: 'acme', isActive: true, createdAt: '2026-01-01T00:00:00Z',
    branding: null, memberCount: 0, ...overrides,
  };
}

function renderView() {
  return render(
    <MemoryRouter initialEntries={[`/tenants/${TENANT_ID}`]}>
      <Routes>
        <Route path="/tenants/:id" element={<TenantDetailView />} />
      </Routes>
    </MemoryRouter>,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

function mockRoute(url: string) {
  if (url.endsWith(`/api/internal/tenants/${TENANT_ID}/members`)) {
    return Promise.resolve(new Response(JSON.stringify({ members: [] }), { status: 200 }));
  }
  if (url.endsWith(`/api/internal/tenants/${TENANT_ID}`)) {
    return Promise.resolve(new Response(JSON.stringify(detailFixture()), { status: 200 }));
  }
  throw new Error(`mockRoute: unexpected URL ${url}`);
}

beforeEach(() => {
  fetchMock = vi.fn((input: string | URL | Request) => mockRoute(input.toString()));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 86e38rdnm: tenant detail -- Info/Branding/Members tabs. */
describe('TenantDetailView', () => {
  it('loads and renders the tenant name in the header, Info tab active by default', async () => {
    renderView();
    await waitFor(() => expect(screen.getAllByText('Acme').length).toBeGreaterThan(0));
    expect(screen.getByTestId('tenant-info-form')).toBeInTheDocument();
    expect(screen.getByTestId('tenant-info-slug')).toHaveTextContent('acme');
  });

  it('AC3/Info tab: saving PATCHes the tenant', async () => {
    const user = userEvent.setup();
    renderView();
    await waitFor(() => expect(screen.getByTestId('tenant-info-form')).toBeInTheDocument());

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: TENANT_ID, name: 'Acme Renamed', slug: 'acme', isActive: true }), { status: 200 }));

    const nameInput = screen.getByLabelText('Name');
    await user.clear(nameInput);
    await user.type(nameInput, 'Acme Renamed');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/internal/tenants/${TENANT_ID}`, expect.objectContaining({ method: 'PATCH' })));
    await waitFor(() => expect(screen.getByTestId('tenant-info-saved')).toBeInTheDocument());
  });

  it('AC2: Branding tab shows a CREATE form (domain editable) for a fresh tenant, and POSTs on submit', async () => {
    const user = userEvent.setup();
    renderView();
    await waitFor(() => expect(screen.getByTestId('tenant-info-form')).toBeInTheDocument());

    await user.click(screen.getByTestId('tenant-tab-branding'));
    expect(screen.getByLabelText('Domain')).toBeEnabled();

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ logoUrl: 'https://cdn.example.com/logo.png', primaryColor: '#112233', secondaryColor: null }), { status: 201 }));

    await user.type(screen.getByLabelText('Domain'), 'acme.example.com');
    await user.type(screen.getByLabelText('Logo URL'), 'https://cdn.example.com/logo.png');
    await user.type(screen.getByLabelText('Primary color'), '#112233');
    await user.click(screen.getByRole('button', { name: /create branding/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/internal/tenants/${TENANT_ID}/branding`, expect.objectContaining({ method: 'POST' })));
    await waitFor(() => expect(screen.getByTestId('tenant-branding-saved')).toBeInTheDocument());
  });

  it('AC3: Branding tab shows an UPDATE form (domain read-only) for a tenant with existing branding, and PATCHes on submit', async () => {
    fetchMock = vi.fn((input: string | URL | Request) => {
      const url = input.toString();
      if (url.endsWith(`/api/internal/tenants/${TENANT_ID}/members`)) return Promise.resolve(new Response(JSON.stringify({ members: [] }), { status: 200 }));
      if (url.endsWith(`/api/internal/tenants/${TENANT_ID}`)) {
        return Promise.resolve(new Response(JSON.stringify(detailFixture({
          branding: { domain: 'acme.example.com', logoUrl: 'https://cdn.example.com/logo.png', primaryColor: '#112233', secondaryColor: null },
        })), { status: 200 }));
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    renderView();
    await waitFor(() => expect(screen.getByTestId('tenant-info-form')).toBeInTheDocument());

    await user.click(screen.getByTestId('tenant-tab-branding'));
    expect(screen.getByLabelText('Domain')).toBeDisabled();
    expect(screen.getByLabelText('Logo URL')).toHaveValue('https://cdn.example.com/logo.png');

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ logoUrl: 'https://cdn.example.com/new-logo.png', primaryColor: '#112233', secondaryColor: null }), { status: 200 }));

    const logoInput = screen.getByLabelText('Logo URL');
    await user.clear(logoInput);
    await user.type(logoInput, 'https://cdn.example.com/new-logo.png');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/internal/tenants/${TENANT_ID}/branding`, expect.objectContaining({ method: 'PATCH' })));
  });

  it('AC4: Members tab lists members and adding one POSTs then reloads', async () => {
    const user = userEvent.setup();
    renderView();
    await waitFor(() => expect(screen.getByTestId('tenant-info-form')).toBeInTheDocument());

    await user.click(screen.getByTestId('tenant-tab-members'));
    await waitFor(() => expect(screen.getByTestId('tenant-members-empty')).toBeInTheDocument());

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ membershipId: 'm1', userId: 'u1', isNewUser: true, role: 'client_admin' }), { status: 201 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      members: [{ id: 'm1', userId: 'u1', email: 'new@example.com', fullName: null, role: 'client_admin', createdAt: '2026-01-01T00:00:00Z' }],
    }), { status: 200 }));

    await user.type(screen.getByLabelText('Member email'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: /add member/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/internal/tenants/${TENANT_ID}/members`, expect.objectContaining({ method: 'POST' })));
    await waitFor(() => expect(screen.getAllByTestId('tenant-member-row')).toHaveLength(1));
  });

  it('AC4: removing a member DELETEs and reloads', async () => {
    fetchMock = vi.fn((input: string | URL | Request) => {
      const url = input.toString();
      if (url.endsWith(`/api/internal/tenants/${TENANT_ID}/members`)) {
        return Promise.resolve(new Response(JSON.stringify({
          members: [{ id: 'm1', userId: 'u1', email: 'existing@example.com', fullName: null, role: 'analyst', createdAt: '2026-01-01T00:00:00Z' }],
        }), { status: 200 }));
      }
      if (url.endsWith(`/api/internal/tenants/${TENANT_ID}`)) return Promise.resolve(new Response(JSON.stringify(detailFixture()), { status: 200 }));
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    renderView();
    await waitFor(() => expect(screen.getByTestId('tenant-info-form')).toBeInTheDocument());
    await user.click(screen.getByTestId('tenant-tab-members'));
    await waitFor(() => expect(screen.getAllByTestId('tenant-member-row')).toHaveLength(1));

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ members: [] }), { status: 200 }));

    await user.click(screen.getByTestId('tenant-member-remove'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/internal/tenants/${TENANT_ID}/members/m1`, expect.objectContaining({ method: 'DELETE' })));
    await waitFor(() => expect(screen.getByTestId('tenant-members-empty')).toBeInTheDocument());
  });
});
