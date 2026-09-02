import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { recordHumanOverrideReversal } from '../../src/modules/rule-engine/record-human-override-reversal.js';
import { resetQuarantineAlertMetricsForTest, renderQuarantineAlertMetrics } from '../../src/jobs/quarantine-alert-metrics.js';

const CLIENT_ID = '10000000-0000-4000-8000-000000000001';
const CRITERION_ID = '20000000-0000-4000-8000-000000000002';
const RULE_VERSION_ID = '30000000-0000-4000-8000-000000000003';
const QUARANTINED_RULE_VERSION_ID = '40000000-0000-4000-8000-000000000004';

function mockClient(opts: {
  clientRows?: unknown[]; criterionRows?: unknown[]; insertRows?: unknown[];
  ruleRows?: unknown[]; policyRows?: unknown[]; sumRows?: unknown[];
}) {
  const {
    clientRows = [{ id: CLIENT_ID }], criterionRows = [{ id: CRITERION_ID }],
    insertRows = [{ id: 'override-1' }], ruleRows = [{ rule_type: 'STRUCTURAL', lifecycle_state: 'ACTIVE' }],
    policyRows = [{ client_id: CLIENT_ID, rule_type: 'STRUCTURAL', n1_confirm: 3, n2_confirm: 5, max_reversals: 5 }],
    sumRows = [{ count: '1' }],
  } = opts;
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('FROM client WHERE')) return Promise.resolve({ rows: clientRows, rowCount: clientRows.length });
    if (sql.includes('FROM criterion WHERE')) return Promise.resolve({ rows: criterionRows, rowCount: criterionRows.length });
    if (sql.includes('INSERT INTO human_override')) return Promise.resolve({ rows: insertRows });
    if (sql.includes('FROM rule_version rv JOIN rule')) return Promise.resolve({ rows: ruleRows });
    if (sql.includes('FROM promotion_policy')) return Promise.resolve({ rows: policyRows });
    if (sql.includes('coalesce(sum(reversal_count)')) return Promise.resolve({ rows: sumRows });
    // transitionRuleLifecycle's own multi-query sequence (only reached when quarantine fires).
    if (sql.includes('SELECT lifecycle_state FROM rule_version WHERE id=$1')) return Promise.resolve({ rows: [{ lifecycle_state: 'ACTIVE' }] });
    if (sql.includes('INSERT INTO rule_version')) return Promise.resolve({ rows: [{ id: QUARANTINED_RULE_VERSION_ID }] });
    if (sql.includes('INSERT INTO promotion_event')) return Promise.resolve({ rows: [] });
    throw new Error(`unexpected query: ${sql}`);
  });
  return { client: { query } as unknown as pg.PoolClient, query };
}

const VALID_INPUT = {
  clientId: CLIENT_ID, criterionId: CRITERION_ID, ruleVersionId: RULE_VERSION_ID,
  caseFingerprint: 'ocean/fsc/transpac', assertedValue: { rate: '1.10' },
};

describe('recordHumanOverrideReversal', () => {
  it('rejects a malformed clientId without querying the DB', async () => {
    const { client, query } = mockClient({});
    await expect(recordHumanOverrideReversal(client, { ...VALID_INPUT, clientId: 'not-a-uuid' }))
      .rejects.toMatchObject({ code: 'INVALID_CLIENT_ID' });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a malformed criterionId', async () => {
    const { client } = mockClient({});
    await expect(recordHumanOverrideReversal(client, { ...VALID_INPUT, criterionId: 'nope' }))
      .rejects.toMatchObject({ code: 'INVALID_CRITERION_ID' });
  });

  it('rejects an empty caseFingerprint', async () => {
    const { client } = mockClient({});
    await expect(recordHumanOverrideReversal(client, { ...VALID_INPUT, caseFingerprint: '  ' }))
      .rejects.toMatchObject({ code: 'INVALID_CASE_FINGERPRINT' });
  });

  it('rejects a well-formed but nonexistent clientId', async () => {
    const { client } = mockClient({ clientRows: [] });
    await expect(recordHumanOverrideReversal(client, VALID_INPUT))
      .rejects.toMatchObject({ code: 'CLIENT_NOT_FOUND' });
  });

  it('rejects a well-formed but nonexistent criterionId', async () => {
    const { client } = mockClient({ criterionRows: [] });
    await expect(recordHumanOverrideReversal(client, VALID_INPUT))
      .rejects.toMatchObject({ code: 'CRITERION_NOT_FOUND' });
  });

  it('inserts reversal_count=1, confirm_count=0 and does not quarantine when under threshold', async () => {
    const { client, query } = mockClient({ sumRows: [{ count: '1' }], policyRows: [{ client_id: CLIENT_ID, rule_type: 'STRUCTURAL', n1_confirm: 3, n2_confirm: 5, max_reversals: 5 }] });
    const result = await recordHumanOverrideReversal(client, VALID_INPUT);
    expect(result).toEqual({ humanOverrideId: 'override-1', quarantined: false, ruleVersionId: RULE_VERSION_ID });
    const insertCall = query.mock.calls.find((c) => (c[0] as string).includes('INSERT INTO human_override'))!;
    expect(insertCall[1]).toEqual([CLIENT_ID, CRITERION_ID, VALID_INPUT.caseFingerprint, JSON.stringify(VALID_INPUT.assertedValue)]);
    expect(insertCall[0]).toMatch(/VALUES \(\$1, \$2, \$3, \$4::jsonb, 0, 1\)/);
  });

  // P6.C.9: the alert-triggering path -- a quarantine transition must
  // increment freight_rule_quarantine_total. quarantine-on-reversal.ts's
  // OWN internal branching (threshold math, the ACTIVE guard) stays covered
  // by the reintroduced test/unit/quarantine-on-reversal.test.ts; this test
  // only proves recordHumanOverrideReversal's call-site hook fires exactly
  // when quarantine.quarantined is true.
  it('increments freight_rule_quarantine_total when the reversal triggers a quarantine', async () => {
    resetQuarantineAlertMetricsForTest();
    const { client } = mockClient({ sumRows: [{ count: '6' }], policyRows: [{ client_id: CLIENT_ID, rule_type: 'STRUCTURAL', n1_confirm: 3, n2_confirm: 5, max_reversals: 5 }] });
    const result = await recordHumanOverrideReversal(client, VALID_INPUT);
    expect(result.quarantined).toBe(true);
    expect(renderQuarantineAlertMetrics()).toContain('freight_rule_quarantine_total 1');
  });

  it('does not increment freight_rule_quarantine_total when the reversal stays under threshold', async () => {
    resetQuarantineAlertMetricsForTest();
    const { client } = mockClient({ sumRows: [{ count: '1' }] });
    const result = await recordHumanOverrideReversal(client, VALID_INPUT);
    expect(result.quarantined).toBe(false);
    expect(renderQuarantineAlertMetrics()).toContain('freight_rule_quarantine_total 0');
  });

  it('propagates the quarantine guard error when the rule is not ACTIVE', async () => {
    const { client } = mockClient({ ruleRows: [{ rule_type: 'STRUCTURAL', lifecycle_state: 'SHADOW' }] });
    await expect(recordHumanOverrideReversal(client, VALID_INPUT)).rejects.toThrow('requires ACTIVE');
  });
});
