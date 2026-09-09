import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

/**
 * 86e367qyd: readHeader(value) { return Array.isArray(value) ? value[0] : value; }
 * was byte-identically duplicated across 4 auth files. Only tenant-auth.ts
 * should define it now; the other 3 import it, same as they already import
 * the sibling helper toFetchHeaders.
 */
describe('readHeader has a single definition', () => {
  const files = [
    'src/modules/findings/tenant-auth.ts',
    'src/modules/findings/internal-analyst-auth.ts',
    'src/modules/identity/client-admin-auth.ts',
    'src/modules/identity/client-viewer-auth.ts',
  ];

  it('is defined in exactly one file (tenant-auth.ts)', () => {
    const definers = files.filter((f) =>
      /function readHeader\(/.test(readFileSync(join(ROOT, f), 'utf8')),
    );
    expect(definers).toEqual(['src/modules/findings/tenant-auth.ts']);
  });

  it('is imported by the other 3 files from tenant-auth.ts', () => {
    for (const f of files.filter((f) => f !== 'src/modules/findings/tenant-auth.ts')) {
      const content = readFileSync(join(ROOT, f), 'utf8');
      expect(content).toMatch(/import\s*\{[^}]*\breadHeader\b[^}]*\}\s*from\s*['"][^'"]*tenant-auth\.js['"]/);
    }
  });
});
