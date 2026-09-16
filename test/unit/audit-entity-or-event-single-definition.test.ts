import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

/**
 * 86e39qa78: the audit-ledger entity/event name shape was defined 3x --
 * audit-log-routes.ts and portal-content-routes.ts each declared their own
 * AUDIT_ENTITY_OR_EVENT constant, and write-audit-event.ts's
 * AuditEventInputSchema inlined the same regex literal twice. Only
 * src/shared/request-validation.ts should define the pattern now.
 */
describe('AUDIT_ENTITY_OR_EVENT_PATTERN has a single definition', () => {
  const CANONICAL = 'src/shared/request-validation.ts';
  const otherFiles = [
    'src/server/audit-log-routes.ts',
    'src/server/portal-content-routes.ts',
    'src/modules/audit-ledger/write-audit-event.ts',
  ];

  const LITERAL = '/^[a-z][a-z0-9_.-]*$/';

  it('is defined only in request-validation.ts', () => {
    const files = [CANONICAL, ...otherFiles];
    const definers = files.filter((f) => readFileSync(join(ROOT, f), 'utf8').includes(LITERAL));
    expect(definers).toEqual([CANONICAL]);
  });

  it('is imported by audit-log-routes.ts, portal-content-routes.ts, and write-audit-event.ts', () => {
    for (const f of otherFiles) {
      const content = readFileSync(join(ROOT, f), 'utf8');
      expect(content).toMatch(/import\s*\{[^}]*\bAUDIT_ENTITY_OR_EVENT_PATTERN\b[^}]*\}\s*from\s*['"][^'"]*request-validation\.js['"]/);
    }
  });
});
