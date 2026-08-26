import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { buildApp } from '../../src/server/app.js';
import { GOLDEN_210, MISMATCHED_GROUP_210 } from '../fixtures/edi-golden.js';

/**
 * 86e2v17u9: POST /api/audit-runs, exercised at the HTTP layer end to end
 * (app.inject against a real buildApp() + a real ephemeral Postgres) rather
 * than a mocked route -- the item's own ACs say "e2e: full HTTP round-trip",
 * and app.inject exercises the complete real route stack (preHandlers,
 * content-type parser, the actual ingest pipeline) without binding a TCP
 * port, so a separate Playwright suite would add nothing for a backend-only
 * endpoint with no UI trigger (Header.tsx's "New audit run" button stays
 * disabled per 86e2uv1r6 -- this item's own Rabbit holes).
 */
describe('POST /api/audit-runs (DB, e2e)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let clientId: string;
  let userId: string;
  let carrierId: string;
  let contractId: string;
  let contractVersionId: string;
  let originalFlag: string | undefined;
  const tag = `ar-${Date.now()}`;

  beforeAll(async () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('AR', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const u = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}@example.com`]);
      userId = u.rows[0].id;
      await owner.query(
        `INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer')`,
        [userId, clientId],
      );
      const carrier = await owner.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Carrier-${tag}`]);
      carrierId = carrier.rows[0].id;
      const contract = await owner.query(
        `INSERT INTO contract (client_id, carrier_id, name) VALUES ($1, $2, 'AR Test Contract') RETURNING id`,
        [clientId, carrierId],
      );
      contractId = contract.rows[0].id;
      const version = await owner.query(
        `INSERT INTO contract_version (client_id, contract_id, version_label, valid_from) VALUES ($1, $2, 'v1', CURRENT_DATE) RETURNING id`,
        [clientId, contractId],
      );
      contractVersionId = version.rows[0].id;
      // GOLDEN_210 bills LINEHAUL at 1000.00 -- a seeded 900.00 contract rate
      // produces a genuine 100.00 USD overcharge through CONTRACT.RATE_VARIANCE
      // (same fixture/rate pair as phase2-contract-tier.db.test.ts and
      // scripts/seed-fullstack-e2e-fixture.mjs's proven working template).
      await owner.query(
        `INSERT INTO contract_rate (client_id, contract_version_id, category, rate, currency) VALUES ($1, $2, 'LINEHAUL', 900.00, 'USD')`,
        [clientId, contractVersionId],
      );
    } finally {
      owner.release();
    }
    app = buildApp();
  });

  afterAll(async () => {
    if (originalFlag === undefined) delete process.env.DEV_AUTH_HEADERS;
    else process.env.DEV_AUTH_HEADERS = originalFlag;
    await app.close();
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_replay_manifest WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM variance_finding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM scorecard WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_finding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM gate_failure WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_fact WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM invoice WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM contract_rate WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM contract_version WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM contract WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM source_document WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
      await owner.query(`DELETE FROM membership WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM app_user WHERE id = $1`, [userId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('AC1: a clean 210 (no contract_version_id) returns 201 with id+outcome, and its findings surface via GET /api/findings', async () => {
    const post = await app.inject({
      method: 'POST',
      url: '/api/audit-runs',
      headers: {
        'x-client-id': clientId,
        'x-user-id': userId,
        'content-type': 'application/edi-x12',
      },
      payload: GOLDEN_210,
    });

    expect(post.statusCode).toBe(201);
    const body = post.json();
    expect(body.id).toEqual(expect.any(String));
    // STANDARD_RUBRIC-only run (no contract_version_id) -- GOLDEN_210 foots
    // cleanly, so this is SCORED, not REJECTED_REWORK.
    expect(body.outcome).toBe('SCORED');

    // Prove the round-trip landed for real: the returned id resolves to a
    // genuine audit_run row (SCORED) whose invoice_id also resolves -- not
    // just that the HTTP response claimed success.
    const persisted = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const res = await c.query<{ outcome: string; invoice_id: string }>(
        `SELECT outcome, invoice_id FROM audit_run WHERE id = $1`,
        [body.id],
      );
      return res.rows[0];
    });
    expect(persisted).toBeDefined();
    expect(persisted!.outcome).toBe('SCORED');
    expect(persisted!.invoice_id).toEqual(expect.any(String));

    const replay = await app.inject({
      method: 'POST',
      url: `/api/audit-runs/${body.id}/replay`,
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      auditRunId: body.id,
      manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      resultHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      originalResultHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      byteIdentical: true,
      matchesOriginal: true,
    });

    const ledger = await withTenantTx({ clientIds: [clientId], internal: false }, (c) =>
      c.query(`SELECT event, entity_id FROM audit_event WHERE client_id = $1 ORDER BY recorded_at`, [clientId]),
    );
    expect(ledger.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'ingestion.source_stored' }),
      expect.objectContaining({ event: 'ingestion.audit_created', entity_id: body.id }),
    ]));

    // GOLDEN_210 under STANDARD_RUBRIC: every charge is CONFORMED against
    // the standard criteria (well-formed, foots, currency stated) -- zero
    // variance_finding rows is the correct, honest outcome here (Greg's
    // comment, 1786934517227: never fabricate a finding to compensate).
    // AC2 below is what proves a real dollar variance surfaces end to end.
    const get = await app.inject({
      method: 'GET',
      url: '/api/findings',
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(get.statusCode).toBe(200);
    expect(Array.isArray(get.json().findings)).toBe(true);
  });

  it('AC2: a contract_version_id query param runs CONTRACT_RUBRIC and produces a visible 100.00 USD overcharge', async () => {
    const post = await app.inject({
      method: 'POST',
      url: `/api/audit-runs?contract_version_id=${contractVersionId}`,
      headers: {
        'x-client-id': clientId,
        'x-user-id': userId,
        'content-type': 'application/edi-x12',
      },
      payload: GOLDEN_210,
    });

    expect(post.statusCode).toBe(201);
    const body = post.json();
    expect(body.outcome).toBe('SCORED');

    const get = await app.inject({
      method: 'GET',
      url: '/api/findings',
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(get.statusCode).toBe(200);
    const findings = get.json().findings as Array<{
      direction: string;
      varianceAmount: string | null;
      billed: string | null;
    }>;
    const overcharge = findings.find((f) => f.direction === 'OVERCHARGE');
    expect(overcharge).toBeDefined();
    expect(Number(overcharge!.varianceAmount)).toBeCloseTo(100.0, 4);
  });

  it('86e2xcn18 AC1: a malformed contract_version_id returns 400 with a generic message, never a raw Postgres error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/audit-runs?contract_version_id=not-a-uuid',
      headers: { 'x-client-id': clientId, 'x-user-id': userId, 'content-type': 'application/edi-x12' },
      payload: GOLDEN_210,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('invalid contract_version_id: must be a well-formed UUID');
    // The whole point of the fix: no raw Postgres error detail (error code,
    // "invalid input syntax", SQL fragments/column names) anywhere in the
    // response -- the clear message above legitimately contains the word
    // "UUID" itself, so this checks for the LEAK signatures specifically,
    // not that word.
    expect(JSON.stringify(body)).not.toMatch(/22P02|invalid input syntax|column|lookupContractRate|SELECT|WHERE/i);
  });

  it('86e2xcn18 AC2: a well-formed but non-existent contract_version_id still reaches lookupContractRate (rate miss -> UNASSESSABLE, not an error)', async () => {
    const nonExistentUuid = '00000000-0000-0000-0000-000000000000';
    const res = await app.inject({
      method: 'POST',
      url: `/api/audit-runs?contract_version_id=${nonExistentUuid}`,
      headers: { 'x-client-id': clientId, 'x-user-id': userId, 'content-type': 'application/edi-x12' },
      payload: GOLDEN_210,
    });
    // A rate-lookup miss is an honest UNASSESSABLE verdict on the affected
    // criterion (rate-lookup.ts's own contract), not a rejected request --
    // the route still returns 201, proving the validated UUID reached the
    // real query rather than being rejected for a different reason.
    expect(res.statusCode).toBe(201);
    expect(res.json().outcome).toBe('SCORED');
  });

  it('AC3: no tenant-auth headers -> 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/audit-runs',
      headers: { 'content-type': 'application/edi-x12' },
      payload: GOLDEN_210,
    });
    expect(res.statusCode).toBe(401);
  });

  it('AC4: garbage bytes -> 4xx, not a 500 and not a silent success', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/audit-runs',
      headers: {
        'x-client-id': clientId,
        'x-user-id': userId,
        'content-type': 'application/edi-x12',
      },
      payload: 'this is not an EDI document at all, just garbage bytes',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.json().error).toEqual(expect.any(String));
  });

  it('AC4b: a well-formed envelope whose GS01 does not match its ST-declared transaction set -> 4xx, not 500', async () => {
    // MISMATCHED_GROUP_210: ST*210 body, but GS01=IO (the 310 group code).
    // parseEdiEnvelope throws a plain Error here (edi-envelope.ts:33), not
    // X12ParseError -- this is the real regression this test guards: the
    // route's malformed-input handling must catch that too, not just the
    // X12ParseError subclass thrown by upstream structural failures.
    const res = await app.inject({
      method: 'POST',
      url: '/api/audit-runs',
      headers: {
        'x-client-id': clientId,
        'x-user-id': userId,
        'content-type': 'application/edi-x12',
      },
      payload: MISMATCHED_GROUP_210,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.json().error).toEqual(expect.any(String));
  });

  it('AC5: posting the same raw bytes twice keeps source_document at one row (storeSourceDocument idempotency)', async () => {
    const uniqueBody = GOLDEN_210.replace('INV210001', `INV-IDEMP-${tag}`);

    const first = await app.inject({
      method: 'POST',
      url: '/api/audit-runs',
      headers: {
        'x-client-id': clientId,
        'x-user-id': userId,
        'content-type': 'application/edi-x12',
      },
      payload: uniqueBody,
    });
    expect(first.statusCode).toBe(201);

    const sha256 = (await import('node:crypto')).createHash('sha256').update(Buffer.from(uniqueBody, 'utf8')).digest('hex');
    const afterFirst = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const res = await c.query<{ id: string; uploaded_at: Date }>(
        `SELECT id, uploaded_at FROM source_document WHERE sha256 = $1`,
        [sha256],
      );
      return res.rows;
    });
    // storeSourceDocument's own contract (source-document.ts): the FIRST
    // store creates exactly one row -- proving that here, not just "exactly
    // one row exists after both posts" (which the global UNIQUE(sha256)
    // index would guarantee even if the second post's idempotency check
    // were broken, e.g. by ON CONFLICT silently failing open).
    expect(afterFirst).toHaveLength(1);

    const second = await app.inject({
      method: 'POST',
      url: '/api/audit-runs',
      headers: {
        'x-client-id': clientId,
        'x-user-id': userId,
        'content-type': 'application/edi-x12',
      },
      payload: uniqueBody,
    });
    expect(second.statusCode).toBe(201);

    const duplicateFinding = await withTenantTx({ clientIds: [clientId], internal: false }, async (c) => {
      const res = await c.query(
        `SELECT cf.result FROM charge_finding cf
         JOIN criterion c ON c.id = cf.criterion_id
         WHERE cf.audit_run_id = $1 AND c.criterion_key = 'STD.DUPLICATE_INVOICE'`,
        [second.json().id],
      );
      return res.rows[0];
    });
    expect(duplicateFinding).toMatchObject({ result: 'VARIANCE' });

    const afterSecond = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const res = await c.query<{ id: string; uploaded_at: Date }>(
        `SELECT id, uploaded_at FROM source_document WHERE sha256 = $1`,
        [sha256],
      );
      return res.rows;
    });
    // Still exactly one row, and it's the SAME row (same id, same
    // uploaded_at) -- proving the second post reused the existing document
    // rather than a second insert racing the unique index and losing.
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]!.id).toBe(afterFirst[0]!.id);
    expect(afterSecond[0]!.uploaded_at).toEqual(afterFirst[0]!.uploaded_at);
  });
});
