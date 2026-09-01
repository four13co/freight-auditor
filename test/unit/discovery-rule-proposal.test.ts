import { describe, expect, it, vi } from 'vitest';
import { evaluate, verdict } from '../../src/modules/rule-engine/interpreter.js';
import type { VersionedAnthropicProvider } from '../../src/modules/contracts/anthropic-provider.js';
import { DISCOVERY_RULE_PROPOSAL_SCHEMA_VERSION, DiscoveryProposedCriteriaModelOutputSchema,
  DiscoveryProposedCriteriaProviderEnvelopeSchema, DISCOVERY_RULE_PROPOSAL_PROMPT, generateDiscoveryRuleProposals,
  type DiscoveryEvidenceItem } from '../../src/modules/discovery/discovery-rule-proposal.js';

const triggerId = '11111111-1111-4111-8111-111111111111';
const auditRunId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const evidence: DiscoveryEvidenceItem[] = [{ triggerKind: 'UNKNOWN_CHARGE_CODE', triggerId, detail: { code: 'ZZZ', x12Element: 'C302-02' } }];

const modelOutput = { schemaVersion: DISCOVERY_RULE_PROPOSAL_SCHEMA_VERSION, criteria: [{
  criterionKey: 'DISCOVERY.PROPOSED.UNKNOWN_CODE_ZZZ', kind: 'SCORING' as const, ruleType: 'EXTERNAL_REFERENCE' as const,
  description: 'Charge code ZZZ should resolve to a known category.', citedTriggerId: triggerId,
  ast: { type: 'require' as const, key: 'has_fuel_category' as const, then: { type: 'compare' as const, op: 'eq' as const,
    left: { type: 'fact' as const, key: 'has_fuel_category' as const }, right: { type: 'lit' as const, value: true } } } }] };
const criterion = modelOutput.criteria[0]!;

describe('discovery rule proposals and deterministic AST generation', () => {
  it('accepts only proposal-safe AST nodes and excludes activation/arithmetic fields', () => {
    expect(DiscoveryProposedCriteriaModelOutputSchema.parse(modelOutput)).toEqual(modelOutput);
    expect(DISCOVERY_RULE_PROPOSAL_PROMPT.system).toMatch(/Never emit arithmetic nodes/);
    expect(DISCOVERY_RULE_PROPOSAL_PROMPT.system).toMatch(/Do not calculate expected charges/);
    expect(() => DiscoveryProposedCriteriaModelOutputSchema.parse({ ...modelOutput, criteria: [{ ...criterion,
      lifecycleState: 'ACTIVE' }] })).toThrow();
    expect(() => DiscoveryProposedCriteriaModelOutputSchema.parse({ ...modelOutput, criteria: [{ ...criterion,
      ast: { type: 'arith', op: 'mul', args: [] } }] })).toThrow();
  });

  it('preserves prohibited provider fields for explicit money-authority rejection before strict parsing', async () => {
    const unsafe = { ...modelOutput, criteria: [{ ...criterion, varianceAmount: '12.00', ast: {
      type: 'arith', op: 'mul', args: [{ type: 'money', amount: '10.00', currency: 'USD' }] } }] };
    expect(DiscoveryProposedCriteriaProviderEnvelopeSchema.parse(unsafe)).toEqual(unsafe);
    const generateStructured = vi.fn().mockResolvedValue({ output: unsafe });
    await expect(generateDiscoveryRuleProposals({ generateStructured } as unknown as VersionedAnthropicProvider,
      auditRunId, evidence)).rejects.toMatchObject({ code: 'MODEL_MONEY_AUTHORITY_REJECTED',
        rejections: expect.arrayContaining([expect.objectContaining({ code: 'ARITHMETIC_AST' }),
          expect.objectContaining({ code: 'MONEY_LITERAL' }), expect.objectContaining({ code: 'AUTHORITATIVE_FINANCIAL_FIELD' })]) });
  });

  it('rejects unknown facts, non-boolean roots, invalid logic arity, duplicate keys, and excessive depth', () => {
    expect(() => DiscoveryProposedCriteriaModelOutputSchema.parse({ ...modelOutput, criteria: [{ ...criterion,
      ast: { type: 'fact', key: 'model_invented_fact' } }] })).toThrow();
    expect(() => DiscoveryProposedCriteriaModelOutputSchema.parse({ ...modelOutput, criteria: [{ ...criterion,
      ast: { type: 'fact', key: 'charge_count' } }] })).toThrow(/boolean verdict/);
    expect(() => DiscoveryProposedCriteriaModelOutputSchema.parse({ ...modelOutput, criteria: [{ ...modelOutput.criteria[0],
      ast: { type: 'logic', op: 'not', args: [criterion.ast, criterion.ast] } }] })).toThrow();
    expect(() => DiscoveryProposedCriteriaModelOutputSchema.parse({ ...modelOutput, criteria: [criterion, criterion] })).toThrow(/duplicate criterion/i);
    let deep: unknown = criterion.ast;
    for (let index = 0; index < 21; index += 1) deep = { type: 'require', key: 'charge_count', then: deep };
    expect(() => DiscoveryProposedCriteriaModelOutputSchema.parse({ ...modelOutput, criteria: [{ ...criterion, ast: deep }] })).toThrow(/maximum depth/);
  });

  it('grounds proposals, canonicalizes ASTs, hashes them, and pins expected inputs as PROPOSED', async () => {
    const reversed = { ...modelOutput, criteria: [{ ...criterion, ast: { type: 'logic' as const, op: 'and' as const,
      args: [criterion.ast, { type: 'compare' as const, op: 'gt' as const,
        left: { type: 'fact' as const, key: 'charge_count' as const }, right: { type: 'lit' as const, value: 0 } }] } }] };
    const reversedCriterion = reversed.criteria[0]!;
    const generateStructured = vi.fn().mockResolvedValue({ output: reversed, provider: 'anthropic' });
    const first = await generateDiscoveryRuleProposals({ generateStructured } as unknown as VersionedAnthropicProvider,
      auditRunId, evidence);
    generateStructured.mockResolvedValue({ output: { ...reversed, criteria: [{ ...reversedCriterion,
      ast: { ...reversedCriterion.ast, args: [...reversedCriterion.ast.args].reverse() } }] }, provider: 'anthropic' });
    const second = await generateDiscoveryRuleProposals({ generateStructured } as unknown as VersionedAnthropicProvider,
      auditRunId, evidence);
    expect(first.output.criteria[0]).toMatchObject({ lifecycleState: 'PROPOSED',
      expectedInputs: ['charge_count', 'has_fuel_category'], astHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(first.output.criteria[0]!.astHash).toBe(second.output.criteria[0]!.astHash);
    expect(verdict(evaluate(first.output.criteria[0]!.ast, { has_fuel_category: true, charge_count: 1 }))).toBe('PASS');
  });

  it('fails closed on an unknown or missing trigger citation', async () => {
    const provider = (output: unknown) => ({ generateStructured: vi.fn().mockResolvedValue({ output }) }) as unknown as VersionedAnthropicProvider;
    await expect(generateDiscoveryRuleProposals(provider({ ...modelOutput, criteria: [{ ...criterion,
      citedTriggerId: '22222222-2222-4222-8222-222222222222' }] }), auditRunId, evidence))
      .rejects.toMatchObject({ code: 'UNCITED_DISCOVERY_PROPOSAL',
        rejections: expect.arrayContaining([expect.objectContaining({ code: 'UNKNOWN_TRIGGER' })]) });
  });

  it('rejects an empty evidence set without calling the provider', async () => {
    const generateStructured = vi.fn();
    await expect(generateDiscoveryRuleProposals({ generateStructured } as unknown as VersionedAnthropicProvider,
      auditRunId, [])).rejects.toMatchObject({ code: 'NO_EVIDENCE' });
    expect(generateStructured).not.toHaveBeenCalled();
  });
});
