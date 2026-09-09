import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

/**
 * 86e367ra2: r2-object-store.ts and configured-object-store.ts reimplemented
 * the same content-addressed object-store contract as object-store.ts's
 * S3ObjectStore + object-store-config.ts's readObjectStoreConfiguration --
 * the pair actually wired into invoice-drafts-routes.ts, contracts-routes.ts,
 * audit-runs-routes.ts, and static-routes.ts. The R2-specific pair was
 * superseded and had zero non-test callers repo-wide.
 */
describe('superseded R2 object-store implementation is removed', () => {
  const removedFiles = [
    'src/modules/reference-data/r2-object-store.ts',
    'src/modules/reference-data/configured-object-store.ts',
    'test/unit/r2-object-store.test.ts',
    'test/unit/configured-object-store.test.ts',
  ];

  it.each(removedFiles)('%s no longer exists', (path) => {
    expect(existsSync(join(ROOT, path))).toBe(false);
  });
});
