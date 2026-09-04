import { useEffect, useRef } from 'react';

/**
 * Moves focus to the returned ref's element the moment `ready` flips from
 * false to true (a loading -> loaded/error transition) -- not on every
 * render while `ready` stays true, and not on the initial not-selected ->
 * still-not-selected case. Screen-reader users driving a list-then-select
 * flow (86e2zfjx3 AC4) get no other signal that new content replaced the
 * loading placeholder; without this they'd have to re-explore the DOM.
 *
 * Attach the returned ref (plus `tabIndex={-1}`, so it's programmatically
 * focusable without joining the tab order) to whichever element actually
 * renders once `ready` -- error message or loaded content are mutually
 * exclusive, so the same ref object can be passed to both.
 */
export function useFocusOnReady<T extends HTMLElement>(ready: boolean) {
  const ref = useRef<T>(null);
  const wasReady = useRef(false);

  useEffect(() => {
    if (ready && !wasReady.current) {
      ref.current?.focus();
    }
    wasReady.current = ready;
  }, [ready]);

  return ref;
}
