/**
 * The one shared dev/real-session gate (carried over from the pre-rebuild
 * app, 86e2xcnw5). true on the dev-header path: import.meta.env.DEV (a
 * real `vite dev` server), or VITE_DEV_AUTH_HEADERS === '1' (CI's explicit
 * build-time opt-in for the web-fullstack job -- a real deploy build never
 * sets this).
 */
export function devHeaderPathActive(): boolean {
  return import.meta.env.DEV || import.meta.env.VITE_DEV_AUTH_HEADERS === '1';
}
