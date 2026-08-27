import { z } from 'zod';

export const ClarificationAnswerInputSchema = z.object({
  answer: z.string().trim().min(1).max(10_000),
  answer_source: z.enum(['read_from_doc', 'analyst_knowledge', 'carrier_confirmed']),
}).strict();

export type ClarificationAnswerInput = z.infer<typeof ClarificationAnswerInputSchema>;

export class ClarifyingQuestionNotFoundError extends Error {
  readonly code = 'CLARIFYING_QUESTION_NOT_FOUND';
  constructor() { super('Clarifying question not found'); this.name = 'ClarifyingQuestionNotFoundError'; }
}

export class ClarificationAnswerConflictError extends Error {
  readonly code = 'CLARIFICATION_ANSWER_REPLAY_CONFLICT';
  constructor() {
    super('This answer was previously superseded and cannot be replayed');
    this.name = 'ClarificationAnswerConflictError';
  }
}
