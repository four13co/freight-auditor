import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { FIXTURE_CARRIER_NAME } from '../../../scripts/seed-fullstack-e2e-fixture.mjs';
import { withTenantTx } from '../../../src/db/tenant-context.js';
import { persistContractExtraction } from '../../../src/modules/contracts/persist-contract-extraction.js';
import { contractExtractionIdempotencyKey } from '../../../src/modules/contracts/validate-contract-extraction-response.js';
import { CONTRACT_EXTRACTION_SCHEMA_VERSION, type ContractExtraction } from '../../../src/modules/contracts/contract-extraction-schema.js';
import { makeTextPdf } from '../../../test/fixtures/pdf-invoice.js';

// 86e33qyyg: full-stack e2e for contract ingestion -> versioning -> finalization
// -- real Fastify server + real Postgres, real HTTP for the two steps that
// have real routes (upload, finalize), no route mocking.
//
// Step 2 (extraction) has no real caller anywhere in src/ today --
// persistContractExtraction is a dangling function with zero callers
// (confirmed via grep during reshape), the same "new surface, not a hookup"
// situation as P6.C.8's reversal write path. Wiring a real automatic pipeline
// is out of scope for an e2e-coverage task (this task's own No-gos) -- it is
// called here in-process with fixture inputs instead, the same "seed the
// non-HTTP precondition directly, drive the real transition over real HTTP"
// pattern P7.A.3/P7.A.4 already established for the invoice-draft flow.
//
// persistRawDocumentAnalysis (the Solution text's other named sub-step) is
// deliberately not called -- see the beforeAll block below for why.
//
// AC2 explicitly does NOT touch ContractRubricPreview (unrelated feature --
// AI rule-proposal review, not contract-version finalization; see this
// task's own reshape note and the P7.A.5 bounce comment history).
//
// This spec seeds its OWN client/app_user/membership rows rather than reusing
// the shared DEV_CLIENT_ID/DEV_USER_ID fixture. Reason: persist-contract-
// extraction.ts's input schema validates clientId/actorUserId with zod's
// strict z.string().uuid() (RFC4122 variant-bit check), which the fixture's
// placeholder IDs ('11111111-...', '22222222-...') fail -- confirmed directly
// against the installed zod version. This is a real, previously-latent
// validation gap (the function has zero other callers today, so nothing had
// hit it), out of scope to fix here. Seeding a dedicated tenant with
// DB-generated (gen_random_uuid()) ids sidesteps it and, as a side benefit,
// means this spec touches zero shared fixture rows -- carrier is the only
// reused fixture, and carrier is global/unscoped by client_id (migration
// 0004_reference_data.sql), so that reuse is safe.

let pool: pg.Pool;
let clientId: string;
let userId: string;
let carrierId: string;
let contractId: string;
let contractVersionId: string;
let sourceDocumentId: string;
let sourceDocumentSha256: string;
let extractionResponseHash: string;

const FIELD_PATH = 'linehaulRate';

function buildExtraction(sha256: string): ContractExtraction {
  return {
    schemaVersion: CONTRACT_EXTRACTION_SCHEMA_VERSION,
    sourceDocumentSha256: sha256,
    model: { provider: 'anthropic', modelId: 'claude-opus-5', promptVersion: 'contract-extraction-v1' },
    fields: [{
      path: FIELD_PATH,
      semanticType: 'CURRENCY',
      value: {
        status: 'FOUND',
        rawText: '$2.50 per mile',
        normalizedValue: '2.50',
        confidence: 0.95,
        citations: [{ pageNumber: 1, excerpt: 'Linehaul rate: $2.50 per mile', boundingBox: [0, 0, 1, 0, 1, 1, 0, 1] }],
      },
    }],
    clauses: [],
    rateTables: [],
  };
}

test.beforeAll(async ({ request }) => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  // Dedicated tenant for this spec (see header note) -- ids come from the
  // DB's own gen_random_uuid() defaults, so they satisfy zod's strict uuid().
  const clientRow = await pool.query<{ id: string }>(
    `INSERT INTO client (name, slug) VALUES ('E2E Contract Ingestion Fixture Client', $1) RETURNING id`,
    [`e2e-contract-ingestion-${Date.now()}`],
  );
  clientId = clientRow.rows[0]!.id;
  const userRow = await pool.query<{ id: string }>(
    `INSERT INTO app_user (email, full_name) VALUES ($1, 'E2E Contract Ingestion Fixture User') RETURNING id`,
    [`e2e-contract-ingestion-${Date.now()}@example.test`],
  );
  userId = userRow.rows[0]!.id;
  await pool.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_admin')`, [userId, clientId]);

  const carrier = await pool.query<{ id: string }>(`SELECT id FROM carrier WHERE name = $1 LIMIT 1`, [FIXTURE_CARRIER_NAME]);
  if (!carrier.rows[0]) {
    throw new Error(
      `contract-ingestion-lifecycle.fullstack.spec: no carrier found named "${FIXTURE_CARRIER_NAME}" -- ` +
        `has 'npm run seed:e2e-fullstack-fixture' been run against this database?`,
    );
  }
  carrierId = carrier.rows[0].id;

  // Step 1: upload -- fully real, over real HTTP.
  const pdf = await makeTextPdf(['E2E Contract Fixture', 'Linehaul rate: $2.50 per mile']);
  const upload = await request.post(`/api/contracts?carrier_id=${carrierId}&name=${encodeURIComponent('E2E Contract Ingestion Fixture')}&valid_from=2026-01-01`, {
    headers: { 'x-client-id': clientId, 'x-user-id': userId, 'content-type': 'application/pdf' },
    data: pdf,
  });
  if (upload.status() !== 201) {
    throw new Error(`contract-ingestion-lifecycle.fullstack.spec: contract upload POST failed with ${upload.status()}`);
  }
  const uploadBody = await upload.json() as { contractId: string; contractVersionId: string; sourceDocumentId: string; sha256: string };
  contractId = uploadBody.contractId;
  contractVersionId = uploadBody.contractVersionId;
  sourceDocumentId = uploadBody.sourceDocumentId;
  sourceDocumentSha256 = uploadBody.sha256;

  // Step 2: extraction -- seeded in-process (no real caller/route exists for
  // persistContractExtraction today; see header note).
  //
  // persistRawDocumentAnalysis (the Solution text's other named sub-step) is
  // deliberately NOT called here: finalizeContractVersion never reads
  // raw_document_analysis -- it only checks the contract_extraction.persisted
  // audit event and extraction_field rows -- so it isn't load-bearing for any
  // of this task's ACs, and none of them assert on it. Skipping it also avoids
  // pulling azure-document-intelligence.ts into web/'s TypeScript build graph,
  // where a pre-existing Buffer/BodyInit incompatibility under web's DOM-lib
  // tsconfig fails `tsc -b` (root's plain tsc --noEmit passes clean on the same
  // file -- this is specific to web's type environment). That's a real,
  // pre-existing bug in a module this task doesn't otherwise touch, worth its
  // own item; flagged in the PR body rather than fixed here.
  await withTenantTx({ clientIds: [clientId], internal: true }, async (client) => {
    const extraction = buildExtraction(sourceDocumentSha256);
    const idempotencyKey = contractExtractionIdempotencyKey(extraction);
    const persisted = await persistContractExtraction(client, {
      clientId, sourceDocumentId, actorUserId: userId, idempotencyKey, extraction,
    });
    extractionResponseHash = persisted.responseHash;
  });
});

test.afterAll(async () => {
  await pool.query(`DELETE FROM verified_contract_version WHERE contract_version_id = $1`, [contractVersionId]);
  await pool.query(`DELETE FROM extraction_field WHERE client_id = $1 AND source_document_id = $2`, [clientId, sourceDocumentId]);
  await pool.query(`DELETE FROM audit_event WHERE client_id = $1 AND entity_id IN ($2, $3)`, [clientId, sourceDocumentId, contractVersionId]);
  await pool.query(`DELETE FROM contract_version WHERE id = $1`, [contractVersionId]);
  await pool.query(`DELETE FROM contract WHERE id = $1`, [contractId]);
  await pool.query(`DELETE FROM source_document WHERE id = $1`, [sourceDocumentId]);
  await pool.query(`DELETE FROM membership WHERE user_id = $1 AND client_id = $2`, [userId, clientId]);
  await pool.query(`DELETE FROM app_user WHERE id = $1`, [userId]);
  await pool.query(`DELETE FROM client WHERE id = $1`, [clientId]);
  await pool.end();
});

test('AC1: an uploaded contract exists as an unfinalized version with no verified snapshot yet', async () => {
  const versionRow = await pool.query<{ id: string; source_document_id: string }>(
    `SELECT id, source_document_id FROM contract_version WHERE id = $1`,
    [contractVersionId],
  );
  expect(versionRow.rows[0]).toBeDefined();
  expect(versionRow.rows[0]!.source_document_id).toBe(sourceDocumentId);

  const verified = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM verified_contract_version WHERE contract_version_id = $1`, [contractVersionId]);
  expect(verified.rows[0]!.n).toBe(0);
});

test('AC2: finalizing over real HTTP with the seeded extraction creates a real verified_contract_version row', async ({ request }) => {
  const finalize = await request.post(`/api/contract-versions/${contractVersionId}/finalize`, {
    headers: { 'x-client-id': clientId, 'x-user-id': userId, 'content-type': 'application/json' },
    data: { extraction_response_hash: extractionResponseHash },
  });
  expect(finalize.status()).toBe(201);
  const body = await finalize.json() as { id: string; verificationHash: string; fieldCount: number; created: boolean };
  expect(body.created).toBe(true);
  expect(body.fieldCount).toBe(1);
  expect(body.verificationHash).toMatch(/^[a-f0-9]{64}$/);

  const row = await pool.query<{ id: string; verification_hash: string }>(`SELECT id, verification_hash FROM verified_contract_version WHERE id = $1`, [body.id]);
  expect(row.rows[0]).toBeDefined();
  expect(row.rows[0]!.verification_hash).toBe(body.verificationHash);
});

test('AC3: re-finalizing after a field correction is rejected, not silently overwritten', async ({ request }) => {
  const before = await pool.query<{ verification_hash: string; resolved_fields: unknown }>(
    `SELECT verification_hash, resolved_fields FROM verified_contract_version WHERE contract_version_id = $1 AND extraction_response_hash = $2`,
    [contractVersionId, extractionResponseHash],
  );
  expect(before.rows[0]).toBeDefined();

  // A human correction to the same field, under the SAME extraction_response_hash
  // -- this changes finalize's resolved value for that field, which would
  // change the recomputed verificationHash if it were allowed through.
  const correctionHash = createHash('sha256').update(`${FIELD_PATH}:corrected:2.75`).digest('hex');
  await pool.query(
    `INSERT INTO extraction_field
       (client_id, source_document_id, field_path, ai_value, human_value, confidence, model_version, prompt_version,
        extraction_response_hash, extraction_schema_version, extraction_status, citations,
        correction_hash, correction_source, corrected_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      clientId, sourceDocumentId, FIELD_PATH,
      JSON.stringify({ status: 'FOUND', rawText: '$2.50 per mile', normalizedValue: '2.50' }),
      JSON.stringify({ status: 'FOUND', rawText: '$2.75 per mile', normalizedValue: '2.75' }),
      0.95, 'claude-opus-5', 'contract-extraction-v1',
      extractionResponseHash, CONTRACT_EXTRACTION_SCHEMA_VERSION, 'FOUND', JSON.stringify([]),
      correctionHash, 'carrier_confirmed', userId,
    ],
  );

  const refinalize = await request.post(`/api/contract-versions/${contractVersionId}/finalize`, {
    headers: { 'x-client-id': clientId, 'x-user-id': userId, 'content-type': 'application/json' },
    data: { extraction_response_hash: extractionResponseHash },
  });
  expect(refinalize.status()).toBe(409);

  const after = await pool.query<{ verification_hash: string; resolved_fields: unknown }>(
    `SELECT verification_hash, resolved_fields FROM verified_contract_version WHERE contract_version_id = $1 AND extraction_response_hash = $2`,
    [contractVersionId, extractionResponseHash],
  );
  expect(after.rows[0]!.verification_hash).toBe(before.rows[0]!.verification_hash);
  expect(after.rows[0]!.resolved_fields).toEqual(before.rows[0]!.resolved_fields);
});
