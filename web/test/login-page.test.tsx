import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import LoginPage from '@/pages/login';

const useAuthMock = vi.fn();
vi.mock('@/providers/auth-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/providers/auth-provider')>();
  return { ...actual, useAuth: () => useAuthMock() };
});

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

function renderLoginPage() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

function setupAuth(overrides: Record<string, unknown> = {}) {
  const state = {
    login: vi.fn(),
    isAuthenticated: false,
    isLoading: false,
    role: null as string | null,
    user: null,
    logout: vi.fn(),
    ...overrides,
  };
  useAuthMock.mockImplementation(() => state);
  return state;
}

describe('LoginPage', () => {
  beforeEach(() => {
    navigateMock.mockClear();
  });

  it('AC: required fields are validated client-side before submit', async () => {
    setupAuth();
    renderLoginPage();

    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('Email and password are required.')).toBeInTheDocument();
  });

  it('AC: an invalid email format is rejected before submit', async () => {
    setupAuth();
    renderLoginPage();

    await userEvent.type(screen.getByLabelText('Email'), 'not-an-email');
    await userEvent.type(screen.getByLabelText('Password'), 'password123');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
  });

  it('AC: a successful login redirects to the employee home page', async () => {
    const state = setupAuth();
    state.login = vi.fn().mockImplementation(async () => {
      state.isAuthenticated = true;
      state.role = 'employee';
      return { error: null };
    });
    renderLoginPage();

    await userEvent.type(screen.getByLabelText('Email'), 'analyst@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'password123');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(state.login).toHaveBeenCalledWith('analyst@example.com', 'password123');
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/employee/home', { replace: true }));
  });

  it('AC: a successful login redirects to the account home page', async () => {
    const state = setupAuth();
    state.login = vi.fn().mockImplementation(async () => {
      state.isAuthenticated = true;
      state.role = 'account';
      return { error: null };
    });
    renderLoginPage();

    await userEvent.type(screen.getByLabelText('Email'), 'viewer@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'password123');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/account/home', { replace: true }));
  });

  it('AC: invalid credentials display an inline error and do not redirect', async () => {
    const login = vi.fn().mockResolvedValue({ error: 'Invalid email or password.' });
    setupAuth({ login });
    renderLoginPage();

    await userEvent.type(screen.getByLabelText('Email'), 'analyst@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('Invalid email or password.')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('AC: a network error while signing in displays an inline error', async () => {
    const login = vi.fn().mockRejectedValue(new Error('network down'));
    setupAuth({ login });
    renderLoginPage();

    await userEvent.type(screen.getByLabelText('Email'), 'analyst@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'password123');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(
      await screen.findByText('Something went wrong. Check your connection and try again.'),
    ).toBeInTheDocument();
  });

  it('AC: the password field supports a show/hide toggle', async () => {
    setupAuth();
    renderLoginPage();

    const passwordInput = screen.getByLabelText('Password') as HTMLInputElement;
    expect(passwordInput.type).toBe('password');

    await userEvent.click(screen.getByRole('button', { name: /show password/i }));
    expect(passwordInput.type).toBe('text');

    await userEvent.click(screen.getByRole('button', { name: /hide password/i }));
    expect(passwordInput.type).toBe('password');
  });

  it('AC: links to forgot-username and forgot-password are present', () => {
    setupAuth();
    renderLoginPage();

    expect(screen.getByRole('link', { name: /forgot your username/i })).toHaveAttribute(
      'href',
      '/forgot-username',
    );
    expect(screen.getByRole('link', { name: /forgot your password/i })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });
});
