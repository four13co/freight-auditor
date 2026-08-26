import { describe, expect, it, vi } from 'vitest';
import { persistTightenConflict } from '../../src/modules/rubric-resolver/persist-tighten-conflict.js';

const input = {
  tenantId: '11111111-1111-4111-8111-111111111111', criterionKey: 'STD.X',
  baseRuleVersionId: '21111111-1111-4111-8111-111111111111',
  attemptedRuleVersionId: '31111111-1111-4111-8111-111111111111',
  proof: { monotonic: false as const, reason: 'BOUND_WEAKENED' as const },
};

describe('non-monotonic tightening conflict persistence', () => {
  it('writes stable append-only evidence without raw AST payloads', async () => {
    const query = vi.fn().mockImplementation(async (_sql, values) => ({ rows: [{ id: values[0], created: true }] }));
    const first = await persistTightenConflict({ query } as never, input);
    const second = await persistTightenConflict({ query } as never, input);
    expect(first.id).toBe(second.id);
    expect(first.created).toBe(true);
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("'NON_MONOTONE_TIGHTEN'");
    expect(JSON.parse(values[3])).toEqual(expect.objectContaining({ reason: 'BOUND_WEAKENED' }));
    expect(values[3]).not.toContain('ast');
  });

  it('rejects malformed identifiers before querying', async () => {
    const query = vi.fn();
    await expect(persistTightenConflict({ query } as never, { ...input, tenantId: 'wrong' }))
      .rejects.toMatchObject({ code: 'TIGHTEN_CONFLICT_INVALID' });
    expect(query).not.toHaveBeenCalled();
  });
});
