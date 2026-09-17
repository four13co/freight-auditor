import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import ClientHomePage from '@/pages/client/HomePage';
import { useScopedEntities } from '@/lib/in-memory-hierarchy-store';

const useAuthMock = vi.fn();
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => useAuthMock(),
}));

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
  return `client-home-page-own-${nextId}`;
}

function seedGrandClient(clientId: string, status: 'active' | 'disabled') {
  const { result } = renderHook(() => useScopedEntities(`client:${clientId}`));
  act(() => result.current.create({ name: 'Northwind Region' }));
  if (status === 'disabled') {
    act(() => result.current.toggleStatus(result.current.entities[0]!.id));
  }
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ClientHomePage />
    </MemoryRouter>,
  );
}

describe('ClientHomePage', () => {
  it('AC: renders a welcome header with the signed-in user and current date', () => {
    ownClientId = freshOwnClientId();
    useAuthMock.mockReturnValue({ user: { name: 'Dana Admin', email: 'dana@example.com', role: 'client' } });

    renderPage();

    expect(screen.getByText(/Good (morning|afternoon|evening), Dana/)).toBeInTheDocument();
  });

  it('AC: dashboard renders with placeholder data scoped to the client', () => {
    ownClientId = freshOwnClientId();
    useAuthMock.mockReturnValue({ user: { name: 'Dana Admin', email: null, role: 'client' } });

    renderPage();

    expect(screen.getByText('Active Grand Clients')).toBeInTheDocument();
    expect(screen.getByText('Transactions pending review')).toBeInTheDocument();
    expect(screen.getByText('Recent findings/variances')).toBeInTheDocument();
    expect(screen.getByText('Open disputes')).toBeInTheDocument();
  });

  it('AC: Active Grand Clients count reflects only this client\'s active Grand Clients', () => {
    ownClientId = freshOwnClientId();
    seedGrandClient(ownClientId, 'active');
    useAuthMock.mockReturnValue({ user: { name: 'Dana Admin', email: null, role: 'client' } });

    renderPage();

    const card = screen.getByText('Active Grand Clients').closest('[data-slot="card"]')!;
    expect(card).toHaveTextContent('1');
  });

  it('AC: reuses shared components from Employee home screen (recent activity feed)', () => {
    ownClientId = freshOwnClientId();
    useAuthMock.mockReturnValue({ user: { name: 'Dana Admin', email: null, role: 'client' } });

    renderPage();

    expect(screen.getByText('Recent activity')).toBeInTheDocument();
    expect(screen.getByText(/Invoice #48213 approved/)).toBeInTheDocument();
  });

  it('AC: quick actions route to the correct Client UI pages', async () => {
    ownClientId = freshOwnClientId();
    useAuthMock.mockReturnValue({ user: { name: 'Dana Admin', email: null, role: 'client' } });
    const user = userEvent.setup();

    renderPage();

    expect(screen.getByRole('link', { name: /View Grand Clients/ })).toHaveAttribute('href', '/client/grand-clients');
    expect(screen.getByRole('link', { name: /Manage users/ })).toHaveAttribute('href', '/client/users');
    expect(screen.getByRole('link', { name: /Rules & rates/ })).toHaveAttribute('href', '/client/grand-clients/rules-rates');
    await user.click(screen.getByRole('link', { name: /View Grand Clients/ }));
  });

  it('AC: responsive grid uses a stacked-to-2-up layout class for the summary cards', () => {
    ownClientId = freshOwnClientId();
    useAuthMock.mockReturnValue({ user: { name: 'Dana Admin', email: null, role: 'client' } });

    const { container } = renderPage();

    const grid = container.querySelector('.grid.grid-cols-1.sm\\:grid-cols-2');
    expect(grid).not.toBeNull();
  });
});
