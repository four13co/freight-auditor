import { describe, expect, it, vi } from 'vitest';
import { retireAmendedRules } from '../../src/modules/contracts/retire-amended-rules.js';

describe('retireAmendedRules', () => {
  it('deprecates an affected active rule and proposes a replacement on the new clause', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ supersedes_version_id: 'oldcv', new_version_id: 'newcv' }] })
      .mockResolvedValueOnce({ rows: [{ clause_ref: '4.2', old_clause_id: 'oldcl', new_clause_id: 'newcl', old_text: 'a', new_text: 'b' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ lifecycle_state: 'ACTIVE' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'deprecated' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'replacement' }] });
    await expect(retireAmendedRules({ query } as never, { clientId: 'c', amendmentId: 'amend' })).resolves.toEqual([{
      oldRuleVersionId: 'active', deprecatedRuleVersionId: 'deprecated', replacementRuleVersionId: 'replacement' }]);
  });
  it('retires without fabricating a replacement when a clause was removed', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ supersedes_version_id: 'oldcv', new_version_id: 'newcv' }] })
      .mockResolvedValueOnce({ rows: [{ clause_ref: '4.2', old_clause_id: 'oldcl', new_clause_id: null, old_text: 'a', new_text: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'active' }] }).mockResolvedValueOnce({ rows: [{ lifecycle_state: 'ACTIVE' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'deprecated' }] }).mockResolvedValueOnce({ rows: [] });
    const result = await retireAmendedRules({ query } as never, { clientId: 'c', amendmentId: 'amend' });
    expect(result[0]?.replacementRuleVersionId).toBeNull();
  });
});
