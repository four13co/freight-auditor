import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginForm } from '../src/components/LoginForm.js';

const signInEmailMock = vi.fn();
vi.mock('../src/lib/auth-client.js', () => ({
  signIn: { email: (...args: unknown[]) => signInEmailMock(...args) },
}));

describe('LoginForm', () => {
  beforeEach(() => {
    signInEmailMock.mockReset();
  });

  it('submits email + password via signIn.email', async () => {
    signInEmailMock.mockResolvedValue({ data: {}, error: null });
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText(/email/i), 'a@example.com');
    await user.type(screen.getByLabelText(/password/i), 'hunter22222222');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

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
    await user.click(screen.getByRole('button', { name: /sign in/i }));

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
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(screen.getByRole('button')).toBeDisabled();
    resolveSignIn!({ data: {}, error: null });
    await waitFor(() => expect(screen.getByRole('button')).not.toBeDisabled());
  });
});
