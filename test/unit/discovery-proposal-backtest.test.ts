import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { stableStringify } from '../../src/modules/evaluator/snapshot.js';
import { backtestDiscoveryRuleProposals, evaluateDiscoveryProposalCorpus, DiscoveryProposalBacktestError } from '../../src/modules/discovery/backtest-discovery-rule-proposals.js';

const ast = { type: 'require' as const, key: 'has_fuel_category', then: { type: 'compare' as const, op: 'eq' as const,
  left: { type: 'fact' as const, key: 'has_fuel_category' }, right: { type: 'lit' as const, value: true } } };
const astHash = createHash('sha256').update(stableStringify(ast)).digest('hex');

const proposalId = crypto.randomUUID();
const clientId = crypto.randomUUID();
const auditRunId = crypto.randomUUID();
const actorUserId = crypto.randomUUID();
const proposalHash = 'a'.repeat(64);
const proposalRow = { id: proposalId, proposal_hash: proposalHash, ast_hash: astHash, ast, expected_inputs: ['has_fuel_category'] };
const twoCases = [
  { caseKey: 'fuel-present', facts: { has_fuel_category: true }, expectedVerdict: 'PASS' as const },
  { caseKey: 'fuel-missing', facts: {}, expectedVerdict: 'UNASSESSABLE' as const },
];

function input(cases: typeof twoCases) {
  return { clientId, auditRunId, actorUserId, corpusSchemaVersion: 'discovery-proposal-backtest/1' as const,
    proposals: [{ proposalId, cases }] };
}

describe('discovery proposal backtest corpus', () => {
  it('deterministically records passing, failing, and unassessable evaluated evidence in case-key order', () => {
    const cases = [
      { caseKey: 'present', facts: { has_fuel_category: true }, expectedVerdict: 'PASS' as const },
      { caseKey: 'missing', facts: {}, expectedVerdict: 'UNASSESSABLE' as const },
      { caseKey: 'regression', facts: { has_fuel_category: false }, expectedVerdict: 'PASS' as const },
    ];
    const result = evaluateDiscoveryProposalCorpus(ast, ['has_fuel_category'], cases);
    expect(result.map(({ caseKey, actualVerdict, passed }) => ({ caseKey, actualVerdict, passed }))).toEqual([
      { caseKey: 'missing', actualVerdict: 'UNASSESSABLE', passed: true },
      { caseKey: 'present', actualVerdict: 'PASS', passed: true },
      { caseKey: 'regression', actualVerdict: 'FAIL', passed: false },
    ]);
    expect(evaluateDiscoveryProposalCorpus(ast, ['has_fuel_category'], [...cases].reverse())).toEqual(result);
    expect(result.every((item) => /^[a-f0-9]{64}$/.test(item.actualHash))).toBe(true);
  });

  it('fails closed on duplicate case keys and facts outside the proposal allowlist', () => {
    expect(() => evaluateDiscoveryProposalCorpus(ast, ['has_fuel_category'], [
      { caseKey: 'same', facts: {}, expectedVerdict: 'PASS' },
      { caseKey: 'same', facts: {}, expectedVerdict: 'FAIL' },
    ])).toThrowError(DiscoveryProposalBacktestError);
    expect(() => evaluateDiscoveryProposalCorpus(ast, ['has_fuel_category'], [
      { caseKey: 'foreign', facts: { duplicate_invoice: true }, expectedVerdict: 'PASS' },
    ])).toThrowError(expect.objectContaining({ code: 'UNEXPECTED_FACT' }));
  });
});

describe('backtestDiscoveryRuleProposals (mocked client)', () => {
  it('fails closed on duplicate supplied proposal ids without touching the database', async () => {
    const query = vi.fn();
    const duplicated = { ...input(twoCases), proposals: [{ proposalId, cases: twoCases }, { proposalId, cases: twoCases }] };
    await expect(backtestDiscoveryRuleProposals({ query } as never, duplicated))
      .rejects.toMatchObject({ code: 'DUPLICATE_PROPOSAL' });
    expect(query).not.toHaveBeenCalled();
  });

  it('throws PROPOSAL_SET_MISMATCH when the stored proposal set does not match what was supplied', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    await expect(backtestDiscoveryRuleProposals({ query } as never, input(twoCases)))
      .rejects.toMatchObject({ code: 'PROPOSAL_SET_MISMATCH' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('throws PROPOSAL_CHANGED when the stored ast no longer matches its recorded ast_hash', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ ...proposalRow, ast_hash: 'f'.repeat(64) }] });
    await expect(backtestDiscoveryRuleProposals({ query } as never, input(twoCases)))
      .rejects.toMatchObject({ code: 'PROPOSAL_CHANGED' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('creates a fresh backtest and its cases, and writes an audit event', async () => {
    const backtestId = crypto.randomUUID();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [proposalRow] }) // SELECT proposal
      .mockResolvedValueOnce({ rows: [{ id: backtestId }] }) // INSERT backtest RETURNING id
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT case fuel-missing (sorted first)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT case fuel-present
      .mockResolvedValueOnce({ rows: [{ id: 'audit-event-id', created: true }] }); // writeAuditEvent

    const result = await backtestDiscoveryRuleProposals({ query } as never, input(twoCases));

    expect(result).toEqual({ backtestIds: [backtestId], proposalCount: 1, passed: true, createdCount: 1 });
    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls[1]![0]).toContain('INSERT INTO discovery_rule_proposal_backtest');
    expect(query.mock.calls[4]![0]).toContain('INSERT INTO audit_event');
  });

  it('records a regression without activating the proposal, and allPassed reflects any failing case', async () => {
    const backtestId = crypto.randomUUID();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [proposalRow] })
      .mockResolvedValueOnce({ rows: [{ id: backtestId }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'audit-event-id', created: true }] });

    const result = await backtestDiscoveryRuleProposals({ query } as never, input([
      { caseKey: 'fuel-present', facts: { has_fuel_category: false }, expectedVerdict: 'PASS' },
      { caseKey: 'fuel-missing', facts: {}, expectedVerdict: 'UNASSESSABLE' },
    ]));

    expect(result.passed).toBe(false);
  });

  it('is idempotent on retry: reuses the existing backtest and case rows via the ON CONFLICT select-fallback', async () => {
    const backtestId = crypto.randomUUID();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [proposalRow] }) // SELECT proposal
      .mockResolvedValueOnce({ rows: [] }) // INSERT backtest -- ON CONFLICT DO NOTHING, no row
      .mockResolvedValueOnce({ rows: [{ id: backtestId }] }) // SELECT existing backtest by corpus_hash
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // INSERT case fuel-missing -- already exists
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // SELECT matching existing case fuel-missing
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // INSERT case fuel-present -- already exists
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // SELECT matching existing case fuel-present
      .mockResolvedValueOnce({ rows: [{ id: 'audit-event-id', created: false }] }); // writeAuditEvent (idempotent)

    const result = await backtestDiscoveryRuleProposals({ query } as never, input(twoCases));

    expect(result).toEqual({ backtestIds: [backtestId], proposalCount: 1, passed: true, createdCount: 0 });
    expect(query).toHaveBeenCalledTimes(8);
  });

  it('throws PARTIAL_CONFLICT when a concurrent write inserted different backtest evidence for the same corpus hash', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [proposalRow] }) // SELECT proposal
      .mockResolvedValueOnce({ rows: [] }) // INSERT backtest conflicts
      .mockResolvedValueOnce({ rows: [] }); // SELECT fallback finds nothing matching -- true conflict

    await expect(backtestDiscoveryRuleProposals({ query } as never, input(twoCases)))
      .rejects.toMatchObject({ code: 'PARTIAL_CONFLICT' });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('throws PARTIAL_CONFLICT when a concurrent write inserted different case evidence for the same case key', async () => {
    const backtestId = crypto.randomUUID();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [proposalRow] }) // SELECT proposal
      .mockResolvedValueOnce({ rows: [{ id: backtestId }] }) // INSERT backtest RETURNING id
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // INSERT case fuel-missing conflicts
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // SELECT fallback finds nothing matching -- true conflict

    await expect(backtestDiscoveryRuleProposals({ query } as never, input(twoCases)))
      .rejects.toMatchObject({ code: 'PARTIAL_CONFLICT' });
    expect(query).toHaveBeenCalledTimes(4);
  });
});
