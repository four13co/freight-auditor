import { describe, expect, it, vi } from 'vitest';
import { evaluate, verdict } from '../../src/modules/rule-engine/interpreter.js';
import type { VersionedAnthropicProvider } from '../../src/modules/contracts/anthropic-provider.js';
import { CLAUSE_NORMALIZATION_SCHEMA_VERSION, type ClauseNormalization } from '../../src/modules/contracts/clause-normalization.js';
import { generateProposedCriteria, PROPOSED_CRITERIA_PROMPT, PROPOSED_CRITERIA_SCHEMA_VERSION,
  ProposedCriteriaModelOutputSchema } from '../../src/modules/contracts/proposed-criteria.js';

const citation = { pageNumber: 2, excerpt: 'A fuel surcharge applies to every shipment.', span: { offset: 410, length: 42 } };
const normalization: ClauseNormalization = { schemaVersion: CLAUSE_NORMALIZATION_SCHEMA_VERSION, clauses: [{ status: 'NORMALIZED',
  clauseReference: '4.2', category: 'ACCESSORIAL', title: 'Fuel surcharge', summary: 'Fuel surcharge is required.',
  applicability: ['all shipments'], terms: [], citations: [citation] }] };
const modelOutput = { schemaVersion: PROPOSED_CRITERIA_SCHEMA_VERSION, criteria: [{
  criterionKey: 'CONTRACT.PROPOSED.FUEL_PRESENT', kind: 'SCORING' as const, ruleType: 'CONTRACT_CONFORMANCE' as const,
  description: 'A categorized fuel charge is present.', clauseReferences: ['4.2'], citations: [citation],
  ast: { type: 'require' as const, key: 'has_fuel_category' as const, then: { type: 'compare' as const, op: 'eq' as const,
    left: { type: 'fact' as const, key: 'has_fuel_category' as const }, right: { type: 'lit' as const, value: true } } } }] };
const criterion = modelOutput.criteria[0]!;

describe('proposed criteria and deterministic AST generation', () => {
  it('accepts only proposal-safe AST nodes and excludes activation/arithmetic fields', () => {
    expect(ProposedCriteriaModelOutputSchema.parse(modelOutput)).toEqual(modelOutput);
    expect(PROPOSED_CRITERIA_PROMPT.system).toMatch(/Never emit arithmetic nodes/);
    expect(PROPOSED_CRITERIA_PROMPT.system).toMatch(/Do not calculate expected charges/);
    expect(() => ProposedCriteriaModelOutputSchema.parse({ ...modelOutput, criteria: [{ ...criterion,
      lifecycleState: 'ACTIVE' }] })).toThrow();
    expect(() => ProposedCriteriaModelOutputSchema.parse({ ...modelOutput, criteria: [{ ...criterion,
      ast: { type: 'arith', op: 'mul', args: [] } }] })).toThrow();
  });

  it('rejects unknown facts, non-boolean roots, invalid logic arity, duplicate keys, and excessive depth', () => {
    expect(() => ProposedCriteriaModelOutputSchema.parse({ ...modelOutput, criteria: [{ ...criterion,
      ast: { type: 'fact', key: 'model_invented_fact' } }] })).toThrow();
    expect(() => ProposedCriteriaModelOutputSchema.parse({ ...modelOutput, criteria: [{ ...criterion,
      ast: { type: 'fact', key: 'charge_count' } }] })).toThrow(/boolean verdict/);
    expect(() => ProposedCriteriaModelOutputSchema.parse({ ...modelOutput, criteria: [{ ...modelOutput.criteria[0],
      ast: { type: 'logic', op: 'not', args: [criterion.ast, criterion.ast] } }] })).toThrow();
    expect(() => ProposedCriteriaModelOutputSchema.parse({ ...modelOutput, criteria: [criterion, criterion] })).toThrow(/duplicate criterion/i);
    let deep: unknown = criterion.ast;
    for (let index = 0; index < 21; index += 1) deep = { type: 'require', key: 'charge_count', then: deep };
    expect(() => ProposedCriteriaModelOutputSchema.parse({ ...modelOutput, criteria: [{ ...criterion, ast: deep }] })).toThrow(/maximum depth/);
  });

  it('grounds proposals, canonicalizes ASTs, hashes them, and pins expected inputs as PROPOSED', async () => {
    const reversed = { ...modelOutput, criteria: [{ ...criterion, ast: { type: 'logic' as const, op: 'and' as const,
      args: [criterion.ast, { type: 'compare' as const, op: 'gt' as const,
        left: { type: 'fact' as const, key: 'charge_count' as const }, right: { type: 'lit' as const, value: 0 } }] } }] };
    const reversedCriterion = reversed.criteria[0]!;
    const generateStructured = vi.fn().mockResolvedValue({ output: reversed, provider: 'anthropic' });
    const first = await generateProposedCriteria({ generateStructured } as unknown as VersionedAnthropicProvider, 'a'.repeat(64), normalization);
    generateStructured.mockResolvedValue({ output: { ...reversed, criteria: [{ ...reversedCriterion,
      ast: { ...reversedCriterion.ast, args: [...reversedCriterion.ast.args].reverse() } }] }, provider: 'anthropic' });
    const second = await generateProposedCriteria({ generateStructured } as unknown as VersionedAnthropicProvider, 'a'.repeat(64), normalization);
    expect(first.output.criteria[0]).toMatchObject({ lifecycleState: 'PROPOSED',
      expectedInputs: ['charge_count', 'has_fuel_category'], astHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(first.output.criteria[0]!.astHash).toBe(second.output.criteria[0]!.astHash);
    expect(verdict(evaluate(first.output.criteria[0]!.ast, { has_fuel_category: true, charge_count: 1 }))).toBe('PASS');
  });

  it('fails closed on unknown, abstained, or mismatched citation provenance', async () => {
    const provider = (output: unknown) => ({ generateStructured: vi.fn().mockResolvedValue({ output }) }) as unknown as VersionedAnthropicProvider;
    await expect(generateProposedCriteria(provider({ ...modelOutput, criteria: [{ ...modelOutput.criteria[0], clauseReferences: ['99'] }] }),
      'a'.repeat(64), normalization)).rejects.toMatchObject({ code: 'UNGROUNDED_PROPOSAL' });
    await expect(generateProposedCriteria(provider({ ...modelOutput, criteria: [{ ...modelOutput.criteria[0],
      citations: [{ ...citation, excerpt: 'invented' }] }] }), 'a'.repeat(64), normalization))
      .rejects.toMatchObject({ code: 'UNGROUNDED_PROPOSAL' });
  });

  it('does not call the provider when every clause abstained', async () => {
    const generateStructured = vi.fn();
    const abstained: ClauseNormalization = { schemaVersion: CLAUSE_NORMALIZATION_SCHEMA_VERSION, clauses: [{ status: 'ABSTAINED',
      clauseReference: '7', reason: 'AMBIGUOUS_MEANING', clarificationQuestion: 'Clarify.', citations: [citation] }] };
    await expect(generateProposedCriteria({ generateStructured } as unknown as VersionedAnthropicProvider,
      'a'.repeat(64), abstained)).rejects.toMatchObject({ code: 'NO_NORMALIZED_CLAUSES' });
    expect(generateStructured).not.toHaveBeenCalled();
  });
});
