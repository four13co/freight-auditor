import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction, type DependencyList } from 'react';

export interface ClientPortalResourceState<T> {
  data: T | null;
  error: boolean;
  /**
   * 86e39qa7c: re-runs the latest `fetchFn` without needing a `deps` change
   * -- the Retry-button / post-mutation-refresh escape hatch the hook
   * originally lacked. Reads `fetchFn` via a ref so it always re-invokes
   * the fetch the calling component would produce on its *next* render,
   * not a stale closure from whenever the effect last ran.
   */
  reload: () => void;
  /**
   * 86e39qa7c: updates `data` in place without a network round-trip -- for
   * a caller that already knows the new value (a save response, an
   * optimistic row edit) and doesn't want a `reload()` refetch just to see
   * it reflected.
   */
  setData: Dispatch<SetStateAction<T | null>>;
}

/**
 * 86e367r8t: collapses the fetch/loading/error state+effect logic
 * duplicated across the portal's 10 Client*View components -- a nullable
 * `T | null` result, a boolean error flag, and a mount/dep-change effect
 * guarded against a stale response landing after unmount or a dep change
 * (the standard `cancelled` flag).
 *
 * `fetchFn` returns `null` (rather than a Promise) to skip fetching
 * entirely and reset to the empty state -- the "no id selected yet" case
 * several views need (ClientClaimView, ClientDisputeDetailView, ...): pass
 * `() => (id === null ? null : fetchThing(id))` with `[id]` as `deps`. A
 * view with no such precondition just returns a Promise unconditionally
 * with `[]` as `deps` (mount-only, matching the original 4 no-param views'
 * own shape exactly).
 *
 * State resets to `{ data: null, error: false }` before each fetch starts
 * (not just once, on mount) -- required for the nullable-id views' own
 * "re-fetches when the id changes" behavior (a stale previous result must
 * not remain visible while the new one loads); a no-op for the mount-only
 * views since their `deps` never change after the first run.
 *
 * Offset pagination (86e39qa7c) is already covered by this same dep-change
 * mechanism -- a caller manages its own `page` state and includes it in
 * `deps` (see ClientAuditLogView.tsx), so no separate paginated variant is
 * needed; `reload()` below is the one genuine gap that blocked adoption by
 * views with a Retry button or a post-mutation refresh.
 */
export function useClientPortalResource<T>(
  fetchFn: () => Promise<T> | null,
  deps: DependencyList,
): ClientPortalResourceState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const fetchFnRef = useRef(fetchFn);
  fetchFnRef.current = fetchFn;

  const run = useCallback(() => {
    const promise = fetchFnRef.current();
    if (promise === null) {
      setData(null);
      setError(false);
      return undefined;
    }

    let cancelled = false;
    setData(null);
    setError(false);
    promise.then(
      (result) => { if (!cancelled) setData(result); },
      () => { if (!cancelled) setError(true); },
    );
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    return run();
  }, deps);

  return { data, error, reload: run, setData };
}
