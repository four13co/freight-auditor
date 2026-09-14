import { useEffect, useState, type FormEvent } from 'react';
import { useSession, authClient, changePassword } from '../lib/auth-client.js';
import { fetchActorContext, updateProfile, type ActorContext } from '../lib/api.js';
import { PasskeyRegistration } from './PasskeyRegistration.js';

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface Passkey {
  id: string;
  name?: string;
}

/**
 * 86e38pz8e: Identity + Security section for both the internal Dashboard
 * and the client portal (mounted at /#/profile in both, Dashboard.tsx/
 * PortalApp.tsx). Session fields (name/email/image) come from useSession()
 * directly; role/org-name/is_internal come from fetchActorContext() (the
 * same GET /api/auth/memberships lookup App.tsx already uses for routing).
 *
 * Local `name`/`image` form state seeds this page's own display once, from
 * the resolved session -- but is NOT what keeps the nav UserMenu (a
 * separate component/session subscription in Sidebar.tsx/PortalApp.tsx) in
 * sync after a save. PATCH /api/profile writes app_user directly rather
 * than through better-auth's own update-user endpoint (this item's own
 * Solution), so better-auth's client-side session cache never observes the
 * change on its own -- `refetch()` (destructured from useSession(), the
 * same function the passkey plugin's own client calls internally via
 * `$store.notify('$sessionSignal')` after ITS server-side mutations) is
 * what forces every useSession() subscriber, including UserMenu's own,
 * to re-fetch and pick up the new name/image. AC2's "reflects in the nav
 * user menu" depends on this call, not on local state.
 */
export function ProfileView() {
  const { data: session, isPending: sessionPending, refetch: refetchSession } = useSession();
  const [actorContext, setActorContext] = useState<ActorContext | null>(null);
  const [name, setName] = useState('');
  const [image, setImage] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [identitySaveStatus, setIdentitySaveStatus] = useState<SaveStatus>('idle');
  const [identityError, setIdentityError] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordStatus, setPasswordStatus] = useState<SaveStatus>('idle');
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [passkeysLoaded, setPasskeysLoaded] = useState(false);
  const [passkeyRemoveError, setPasskeyRemoveError] = useState<string | null>(null);

  useEffect(() => {
    void fetchActorContext().then(setActorContext);
  }, []);

  // AC2: pre-fill the editable form from the resolved session, once --
  // never on a later session re-render, or an in-progress edit would be
  // silently overwritten out from under the user.
  useEffect(() => {
    if (loaded || sessionPending) return;
    if (!session?.user) return;
    setName(session.user.name ?? '');
    setImage(session.user.image ?? '');
    setLoaded(true);
  }, [session, sessionPending, loaded]);

  // Fails closed to an empty list on any error/malformed response (network
  // failure, an expired session, a non-array body) -- the passkey section
  // degrading to "no passkeys registered yet" is far better than a crash
  // that blanks the whole page, including the unrelated Identity/Security
  // forms above it.
  function refreshPasskeys() {
    void authClient.passkey
      .listUserPasskeys()
      .then((result) => {
        setPasskeys(Array.isArray(result.data) ? result.data : []);
        setPasskeysLoaded(true);
      })
      .catch(() => {
        setPasskeys([]);
        setPasskeysLoaded(true);
      });
  }

  useEffect(() => {
    refreshPasskeys();
  }, []);

  async function handleIdentitySubmit(e: FormEvent) {
    e.preventDefault();
    setIdentityError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setIdentityError('Name cannot be blank.');
      return;
    }
    const trimmedImage = image.trim();
    if (trimmedImage && !isValidHttpUrl(trimmedImage)) {
      setIdentityError('Avatar must be a valid http(s) URL, or left blank.');
      return;
    }

    setIdentitySaveStatus('saving');
    try {
      const updated = await updateProfile({ name: trimmedName, image: trimmedImage === '' ? null : trimmedImage });
      setName(updated.name ?? '');
      setImage(updated.image ?? '');
      await refetchSession();
      setIdentitySaveStatus('saved');
    } catch {
      setIdentitySaveStatus('error');
    }
  }

  async function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault();
    setPasswordError(null);

    if (newPassword !== confirmPassword) {
      setPasswordError('New password and confirmation do not match.');
      return;
    }

    setPasswordStatus('saving');
    const { error } = await changePassword({ currentPassword, newPassword });
    if (error) {
      setPasswordStatus('error');
      setPasswordError(error.message ?? 'Could not change password.');
      return;
    }
    setPasswordStatus('saved');
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  }

  async function handleRemovePasskey(id: string) {
    setPasskeyRemoveError(null);
    const { error } = await authClient.passkey.deletePasskey({ id });
    if (error) {
      setPasskeyRemoveError(error.message ?? 'Could not remove passkey.');
      return;
    }
    refreshPasskeys();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
      <div className="flex items-center gap-3 border-b-2 border-[rgba(32,30,29,0.4)] px-5 py-3.5">
        <span className="text-xl font-extrabold tracking-[-0.015em] text-[#201e1d]">Profile</span>
      </div>

      <section className="flex max-w-md flex-col gap-3 px-5" aria-labelledby="profile-identity-heading">
        <h2 id="profile-identity-heading" className="text-[15px] font-extrabold text-[#201e1d]">
          Identity
        </h2>

        <div className="flex flex-col gap-1 text-[13px]">
          <span className="font-semibold text-[#201e1d]">Email</span>
          <span data-testid="profile-email" className="text-[rgba(32,30,29,0.75)]">
            {session?.user?.email ?? '—'}
          </span>
        </div>

        <div className="flex flex-col gap-1 text-[13px]">
          <span className="font-semibold text-[#201e1d]">Role</span>
          <span data-testid="profile-role" className="text-[rgba(32,30,29,0.75)]">
            {actorContext?.isInternal ? 'Internal analyst' : (actorContext?.role ?? '—')}
          </span>
        </div>

        {!actorContext?.isInternal && (
          <div className="flex flex-col gap-1 text-[13px]">
            <span className="font-semibold text-[#201e1d]">Organization</span>
            <span data-testid="profile-org-name" className="text-[rgba(32,30,29,0.75)]">
              {actorContext?.clientName ?? '—'}
            </span>
          </div>
        )}

        <form
          data-testid="profile-identity-form"
          onSubmit={(e) => {
            void handleIdentitySubmit(e);
          }}
          className="flex flex-col gap-3"
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="profile-name" className="text-[13px] font-semibold text-[#201e1d]">
              Display name
            </label>
            <input
              id="profile-name"
              aria-label="Display name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-9 border border-[rgba(32,30,29,0.4)] px-2.5 text-sm outline-none"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="profile-image" className="text-[13px] font-semibold text-[#201e1d]">
              Avatar URL
            </label>
            <input
              id="profile-image"
              aria-label="Avatar URL"
              value={image}
              onChange={(e) => setImage(e.target.value)}
              placeholder="https://cdn.example.com/avatar.png"
              className="h-9 border border-[rgba(32,30,29,0.4)] px-2.5 text-sm outline-none"
            />
          </div>

          {identityError && (
            <span role="alert" data-testid="profile-identity-error" className="text-[12px] text-[#c0290f]">
              {identityError}
            </span>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={identitySaveStatus === 'saving'}
              className="flex h-9 items-center bg-[#ec3013] px-4 text-[13px] font-extrabold text-[#f3f2f2] disabled:opacity-60"
            >
              {identitySaveStatus === 'saving' ? 'Saving…' : 'Save'}
            </button>
            {identitySaveStatus === 'saved' && (
              <span data-testid="profile-identity-saved" role="status" className="text-[13px] font-semibold text-[#1a7f37]">
                Saved
              </span>
            )}
            {identitySaveStatus === 'error' && !identityError && (
              <span data-testid="profile-identity-save-error" role="alert" className="text-[13px] font-semibold text-[#c0290f]">
                Save failed. Try again.
              </span>
            )}
          </div>
        </form>
      </section>

      <section className="flex max-w-md flex-col gap-3 px-5" aria-labelledby="profile-security-heading">
        <h2 id="profile-security-heading" className="text-[15px] font-extrabold text-[#201e1d]">
          Security
        </h2>

        <form
          data-testid="profile-password-form"
          onSubmit={(e) => {
            void handlePasswordSubmit(e);
          }}
          className="flex flex-col gap-3"
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="profile-current-password" className="text-[13px] font-semibold text-[#201e1d]">
              Current password
            </label>
            <input
              id="profile-current-password"
              aria-label="Current password"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="h-9 border border-[rgba(32,30,29,0.4)] px-2.5 text-sm outline-none"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="profile-new-password" className="text-[13px] font-semibold text-[#201e1d]">
              New password
            </label>
            <input
              id="profile-new-password"
              aria-label="New password"
              type="password"
              autoComplete="new-password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="h-9 border border-[rgba(32,30,29,0.4)] px-2.5 text-sm outline-none"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="profile-confirm-password" className="text-[13px] font-semibold text-[#201e1d]">
              Confirm new password
            </label>
            <input
              id="profile-confirm-password"
              aria-label="Confirm new password"
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="h-9 border border-[rgba(32,30,29,0.4)] px-2.5 text-sm outline-none"
            />
          </div>

          {passwordError && (
            <span role="alert" data-testid="profile-password-error" className="text-[12px] text-[#c0290f]">
              {passwordError}
            </span>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={passwordStatus === 'saving'}
              className="flex h-9 items-center bg-[#ec3013] px-4 text-[13px] font-extrabold text-[#f3f2f2] disabled:opacity-60"
            >
              {passwordStatus === 'saving' ? 'Changing…' : 'Change password'}
            </button>
            {passwordStatus === 'saved' && (
              <span data-testid="profile-password-saved" role="status" className="text-[13px] font-semibold text-[#1a7f37]">
                Password changed
              </span>
            )}
          </div>
        </form>

        <div className="flex flex-col gap-2 pt-2">
          <h3 className="text-[13px] font-extrabold text-[#201e1d]">Passkeys</h3>
          <PasskeyRegistration onRegistered={refreshPasskeys} />
          {passkeyRemoveError && (
            <span role="alert" className="text-[12px] text-[#c0290f]">
              {passkeyRemoveError}
            </span>
          )}
          {passkeysLoaded && passkeys.length === 0 && (
            <span data-testid="passkey-empty" className="text-[13px] text-[rgba(32,30,29,0.65)]">
              No passkeys registered yet.
            </span>
          )}
          {passkeys.length > 0 && (
            <ul data-testid="passkey-list" className="flex flex-col gap-1.5">
              {passkeys.map((passkey) => (
                <li
                  key={passkey.id}
                  data-testid="passkey-row"
                  className="flex items-center justify-between gap-2 border border-[rgba(32,30,29,0.2)] px-3 py-2 text-[13px]"
                >
                  <span>{passkey.name ?? 'Unnamed passkey'}</span>
                  <button
                    type="button"
                    onClick={() => {
                      void handleRemovePasskey(passkey.id);
                    }}
                    className="text-[12px] font-bold text-[#c0290f]"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
