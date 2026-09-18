import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

/**
 * 86e3aq0h7: role-wire-mapping.ts (roleWireToDb/roleDbToWire) was
 * 86e3ankd7's wire-boundary translation layer, deleted now that the wire
 * speaks account_viewer/account_admin directly. Walks src/ and test/ (not
 * web/, not node_modules) rather than a fixed file list, so a future
 * reintroduction anywhere is caught, not just at the sites known today.
 */
function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, files);
    } else if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

const SELF = 'test/unit/role-wire-mapping-removed.test.ts';

describe('role-wire-mapping.ts is fully removed', () => {
  it('no file under src/ or test/ imports or references it', () => {
    const offenders: string[] = [];
    for (const dir of ['src', 'test']) {
      for (const file of walk(join(ROOT, dir))) {
        const relative = file.slice(ROOT.length + 1);
        if (relative === SELF) continue;
        const content = readFileSync(file, 'utf8');
        if (/role-wire-mapping|roleWireToDb|roleDbToWire/.test(content)) {
          offenders.push(relative);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
