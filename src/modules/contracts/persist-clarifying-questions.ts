import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';
import {
  clarifyingQuestionHash,
  ClarifyingQuestionError,
  generatedClarifyingQuestionSchema,
  type GeneratedClarifyingQuestion,
} from './clarifying-questions.js';

const postgresUuid = z.string().uuid();
const persistenceInputSchema = z.object({
  clientId: postgresUuid, sourceDocumentId: postgresUuid, actorUserId: postgresUuid.nullable(),
  extractionResponseHash: z.string().regex(/^[a-f0-9]{64}$/), policyVersion: z.string().trim().min(1).max(200),
  questions: z.array(generatedClarifyingQuestionSchema).max(30_000),
}).strict();

export async function persistClarifyingQuestions(
  client: pg.PoolClient,
  untrustedInput: { clientId: string; sourceDocumentId: string; actorUserId: string | null; extractionResponseHash: string;
    policyVersion: string; questions: GeneratedClarifyingQuestion[] },
): Promise<{ questionCount: number; created: boolean }> {
  const input = persistenceInputSchema.parse(untrustedInput);
  for (const question of input.questions) {
    if (question.questionHash !== clarifyingQuestionHash(input.policyVersion, question.path, question.status, question.reason, question.question)) {
      throw new ClarifyingQuestionError('QUESTION_HASH_MISMATCH');
    }
  }
  const extractionExists = (await client.query(`SELECT 1 FROM audit_event WHERE client_id=$1
    AND entity='contract_extraction' AND entity_id=$2 AND event='persisted' AND detail->>'responseHash'=$3`,
  [input.clientId, input.sourceDocumentId, input.extractionResponseHash])).rowCount;
  if (!extractionExists) throw new ClarifyingQuestionError('EXTRACTION_NOT_FOUND');

  let insertedCount = 0;
  let matchingCount = 0;
  if (input.questions.length) {
    const result = await client.query<{ inserted_count: string; matching_count: string }>(`WITH payload AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS value(
          field_path text, question text, abstention_status text, abstention_reason text, question_hash text)
      ), inserted AS (
        INSERT INTO clarifying_question
          (client_id, source_document_id, field_path, question, extraction_response_hash,
           abstention_status, abstention_reason, policy_version, question_hash)
        SELECT $2,$3,field_path,question,$4,abstention_status,abstention_reason,$5,question_hash FROM payload
        ON CONFLICT (client_id, source_document_id, extraction_response_hash, field_path)
          WHERE extraction_response_hash IS NOT NULL DO NOTHING RETURNING id
      )
      SELECT (SELECT count(*) FROM inserted)::text inserted_count,
        ((SELECT count(*) FROM inserted) + (SELECT count(*) FROM clarifying_question q JOIN payload p
          ON q.field_path=p.field_path AND q.question=p.question AND q.abstention_status=p.abstention_status
          AND q.abstention_reason=p.abstention_reason AND q.question_hash=p.question_hash
          WHERE q.client_id=$2 AND q.source_document_id=$3 AND q.extraction_response_hash=$4
            AND q.policy_version=$5))::text matching_count`,
    [JSON.stringify(input.questions.map((question) => ({ field_path: question.path, question: question.question,
      abstention_status: question.status, abstention_reason: question.reason, question_hash: question.questionHash }))),
    input.clientId, input.sourceDocumentId, input.extractionResponseHash, input.policyVersion]);
    insertedCount = Number(result.rows[0]!.inserted_count);
    matchingCount = Number(result.rows[0]!.matching_count);
    if (matchingCount !== input.questions.length || (insertedCount !== 0 && insertedCount !== input.questions.length)) {
      throw new ClarifyingQuestionError('PARTIAL_CONFLICT');
    }
  }
  const audit = await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, input.sourceDocumentId, input.extractionResponseHash, 'clarifying_questions.generated'),
    clientId: input.clientId, entity: 'clarifying_questions', entityId: input.sourceDocumentId,
    event: 'generated', actorKind: input.actorUserId ? 'analyst' : 'system', actorUserId: input.actorUserId,
    detail: { extractionResponseHash: input.extractionResponseHash, policyVersion: input.policyVersion,
      questionCount: input.questions.length, questionHashes: input.questions.map((question) => question.questionHash) },
  });
  return { questionCount: input.questions.length, created: audit.created };
}
