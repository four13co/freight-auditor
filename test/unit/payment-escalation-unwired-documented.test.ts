import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

/**
 * 86e36ctpz: generate-payment-escalation.ts is built and tested but never
 * called outside tests, and unlike its sibling generate-short-pay-decision.ts
 * (which carries an explicit "Deliberately NOT auto-wired into persist.ts"
 * comment), it had no such note -- the only documented reasoning lived in a
 * since-closed PR's Uncertainties section. Pins an in-module comment stating
 * why it's unwired, discoverable without PR history.
 */
describe('generate-payment-escalation.ts documents why it is deliberately unwired', () => {
  const content = readFileSync(
    join(ROOT, 'src/modules/payments/generate-payment-escalation.ts'),
    'utf8',
  );

  it('states it is deliberately not auto-wired', () => {
    expect(content).toMatch(/[Dd]eliberately\s+(?:NOT|not)\s+(?:auto-)?wired/);
  });

  it('names why: a scheduled/grace-period check, not a one-shot lifecycle transition', () => {
    expect(content).toMatch(/scheduled/i);
    expect(content).toMatch(/grace.?period/i);
    expect(content).toMatch(/persist\.ts/);
  });

  it('names what would unblock it: a not-yet-built scheduled trigger point', () => {
    expect(content).toMatch(/doesn't (yet )?exist|does not (yet )?exist|not.?yet.?built/i);
  });
});
