import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

/**
 * 86e367r76: reconcile-portfolio-totals.ts re-declared ReconcilableClaimRow/
 * ReconcilableRecoveryEventRow byte-identical to the types 86e32tg28 already
 * exports from reconcile-claim-buckets.ts. The math got unified but the
 * types didn't.
 */
describe('ReconcilableClaimRow/ReconcilableRecoveryEventRow have a single definition', () => {
  it('are defined only in reconcile-claim-buckets.ts', () => {
    const buckets = readFileSync(join(ROOT, 'src/modules/claims/reconcile-claim-buckets.ts'), 'utf8');
    const totals = readFileSync(join(ROOT, 'src/modules/claims/reconcile-portfolio-totals.ts'), 'utf8');

    expect(buckets).toMatch(/export interface ReconcilableClaimRow/);
    expect(buckets).toMatch(/export interface ReconcilableRecoveryEventRow/);
    expect(totals).not.toMatch(/interface ReconcilableClaimRow/);
    expect(totals).not.toMatch(/interface ReconcilableRecoveryEventRow/);
  });

  it('reconcile-portfolio-totals.ts imports both types from reconcile-claim-buckets.js', () => {
    const content = readFileSync(join(ROOT, 'src/modules/claims/reconcile-portfolio-totals.ts'), 'utf8');
    expect(content).toMatch(/import\s*\{[^}]*\bReconcilableClaimRow\b[^}]*\}\s*from\s*['"][^'"]*reconcile-claim-buckets\.js['"]/s);
    expect(content).toMatch(/import\s*\{[^}]*\bReconcilableRecoveryEventRow\b[^}]*\}\s*from\s*['"][^'"]*reconcile-claim-buckets\.js['"]/s);
  });

  it('get-portfolio-reconciliation.ts no longer claims to be self-contained/no-import-from-#202', () => {
    const content = readFileSync(join(ROOT, 'src/modules/claims/get-portfolio-reconciliation.ts'), 'utf8');
    expect(content).not.toMatch(/Deliberately self-contained/);
    expect(content).not.toMatch(/no import from #202/);
  });
});
