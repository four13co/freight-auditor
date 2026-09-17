import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import ForgotPasswordPage from '@/pages/forgot-password';

const requestPasswordResetMock = vi.fn();
vi.mock('@/lib/auth-client', () => ({
  requestPasswordReset: (...args: unknown[]) => requestPasswordResetMock(...args),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <ForgotPasswordPage />
    </MemoryRouter>,
  );
}

describe('ForgotPasswordPage', () => {
  beforeEach(() => {
    requestPasswordResetMock.mockReset();
  });

  it('AC: an invalid email format is rejected before submit', async () => {
    renderPage();

    await userEvent.type(screen.getByLabelText('Email'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(requestPasswordResetMock).not.toHaveBeenCalled();
  });

  it('AC: shows the same generic confirmation regardless of whether the account exists', async () => {
    requestPasswordResetMock.mockResolvedValue({ data: { status: true }, error: null });
    renderPage();

    await userEvent.type(screen.getByLabelText('Email'), 'someone@example.com');
    await userEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    expect(
      await screen.findByText("If an account with that email exists, we've sent a link to reset your password."),
    ).toBeInTheDocument();
  });

  it('AC: masks a backend-side error (e.g. reset not configured) behind the same confirmation', async () => {
    requestPasswordResetMock.mockResolvedValue({
      data: null,
      error: { status: 400, message: "Reset password isn't enabled" },
    });
    renderPage();

    await userEvent.type(screen.getByLabelText('Email'), 'someone@example.com');
    await userEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    expect(
      await screen.findByText("If an account with that email exists, we've sent a link to reset your password."),
    ).toBeInTheDocument();
  });

  it('AC: a genuine network error surfaces distinctly from the masked confirmation', async () => {
    requestPasswordResetMock.mockRejectedValue(new TypeError('Failed to fetch'));
    renderPage();

    await userEvent.type(screen.getByLabelText('Email'), 'someone@example.com');
    await userEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    expect(
      await screen.findByText('Something went wrong. Check your connection and try again.'),
    ).toBeInTheDocument();
  });
});
