import { useEffect, useState } from 'react';
import { Dashboard } from './components/Dashboard.js';
import { LoginForm } from './components/LoginForm.js';
import { useSession } from './lib/auth-client.js';
import { fetchAndStoreClientId } from './lib/api.js';

/**
 * 86e2v1bdj: gates the dashboard behind a real session in a production
 * build. Uses the SAME two flags api.ts's authHeaders() gates on (DEV, or
 * the explicit VITE_DEV_AUTH_HEADERS CI opt-in) -- these two gates must stay
 * coherent: any build that skips the login form here must be the same build
 * that's actually sending the dev headers api.ts relies on, or the dashboard
 * renders with a blank/401 payload instead of real data. Keeps the existing
 * dev-header path (86e2uv4p0's fullstack e2e suite, and this item's own
 * login e2e spec's dev-header baseline) working exactly as before --
 * neither suite authenticates a real better-auth session, and must not be
 * required to. Outside both flags, an unauthenticated user must see the
 * login form, never the dashboard or a blank/broken screen (AC1/AC5) -- and
 * while the session check itself is still pending, neither renders, to
 * avoid a login-form flash for an already-logged-in user reloading the page
 * (AC4: "session persists... without requiring re-login").
 */
function devHeaderPathActive(): boolean {
  return import.meta.env.DEV || import.meta.env.VITE_DEV_AUTH_HEADERS === '1';
}

export default function App() {
  const { data: session, isPending } = useSession();
  // 86e2wb92b: on the real-session path, api.ts's authHeaders() needs a
  // stored client_id before any /api/findings* call can succeed -- fetched
  // once per session via /api/auth/memberships. Starts true so Dashboard
  // never renders (and never fires its own fetches) before that lookup
  // settles; the dev-header path skips this entirely (devHeaderPathActive()
  // short-circuits below), so it never waits on a lookup it doesn't need.
  const [clientIdReady, setClientIdReady] = useState(false);

  useEffect(() => {
    if (devHeaderPathActive() || !session) return;
    setClientIdReady(false);
    fetchAndStoreClientId().finally(() => setClientIdReady(true));
  }, [session]);

  if (devHeaderPathActive()) return <Dashboard />;
  if (isPending) return null;
  if (!session) return <LoginForm />;
  if (!clientIdReady) return null;
  return <Dashboard />;
}
