import { describe, expect, it } from 'vitest';
import { generateClarifyingQuestions } from '../../src/modules/contracts/clarifying-questions.js';

const abstentions = [
  { path: 'contract.validFrom', status: 'AMBIGUOUS' as const, reason: 'LOW_CONFIDENCE' as const,
    clarificationQuestion: 'What is the full effective date?' },
  { path: 'contract.currency', status: 'NOT_FOUND' as const, reason: 'MISSING_REQUIRED_FIELD' as const,
    clarificationQuestion: 'Which currency applies?' },
];

describe('generateClarifyingQuestions', () => {
  it('generates stable, sorted, provenance-bearing questions', () => {
    const result = generateClarifyingQuestions(abstentions, 'abstention/1');
    expect(result.map((question) => question.path)).toEqual(['contract.currency', 'contract.validFrom']);
    expect(result[0]).toMatchObject({ status: 'NOT_FOUND', reason: 'MISSING_REQUIRED_FIELD', question: 'Which currency applies?' });
    expect(result.every((question) => /^[a-f0-9]{64}$/.test(question.questionHash))).toBe(true);
    expect(generateClarifyingQuestions(abstentions, 'abstention/1')).toEqual(result);
  });

  it('collapses exact retry duplicates without emitting duplicate questions', () => {
    expect(generateClarifyingQuestions([...abstentions, abstentions[0]!], 'abstention/1')).toHaveLength(2);
  });

  it('rejects conflicting duplicates and malformed questions', () => {
    expect(() => generateClarifyingQuestions([...abstentions, { ...abstentions[0]!, clarificationQuestion: 'Different?' }], 'abstention/1'))
      .toThrowError(expect.objectContaining({ code: 'CONFLICTING_ABSTENTION' }));
    expect(() => generateClarifyingQuestions([{ ...abstentions[0]!, clarificationQuestion: '' }], 'abstention/1')).toThrow();
  });

  it('includes policy version in question identity', () => {
    expect(generateClarifyingQuestions(abstentions, 'abstention/1')[0]!.questionHash)
      .not.toBe(generateClarifyingQuestions(abstentions, 'abstention/2')[0]!.questionHash);
  });
});
