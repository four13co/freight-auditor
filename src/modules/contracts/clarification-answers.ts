import type pg from 'pg';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';
import {
  ClarificationAnswerConflictError,
  ClarificationAnswerInputSchema,
  ClarifyingQuestionNotFoundError,
  type ClarificationAnswerInput,
} from './clarification-answer-schema.js';

export async function listClarifyingQuestions(
  client: pg.PoolClient,
  sourceDocumentId: string,
): Promise<Array<Record<string, unknown>>> {
  return (await client.query(`SELECT id, source_document_id, field_path, question, answer, answer_source,
      abstention_status, abstention_reason, policy_version, question_hash, created_at
    FROM clarifying_question WHERE source_document_id=$1 ORDER BY field_path, id`, [sourceDocumentId])).rows;
}

export async function answerClarifyingQuestion(
  client: pg.PoolClient,
  input: { clientId: string; questionId: string; actorUserId: string; answer: ClarificationAnswerInput },
): Promise<{ id: string; answer: string; answer_source: ClarificationAnswerInput['answer_source']; changed: boolean }> {
  const answer = ClarificationAnswerInputSchema.parse(input.answer);
  const result = await client.query<{ id: string; answer: string | null; answer_source: string | null }>(
    `SELECT id, answer, answer_source FROM clarifying_question WHERE id=$1 FOR UPDATE`, [input.questionId],
  );
  const current = result.rows[0];
  if (!current) throw new ClarifyingQuestionNotFoundError();
  if (current.answer === answer.answer && current.answer_source === answer.answer_source) {
    return { id: current.id, answer: answer.answer, answer_source: answer.answer_source, changed: false };
  }

  const audit = await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, input.questionId, answer.answer_source, answer.answer, 'clarification_question.answered'),
    clientId: input.clientId, entity: 'clarifying_question', entityId: input.questionId, event: 'answered',
    actorKind: 'analyst', actorUserId: input.actorUserId,
    detail: { answer: answer.answer, answerSource: answer.answer_source },
  });
  if (!audit.created) throw new ClarificationAnswerConflictError();
  await client.query(`UPDATE clarifying_question SET answer=$2, answer_source=$3::answer_source WHERE id=$1`,
    [input.questionId, answer.answer, answer.answer_source]);
  return { id: current.id, answer: answer.answer, answer_source: answer.answer_source, changed: true };
}
