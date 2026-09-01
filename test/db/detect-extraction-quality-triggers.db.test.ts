import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { createHash } from 'node:crypto';
import { getPool, closePool } from '../../src/db/pool.js';
import { detectExtractionQualityTriggers } from '../../src/modules/discovery/detect-extraction-quality-triggers.js';

/**
 * P3.D.3: a contract-extraction field the model answered with low confidence,
 * or could not resolve at all (NOT_FOUND/AMBIGUOUS), surfaces as a discovery
 * trigger, scoped to one extraction run (extractionResponseHash), idempotent
 * on re-run. A field a human has since corrected is excluded. Re-extracting a
 * document (a new response hash) must not resurface a superseded run's
 * already-triggered field as a duplicate/stale trigger.
 */
describe('detectExtractionQualityTriggers (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  let sourceDocumentId: string;
  let userId: string;
  const tag = `eqt-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('EQT', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const user = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}@example.com`]);
      userId = user.rows[0].id;
      const sha = createHash('sha256').update(tag).digest('hex');
      const doc = await owner.query(
        `INSERT INTO source_document (client_id, sha256, content_type, byte_size, storage_uri)
         VALUES ($1, $2, 'application/pdf', 1, $3) RETURNING id`,
        [clientId, sha, `local://${tag}`],
      );
      sourceDocumentId = doc.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM extraction_quality_trigger WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM extraction_field WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM source_document WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM app_user WHERE id = $1`, [userId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedField(
    client: pg.PoolClient,
    field: { fieldPath: string; status: 'FOUND' | 'NOT_FOUND' | 'AMBIGUOUS'; confidence: number; responseHash: string; humanCorrected?: boolean },
  ): Promise<{ id: string }> {
    const inserted = await client.query(
      `INSERT INTO extraction_field
         (client_id, source_document_id, field_path, ai_value, confidence, model_version, prompt_version,
          extraction_response_hash, extraction_schema_version, extraction_status, citations)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'test-model', 'test-prompt/1', $6, 'contract-extraction/1', $7, '[]'::jsonb)
       RETURNING id`,
      [clientId, sourceDocumentId, field.fieldPath, JSON.stringify({ status: field.status }), field.confidence, field.responseHash, field.status],
    );
    const id = inserted.rows[0].id;
    if (field.humanCorrected) {
      await client.query(
        `INSERT INTO extraction_field
           (client_id, source_document_id, field_path, ai_value, human_value, confidence, model_version, prompt_version,
            extraction_response_hash, extraction_schema_version, extraction_status, citations, correction_hash, correction_source, corrected_by)
         VALUES ($1, $2, $3, $4::jsonb, '{"corrected":true}'::jsonb, $5, 'test-model', 'test-prompt/1', $6, 'contract-extraction/1', $7, '[]'::jsonb,
           $8, 'analyst_knowledge', $9)`,
        [clientId, sourceDocumentId, field.fieldPath, JSON.stringify({ status: field.status }), field.confidence, field.responseHash,
          field.status, createHash('sha256').update(`${field.responseHash}-correction`).digest('hex'), userId],
      );
    }
    return { id };
  }

  function responseHash(label: string): string {
    return createHash('sha256').update(`${tag}-${label}-${Math.random()}`).digest('hex');
  }

  it('creates a LOW_CONFIDENCE trigger for a found-but-unsure field and a STRUCTURAL_ANOMALY trigger for an unresolved one, and is idempotent on re-run', async () => {
    const owner = await pool.connect();
    try {
      const runHash = responseHash('run-a');
      const low = await seedField(owner, { fieldPath: `contract.rate.${tag}`, status: 'FOUND', confidence: 0.2, responseHash: runHash });
      const notFound = await seedField(owner, { fieldPath: `contract.term.${tag}`, status: 'NOT_FOUND', confidence: 0, responseHash: runHash });
      await seedField(owner, { fieldPath: `contract.effectiveDate.${tag}`, status: 'FOUND', confidence: 0.97, responseHash: runHash });

      const first = await detectExtractionQualityTriggers(owner, { clientId, sourceDocumentId, extractionResponseHash: runHash });
      expect(first.createdCount).toBe(2);
      expect(first.triggerIds).toHaveLength(2);

      const second = await detectExtractionQualityTriggers(owner, { clientId, sourceDocumentId, extractionResponseHash: runHash });
      expect(second.createdCount).toBe(0);
      expect(new Set(second.triggerIds)).toEqual(new Set(first.triggerIds));

      const rows = (await owner.query(
        `SELECT extraction_field_id, trigger_type FROM extraction_quality_trigger WHERE client_id = $1 AND extraction_field_id = ANY($2::uuid[]) ORDER BY trigger_type`,
        [clientId, [low.id, notFound.id]],
      )).rows;
      expect(rows).toEqual([
        { extraction_field_id: low.id, trigger_type: 'LOW_CONFIDENCE' },
        { extraction_field_id: notFound.id, trigger_type: 'STRUCTURAL_ANOMALY' },
      ]);
    } finally {
      owner.release();
    }
  });

  it('creates an AMBIGUOUS structural-anomaly trigger, respects a custom threshold, and excludes a human-corrected field', async () => {
    const owner = await pool.connect();
    try {
      const runHash = responseHash('run-b');
      const ambiguous = await seedField(owner, { fieldPath: `rateTable.orientation.${tag}`, status: 'AMBIGUOUS', confidence: 0.1, responseHash: runHash });
      const belowCustomThreshold = await seedField(owner, { fieldPath: `contract.customThreshold.${tag}`, status: 'FOUND', confidence: 0.6, responseHash: runHash });
      await seedField(owner, { fieldPath: `contract.corrected.${tag}`, status: 'FOUND', confidence: 0.1, responseHash: runHash, humanCorrected: true });

      const result = await detectExtractionQualityTriggers(owner, { clientId, sourceDocumentId, extractionResponseHash: runHash, lowConfidenceThreshold: 0.7 });
      expect(result.createdCount).toBe(2);
      expect(result.triggerIds).toHaveLength(2);

      const rows = (await owner.query(
        `SELECT extraction_field_id, trigger_type FROM extraction_quality_trigger
         WHERE client_id = $1 AND extraction_field_id = ANY($2::uuid[])`,
        [clientId, [ambiguous.id, belowCustomThreshold.id]],
      )).rows;
      expect(rows).toEqual(expect.arrayContaining([
        { extraction_field_id: ambiguous.id, trigger_type: 'STRUCTURAL_ANOMALY' },
        { extraction_field_id: belowCustomThreshold.id, trigger_type: 'LOW_CONFIDENCE' },
      ]));

      const correctedCount = (await owner.query(
        `SELECT count(*)::int count FROM extraction_quality_trigger eqt
         JOIN extraction_field ef ON ef.id = eqt.extraction_field_id
         WHERE eqt.client_id = $1 AND ef.field_path = $2`,
        [clientId, `contract.corrected.${tag}`],
      )).rows[0].count;
      expect(correctedCount).toBe(0);
    } finally {
      owner.release();
    }
  });

  it('re-extracting a document (a new response hash) does not resurface the prior run\'s superseded field as a duplicate/stale trigger', async () => {
    const owner = await pool.connect();
    try {
      const fieldPath = `contract.retry.${tag}`;
      const runA = responseHash('retry-run-a');
      const runB = responseHash('retry-run-b');

      // Run A: the model could not resolve the field at all.
      const staleField = await seedField(owner, { fieldPath, status: 'NOT_FOUND', confidence: 0, responseHash: runA });
      const runAResult = await detectExtractionQualityTriggers(owner, { clientId, sourceDocumentId, extractionResponseHash: runA });
      expect(runAResult.createdCount).toBe(1);
      expect(runAResult.triggerIds).toEqual([expect.any(String)]);

      // Run B: the document is re-extracted; the same field_path now resolves
      // cleanly under a *different* extraction_field row (new response hash).
      const freshField = await seedField(owner, { fieldPath, status: 'FOUND', confidence: 0.95, responseHash: runB });
      const runBResult = await detectExtractionQualityTriggers(owner, { clientId, sourceDocumentId, extractionResponseHash: runB });

      // The current run's high-confidence FOUND result produces no trigger,
      // and critically, run A's already-resolved STRUCTURAL_ANOMALY for the
      // same field_path is not reclassified or re-returned by a call scoped
      // to run B's hash.
      expect(runBResult.createdCount).toBe(0);
      expect(runBResult.triggerIds).toEqual([]);

      const rows = (await owner.query(
        `SELECT extraction_field_id, trigger_type FROM extraction_quality_trigger WHERE client_id = $1 AND field_path = $2 ORDER BY extraction_field_id`,
        [clientId, fieldPath],
      )).rows;
      // Only run A's trigger exists; run B never produced or duplicated one.
      expect(rows).toEqual([{ extraction_field_id: staleField.id, trigger_type: 'STRUCTURAL_ANOMALY' }]);
      expect(rows.some((row) => row.extraction_field_id === freshField.id)).toBe(false);
    } finally {
      owner.release();
    }
  });

  it('throws SOURCE_NOT_FOUND for a source document outside the tenant', async () => {
    const owner = await pool.connect();
    try {
      await expect(
        detectExtractionQualityTriggers(owner, { clientId, sourceDocumentId: '99999999-9999-4999-8999-999999999999', extractionResponseHash: responseHash('missing') }),
      ).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
    } finally {
      owner.release();
    }
  });
});
