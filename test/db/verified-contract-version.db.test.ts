import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makePool, withAppTx } from './helpers.js';
import { setTenantTxScope } from '../../src/db/tenant-context.js';
import { CONTRACT_EXTRACTION_SCHEMA_VERSION, type ContractExtraction } from '../../src/modules/contracts/contract-extraction-schema.js';
import { persistContractExtraction } from '../../src/modules/contracts/persist-contract-extraction.js';
import { contractExtractionIdempotencyKey } from '../../src/modules/contracts/validate-contract-extraction-response.js';
import { answerClarifyingQuestion } from '../../src/modules/contracts/clarification-answers.js';
import { persistExtractionFieldCorrection } from '../../src/modules/contracts/persist-extraction-field-correction.js';
import { finalizeContractVersion } from '../../src/modules/contracts/finalize-contract-version.js';
import { ContractVersionFinalizationError } from '../../src/modules/contracts/finalize-contract-version-schema.js';

describe('verified contract version finalization (DB)', () => {
  let pool: pg.Pool;
  const tag = `verified-version-${Date.now()}`;
  const sourceSha = createHash('sha256').update(tag).digest('hex');
  let clientId: string; let otherClientId: string; let userId: string; let carrierId: string;
  let contractId: string; let contractVersionId: string; let sourceDocumentId: string; let fieldId: string; let questionId: string;
  let extractionResponseHash: string;

  const extraction = (): ContractExtraction => ({
    schemaVersion: CONTRACT_EXTRACTION_SCHEMA_VERSION, sourceDocumentSha256: sourceSha,
    model: { provider: 'anthropic', modelId: 'claude-opus-4-8', promptVersion: 'contract-extract/1' },
    fields: [{ path: 'contract.currency', semanticType: 'CURRENCY', value: { status: 'FOUND', rawText: 'US currency',
      normalizedValue: 'USD', confidence: 0.9, citations: [{ pageNumber: 2, excerpt: 'All charges in US currency',
        boundingBox: [1, 2, 3, 2, 3, 4, 1, 4] }] } }],
    clauses: [], rateTables: [],
  });

  beforeAll(async () => {
    pool = makePool();
    clientId = (await pool.query(`INSERT INTO client(name,slug) VALUES('Verified',$1) RETURNING id`, [tag])).rows[0].id;
    otherClientId = (await pool.query(`INSERT INTO client(name,slug) VALUES('Other',$1) RETURNING id`, [`${tag}-other`])).rows[0].id;
    userId = (await pool.query(`INSERT INTO app_user(email) VALUES($1) RETURNING id`, [`${tag}@example.com`])).rows[0].id;
    carrierId = (await pool.query(`INSERT INTO carrier(name) VALUES($1) RETURNING id`, [tag])).rows[0].id;
    sourceDocumentId = (await pool.query(`INSERT INTO source_document(client_id,sha256,content_type,byte_size,storage_uri)
      VALUES($1,$2,'application/pdf',1,$3) RETURNING id`, [clientId, sourceSha, `local://${tag}`])).rows[0].id;
    contractId = (await pool.query(`INSERT INTO contract(client_id,carrier_id,name) VALUES($1,$2,'Verified') RETURNING id`,
      [clientId, carrierId])).rows[0].id;
    contractVersionId = (await pool.query(`INSERT INTO contract_version(client_id,contract_id,valid_from,source_document_id)
      VALUES($1,$2,'2026-01-01',$3) RETURNING id`, [clientId, contractId, sourceDocumentId])).rows[0].id;
    extractionResponseHash = contractExtractionIdempotencyKey(extraction());
    await withCommittedTenant([clientId], (client) => persistContractExtraction(client, {
      clientId, sourceDocumentId, actorUserId: null, idempotencyKey: extractionResponseHash, extraction: extraction(),
    }));
    fieldId = (await pool.query(`SELECT id FROM extraction_field WHERE client_id=$1 AND correction_hash IS NULL`, [clientId])).rows[0].id;
    questionId = (await pool.query(`INSERT INTO clarifying_question(client_id,source_document_id,field_path,question,
      extraction_response_hash,abstention_status,abstention_reason,policy_version,question_hash)
      VALUES($1,$2,'contract.currency','Confirm currency',$3,'AMBIGUOUS','LOW_CONFIDENCE','abstention/1',$4) RETURNING id`,
    [clientId, sourceDocumentId, extractionResponseHash, 'd'.repeat(64)])).rows[0].id;
  });

  async function withCommittedTenant<T>(ids: string[], fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query('BEGIN'); await setTenantTxScope(client, { clientIds: ids });
      const result = await fn(client); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  afterAll(async () => {
    await pool.query(`DELETE FROM audit_event WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM verified_contract_version WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM clarifying_question WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM extraction_field WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM contract_version WHERE id=$1`, [contractVersionId]);
    await pool.query(`DELETE FROM contract WHERE id=$1`, [contractId]);
    await pool.query(`DELETE FROM source_document WHERE id=$1`, [sourceDocumentId]);
    await pool.query(`DELETE FROM app_user WHERE id=$1`, [userId]);
    await pool.query(`DELETE FROM client WHERE id IN($1,$2)`, [clientId, otherClientId]);
    await pool.query(`DELETE FROM carrier WHERE id=$1`, [carrierId]); await pool.end();
  });

  it('fails safe until clarifications are answered', async () => {
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => finalizeContractVersion(client, {
      clientId, contractVersionId, actorUserId: userId, extractionResponseHash,
    }))).rejects.toMatchObject({ code: 'UNANSWERED_CLARIFICATIONS' });
  });

  it('finalizes once with corrected effective values and immutable original evidence', async () => {
    await withCommittedTenant([clientId], (client) => answerClarifyingQuestion(client, { clientId, questionId, actorUserId: userId,
      answer: { answer: 'CAD', answer_source: 'carrier_confirmed' } }));
    const correction = await withCommittedTenant([clientId], (client) => persistExtractionFieldCorrection(client, {
      clientId, fieldId, actorUserId: userId,
      correction: { human_value: { status: 'FOUND', rawText: 'Canadian dollars', normalizedValue: 'CAD' }, answer_source: 'carrier_confirmed' },
    }));
    const first = await withCommittedTenant([clientId], (client) => finalizeContractVersion(client,
      { clientId, contractVersionId, actorUserId: userId, extractionResponseHash }));
    const retry = await withCommittedTenant([clientId], (client) => finalizeContractVersion(client,
      { clientId, contractVersionId, actorUserId: userId, extractionResponseHash }));
    expect(first).toEqual({ ...retry, created: true, fieldCount: 1 }); expect(retry.created).toBe(false);
    const snapshot = (await pool.query(`SELECT resolved_fields,verified_by FROM verified_contract_version WHERE id=$1`, [first.id])).rows[0];
    expect(snapshot.verified_by).toBe(userId);
    expect(snapshot.resolved_fields[0]).toMatchObject({ originalFieldId: fieldId, evidenceFieldId: correction.id,
      aiValue: { normalizedValue: 'USD' }, humanValue: { normalizedValue: 'CAD' }, effectiveValue: { normalizedValue: 'CAD' } });
    expect((await pool.query(`SELECT ai_value,human_value FROM extraction_field WHERE id=$1`, [fieldId])).rows[0])
      .toMatchObject({ ai_value: { normalizedValue: 'USD' }, human_value: null });
    expect((await pool.query(`SELECT count(*)::int count FROM audit_event WHERE entity='contract_version' AND event='verified'
      AND entity_id=$1`, [contractVersionId])).rows[0].count).toBe(1);
  });

  it('is tenant-isolated and append-only', async () => {
    await expect(withAppTx(pool, { clientIds: [otherClientId] }, (client) => finalizeContractVersion(client, {
      clientId: otherClientId, contractVersionId, actorUserId: userId, extractionResponseHash,
    }))).rejects.toBeInstanceOf(ContractVersionFinalizationError);
    expect(await withAppTx(pool, { clientIds: [otherClientId] }, async (client) =>
      (await client.query(`SELECT id FROM verified_contract_version`)).rows)).toEqual([]);
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => client.query(
      `UPDATE verified_contract_version SET resolved_fields='[]'`))).rejects.toThrow(/permission denied/i);
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => client.query(
      `DELETE FROM verified_contract_version`))).rejects.toThrow(/permission denied/i);
  });
});
