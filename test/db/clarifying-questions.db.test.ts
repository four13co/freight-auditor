import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makePool, withAppTx } from './helpers.js';
import { setTenantTxScope } from '../../src/db/tenant-context.js';
import { CONTRACT_EXTRACTION_SCHEMA_VERSION, type ContractExtraction } from '../../src/modules/contracts/contract-extraction-schema.js';
import { applyContractExtractionAbstention } from '../../src/modules/contracts/apply-contract-extraction-abstention.js';
import { generateClarifyingQuestions, persistClarifyingQuestions } from '../../src/modules/contracts/clarifying-questions.js';
import { persistContractExtraction } from '../../src/modules/contracts/persist-contract-extraction.js';
import { contractExtractionIdempotencyKey } from '../../src/modules/contracts/validate-contract-extraction-response.js';

describe('clarifying questions from abstentions (DB)', () => {
  let pool: pg.Pool;
  const tag = `clarifying-questions-${Date.now()}`;
  const sha = createHash('sha256').update(tag).digest('hex');
  let clientId: string;
  let otherClientId: string;
  let sourceDocumentId: string;
  let extractionResponseHash: string;

  const policy = { version: 'abstention/1', minimumConfidence: 0.8, requiredFields: [
    { path: 'contract.validFrom', semanticType: 'DATE' as const, clarificationQuestion: 'What is the full effective date?' },
    { path: 'contract.currency', semanticType: 'CURRENCY' as const, clarificationQuestion: 'Which currency applies?' },
  ] };
  const extraction = (): ContractExtraction => ({
    schemaVersion: CONTRACT_EXTRACTION_SCHEMA_VERSION, sourceDocumentSha256: sha,
    model: { provider: 'anthropic', modelId: 'claude-opus-4-8', promptVersion: 'contract-extract/1' },
    fields: [{ path: 'contract.validFrom', semanticType: 'DATE', value: { status: 'FOUND', rawText: 'January 2026',
      normalizedValue: '2026-01-01', confidence: 0.4,
      citations: [{ pageNumber: 1, excerpt: 'Effective January 2026', span: { offset: 10, length: 22 } }] } }],
    clauses: [], rateTables: [],
  });

  beforeAll(async () => {
    pool = makePool();
    clientId = (await pool.query(`INSERT INTO client (name,slug) VALUES ('Questions',$1) RETURNING id`, [tag])).rows[0].id;
    otherClientId = (await pool.query(`INSERT INTO client (name,slug) VALUES ('Other',$1) RETURNING id`, [`${tag}-other`])).rows[0].id;
    sourceDocumentId = (await pool.query(`INSERT INTO source_document
      (client_id,sha256,content_type,byte_size,storage_uri) VALUES ($1,$2,'application/pdf',1,$3) RETURNING id`,
    [clientId, sha, `local://${tag}`])).rows[0].id;
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM audit_event WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM clarifying_question WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM extraction_field WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM source_document WHERE id=$1`, [sourceDocumentId]);
    await pool.query(`DELETE FROM client WHERE id IN ($1,$2)`, [clientId, otherClientId]);
    await pool.end();
  });

  async function withCommittedTenant<T>(ids: string[], fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await setTenantTxScope(client, { clientIds: ids });
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  it('persists generated questions once and keeps them tenant-isolated', async () => {
    const processed = applyContractExtractionAbstention(extraction(), policy);
    extractionResponseHash = contractExtractionIdempotencyKey(processed.extraction);
    const questions = generateClarifyingQuestions(processed.abstentions, processed.policyVersion);
    await withCommittedTenant([clientId], (client) => persistContractExtraction(client, {
      clientId, sourceDocumentId, actorUserId: null, idempotencyKey: extractionResponseHash, extraction: processed.extraction,
    }));
    const first = await withCommittedTenant([clientId], (client) => persistClarifyingQuestions(client, {
      clientId, sourceDocumentId, actorUserId: null, extractionResponseHash, policyVersion: processed.policyVersion, questions,
    }));
    const retry = await withCommittedTenant([clientId], (client) => persistClarifyingQuestions(client, {
      clientId, sourceDocumentId, actorUserId: null, extractionResponseHash, policyVersion: processed.policyVersion, questions,
    }));
    expect(first).toEqual({ questionCount: 2, created: true });
    expect(retry).toEqual({ questionCount: 2, created: false });

    const stored = await withAppTx(pool, { clientIds: [clientId] }, async (client) => (await client.query(
      `SELECT field_path, question, abstention_status, abstention_reason, policy_version, question_hash
       FROM clarifying_question WHERE extraction_response_hash=$1 ORDER BY field_path`, [extractionResponseHash])).rows);
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ field_path: 'contract.currency', question: 'Which currency applies?',
      abstention_status: 'NOT_FOUND', abstention_reason: 'MISSING_REQUIRED_FIELD', policy_version: 'abstention/1' });
    expect(stored.every((row) => /^[a-f0-9]{64}$/.test(row.question_hash))).toBe(true);
    const hidden = await withAppTx(pool, { clientIds: [otherClientId] }, async (client) =>
      (await client.query(`SELECT id FROM clarifying_question WHERE extraction_response_hash=$1`, [extractionResponseHash])).rows);
    expect(hidden).toEqual([]);
  });

  it('fails closed for unknown extraction evidence and tampered question identity', async () => {
    const processed = applyContractExtractionAbstention(extraction(), policy);
    const questions = generateClarifyingQuestions(processed.abstentions, processed.policyVersion);
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => persistClarifyingQuestions(client, {
      clientId, sourceDocumentId, actorUserId: null, extractionResponseHash: 'b'.repeat(64), policyVersion: processed.policyVersion, questions,
    }))).rejects.toMatchObject({ code: 'EXTRACTION_NOT_FOUND' });
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => persistClarifyingQuestions(client, {
      clientId, sourceDocumentId, actorUserId: null, extractionResponseHash, policyVersion: processed.policyVersion,
      questions: [{ ...questions[0]!, questionHash: 'b'.repeat(64) }],
    }))).rejects.toMatchObject({ code: 'QUESTION_HASH_MISMATCH' });
  });

  it('keeps generated identity immutable while allowing answer fields only', async () => {
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) =>
      client.query(`UPDATE clarifying_question SET question=question WHERE extraction_response_hash=$1`, [extractionResponseHash])))
      .rejects.toThrow(/permission denied/i);
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) =>
      client.query(`DELETE FROM clarifying_question WHERE extraction_response_hash=$1`, [extractionResponseHash])))
      .rejects.toThrow(/permission denied/i);
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) =>
      client.query(`UPDATE clarifying_question SET answer='USD', answer_source='read_from_doc'
        WHERE extraction_response_hash=$1 AND field_path='contract.currency'`, [extractionResponseHash])))
      .resolves.toMatchObject({ rowCount: 1 });
  });
});
