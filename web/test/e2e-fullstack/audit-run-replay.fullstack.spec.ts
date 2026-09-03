import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DEV_CLIENT_ID, DEV_USER_ID } from '../../../scripts/seed-dev-tenant.mjs';
import { FIXTURE_CARRIER_NAME } from '../../../scripts/seed-fullstack-e2e-fixture.mjs';

// 86e33qywt: full-stack e2e for audit-run replay (POST /api/audit-runs/:id/replay)
// -- real Fastify server + real Postgres, real HTTP round-trip via
// Playwright's `request` fixture (not app.inject, unlike
// test/db/audit-runs-endpoint.db.test.ts's existing coverage of the same
// guarantee). No dedicated replay UI exists anywhere in web/src (confirmed
// via grep), and replay produces no rendered effect to verify even if one
// did -- it re-evaluates the pinned manifest in-memory and writes exactly
// one audit_event linked to the ORIGINAL audit_run_id; no second run, no
// scorecard/finding mutation (src/modules/audit-ledger/replay-audit-run.ts:39-86).
// Same "no dedicated UI, drive the endpoint directly" precedent
// audit-run-creation.fullstack.spec.ts (P7.A.1) already established.

const REPLAY_INVOICE_NUMBER = 'INV-P7A2-001';

const EDI_210 =
  'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260703*1200*U*00401*000000030*0*P*>~' +
  'GS*IM*SENDER*RECEIVER*20260703*1200*30*X*004010~' +
  'ST*210*0030~' +
  `B3**${REPLAY_INVOICE_NUMBER}*SHIP-P7A2-001****1250.00****ABCD~` +
  'L1*1***1000.00****400****Linehaul~' +
  'L1*2***250.00****405****Fuel Surcharge~' +
  'SE*5*0030~';

let pool: pg.Pool;
let auditRunId: string;
let invoiceId: string;

test.beforeAll(async ({ request }) => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  const contractVersion = await pool.query<{ id: string }>(
    `SELECT cv.id FROM contract_version cv
     JOIN contract c ON c.id = cv.contract_id
     JOIN carrier ca ON ca.id = c.carrier_id
     WHERE ca.name = $1 AND cv.client_id = $2
     ORDER BY cv.id LIMIT 1`,
    [FIXTURE_CARRIER_NAME, DEV_CLIENT_ID],
  );
  if (!contractVersion.rows[0]) {
    throw new Error(
      `audit-run-replay.fullstack.spec: no contract_version found for carrier "${FIXTURE_CARRIER_NAME}" / ` +
        `client ${DEV_CLIENT_ID} -- has 'npm run seed:e2e-fullstack-fixture' been run against this database?`,
    );
  }

  const post = await request.post(`/api/audit-runs?contract_version_id=${contractVersion.rows[0].id}`, {
    headers: { 'x-client-id': DEV_CLIENT_ID, 'x-user-id': DEV_USER_ID, 'content-type': 'application/edi-x12' },
    data: EDI_210,
  });
  if (post.status() !== 201) {
    throw new Error(`audit-run-replay.fullstack.spec: seed audit-run POST failed with ${post.status()}`);
  }
  const body = await post.json() as { id: string; outcome: string };
  if (body.outcome !== 'SCORED') {
    throw new Error(`audit-run-replay.fullstack.spec: expected SCORED, got ${body.outcome}`);
  }
  auditRunId = body.id;

  const invoiceRow = await pool.query<{ invoice_id: string }>(`SELECT invoice_id FROM audit_run WHERE id = $1`, [auditRunId]);
  invoiceId = invoiceRow.rows[0]!.invoice_id;

  const manifest = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_replay_manifest WHERE audit_run_id = $1`, [auditRunId]);
  if (manifest.rows[0]!.n === 0) {
    throw new Error(`audit-run-replay.fullstack.spec: no audit_replay_manifest was written for ${auditRunId}`);
  }
});

test.afterAll(async () => {
  const sourceDocument = await pool.query<{ source_document_id: string | null }>(
    `SELECT source_document_id FROM charge_finding WHERE audit_run_id = $1 AND source_document_id IS NOT NULL LIMIT 1`,
    [auditRunId],
  );
  await pool.query(`DELETE FROM audit_event WHERE client_id = $1 AND entity_id = $2`, [DEV_CLIENT_ID, auditRunId]);
  await pool.query(`DELETE FROM scorecard WHERE audit_run_id = $1`, [auditRunId]);
  await pool.query(`DELETE FROM charge_finding WHERE audit_run_id = $1`, [auditRunId]);
  await pool.query(`DELETE FROM gate_failure WHERE audit_run_id = $1`, [auditRunId]);
  await pool.query(`DELETE FROM variance_finding WHERE audit_run_id = $1`, [auditRunId]);
  await pool.query(`DELETE FROM charge_fact WHERE invoice_id = $1`, [invoiceId]);
  await pool.query(`DELETE FROM audit_replay_manifest WHERE audit_run_id = $1`, [auditRunId]);
  await pool.query(`DELETE FROM audit_run WHERE id = $1`, [auditRunId]);
  await pool.query(`DELETE FROM invoice WHERE id = $1`, [invoiceId]);
  if (sourceDocument.rows[0]?.source_document_id) {
    await pool.query(`DELETE FROM source_document WHERE id = $1`, [sourceDocument.rows[0].source_document_id]);
  }
  await pool.end();
});

test('AC1: replaying a completed run over real HTTP reports byte-identical, matching results', async ({ request }) => {
  const replay = await request.post(`/api/audit-runs/${auditRunId}/replay`, {
    headers: { 'x-client-id': DEV_CLIENT_ID, 'x-user-id': DEV_USER_ID },
  });
  expect(replay.status()).toBe(200);
  const body = await replay.json() as {
    auditRunId: string; manifestHash: string; originalResultHash: string; resultHash: string;
    byteIdentical: boolean; matchesOriginal: boolean;
  };
  expect(body.auditRunId).toBe(auditRunId);
  expect(body.byteIdentical).toBe(true);
  expect(body.matchesOriginal).toBe(true);
  expect(body.resultHash).toBe(body.originalResultHash);
  expect(body.manifestHash).toMatch(/^[a-f0-9]{64}$/);
});

test('AC2: replay is recorded as one audit_event linked to the ORIGINAL audit_run_id, not a second run', async ({ request }) => {
  const before = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_run WHERE client_id = $1`, [DEV_CLIENT_ID]);

  const replay = await request.post(`/api/audit-runs/${auditRunId}/replay`, {
    headers: { 'x-client-id': DEV_CLIENT_ID, 'x-user-id': DEV_USER_ID },
  });
  expect(replay.status()).toBe(200);

  const after = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_run WHERE client_id = $1`, [DEV_CLIENT_ID]);
  expect(after.rows[0]!.n).toBe(before.rows[0]!.n);

  const ledger = await pool.query<{ event: string; entity_id: string }>(
    `SELECT event, entity_id FROM audit_event WHERE client_id = $1 AND entity_id = $2 ORDER BY recorded_at`,
    [DEV_CLIENT_ID, auditRunId],
  );
  expect(ledger.rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ event: 'ingestion.audit_created', entity_id: auditRunId }),
    expect.objectContaining({ event: 'replay.executed', entity_id: auditRunId }),
  ]));
});
