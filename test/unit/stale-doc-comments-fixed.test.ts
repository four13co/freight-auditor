import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

/**
 * 86e367qz9: two doc comments described gaps that 86e32tg6n and the
 * criterion_id resolver fix already closed, and were left actively
 * misleading. Pins both comments' corrected claims so neither can silently
 * regress back to describing a gap that no longer exists.
 */
describe('stale doc comments no longer describe closed gaps', () => {
  it('stub-crosswalk.ts no longer claims resolveChargeCode is unwired', () => {
    const content = readFileSync(join(ROOT, 'src/modules/ingestion/stub-crosswalk.ts'), 'utf8');
    expect(content).not.toMatch(/never been wired to any parser/);
    expect(content).toMatch(/86e32tg6n/);
    expect(content).toMatch(/resolveCategorizer now calls it directly/);
  });

  it('list-gate-failures.ts no longer claims gate_failure.criterion_id is always NULL', () => {
    const content = readFileSync(join(ROOT, 'src/modules/findings/list-gate-failures.ts'), 'utf8');
    expect(content).not.toMatch(/criterion_id is currently always NULL/);
    expect(content).toMatch(/resolveCriterionIds/);
  });
});
