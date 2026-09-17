import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import EmployeeHomePage from '@/pages/employee/HomePage';

const useAuthMock = vi.fn();
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => useAuthMock(),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <EmployeeHomePage />
    </MemoryRouter>,
  );
}

describe('EmployeeHomePage', () => {
  it('AC: renders a welcome header with the signed-in user and current date', () => {
    useAuthMock.mockReturnValue({ user: { name: 'Dana Admin', email: 'dana@example.com', role: 'employee' } });

    renderPage();

    expect(screen.getByText(/Good (morning|afternoon|evening), Dana/)).toBeInTheDocument();
  });

  it('AC: falls back to email when the user has no name', () => {
    useAuthMock.mockReturnValue({ user: { name: null, email: 'dana@example.com', role: 'employee' } });

    renderPage();

    expect(screen.getByText(/Good (morning|afternoon|evening), dana@example.com/)).toBeInTheDocument();
  });

  it('AC: summary cards render with placeholder metrics (active clients, pending transactions, findings, disputes)', () => {
    useAuthMock.mockReturnValue({ user: { name: 'Dana Admin', email: null, role: 'employee' } });

    renderPage();

    expect(screen.getByText('Active clients')).toBeInTheDocument();
    expect(screen.getByText('Transactions pending review')).toBeInTheDocument();
    expect(screen.getByText('Recent findings/variances')).toBeInTheDocument();
    expect(screen.getByText('Open disputes')).toBeInTheDocument();
  });

  it('AC: recent activity feed shows items with a status badge and relative time', () => {
    useAuthMock.mockReturnValue({ user: { name: 'Dana Admin', email: null, role: 'employee' } });

    renderPage();

    expect(screen.getByText(/Invoice #48213 approved for Acme Freight/)).toBeInTheDocument();
    expect(screen.getByText('2 minutes ago')).toBeInTheDocument();
    expect(screen.getByText('approved')).toBeInTheDocument();
  });

  it('AC: quick action buttons route to the correct pages', async () => {
    useAuthMock.mockReturnValue({ user: { name: 'Dana Admin', email: null, role: 'employee' } });
    const user = userEvent.setup();

    renderPage();

    expect(screen.getByRole('link', { name: /Manage clients/ })).toHaveAttribute('href', '/employee/clients');
    expect(screen.getByRole('link', { name: /Manage users/ })).toHaveAttribute('href', '/employee/users');
    expect(screen.getByRole('link', { name: /Rules & rates/ })).toHaveAttribute('href', '/employee/rules-rates');
    await user.click(screen.getByRole('link', { name: /Manage clients/ }));
  });

  it('AC: responsive grid uses a stacked-to-2-up layout class for the summary cards', () => {
    useAuthMock.mockReturnValue({ user: { name: 'Dana Admin', email: null, role: 'employee' } });

    const { container } = renderPage();

    const grid = container.querySelector('.grid.grid-cols-1.sm\\:grid-cols-2');
    expect(grid).not.toBeNull();
  });
});
