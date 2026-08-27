import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { withTenantTx } from '../db/tenant-context.js';
import { registerTenantAuthPreHandler } from '../modules/findings/tenant-auth.js';
import { requireSingleClientId } from '../modules/ingestion/raw-upload-route.js';
import { isUuid } from '../shared/request-validation.js';
import {
  ClarificationAnswerConflictError,
  ClarificationAnswerInputSchema,
  ClarifyingQuestionNotFoundError,
} from '../modules/contracts/clarification-answer-schema.js';
import {
  answerClarifyingQuestion,
  listClarifyingQuestions,
} from '../modules/contracts/clarification-answers.js';

export async function registerClarificationAnswersRoutes(routes: FastifyInstance): Promise<void> {
  await registerTenantAuthPreHandler(routes);

  routes.get('/api/clarifying-questions', async (request, reply) => {
    const sourceDocumentId = (request.query as { source_document_id?: string }).source_document_id;
    if (!sourceDocumentId || !isUuid(sourceDocumentId)) {
      return reply.code(400).send({ error: 'source_document_id must be a well-formed UUID' });
    }
    const questions = await withTenantTx(request.tenantContext!, (client) => listClarifyingQuestions(client, sourceDocumentId));
    return { questions };
  });

  routes.put('/api/clarifying-questions/:id/answer', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return reply.code(400).send({ error: 'invalid clarifying question id' });
    const clientId = requireSingleClientId(request.tenantContext!);
    if (!clientId || !request.actorUserId) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const answer = ClarificationAnswerInputSchema.parse(request.body);
      const result = await withTenantTx(request.tenantContext!, (client) => answerClarifyingQuestion(client, {
        clientId, questionId: id, actorUserId: request.actorUserId!, answer,
      }));
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof ZodError) return reply.code(400).send({ error: 'invalid clarification answer', details: error.issues });
      if (error instanceof ClarifyingQuestionNotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ClarificationAnswerConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
}
