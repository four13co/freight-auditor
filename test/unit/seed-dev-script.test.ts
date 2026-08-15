import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * 86e2urn24: scripts/seed-dev-tenant.mjs must be run by hand before the
 * dashboard can return non-401 data (see PR #55/86e2urebj), but had no
 * npm script or documentation pointing at it. This asserts the discovery
 * path exists -- not the seed script's own logic, which is already covered
 * by test/db/seed-dev-tenant.db.test.ts.
 */
describe('seed:dev npm script (discoverability)', () => {
  it('AC1: package.json has a seed:dev script invoking scripts/seed-dev-tenant.mjs', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.['seed:dev']).toBe('node scripts/seed-dev-tenant.mjs');
  });
});
