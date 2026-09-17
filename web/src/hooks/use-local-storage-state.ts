import { useEffect, useState } from 'react';

/**
 * Reads once on mount (SSR-safe: falls back to `initialValue` when
 * `localStorage` is unavailable or the stored value fails to parse), then
 * mirrors every state change back to `localStorage` under `key`.
 */
export function useLocalStorageState<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored !== null ? (JSON.parse(stored) as T) : initialValue;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // localStorage unavailable (private mode, quota) -- state still works in-memory.
    }
  }, [key, value]);

  return [value, setValue] as const;
}
