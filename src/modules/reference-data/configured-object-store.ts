import type { ObjectStore } from './object-store.js';
import { LocalDiskObjectStore } from './object-store.js';
import { r2ObjectStoreFromEnv } from './r2-object-store.js';

export function configuredObjectStore(
  localRoot: string,
  env: Record<string, string | undefined> = process.env,
): ObjectStore {
  return env.R2_BUCKET?.trim() ? r2ObjectStoreFromEnv(env) : new LocalDiskObjectStore(localRoot);
}
