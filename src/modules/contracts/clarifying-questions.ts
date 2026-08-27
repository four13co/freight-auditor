import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ContractExtractionAbstention } from './apply-contract-extraction-abstention.js';

const abstentionSchema = z.object({
  path: z.string().trim().min(1).max(1_000), status: z.enum(['NOT_FOUND', 'AMBIGUOUS']),
  reason: z.enum(['MISSING_REQUIRED_FIELD', 'LOW_CONFIDENCE', 'MODEL_ABSTENTION', 'AMBIGUOUS_TABLE_ORIENTATION']),
  clarificationQuestion: z.string().trim().min(1).max(2_000),
}).strict();
export const generatedClarifyingQuestionSchema = abstentionSchema.omit({ clarificationQuestion: true }).extend({
  question: z.string().trim().min(1).max(2_000), questionHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type GeneratedClarifyingQuestion = z.infer<typeof generatedClarifyingQuestionSchema>;
export class ClarifyingQuestionError extends Error {
  constructor(readonly code: 'CONFLICTING_ABSTENTION' | 'QUESTION_HASH_MISMATCH' | 'EXTRACTION_NOT_FOUND' | 'PARTIAL_CONFLICT') {
    super(code.toLocaleLowerCase('en-US').replace(/_/g, ' ')); this.name = 'ClarifyingQuestionError';
  }
}

export function generateClarifyingQuestions(
  untrustedAbstentions: ContractExtractionAbstention[],
  policyVersion: string,
): GeneratedClarifyingQuestion[] {
  const abstentions = z.array(abstentionSchema).max(30_000).parse(untrustedAbstentions);
  const version = z.string().trim().min(1).max(200).parse(policyVersion);
  const byPath = new Map<string, GeneratedClarifyingQuestion>();
  for (const abstention of abstentions) {
    const question = { path: abstention.path, status: abstention.status, reason: abstention.reason,
      question: abstention.clarificationQuestion,
      questionHash: clarifyingQuestionHash(version, abstention.path, abstention.status, abstention.reason, abstention.clarificationQuestion) };
    const prior = byPath.get(question.path);
    if (prior && JSON.stringify(prior) !== JSON.stringify(question)) throw new ClarifyingQuestionError('CONFLICTING_ABSTENTION');
    byPath.set(question.path, question);
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function clarifyingQuestionHash(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}
