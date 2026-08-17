/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { DASHBOARD_ROWS, DASHBOARD_SUMMARY, SORTABLE_ROWS } from './fixtures.js';

// Raw source text of the three consuming files, read via Vite's import.meta.glob
// (no Node `fs`/`@types/node` needed -- this tsconfig deliberately excludes
// Node types, browser-only scope). Eager + raw query gives the file content
// as a plain string at module-eval time.
const rawSources = import.meta.glob(
  ['./Dashboard.test.tsx', './FindingsTable.test.tsx', './e2e/dashboard.spec.ts'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

// 86e2v251x: Dashboard.test.tsx, FindingsTable.test.tsx, and
// e2e/dashboard.spec.ts all import their ROWS/SUMMARY from this shared
// module now instead of each hand-defining their own. Source-level checks
// below prove that at the text level (so a regression back to inline
// fixtures fails here, not just a shape-match check that would still pass
// against a reinstated inline copy) -- plus a runtime check on the shared
// module's own contract: a fixed, non-Date.now()-relative createdAt
// strategy, the concrete drift risk the duplication created.
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

  it.each(Object.keys(rawSources))('%s imports from the shared fixtures module', (path) => {
    expect(rawSources[path]).toMatch(/from ['"]\.\.?\/(\.\.\/)?fixtures\.js['"]/);
  });

  it.each(Object.keys(rawSources))('%s no longer hand-defines its own ROWS or SUMMARY constant', (path) => {
    expect(rawSources[path]).not.toMatch(/^const (ROWS|SUMMARY)[\s:=]/m);
  });
});
