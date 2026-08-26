import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { persistRawDocumentAnalysis } from '../../src/modules/contracts/persist-raw-document-analysis.js';
import { LocalDiskObjectStore } from '../../src/modules/reference-data/object-store.js';
import { storeSourceDocument } from '../../src/modules/reference-data/source-document.js';

describe('raw OCR/layout persistence (DB)', () => {
  let pool: pg.Pool;
  let clientA: string;
  let clientB: string;
  let sourceId: string;
  const tag = `raw-analysis-${Date.now()}`;
  const operationLocation = `https://example.cognitiveservices.azure.com/result/${tag}`;

  beforeAll(async () => {
    pool = getPool();
    clientA = (await pool.query(`INSERT INTO client (name, slug) VALUES ('A',$1) RETURNING id`, [`${tag}-a`])).rows[0].id;
    clientB = (await pool.query(`INSERT INTO client (name, slug) VALUES ('B',$1) RETURNING id`, [`${tag}-b`])).rows[0].id;
    sourceId = await withTenantTx({ clientIds: [clientA] }, async (client) =>
      (await storeSourceDocument(client, new LocalDiskObjectStore(`/tmp/${tag}`), {
        clientId: clientA, bytes: Buffer.from(tag), contentType: 'application/pdf',
      })).id,
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientA]);
    await pool.query(`DELETE FROM raw_document_analysis WHERE client_id = $1`, [clientA]);
    await pool.query(`DELETE FROM source_document WHERE client_id = $1`, [clientA]);
    await pool.query(`DELETE FROM client WHERE id IN ($1,$2)`, [clientA, clientB]);
    await closePool();
  });

  const input = () => ({
    clientId: clientA, sourceDocumentId: sourceId, actorUserId: null,
    result: { provider: 'azure-document-intelligence' as const, apiVersion: '2024-11-30', modelId: 'prebuilt-layout', operationLocation,
      rawResponse: { status: 'succeeded' as const, analyzeResult: { apiVersion: '2024-11-30', modelId: 'prebuilt-layout', content: 'raw' } } },
  });

  it('persists once, returns the same row on retry, and remains invisible cross-tenant', async () => {
    const first = await withTenantTx({ clientIds: [clientA] }, (client) => persistRawDocumentAnalysis(client, input()));
    const retry = await withTenantTx({ clientIds: [clientA] }, (client) => persistRawDocumentAnalysis(client, input()));
    expect(first.created).toBe(true);
    expect(retry).toEqual({ ...first, created: false });
    const visibleToB = await withTenantTx({ clientIds: [clientB] }, async (client) =>
      (await client.query(`SELECT id FROM raw_document_analysis WHERE id = $1`, [first.id])).rows,
    );
    expect(visibleToB).toEqual([]);
  });

  it('denies UPDATE and DELETE to the application role', async () => {
    await expect(withTenantTx({ clientIds: [clientA] }, (client) => client.query(`UPDATE raw_document_analysis SET model_id='x'`))).rejects.toThrow(/permission denied/i);
    await expect(withTenantTx({ clientIds: [clientA] }, (client) => client.query(`DELETE FROM raw_document_analysis`))).rejects.toThrow(/permission denied/i);
  });
});
