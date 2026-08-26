import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';
import { buildApp } from '../../src/server/app.js';

describe('contract document upload API (DB)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let clientId: string;
  let otherClientId: string;
  let userId: string;
  let carrierId: string;
  const tag = `contract-upload-${Date.now()}`;
  const originalDevHeaders = process.env.DEV_AUTH_HEADERS;
  const originalRoot = process.env.OBJECT_STORE_ROOT;

  beforeAll(async () => {
    process.env.DEV_AUTH_HEADERS = '1';
    process.env.OBJECT_STORE_ROOT = `/tmp/${tag}`;
    pool = getPool();
    const client = await pool.query(`INSERT INTO client (name, slug) VALUES ('Contract Upload', $1) RETURNING id`, [tag]);
    clientId = client.rows[0].id;
    const other = await pool.query(`INSERT INTO client (name, slug) VALUES ('Other', $1) RETURNING id`, [`${tag}-other`]);
    otherClientId = other.rows[0].id;
    const user = await pool.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}@example.com`]);
    userId = user.rows[0].id;
    await pool.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1,$2,'client_admin')`, [userId, clientId]);
    const carrier = await pool.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [tag]);
    carrierId = carrier.rows[0].id;
    app = buildApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM contract_version WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM contract WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM source_document WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM membership WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM app_user WHERE id = $1`, [userId]);
    await pool.query(`DELETE FROM client WHERE id IN ($1,$2)`, [clientId, otherClientId]);
    await pool.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
    await closePool();
    if (originalDevHeaders === undefined) delete process.env.DEV_AUTH_HEADERS; else process.env.DEV_AUTH_HEADERS = originalDevHeaders;
    if (originalRoot === undefined) delete process.env.OBJECT_STORE_ROOT; else process.env.OBJECT_STORE_ROOT = originalRoot;
  });

  const headers = () => ({
    'x-client-id': clientId, 'x-user-id': userId, 'content-type': 'application/pdf',
  });

  it('creates an immutable contract/version/source chain and append-only audit event', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/contracts?carrier_id=${carrierId}&name=Primary&version_label=v1&valid_from=2026-01-01&valid_to=2027-01-01`,
      headers: headers(), payload: Buffer.from(`PDF-${tag}-v1`),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    const chain = await pool.query(
      `SELECT cv.contract_id, cv.source_document_id, ae.actor_user_id
       FROM contract_version cv JOIN audit_event ae ON ae.entity_id = cv.id WHERE cv.id = $1`,
      [body.contractVersionId],
    );
    expect(chain.rows[0]).toMatchObject({ contract_id: body.contractId, source_document_id: body.sourceDocumentId, actor_user_id: userId });
  });

  it('returns the same ids with 200 when identical bytes are retried', async () => {
    const request = {
      method: 'POST' as const,
      url: `/api/contracts?carrier_id=${carrierId}&name=Retry&valid_from=2028-01-01`,
      headers: headers(), payload: Buffer.from(`PDF-${tag}-retry`),
    };
    const first = await app.inject(request);
    const second = await app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ ...first.json(), created: false });
  });

  it('fails closed when the requested tenant is not in the user membership', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/contracts?carrier_id=${carrierId}&name=Forbidden&valid_from=2030-01-01`,
      headers: { ...headers(), 'x-client-id': otherClientId }, payload: Buffer.from(`PDF-${tag}-forbidden`),
    });
    expect(response.statusCode).toBe(401);
  });
});
