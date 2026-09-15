import { useState } from 'react';
import { useSession, signOut } from '../lib/auth-client.js';
import { devHeaderPathActive } from '../lib/dev-auth.js';
import { CLIENT_ID_STORAGE_KEY } from '../lib/api.js';
import { getDisplayName, getInitials } from '../lib/user-display.js';

/**
 * 86e38pz8e: shared between Sidebar.tsx's footer (replacing the hardcoded
 * "Dana Mercer" / "Ops analyst · Four13" placeholder) and PortalApp.tsx's
 * PortalNav (which had no user/account section at all) -- avatar (or
 * initials), name/email from the real better-auth session, and a dropdown
 * with "Profile" (-> /#/profile) and "Sign out". Calls useSession()/
 * signOut() directly; neither needs Router context, so this works
 * identically whether its host is renderable standalone (Sidebar.test.tsx's
 * `render(<Sidebar />)` with no Router) or always Router-wrapped
 * (PortalNav).
 *
 * devHeaderPathActive() gates the DISPLAYED identity, not the controls --
 * the dev-header path never establishes a real better-auth session (same
 * gate PasskeyRegistration.tsx already uses), so session data is
 * deliberately ignored there rather than shown stale/wrong; Profile and
 * Sign out stay reachable either way.
 */
export function UserMenu() {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const devPath = devHeaderPathActive();
  const name = devPath ? null : (session?.user?.name ?? null);
  const email = devPath ? null : (session?.user?.email ?? null);
  const image = devPath ? null : (session?.user?.image ?? null);
  const displayName = getDisplayName(name, email);
  const initials = getInitials(name, email);

  async function handleSignOut() {
    setOpen(false);
    const { error } = await signOut();
    if (!error) sessionStorage.removeItem(CLIENT_ID_STORAGE_KEY);
  }

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="user-menu-trigger"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 text-left"
      >
        {image ? (
          <img src={image} alt="" data-testid="user-menu-avatar" className="h-8 w-8 flex-none rounded-full object-cover" />
        ) : (
          <span
            data-testid="user-menu-initials"
            className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-sidebar-active text-[12px] font-bold text-sidebar-fg"
          >
            {initials}
          </span>
        )}
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-semibold">{displayName}</span>
          {email && <span className="truncate text-[11px] text-sidebar-fg-55">{email}</span>}
        </span>
      </button>
      {open && (
        <div
          role="menu"
          data-testid="user-menu-dropdown"
          className="absolute bottom-full left-0 z-10 mb-1 w-full border border-sidebar-border bg-sidebar-bg py-1"
        >
          <a
            role="menuitem"
            href="#/profile"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-[13px] text-sidebar-fg-85"
          >
            Profile
          </a>
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              void handleSignOut();
            }}
            className="block w-full px-3 py-2 text-left text-[13px] text-sidebar-fg-85"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
