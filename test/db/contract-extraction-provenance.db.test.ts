import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createHash } from 'node:crypto';
import { makePool, withAppTx } from './helpers.js';
import { setTenantTxScope } from '../../src/db/tenant-context.js';
import { CONTRACT_EXTRACTION_SCHEMA_VERSION, type ContractExtraction } from '../../src/modules/contracts/contract-extraction-schema.js';
import { persistContractExtraction } from '../../src/modules/contracts/persist-contract-extraction.js';
import { contractExtractionIdempotencyKey } from '../../src/modules/contracts/validate-contract-extraction-response.js';
import { persistExtractionFieldCorrection } from '../../src/modules/contracts/persist-extraction-field-correction.js';
import { ExtractionFieldNotFoundError } from '../../src/modules/contracts/extraction-field-correction-schema.js';

describe('contract extraction provenance persistence (DB)', () => {
  let pool: pg.Pool;
  const tag = `contract-extraction-${Date.now()}`;
  const sha = createHash('sha256').update(tag).digest('hex');
  let clientId: string;
  let otherClientId: string;
  let sourceDocumentId: string;
  let userId: string;
  let originalFieldId: string;

  beforeAll(async () => {
    pool = makePool();
    clientId = (await pool.query(`INSERT INTO client (name,slug) VALUES ('Extraction',$1) RETURNING id`, [tag])).rows[0].id;
    otherClientId = (await pool.query(`INSERT INTO client (name,slug) VALUES ('Other',$1) RETURNING id`, [`${tag}-other`])).rows[0].id;
    userId = (await pool.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}@example.com`])).rows[0].id;
    sourceDocumentId = (await pool.query(`INSERT INTO source_document
      (client_id,sha256,content_type,byte_size,storage_uri) VALUES ($1,$2,'application/pdf',1,$3) RETURNING id`,
    [clientId, sha, `local://${tag}`])).rows[0].id;
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM audit_event WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM extraction_field WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM source_document WHERE id=$1`, [sourceDocumentId]);
    await pool.query(`DELETE FROM app_user WHERE id=$1`, [userId]);
    await pool.query(`DELETE FROM client WHERE id IN ($1,$2)`, [clientId, otherClientId]);
    await pool.end();
  });

  const extraction = (): ContractExtraction => ({
    schemaVersion: CONTRACT_EXTRACTION_SCHEMA_VERSION, sourceDocumentSha256: sha,
    model: { provider: 'anthropic' as const, modelId: 'claude-opus-4-8', promptVersion: 'contract-extract/1' },
    fields: [{ path: 'contract.validFrom', semanticType: 'DATE' as const, value: { status: 'FOUND' as const,
      rawText: 'January 1, 2026', normalizedValue: '2026-01-01', confidence: 0.9876,
      citations: [{ pageNumber: 3, excerpt: 'Effective January 1, 2026', boundingBox: [1, 2, 3, 2, 3, 4, 1, 4] }] } }],
    clauses: [], rateTables: [],
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

  it('persists complete provenance once, returns stable retry results, and remains tenant-isolated', async () => {
      const value = extraction();
      const idempotencyKey = contractExtractionIdempotencyKey(value);
      const first = await withCommittedTenant([clientId], (client) => persistContractExtraction(client,
        { clientId, sourceDocumentId, actorUserId: null, idempotencyKey, extraction: value }));
      const retry = await withCommittedTenant([clientId], (client) => persistContractExtraction(client,
        { clientId, sourceDocumentId, actorUserId: null, idempotencyKey, extraction: value }));
      expect(first).toEqual({ responseHash: idempotencyKey, fieldCount: 1, created: true });
      expect(retry).toEqual({ ...first, created: false });

      const stored = await withAppTx(pool, { clientIds: [clientId] }, async (client) => (await client.query(
        `SELECT id, field_path, ai_value, confidence, page_ref, bbox, model_version, prompt_version,
          extraction_response_hash, extraction_schema_version, extraction_status, citations
         FROM extraction_field WHERE extraction_response_hash=$1`, [idempotencyKey])).rows[0]);
      expect(stored).toMatchObject({ field_path: 'contract.validFrom', confidence: '0.9876', page_ref: '3',
        model_version: 'claude-opus-4-8', prompt_version: 'contract-extract/1', extraction_response_hash: idempotencyKey,
        extraction_schema_version: CONTRACT_EXTRACTION_SCHEMA_VERSION, extraction_status: 'FOUND',
        ai_value: { status: 'FOUND', rawText: 'January 1, 2026', normalizedValue: '2026-01-01' } });
      expect(stored.bbox).toEqual([{ pageNumber: 3, boundingBox: [1, 2, 3, 2, 3, 4, 1, 4] }]);
      expect(stored.citations[0]).toMatchObject({ pageNumber: 3, excerpt: 'Effective January 1, 2026' });
      originalFieldId = stored.id;

      const hidden = await withAppTx(pool, { clientIds: [otherClientId] }, async (client) =>
        (await client.query(`SELECT id FROM extraction_field WHERE extraction_response_hash=$1`, [idempotencyKey])).rows);
      expect(hidden).toEqual([]);
  });

  it('appends idempotent corrections with the original AI value and provenance intact', async () => {
    const correction = { human_value: { status: 'FOUND', rawText: 'February 1, 2026', normalizedValue: '2026-02-01' },
      answer_source: 'analyst_knowledge' as const };
    const first = await withCommittedTenant([clientId], (client) => persistExtractionFieldCorrection(client,
      { clientId, fieldId: originalFieldId, actorUserId: userId, correction }));
    const retry = await withCommittedTenant([clientId], (client) => persistExtractionFieldCorrection(client,
      { clientId, fieldId: originalFieldId, actorUserId: userId, correction }));
    expect(first).toEqual({ ...retry, created: true });
    expect(retry.created).toBe(false);
    const rows = await withAppTx(pool, { clientIds: [clientId] }, async (client) => (await client.query(
      `SELECT ai_value,human_value,correction_source,corrected_by,model_version,prompt_version,citations
       FROM extraction_field WHERE correction_hash=$1`, [first.correctionHash])).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ai_value: { normalizedValue: '2026-01-01' }, human_value: { normalizedValue: '2026-02-01' },
      correction_source: 'analyst_knowledge', corrected_by: userId,
      model_version: 'claude-opus-4-8', prompt_version: 'contract-extract/1',
    });
    expect(rows[0].citations[0]).toMatchObject({ pageNumber: 3 });
    expect((await pool.query(`SELECT count(*)::int count FROM audit_event WHERE entity='extraction_field' AND entity_id=$1`,
      [first.id])).rows[0].count).toBe(1);
    const value = extraction();
    const idempotencyKey = contractExtractionIdempotencyKey(value);
    expect(await withCommittedTenant([clientId], (client) => persistContractExtraction(client,
      { clientId, sourceDocumentId, actorUserId: null, idempotencyKey, extraction: value })))
      .toEqual({ responseHash: idempotencyKey, fieldCount: 1, created: false });
  });

  it('fails closed across tenants and keeps correction history append-only', async () => {
    await expect(withAppTx(pool, { clientIds: [otherClientId] }, (client) => persistExtractionFieldCorrection(client, {
      clientId: otherClientId, fieldId: originalFieldId, actorUserId: userId,
      correction: { human_value: 'wrong tenant', answer_source: 'analyst_knowledge' },
    }))).rejects.toBeInstanceOf(ExtractionFieldNotFoundError);
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => client.query(
      `UPDATE extraction_field SET human_value='{}' WHERE correction_hash IS NOT NULL`))).rejects.toThrow(/permission denied/i);
    await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => client.query(
      `DELETE FROM extraction_field WHERE correction_hash IS NOT NULL`))).rejects.toThrow(/permission denied/i);
  });

  // app_is_internal() (86e31a9ch) grants RLS-level visibility across every
  // client, so this exercises the query-level client_id predicate directly:
  // an internal caller passing the WRONG clientId must still not find the
  // row, regardless of what RLS alone would have allowed through.
  it('the explicit client_id predicate rejects a mismatched clientId even under an internal (cross-client) RLS scope', async () => {
    await expect(withAppTx(pool, { internal: true }, (client) => persistExtractionFieldCorrection(client, {
      clientId: otherClientId, fieldId: originalFieldId, actorUserId: userId,
      correction: { human_value: 'wrong tenant via internal scope', answer_source: 'analyst_knowledge' },
    }))).rejects.toBeInstanceOf(ExtractionFieldNotFoundError);
  });

  it('fails closed on source/hash/key mismatch before writing evidence', async () => {
      const value = extraction();
      const key = contractExtractionIdempotencyKey(value);
      await expect(withAppTx(pool, { clientIds: [otherClientId] }, (client) => persistContractExtraction(client,
        { clientId: otherClientId, sourceDocumentId, actorUserId: null, idempotencyKey: key, extraction: value })))
        .rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
      await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => persistContractExtraction(client,
        { clientId, sourceDocumentId, actorUserId: null, idempotencyKey: 'b'.repeat(64), extraction: value })))
        .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_MISMATCH' });
      const wrongSource = { ...value, sourceDocumentSha256: 'b'.repeat(64) };
      await expect(withAppTx(pool, { clientIds: [clientId] }, (client) => persistContractExtraction(client,
        { clientId, sourceDocumentId, actorUserId: null, idempotencyKey: contractExtractionIdempotencyKey(wrongSource), extraction: wrongSource })))
        .rejects.toMatchObject({ code: 'SOURCE_HASH_MISMATCH' });
  });

  it('keeps provenance rows append-only for the application role', async () => {
    await expect(withAppTx(pool, { internal: true }, (client) => client.query(`UPDATE extraction_field SET confidence=0 WHERE false`)))
      .rejects.toThrow(/permission denied/i);
    await expect(withAppTx(pool, { internal: true }, (client) => client.query(`DELETE FROM extraction_field WHERE false`)))
      .rejects.toThrow(/permission denied/i);
  });
});
