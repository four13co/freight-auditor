/**
 * 86e2xcnw5: the ONE shared dev/real-session gate. App.tsx's
 * devHeaderPathActive() and api.ts's authHeaders() each encoded this exact
 * predicate as a separate expression (api.ts's own negated form) in two
 * files -- both files' own comments explicitly said the two gates "must
 * stay coherent," which is the tell that this should be one named, exported
 * predicate instead of two hand-synchronized ones.
 *
 * true on the dev-header path: import.meta.env.DEV (a real `vite dev`
 * server), or VITE_DEV_AUTH_HEADERS === '1' (CI's explicit build-time
 * opt-in for the web-fullstack job -- a real deploy build never sets this).
 */
export function devHeaderPathActive(): boolean {
  return import.meta.env.DEV || import.meta.env.VITE_DEV_AUTH_HEADERS === '1';
}
