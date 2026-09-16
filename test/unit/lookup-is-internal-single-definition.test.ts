import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

/**
 * 86e39qa6r: lookupIsInternal (SELECT is_internal FROM app_user WHERE id =
 * $1 AND is_active = true) was defined 3x -- tenant-admin-auth.ts,
 * internal-analyst-auth.ts (byte-for-byte identical), and a drifted inline
 * copy in tenant-auth.ts's lookupActorType missing the is_active check.
 * Only tenant-auth.ts should define it now; the other 2 import it, same
 * pattern as read-header-single-definition.test.ts.
 */
describe('lookupIsInternal has a single definition', () => {
  const definerPath = 'src/modules/findings/tenant-auth.ts';
  const importerPaths = ['src/modules/findings/internal-analyst-auth.ts', 'src/modules/identity/tenant-admin-auth.ts'];

  it('is defined in exactly one file (tenant-auth.ts)', () => {
    const files = [definerPath, ...importerPaths];
    const definers = files.filter((f) =>
      /function lookupIsInternal\(/.test(readFileSync(join(ROOT, f), 'utf8')),
    );
    expect(definers).toEqual([definerPath]);
  });

  it('is imported by the other 2 files from tenant-auth.ts', () => {
    for (const f of importerPaths) {
      const content = readFileSync(join(ROOT, f), 'utf8');
      expect(content).toMatch(/import\s*\{[^}]*\blookupIsInternal\b[^}]*\}\s*from\s*['"][^'"]*tenant-auth\.js['"]/);
    }
  });

  it('is not re-declared inline anywhere, including a drifted copy missing the is_active check', () => {
    for (const f of importerPaths) {
      const content = readFileSync(join(ROOT, f), 'utf8');
      expect(content).not.toMatch(/SELECT is_internal FROM app_user/);
    }
  });
});
