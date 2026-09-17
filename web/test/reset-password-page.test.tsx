import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import ResetPasswordPage from '@/pages/reset-password';

const resetPasswordMock = vi.fn();
vi.mock('@/lib/auth-client', () => ({
  resetPassword: (...args: unknown[]) => resetPasswordMock(...args),
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ResetPasswordPage />
    </MemoryRouter>,
  );
}

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    resetPasswordMock.mockReset();
  });

  it('AC: a missing token shows an expired/invalid state with a link to request a new reset', () => {
    renderAt('/reset-password');

    expect(screen.getByText('Reset link invalid or expired')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /request a new reset/i })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
    expect(resetPasswordMock).not.toHaveBeenCalled();
  });

  it('AC: passwords must match', async () => {
    renderAt('/reset-password?token=abc123');

    await userEvent.type(screen.getByLabelText('New password'), 'password123');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'password124');
    await userEvent.click(screen.getByRole('button', { name: /update password/i }));

    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
    expect(resetPasswordMock).not.toHaveBeenCalled();
  });

  it('AC: enforces the minimum password length before submit', async () => {
    renderAt('/reset-password?token=abc123');

    await userEvent.type(screen.getByLabelText('New password'), 'short');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'short');
    await userEvent.click(screen.getByRole('button', { name: /update password/i }));

    expect(await screen.findByText('Password must be at least 8 characters.')).toBeInTheDocument();
    expect(resetPasswordMock).not.toHaveBeenCalled();
  });

  it('AC: a successful reset shows a confirmation with a link back to login', async () => {
    resetPasswordMock.mockResolvedValue({ data: { status: true }, error: null });
    renderAt('/reset-password?token=abc123');

    await userEvent.type(screen.getByLabelText('New password'), 'password123');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'password123');
    await userEvent.click(screen.getByRole('button', { name: /update password/i }));

    expect(resetPasswordMock).toHaveBeenCalledWith({ newPassword: 'password123', token: 'abc123' });
    expect(await screen.findByText('Password updated')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to login/i })).toHaveAttribute('href', '/login');
  });

  it('AC: an expired or already-used token shows a graceful error', async () => {
    resetPasswordMock.mockResolvedValue({
      data: null,
      error: { status: 400, message: 'invalid token' },
    });
    renderAt('/reset-password?token=stale-token');

    await userEvent.type(screen.getByLabelText('New password'), 'password123');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'password123');
    await userEvent.click(screen.getByRole('button', { name: /update password/i }));

    expect(
      await screen.findByText('This reset link has expired or already been used.'),
    ).toBeInTheDocument();
  });

  it('AC: a network error while resetting displays an inline error', async () => {
    resetPasswordMock.mockRejectedValue(new TypeError('Failed to fetch'));
    renderAt('/reset-password?token=abc123');

    await userEvent.type(screen.getByLabelText('New password'), 'password123');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'password123');
    await userEvent.click(screen.getByRole('button', { name: /update password/i }));

    expect(
      await screen.findByText('Something went wrong. Check your connection and try again.'),
    ).toBeInTheDocument();
  });
});
