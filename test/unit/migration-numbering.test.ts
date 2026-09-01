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
 *
 * Same class, 0067: #238, #244, and #251 each independently claimed 0067
 * (each PR's own CI only ever saw its own single 0067 file). Verified
 * against deploy.yml's migrate-database job logs, not assumed: all three are
 * already applied and recorded on the real freight-auditor-dev DB by these
 * exact filenames -- 0067_workflow_outbox_message_recovery (run 33499501288,
 * 2026-09-01T10:51:35Z) and 0067_discovery_rule_proposal_backtest +
 * 0067_dispute_comm_dedupe_key (run 33499670912, 2026-09-01T10:54:11Z, same
 * run that also applied 0068_discovery_rule_proposal_acceptance). Renaming
 * any of the three now would make node-pg-migrate treat it as a new,
 * unapplied migration on the next deploy and re-run its UP body against
 * objects that already exist -- a real deploy failure, not a hypothetical.
 * Grandfathered, not renumbered, for the identical reason 0019 was.
 */
const GRANDFATHERED_DUPLICATE_NUMBERS = new Set(['0019', '0067']);

/**
 * node-pg-migrate's checkOrder zips already-applied migration names against
 * the on-disk file list position-by-position and throws on the first
 * mismatch (see 86e319zzf, #189/#210): two files claiming the same leading
 * number, or a lower number landing after a higher one has already been
 * applied elsewhere, breaks every future deploy. A duplicate number on disk
 * is the one form of that collision this repo can catch statically, without
 * a real DB or knowledge of what's already applied in production.
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
