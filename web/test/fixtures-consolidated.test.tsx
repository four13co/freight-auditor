import { describe, it, expect } from 'vitest';
import { DASHBOARD_ROWS, DASHBOARD_SUMMARY, SORTABLE_ROWS } from './fixtures.js';

// 86e2v251x: Dashboard.test.tsx, FindingsTable.test.tsx, and
// e2e/dashboard.spec.ts all import their ROWS/SUMMARY from this shared
// module now (see their import lines) instead of each hand-defining their
// own -- this test guards the shared module's own contract: a fixed,
// non-Date.now()-relative createdAt strategy, since that was the concrete
// drift risk the duplication created (formatAge's only Date.now()-dependent
// behavior had no fixture proving it stayed stable over time).
describe('shared test fixtures (86e2v251x)', () => {
  it('every fixture row has a fixed (non-relative) ISO-8601 createdAt', () => {
    for (const row of [...DASHBOARD_ROWS, ...SORTABLE_ROWS]) {
      expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    }
  });

  it('DASHBOARD_ROWS + DASHBOARD_SUMMARY match the shape Dashboard.test.tsx and the e2e spec render against', () => {
    expect(DASHBOARD_ROWS).toHaveLength(3);
    expect(DASHBOARD_SUMMARY.recoverableOpen).toBe('148320.0000');
  });

  it('SORTABLE_ROWS matches the shape FindingsTable.test.tsx sorts against', () => {
    expect(SORTABLE_ROWS).toHaveLength(4);
    expect(SORTABLE_ROWS.map((r) => r.varianceAmount)).toEqual(['10.00', '9.00', '-5.00', null]);
  });
});
