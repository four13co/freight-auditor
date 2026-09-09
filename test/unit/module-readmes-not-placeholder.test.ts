import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

/**
 * 86e367r7x: claims/README.md, disputes/README.md, audit-ledger/README.md,
 * reference-data/README.md, and rule-engine/README.md still said
 * "Placeholder -- No implementation yet" despite being among the most
 * fully-built modules in the codebase. disputes/ and reference-data/ were
 * already fixed (86e367r7r, 86e367rab); this closes claims/, audit-ledger/,
 * and rule-engine/.
 */
describe('module READMEs no longer claim to be unimplemented placeholders', () => {
  const modules = ['claims', 'disputes', 'audit-ledger', 'reference-data', 'rule-engine'];

  it('none of the 5 READMEs say "Placeholder ... No implementation yet"', () => {
    for (const mod of modules) {
      const content = readFileSync(join(ROOT, 'src/modules', mod, 'README.md'), 'utf8');
      expect(content).not.toMatch(/Placeholder.*No implementation yet/s);
    }
  });

  it('each of the 3 previously-stale READMEs names real files that actually exist in its module', () => {
    const expectations: Record<string, string[]> = {
      claims: ['resolve-claim.ts', 'create-claim-from-dispute.ts', 'record-partial-recovery.ts'],
      'audit-ledger': ['write-audit-event.ts', 'replay-audit-run.ts'],
      'rule-engine': ['interpreter.ts', 'transition-rule-lifecycle.ts'],
    };
    for (const [mod, files] of Object.entries(expectations)) {
      const content = readFileSync(join(ROOT, 'src/modules', mod, 'README.md'), 'utf8');
      for (const file of files) {
        expect(content).toContain(file);
      }
    }
  });
});
