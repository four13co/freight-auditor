import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import ForgotUsernamePage from '@/pages/forgot-username';

const fetchMock = vi.fn();

function renderPage() {
  return render(
    <MemoryRouter>
      <ForgotUsernamePage />
    </MemoryRouter>,
  );
}

describe('ForgotUsernamePage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('AC: an invalid email format is rejected before submit', async () => {
    renderPage();

    await userEvent.type(screen.getByLabelText('Email'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: /send username/i }));

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('AC: shows the same generic success message whether or not the account exists', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    renderPage();

    await userEvent.type(screen.getByLabelText('Email'), 'someone@example.com');
    await userEvent.click(screen.getByRole('button', { name: /send username/i }));

    expect(
      await screen.findByText("If an account with that email exists, we've sent your username."),
    ).toBeInTheDocument();
  });

  it('AC: a network error surfaces distinctly from the masked success state', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    renderPage();

    await userEvent.type(screen.getByLabelText('Email'), 'someone@example.com');
    await userEvent.click(screen.getByRole('button', { name: /send username/i }));

    expect(
      await screen.findByText('Something went wrong. Check your connection and try again.'),
    ).toBeInTheDocument();
  });

  it('AC: has a back-to-login link on both the form and confirmation states', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    renderPage();

    expect(screen.getByRole('link', { name: /back to login/i })).toHaveAttribute('href', '/login');

    await userEvent.type(screen.getByLabelText('Email'), 'someone@example.com');
    await userEvent.click(screen.getByRole('button', { name: /send username/i }));

    expect(await screen.findByRole('link', { name: /back to login/i })).toHaveAttribute('href', '/login');
  });
});
