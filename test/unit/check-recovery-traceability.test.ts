import { describe, it, expect } from 'vitest';
import { checkRecoveryTraceability } from '../../src/modules/claims/check-recovery-traceability.js';

describe('checkRecoveryTraceability', () => {
  it('traces directly when the event carries a cited variance_finding_id', () => {
    const result = checkRecoveryTraceability('re1', 'vf1', true, []);
    expect(result).toEqual({ recoveryEventId: 're1', traceable: true, path: 'DIRECT', citedVarianceFindingIds: ['vf1'] });
  });

  it('is untraceable when the direct finding has no citation', () => {
    const result = checkRecoveryTraceability('re1', 'vf1', false, []);
    expect(result.traceable).toBe(false);
    expect(result.path).toBe('DIRECT');
    expect(result.citedVarianceFindingIds).toEqual([]);
  });

  it('traces indirectly via a cited dispute-line finding when no direct link exists', () => {
    const result = checkRecoveryTraceability('re1', null, null, [{ varianceFindingId: 'vf2', hasCitation: true }]);
    expect(result).toEqual({ recoveryEventId: 're1', traceable: true, path: 'INDIRECT', citedVarianceFindingIds: ['vf2'] });
  });

  it('collects every cited finding when multiple dispute-line findings have citations', () => {
    const result = checkRecoveryTraceability('re1', null, null, [
      { varianceFindingId: 'vf2', hasCitation: true },
      { varianceFindingId: 'vf3', hasCitation: false },
      { varianceFindingId: 'vf4', hasCitation: true },
    ]);
    expect(result.traceable).toBe(true);
    expect(result.citedVarianceFindingIds).toEqual(['vf2', 'vf4']);
  });

  it('is untraceable with no direct link and no cited dispute-line findings', () => {
    const result = checkRecoveryTraceability('re1', null, null, []);
    expect(result).toEqual({ recoveryEventId: 're1', traceable: false, path: 'UNTRACEABLE', citedVarianceFindingIds: [] });
  });

  it('is untraceable when dispute-line findings exist but none carry a citation', () => {
    const result = checkRecoveryTraceability('re1', null, null, [{ varianceFindingId: 'vf2', hasCitation: false }]);
    expect(result.traceable).toBe(false);
    expect(result.path).toBe('UNTRACEABLE');
  });

  it('prefers the direct path over any indirect findings when both are present', () => {
    const result = checkRecoveryTraceability('re1', 'vf1', true, [{ varianceFindingId: 'vf2', hasCitation: true }]);
    expect(result.path).toBe('DIRECT');
    expect(result.citedVarianceFindingIds).toEqual(['vf1']);
  });
});
