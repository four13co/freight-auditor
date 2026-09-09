import { useEffect, useState, type DependencyList } from 'react';

export interface ClientPortalResourceState<T> {
  data: T | null;
  error: boolean;
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
 */
export function useClientPortalResource<T>(
  fetchFn: () => Promise<T> | null,
  deps: DependencyList,
): ClientPortalResourceState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const promise = fetchFn();
    if (promise === null) {
      setData(null);
      setError(false);
      return;
    }

    let cancelled = false;
    setData(null);
    setError(false);
    promise.then(
      (result) => { if (!cancelled) setData(result); },
      () => { if (!cancelled) setError(true); },
    );
    return () => { cancelled = true; };
  }, deps);

  return { data, error };
}
