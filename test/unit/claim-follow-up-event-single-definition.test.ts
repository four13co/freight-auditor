import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

/**
 * 86e367qzk: 'claim.follow_up_sent' was declared/hardcoded independently in
 * 3 places (generate-claim-escalation.ts's own CLAIM_FOLLOW_UP_EVENT const,
 * "temporary until #184 merges"; list-claim-aging-queues.ts's own copy;
 * generate-claim-follow-up.ts's raw literal x2) after #184 had already
 * merged. Same treatment CLAIM_TERMINAL_EVENTS already got in
 * claim-status.ts -- this unifies CLAIM_FOLLOW_UP_EVENT there too.
 */
describe('CLAIM_FOLLOW_UP_EVENT has a single definition', () => {
  const claimStatusPath = 'src/modules/claims/claim-status.ts';
  const callerPaths = [
    'src/modules/claims/generate-claim-escalation.ts',
    'src/modules/claims/list-claim-aging-queues.ts',
    'src/modules/claims/generate-claim-follow-up.ts',
  ];

  it('is defined in claim-status.ts', () => {
    const content = readFileSync(join(ROOT, claimStatusPath), 'utf8');
    expect(content).toMatch(/export const CLAIM_FOLLOW_UP_EVENT = 'claim\.follow_up_sent'/);
  });

  it('is not independently declared or hardcoded as a literal in any of the 3 call sites', () => {
    for (const path of callerPaths) {
      const content = readFileSync(join(ROOT, path), 'utf8');
      expect(content).not.toMatch(/CLAIM_FOLLOW_UP_EVENT\s*=\s*'claim\.follow_up_sent'/);
      expect(content).not.toContain("'claim.follow_up_sent'");
    }
  });

  it('is imported from claim-status.js by all 3 call sites', () => {
    for (const path of callerPaths) {
      const content = readFileSync(join(ROOT, path), 'utf8');
      expect(content).toMatch(/import\s*\{[^}]*\bCLAIM_FOLLOW_UP_EVENT\b[^}]*\}\s*from\s*['"][^'"]*claim-status\.js['"]/);
    }
  });
});
