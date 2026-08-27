import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makePool, withAppTx } from './helpers.js';
import { setTenantTxScope, type TenantContext } from '../../src/db/tenant-context.js';
import {
  answerClarifyingQuestion,
  listClarifyingQuestions,
} from '../../src/modules/contracts/clarification-answers.js';
import {
  ClarificationAnswerConflictError,
  ClarifyingQuestionNotFoundError,
} from '../../src/modules/contracts/clarification-answer-schema.js';

describe('clarification answers (DB)', () => {
  let pool: pg.Pool;
  const tag = `clarification-answers-${Date.now()}`;
  let clientId: string;
  let otherClientId: string;
  let userId: string;
  let sourceDocumentId: string;
  let questionId: string;

  beforeAll(async () => {
    pool = makePool();
    clientId = (await pool.query(`INSERT INTO client (name,slug) VALUES ('Answers',$1) RETURNING id`, [tag])).rows[0].id;
    otherClientId = (await pool.query(`INSERT INTO client (name,slug) VALUES ('Other',$1) RETURNING id`, [`${tag}-other`])).rows[0].id;
    userId = (await pool.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}@example.com`])).rows[0].id;
    sourceDocumentId = (await pool.query(`INSERT INTO source_document
      (client_id,sha256,content_type,byte_size,storage_uri) VALUES ($1,$2,'application/pdf',1,$3) RETURNING id`,
    [clientId, 'a'.repeat(64), `local://${tag}`])).rows[0].id;
    questionId = (await pool.query(`INSERT INTO clarifying_question
      (client_id,source_document_id,field_path,question,extraction_response_hash,abstention_status,
       abstention_reason,policy_version,question_hash) VALUES ($1,$2,'contract.currency','Which currency?',
       $3,'NOT_FOUND','MISSING_REQUIRED_FIELD','abstention/1',$4) RETURNING id`,
    [clientId, sourceDocumentId, 'b'.repeat(64), 'c'.repeat(64)])).rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM audit_event WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM clarifying_question WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM source_document WHERE id=$1`, [sourceDocumentId]);
    await pool.query(`DELETE FROM app_user WHERE id=$1`, [userId]);
    await pool.query(`DELETE FROM client WHERE id IN ($1,$2)`, [clientId, otherClientId]);
    await pool.end();
  });

  async function withCommittedTenant<T>(ctx: TenantContext, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await setTenantTxScope(client, ctx);
      const result = await fn(client); await client.query('COMMIT'); return result;
    } catch (error) {
      await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  }

  it('answers idempotently, audits changes, and rejects superseded replay', async () => {
    const first = await withCommittedTenant({ clientIds: [clientId] }, (client) => answerClarifyingQuestion(client, {
      clientId, questionId, actorUserId: userId, answer: { answer: 'USD', answer_source: 'read_from_doc' },
    }));
    expect(first.changed).toBe(true);
    const retry = await withCommittedTenant({ clientIds: [clientId] }, (client) => answerClarifyingQuestion(client, {
      clientId, questionId, actorUserId: userId, answer: { answer: 'USD', answer_source: 'read_from_doc' },
    }));
    expect(retry.changed).toBe(false);
    await withCommittedTenant({ clientIds: [clientId] }, (client) => answerClarifyingQuestion(client, {
      clientId, questionId, actorUserId: userId, answer: { answer: 'US dollars', answer_source: 'carrier_confirmed' },
    }));
    await expect(withCommittedTenant({ clientIds: [clientId] }, (client) => answerClarifyingQuestion(client, {
      clientId, questionId, actorUserId: userId, answer: { answer: 'USD', answer_source: 'read_from_doc' },
    }))).rejects.toBeInstanceOf(ClarificationAnswerConflictError);
    const row = (await pool.query(`SELECT answer,answer_source FROM clarifying_question WHERE id=$1`, [questionId])).rows[0];
    expect(row).toEqual({ answer: 'US dollars', answer_source: 'carrier_confirmed' });
    expect((await pool.query(`SELECT count(*)::int count FROM audit_event WHERE entity='clarifying_question' AND entity_id=$1`,
      [questionId])).rows[0].count).toBe(2);
  });

  it('lists only in-scope questions and fails closed for cross-tenant answers', async () => {
    expect(await withAppTx(pool, { clientIds: [clientId] }, (client) => listClarifyingQuestions(client, sourceDocumentId)))
      .toHaveLength(1);
    expect(await withAppTx(pool, { clientIds: [otherClientId] }, (client) => listClarifyingQuestions(client, sourceDocumentId)))
      .toEqual([]);
    await expect(withAppTx(pool, { clientIds: [otherClientId] }, (client) => answerClarifyingQuestion(client, {
      clientId: otherClientId, questionId, actorUserId: userId,
      answer: { answer: 'CAD', answer_source: 'analyst_knowledge' },
    }))).rejects.toBeInstanceOf(ClarifyingQuestionNotFoundError);
  });
});
