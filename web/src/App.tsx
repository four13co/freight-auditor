import { useEffect, useState } from 'react';
import { Dashboard } from './components/Dashboard.js';
import { LoginForm } from './components/LoginForm.js';
import { PortalApp } from './components/PortalApp.js';
import { useSession } from './lib/auth-client.js';
import { fetchAndStoreClientId, fetchActorContext, fetchBranding, type ActorContext, type Branding } from './lib/api.js';
import { devHeaderPathActive } from './lib/dev-auth.js';

/**
 * 86e2v1bdj: gates the dashboard behind a real session in a production
 * build. Uses the SAME shared gate api.ts's authHeaders() gates on
 * (lib/dev-auth.ts's devHeaderPathActive(), 86e2xcnw5) -- these two call
 * sites must stay coherent: any build that skips the login form here must
 * be the same build that's actually sending the dev headers api.ts relies
 * on, or the dashboard renders with a blank/401 payload instead of real
 * data. Keeps the existing dev-header path (86e2uv4p0's fullstack e2e
 * suite, and this item's own login e2e spec's dev-header baseline) working
 * exactly as before -- neither suite authenticates a real better-auth
 * session, and must not be required to. Outside both flags, an
 * unauthenticated user must see the login form, never the dashboard or a
 * blank/broken screen (AC1/AC5) -- and while the session check itself is
 * still pending, neither renders, to avoid a login-form flash for an
 * already-logged-in user reloading the page (AC4: "session persists...
 * without requiring re-login").
 *
 * 86e2zfjmb: on the real-session path, a resolved session no longer always
 * means Dashboard -- an internal analyst (app_user.is_internal) still lands
 * on Dashboard exactly as before, but a portal member (client_viewer/
 * client_admin) now routes to the client portal shell (PortalApp) instead.
 * The dev-header path is deliberately UNCHANGED (still an unconditional
 * early return to Dashboard, no actor-type fetch at all): that path's fixed
 * identity has always been treated as this app's one dashboard user (see
 * scripts/seed-dev-tenant.mjs's own comment), and the existing dev-header
 * e2e suite must keep passing exactly as today (AC1) -- fetching actor type
 * on that path would risk a network dependency the dev-header suite never
 * needed before.
 */
export default function App() {
  const { data: session, isPending } = useSession();
  // 86e2wb92b: on the real-session path, api.ts's authHeaders() needs a
  // stored client_id before any /api/findings* call can succeed -- fetched
  // once per session via /api/auth/memberships. Starts true so Dashboard
  // never renders (and never fires its own fetches) before that lookup
  // settles; the dev-header path skips this entirely (devHeaderPathActive()
  // short-circuits below), so it never waits on a lookup it doesn't need.
  const [clientIdReady, setClientIdReady] = useState(false);
  // 86e2zfjmb: the actor-type lookup this same real-session effect now also
  // performs (in parallel with fetchAndStoreClientId, not sequentially --
  // see fetchActorContext's own comment for why this is two fetches to the
  // same endpoint rather than one).
  const [actorContext, setActorContext] = useState<ActorContext | null>(null);
  // 86e320pkc: per-Customer white-labeling. Unconditional and independent of
  // the session effect below -- branding must render even on the login page
  // itself (any user, signed in or not, visiting a Customer's configured
  // domain), so this never gates Dashboard/LoginForm/PortalApp on itself the
  // way clientIdReady does; a re-render once it resolves is sufficient.
  const [branding, setBranding] = useState<Branding | null>(null);

  useEffect(() => {
    fetchBranding().then((result) => {
      setBranding(result);
      const root = document.documentElement.style;
      if (result.branded && result.primaryColor) {
        root.setProperty('--brand-primary', result.primaryColor);
      } else {
        root.removeProperty('--brand-primary');
      }
      if (result.branded && result.secondaryColor) {
        root.setProperty('--brand-secondary', result.secondaryColor);
      } else {
        root.removeProperty('--brand-secondary');
      }
    });
  }, []);

  useEffect(() => {
    if (devHeaderPathActive() || !session) return;
    setClientIdReady(false);
    setActorContext(null);
    // 86e2wb92b's fetchAndStoreClientId() has no internal try/catch around
    // its own res.json() call (a deliberate no-behavior-change constraint on
    // that pre-existing function -- see fetchActorContext's own comment) --
    // .catch(() => {}) here, not inside that function, keeps a rejection
    // from it out of this Promise.all so a malformed-response failure on
    // EITHER lookup still lets clientIdReady/actorContext settle instead of
    // leaving this effect (and therefore the whole app) permanently blank.
    Promise.all([fetchAndStoreClientId().catch(() => {}), fetchActorContext()]).then(([, ctx]) => {
      setActorContext(ctx);
      setClientIdReady(true);
    });
  }, [session]);

  if (devHeaderPathActive()) return <Dashboard branding={branding} />;
  if (isPending) return null;
  if (!session) return <LoginForm />;
  if (!clientIdReady || !actorContext) return null;
  return actorContext.isInternal ? <Dashboard branding={branding} /> : <PortalApp branding={branding} />;
}
