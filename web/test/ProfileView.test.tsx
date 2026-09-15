import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProfileView } from '../src/components/ProfileView.js';

const useSessionMock = vi.fn();
const refetchSessionMock = vi.fn().mockResolvedValue(undefined);
const changePasswordMock = vi.fn();
const listUserPasskeysMock = vi.fn();
const deletePasskeyMock = vi.fn();
const addPasskeyMock = vi.fn();

vi.mock('../src/lib/auth-client.js', () => ({
  useSession: () => useSessionMock(),
  changePassword: (...args: unknown[]) => changePasswordMock(...args),
  authClient: {
    passkey: {
      listUserPasskeys: (...args: unknown[]) => listUserPasskeysMock(...args),
      deletePasskey: (...args: unknown[]) => deletePasskeyMock(...args),
      addPasskey: (...args: unknown[]) => addPasskeyMock(...args),
    },
  },
}));

const SESSION_USER = { id: 'u1', name: 'Dana Mercer', email: 'dana@example.com', image: null };

describe('ProfileView', () => {
  beforeEach(() => {
    useSessionMock.mockReturnValue({ data: { user: SESSION_USER }, isPending: false, refetch: refetchSessionMock });
    refetchSessionMock.mockReset().mockResolvedValue(undefined);
    changePasswordMock.mockReset().mockResolvedValue({ error: null });
    listUserPasskeysMock.mockReset().mockResolvedValue({ data: [], error: null });
    deletePasskeyMock.mockReset().mockResolvedValue({ error: null });
    addPasskeyMock.mockReset().mockResolvedValue({ error: null });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ clientIds: ['c1'], isInternal: false, role: 'client_admin', clientName: 'Acme Corp' }), { status: 200 }),
    ));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('AC2: shows name, email, role, and org/tenant once loaded', async () => {
    render(<ProfileView />);

    expect(screen.getByTestId('profile-email')).toHaveTextContent('dana@example.com');
    await waitFor(() => expect(screen.getByTestId('profile-role')).toHaveTextContent('client_admin'));
    expect(screen.getByTestId('profile-org-name')).toHaveTextContent('Acme Corp');
    expect(screen.getByLabelText('Display name')).toHaveValue('Dana Mercer');
  });

  it('shows "Internal analyst" instead of a role/org for an internal analyst, omitting the Organization field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ clientIds: [], isInternal: true, role: null, clientName: null }), { status: 200 }),
    ));
    render(<ProfileView />);

    await waitFor(() => expect(screen.getByTestId('profile-role')).toHaveTextContent('Internal analyst'));
    expect(screen.queryByTestId('profile-org-name')).not.toBeInTheDocument();
  });

  it('AC3: saving a new display name PATCHes /api/profile and reflects the response', async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes('/api/auth/memberships')) {
        return Promise.resolve(new Response(JSON.stringify({ clientIds: ['c1'], isInternal: false, role: 'client_admin', clientName: 'Acme Corp' }), { status: 200 }));
      }
      if (url.includes('/api/profile')) {
        return Promise.resolve(new Response(JSON.stringify({ name: 'New Name', email: 'dana@example.com', image: null }), { status: 200 }));
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<ProfileView />);
    await waitFor(() => expect(screen.getByLabelText('Display name')).toHaveValue('Dana Mercer'));

    await user.clear(screen.getByLabelText('Display name'));
    await user.type(screen.getByLabelText('Display name'), 'New Name');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByTestId('profile-identity-saved')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith('/api/profile', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ name: 'New Name', image: null }),
    }));
  });

  it('AC2: a successful save triggers a session refetch, so the nav UserMenu (a separate useSession() subscriber) picks up the new name', async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes('/api/auth/memberships')) {
        return Promise.resolve(new Response(JSON.stringify({ clientIds: ['c1'], isInternal: false, role: 'client_admin', clientName: 'Acme Corp' }), { status: 200 }));
      }
      if (url.includes('/api/profile')) {
        return Promise.resolve(new Response(JSON.stringify({ name: 'New Name', email: 'dana@example.com', image: null }), { status: 200 }));
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<ProfileView />);
    await waitFor(() => expect(screen.getByLabelText('Display name')).toHaveValue('Dana Mercer'));

    await user.clear(screen.getByLabelText('Display name'));
    await user.type(screen.getByLabelText('Display name'), 'New Name');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(refetchSessionMock).toHaveBeenCalledTimes(1));
  });

  it('rejects a blank display name client-side, without calling PATCH', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ clientIds: [], isInternal: true, role: null, clientName: null }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<ProfileView />);
    await waitFor(() => expect(screen.getByLabelText('Display name')).toHaveValue('Dana Mercer'));

    await user.clear(screen.getByLabelText('Display name'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByTestId('profile-identity-error')).toHaveTextContent('Name cannot be blank.');
    expect(fetchMock).not.toHaveBeenCalledWith('/api/profile', expect.anything());
  });

  it('AC4/AC5: submits a password change against changePassword()', async () => {
    const user = userEvent.setup();
    render(<ProfileView />);

    await user.type(screen.getByLabelText('Current password'), 'old-pw-12345');
    await user.type(screen.getByLabelText('New password'), 'new-pw-12345');
    await user.type(screen.getByLabelText('Confirm new password'), 'new-pw-12345');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() => expect(screen.getByTestId('profile-password-saved')).toBeInTheDocument());
    expect(changePasswordMock).toHaveBeenCalledWith({ currentPassword: 'old-pw-12345', newPassword: 'new-pw-12345' });
  });

  it('rejects a mismatched confirmation client-side, without calling changePassword()', async () => {
    const user = userEvent.setup();
    render(<ProfileView />);

    await user.type(screen.getByLabelText('Current password'), 'old-pw-12345');
    await user.type(screen.getByLabelText('New password'), 'new-pw-12345');
    await user.type(screen.getByLabelText('Confirm new password'), 'different-pw');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(screen.getByTestId('profile-password-error')).toHaveTextContent('do not match');
    expect(changePasswordMock).not.toHaveBeenCalled();
  });

  it('surfaces the server error when changePassword() fails (e.g. wrong current password)', async () => {
    changePasswordMock.mockResolvedValue({ error: { message: 'Invalid current password' } });
    const user = userEvent.setup();
    render(<ProfileView />);

    await user.type(screen.getByLabelText('Current password'), 'wrong-pw-12345');
    await user.type(screen.getByLabelText('New password'), 'new-pw-12345');
    await user.type(screen.getByLabelText('Confirm new password'), 'new-pw-12345');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() => expect(screen.getByTestId('profile-password-error')).toHaveTextContent('Invalid current password'));
  });

  it('AC6: lists registered passkeys and removes one via deletePasskey()', async () => {
    listUserPasskeysMock
      .mockResolvedValueOnce({ data: [{ id: 'pk-1', name: 'MacBook Touch ID' }], error: null })
      .mockResolvedValueOnce({ data: [], error: null });
    const user = userEvent.setup();
    render(<ProfileView />);

    await waitFor(() => expect(screen.getByTestId('passkey-list')).toBeInTheDocument());
    expect(screen.getByText('MacBook Touch ID')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(deletePasskeyMock).toHaveBeenCalledWith({ id: 'pk-1' });
    await waitFor(() => expect(screen.getByTestId('passkey-empty')).toBeInTheDocument());
  });

  it('shows an empty state when no passkeys are registered', async () => {
    render(<ProfileView />);
    await waitFor(() => expect(screen.getByTestId('passkey-empty')).toBeInTheDocument());
  });

  it('fails closed to an empty passkey list (never crashes) when the list fetch returns a malformed body', async () => {
    listUserPasskeysMock.mockResolvedValue({ data: 'not-an-array', error: null });
    render(<ProfileView />);

    await waitFor(() => expect(screen.getByTestId('passkey-empty')).toBeInTheDocument());
    // The rest of the page must still be usable -- this is the regression
    // this test guards: a passkey-list crash previously blanked the whole
    // page, including these unrelated sections.
    expect(screen.getByLabelText('Display name')).toBeInTheDocument();
  });

  it('fails closed to an empty passkey list (never crashes) when the list fetch itself rejects', async () => {
    listUserPasskeysMock.mockRejectedValue(new Error('network error'));
    render(<ProfileView />);

    await waitFor(() => expect(screen.getByTestId('passkey-empty')).toBeInTheDocument());
  });
});
