import { beforeEach, describe, expect, it, vi } from 'vitest';

const retireAmendedRules = vi.fn();
const detectUnassessableTriggers = vi.fn();
const detectUnknownChargeCodeTriggers = vi.fn();
const detectSuspiciousPassTriggers = vi.fn();

vi.mock('../../src/modules/contracts/retire-amended-rules.js', () => ({ retireAmendedRules }));
vi.mock('../../src/modules/discovery/detect-unassessable-triggers.js', () => ({ detectUnassessableTriggers }));
vi.mock('../../src/modules/discovery/detect-unknown-charge-code-triggers.js', () => ({ detectUnknownChargeCodeTriggers }));
vi.mock('../../src/modules/discovery/detect-suspicious-pass-triggers.js', () => ({ detectSuspiciousPassTriggers }));

const { rerunDiscoveryForAmendment } = await import('../../src/modules/contracts/rerun-discovery-for-amendment.js');

const clientId = '11111111-1111-4111-8111-111111111111';
const amendmentId = '22222222-2222-4222-8222-222222222222';
const runA = '33333333-3333-4333-8333-333333333333';
const runB = '44444444-4444-4444-8444-444444444444';
const ruleVersionA = '55555555-5555-4555-8555-555555555555';
const ruleVersionB = '66666666-6666-4666-8666-666666666666';

function makeClient(rows: unknown[]) {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

describe('rerunDiscoveryForAmendment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detectUnassessableTriggers.mockResolvedValue({ triggerIds: [], createdCount: 0 });
    detectUnknownChargeCodeTriggers.mockResolvedValue({ triggerIds: [], createdCount: 0 });
    detectSuspiciousPassTriggers.mockResolvedValue({ triggerIds: [], createdCount: 0 });
  });

  it('returns early with no audit runs touched when the amendment affects no ACTIVE rule versions', async () => {
    retireAmendedRules.mockResolvedValue([]);
    const client = makeClient([]);

    const result = await rerunDiscoveryForAmendment(client as never, { clientId, amendmentId });

    expect(result).toEqual({ transitions: [], affectedAuditRunIds: [], triggersCreated: 0 });
    expect(client.query).not.toHaveBeenCalled();
    expect(detectUnassessableTriggers).not.toHaveBeenCalled();
  });

  it('re-runs all three audit-run-scoped detectors once per unique affected audit run, deduped across sources', async () => {
    retireAmendedRules.mockResolvedValue([
      { oldRuleVersionId: ruleVersionA, deprecatedRuleVersionId: 'dep-a', replacementRuleVersionId: 'rep-a' },
      { oldRuleVersionId: ruleVersionB, deprecatedRuleVersionId: 'dep-b', replacementRuleVersionId: null },
    ]);
    // runA appears via both charge_finding and gate_failure; the UNION must dedupe it. runB is gate_failure-only.
    const client = makeClient([{ audit_run_id: runA }, { audit_run_id: runB }]);
    detectUnassessableTriggers.mockResolvedValue({ triggerIds: ['t1'], createdCount: 1 });
    detectUnknownChargeCodeTriggers.mockResolvedValue({ triggerIds: ['t2'], createdCount: 1 });
    detectSuspiciousPassTriggers.mockResolvedValue({ triggerIds: [], createdCount: 0 });

    const result = await rerunDiscoveryForAmendment(client as never, { clientId, amendmentId });

    expect(retireAmendedRules).toHaveBeenCalledWith(client, { clientId, amendmentId });
    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('UNION');
    expect(params[0]).toBe(clientId);
    expect(params[1]).toEqual([ruleVersionA, ruleVersionB]);

    for (const runId of [runA, runB]) {
      expect(detectUnassessableTriggers).toHaveBeenCalledWith(client, { clientId, auditRunId: runId });
      expect(detectUnknownChargeCodeTriggers).toHaveBeenCalledWith(client, { clientId, auditRunId: runId });
      expect(detectSuspiciousPassTriggers).toHaveBeenCalledWith(client, { clientId, auditRunId: runId });
    }
    expect(detectUnassessableTriggers).toHaveBeenCalledTimes(2);
    expect(result.affectedAuditRunIds).toEqual([runA, runB]);
    expect(result.triggersCreated).toBe(4); // (1 + 1 + 0) per run * 2 runs
  });

  it('dedupes repeated oldRuleVersionId values across multiple clause transitions before querying', async () => {
    retireAmendedRules.mockResolvedValue([
      { oldRuleVersionId: ruleVersionA, deprecatedRuleVersionId: 'dep-a', replacementRuleVersionId: 'rep-a' },
      { oldRuleVersionId: ruleVersionA, deprecatedRuleVersionId: 'dep-a2', replacementRuleVersionId: 'rep-a2' },
    ]);
    const client = makeClient([]);

    const result = await rerunDiscoveryForAmendment(client as never, { clientId, amendmentId });

    const [, params] = client.query.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toEqual([ruleVersionA]);
    expect(result.affectedAuditRunIds).toEqual([]);
    expect(result.triggersCreated).toBe(0);
  });

  it('propagates a retireAmendedRules failure without swallowing it', async () => {
    retireAmendedRules.mockRejectedValue(new Error('contract amendment not found for tenant: nope'));
    const client = makeClient([]);

    await expect(rerunDiscoveryForAmendment(client as never, { clientId, amendmentId }))
      .rejects.toThrow('contract amendment not found for tenant: nope');
    expect(detectUnassessableTriggers).not.toHaveBeenCalled();
  });
});
