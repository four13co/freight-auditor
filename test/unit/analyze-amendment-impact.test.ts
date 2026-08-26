import { describe, expect, it, vi } from 'vitest';
import { analyzeAmendmentImpact } from '../../src/modules/contracts/analyze-amendment-impact.js';

describe('analyzeAmendmentImpact', () => {
  it('classifies clause changes and resolves every active citing rule', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ supersedes_version_id: 'old', new_version_id: 'new' }] })
      .mockResolvedValueOnce({ rows: [
        { clause_ref: '1', old_clause_id: 'o1', new_clause_id: 'n1', old_text: 'a', new_text: 'b' },
        { clause_ref: '2', old_clause_id: 'o2', new_clause_id: null, old_text: 'x', new_text: null },
        { clause_ref: '3', old_clause_id: null, new_clause_id: 'n3', old_text: null, new_text: 'z' },
      ] }).mockResolvedValueOnce({ rows: [{ id: 'rv1' }, { id: 'rv2' }] }).mockResolvedValueOnce({ rows: [] });
    const result = await analyzeAmendmentImpact({ query } as never, { clientId: 'c', amendmentId: 'a' });
    expect(result.map((r) => [r.clauseReference, r.change, r.affectedRuleVersionIds])).toEqual([
      ['1', 'CHANGED', ['rv1', 'rv2']], ['2', 'REMOVED', []], ['3', 'ADDED', []],
    ]);
  });
  it('fails closed for an unlinked amendment', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ supersedes_version_id: null, new_version_id: 'new' }] });
    await expect(analyzeAmendmentImpact({ query } as never, { clientId: 'c', amendmentId: 'a' })).rejects.toThrow('must link old and new');
  });
});
