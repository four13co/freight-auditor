import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginForm } from '../src/components/LoginForm.js';

const signInEmailMock = vi.fn();
const signInPasskeyMock = vi.fn();
vi.mock('../src/lib/auth-client.js', () => ({
  signIn: {
    email: (...args: unknown[]) => signInEmailMock(...args),
    passkey: (...args: unknown[]) => signInPasskeyMock(...args),
  },
}));

describe('LoginForm', () => {
  beforeEach(() => {
    signInEmailMock.mockReset();
    signInPasskeyMock.mockReset();
  });

  it('submits email + password via signIn.email', async () => {
    signInEmailMock.mockResolvedValue({ data: {}, error: null });
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText(/email/i), 'a@example.com');
    await user.type(screen.getByLabelText(/password/i), 'hunter22222222');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() =>
      expect(signInEmailMock).toHaveBeenCalledWith({ email: 'a@example.com', password: 'hunter22222222' }),
    );
  });

  it('AC3: shows an error and does not navigate away when credentials are invalid', async () => {
    signInEmailMock.mockResolvedValue({ data: null, error: { message: 'Invalid email or password' } });
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText(/email/i), 'a@example.com');
    await user.type(screen.getByLabelText(/password/i), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid email or password/i);
  });

  it('disables the submit button while a sign-in request is in flight', async () => {
    let resolveSignIn: (value: { data: unknown; error: null }) => void;
    signInEmailMock.mockReturnValue(
      new Promise((resolve) => {
        resolveSignIn = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText(/email/i), 'a@example.com');
    await user.type(screen.getByLabelText(/password/i), 'hunter22222222');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
    resolveSignIn!({ data: {}, error: null });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).not.toBeDisabled());
  });

  it('86e2v1bf1: clicking "Sign in with a passkey" calls signIn.passkey, additive to the email/password path above', async () => {
    signInPasskeyMock.mockResolvedValue({ data: { session: {}, user: {} }, error: null });
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.click(screen.getByRole('button', { name: /sign in with a passkey/i }));

    await waitFor(() => expect(signInPasskeyMock).toHaveBeenCalled());
    expect(signInEmailMock).not.toHaveBeenCalled();
  });

  it('86e2v1bf1 AC3: shows an error when passkey sign-in fails, without disabling the email/password form', async () => {
    signInPasskeyMock.mockResolvedValue({ data: null, error: { message: 'Passkey authentication was cancelled' } });
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.click(screen.getByRole('button', { name: /sign in with a passkey/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/passkey authentication was cancelled/i);
    expect(screen.getByRole('button', { name: 'Sign in' })).not.toBeDisabled();
    expect(screen.getByLabelText(/email/i)).toBeEnabled();
  });
});
