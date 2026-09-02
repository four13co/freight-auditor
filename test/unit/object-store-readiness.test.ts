import { describe, expect, it, vi } from 'vitest';
import type { ObjectStore } from '../../src/modules/reference-data/object-store.js';
import { checkObjectStoreReadiness } from '../../src/server/static-routes.js';

function fakeStore(has: ObjectStore['has']): ObjectStore {
  return {
    has,
    put: vi.fn(),
    get: vi.fn(),
  };
}

describe('checkObjectStoreReadiness', () => {
  it('reports ok when the sentinel exists or is cleanly absent', async () => {
    await expect(checkObjectStoreReadiness(() => fakeStore(vi.fn().mockResolvedValue(true))))
      .resolves.toBe('ok');
    await expect(checkObjectStoreReadiness(() => fakeStore(vi.fn().mockResolvedValue(false))))
      .resolves.toBe('ok');
  });

  it('reports unreachable for provider/auth/bucket failures without exposing details', async () => {
    const has = vi.fn().mockRejectedValue(new Error('secret endpoint and credential details'));
    await expect(checkObjectStoreReadiness(() => fakeStore(has))).resolves.toBe('unreachable');
  });

  it('reports misconfigured when the configured store cannot be constructed', async () => {
    await expect(checkObjectStoreReadiness(() => {
      throw new Error('R2_SECRET_ACCESS_KEY is required');
    })).resolves.toBe('misconfigured');
  });
});
