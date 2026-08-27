import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

const clientId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const questionId = '33333333-3333-4333-8333-333333333333';
const documentId = '44444444-4444-4444-8444-444444444444';

describe('clarification answer routes', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { if (app) await app.close(); app = undefined; vi.resetModules(); });

  async function setup(correctionError?: 'notfound' | 'conflict') {
    vi.doMock('../../src/modules/findings/tenant-auth.js', () => ({
      registerTenantAuthPreHandler: async (routes: FastifyInstance) => routes.addHook('preHandler', async (
        request: FastifyRequest, _reply: FastifyReply,
      ) => { request.tenantContext = { clientIds: [clientId] }; request.actorUserId = userId; }),
    }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn(async (_ctx, fn) => fn({})) }));
    const answerClarifyingQuestion = vi.fn().mockResolvedValue({ id: questionId, answer: 'USD', answer_source: 'read_from_doc', changed: true });
    const listClarifyingQuestions = vi.fn().mockResolvedValue([{ id: questionId }]);
    const errors = await import('../../src/modules/contracts/extraction-field-correction-schema.js');
    const persistExtractionFieldCorrection = correctionError
      ? vi.fn().mockRejectedValue(correctionError === 'notfound'
        ? new errors.ExtractionFieldNotFoundError() : new errors.ExtractionFieldCorrectionConflictError())
      : vi.fn().mockResolvedValue({ id: questionId, correctionHash: 'a'.repeat(64), created: true });
    vi.doMock('../../src/modules/contracts/clarification-answers.js', () => ({ answerClarifyingQuestion, listClarifyingQuestions }));
    vi.doMock('../../src/modules/contracts/persist-extraction-field-correction.js', () => ({ persistExtractionFieldCorrection }));
    const { registerClarificationAnswersRoutes } = await import('../../src/server/clarification-answers-routes.js');
    app = Fastify(); await app.register(registerClarificationAnswersRoutes); await app.ready();
    return { answerClarifyingQuestion, listClarifyingQuestions, persistExtractionFieldCorrection };
  }

  it('lists tenant-scoped questions for a source document', async () => {
    const calls = await setup();
    const response = await app!.inject({ method: 'GET', url: `/api/clarifying-questions?source_document_id=${documentId}` });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ questions: [{ id: questionId }] });
    expect(calls.listClarifyingQuestions).toHaveBeenCalledWith({}, documentId);
  });

  it('validates list and answer identifiers before persistence', async () => {
    const calls = await setup();
    expect((await app!.inject({ method: 'GET', url: '/api/clarifying-questions?source_document_id=nope' })).statusCode).toBe(400);
    expect((await app!.inject({ method: 'PUT', url: '/api/clarifying-questions/nope/answer', payload: {} })).statusCode).toBe(400);
    expect(calls.listClarifyingQuestions).not.toHaveBeenCalled(); expect(calls.answerClarifyingQuestion).not.toHaveBeenCalled();
  });

  it('validates answer_source and writes an authenticated answer', async () => {
    const calls = await setup();
    const invalid = await app!.inject({ method: 'PUT', url: `/api/clarifying-questions/${questionId}/answer`,
      payload: { answer: 'USD', answer_source: 'model_guess' } });
    expect(invalid.statusCode).toBe(400);
    const response = await app!.inject({ method: 'PUT', url: `/api/clarifying-questions/${questionId}/answer`,
      payload: { answer: ' USD ', answer_source: 'read_from_doc' } });
    expect(response.statusCode).toBe(200);
    expect(calls.answerClarifyingQuestion).toHaveBeenCalledWith({}, {
      clientId, questionId, actorUserId: userId, answer: { answer: 'USD', answer_source: 'read_from_doc' },
    });
  });

  it('creates a schema-validated extraction-field correction', async () => {
    const calls = await setup();
    const invalid = await app!.inject({ method: 'POST', url: `/api/extraction-fields/${questionId}/corrections`,
      payload: { human_value: 'value', answer_source: 'model_guess' } });
    expect(invalid.statusCode).toBe(400);
    const response = await app!.inject({ method: 'POST', url: `/api/extraction-fields/${questionId}/corrections`,
      payload: { human_value: { normalizedValue: '2026-02-01' }, answer_source: 'analyst_knowledge' } });
    expect(response.statusCode).toBe(201);
    expect(calls.persistExtractionFieldCorrection).toHaveBeenCalledWith({}, {
      clientId, fieldId: questionId, actorUserId: userId,
      correction: { human_value: { normalizedValue: '2026-02-01' }, answer_source: 'analyst_knowledge' },
    });
  });

  it('maps missing and conflicting correction evidence to stable API errors', async () => {
    await setup('notfound');
    const missing = await app!.inject({ method: 'POST', url: `/api/extraction-fields/${questionId}/corrections`,
      payload: { human_value: 'value', answer_source: 'read_from_doc' } });
    expect(missing.statusCode).toBe(404);
    await app!.close(); app = undefined; vi.resetModules();
    await setup('conflict');
    const conflict = await app!.inject({ method: 'POST', url: `/api/extraction-fields/${questionId}/corrections`,
      payload: { human_value: 'value', answer_source: 'read_from_doc' } });
    expect(conflict.statusCode).toBe(409);
  });
});
