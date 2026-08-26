import { describe, expect, it, vi } from 'vitest';
import { ACTIVE_RULE_RESOLVER_VERSION, resolveActiveRuleVersion } from '../../src/modules/rubric-resolver/resolve-active-rule-version.js';

const request = {
  ruleId: '11111111-1111-4111-8111-111111111111', effectiveOn: '2026-08-01',
  recordedAsOf: '2026-08-25T12:00:00.000Z',
};

describe('ACTIVE rule-version resolution', () => {
  it('filters lifecycle and time, then ranks by hardness deterministically', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: '21111111-1111-4111-8111-111111111111', hardness: 'FIRM_RULE', ast_hash: 'a'.repeat(64),
    }] });
    await expect(resolveActiveRuleVersion({ query } as never, request)).resolves.toEqual({
      status: 'FOUND', ruleVersionId: '21111111-1111-4111-8111-111111111111',
      hardness: 'FIRM_RULE', astHash: 'a'.repeat(64), resolverVersion: ACTIVE_RULE_RESOLVER_VERSION,
    });
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("lifecycle_state = 'ACTIVE'");
    expect(sql).toContain("WHEN 'FIRM_RULE' THEN 4");
    expect(sql).toContain('valid_to > $2::date');
    expect(values).toEqual([request.ruleId, request.effectiveOn, request.recordedAsOf]);
  });

  it('returns explicit unavailability instead of falling back to non-active versions', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(resolveActiveRuleVersion({ query } as never, request)).resolves.toEqual({
      status: 'UNAVAILABLE', reason: 'NO_ACTIVE_VERSION', resolverVersion: ACTIVE_RULE_RESOLVER_VERSION,
    });
  });

  it('rejects malformed input before querying', async () => {
    const query = vi.fn();
    await expect(resolveActiveRuleVersion({ query } as never, { ...request, ruleId: 'bad' }))
      .rejects.toMatchObject({ code: 'ACTIVE_RULE_REQUEST_INVALID' });
    expect(query).not.toHaveBeenCalled();
  });
});
