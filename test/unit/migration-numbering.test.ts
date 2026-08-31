import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '../../migrations');

/**
 * Pre-existing collision from #127 (already merged, already applied under
 * these exact filenames wherever node-pg-migrate has run) -- renumbering
 * either file now would break checkOrder against any DB that already
 * recorded it under 0019. Grandfathered rather than fixed; this guard is
 * only meant to stop a *new* collision from being introduced going forward.
 */
const GRANDFATHERED_DUPLICATE_NUMBERS = new Set(['0019']);

/**
 * node-pg-migrate's checkOrder zips already-applied migration names against
 * the on-disk file list position-by-position and throws on the first
 * mismatch (see 86e319zzf, #189/#210): two files claiming the same leading
 * number, or a lower number landing after a higher one has already been
 * applied elsewhere, breaks every future deploy. A duplicate number on disk
 * is the one form of that collision this repo can catch statically, without
 * a real DB or knowledge of what's already applied in production.
 *
 * The other form -- a pending file numbered below one already applied on a
 * specific persistent DB -- is no longer only caught reactively (#212,
 * #217's rename-and-re-PR cycle). scripts/renumber-pending-migrations.mjs
 * (86e31e6vz) now runs at deploy time, right before `migrate up`, and
 * renumbers any pending file against that DB's real applied history before
 * checkOrder ever sees it. See test/unit/renumber-pending-migrations.test.ts.
 */
describe('migration file numbering', () => {
  it('has no new migration files claiming an already-used leading number', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    const numbers = new Map<string, string[]>();
    for (const file of files) {
      const match = /^(\d+)_/.exec(file);
      if (!match) continue;
      const number = match[1]!;
      const existing = numbers.get(number) ?? [];
      existing.push(file);
      numbers.set(number, existing);
    }

    const duplicates = [...numbers.entries()].filter(
      ([number, matchingFiles]) => matchingFiles.length > 1 && !GRANDFATHERED_DUPLICATE_NUMBERS.has(number),
    );
    expect(duplicates).toEqual([]);
  });
});
