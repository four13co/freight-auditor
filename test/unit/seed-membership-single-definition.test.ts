import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

/**
 * 86e39qa78: seed-admin-user.mjs, seed-dev-tenant.mjs, and
 * seed-e2e-auth-user.mjs each pasted the same
 * `INSERT INTO membership ... ON CONFLICT DO UPDATE SET role = EXCLUDED.role`
 * line. Only scripts/seed-membership.mjs should inline that SQL now; the
 * three seed scripts call its upsertAnalystMembership() helper instead.
 */
describe('the membership upsert SQL has a single definition', () => {
  const CANONICAL = 'scripts/seed-membership.mjs';
  const seedScripts = ['scripts/seed-admin-user.mjs', 'scripts/seed-dev-tenant.mjs', 'scripts/seed-e2e-auth-user.mjs'];
  const SQL_FRAGMENT = 'ON CONFLICT (user_id, client_id) DO UPDATE SET role = EXCLUDED.role';

  it('is defined only in seed-membership.mjs', () => {
    const files = [CANONICAL, ...seedScripts];
    const definers = files.filter((f) => readFileSync(join(ROOT, f), 'utf8').includes(SQL_FRAGMENT));
    expect(definers).toEqual([CANONICAL]);
  });

  it('is imported by each seed script from seed-membership.mjs', () => {
    for (const f of seedScripts) {
      const content = readFileSync(join(ROOT, f), 'utf8');
      expect(content).toMatch(/import\s*\{[^}]*\bupsertAnalystMembership\b[^}]*\}\s*from\s*['"]\.\/seed-membership\.mjs['"]/);
    }
  });
});
