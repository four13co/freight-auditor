import { test, expect } from '@playwright/test';
import pg from 'pg';
import { withTenantTx } from '../../../src/db/tenant-context.js';
import { seedCriteria } from '../../../scripts/seed-criteria.mjs';
import { createDisputeFromFindings } from '../../../src/modules/disputes/create-dispute-from-findings.js';
import { approveDispute } from '../../../src/modules/disputes/approve-dispute.js';
import { acceptDispute } from '../../../src/modules/disputes/resolve-dispute.js';

// 86e33qzmb: full-stack e2e for claim creation from a resolved dispute
// (claim-routes.ts) and its list/detail read APIs (claim-recovery-routes.ts)
// -- real Fastify server + real Postgres, real HTTP, no route mocking. No
// browser interaction: this task's own Solution/ACs are entirely
// HTTP-level (POST /api/disputes/:id/claim, GET /api/claims,
// GET /api/claims/:id) -- no UI component is named or required.
//
// Per this task's own Rabbit-holes note, the resolved dispute is seeded
// directly in this spec's own beforeAll rather than depending on P7.C.2's
// spec having run first -- these must be independently runnable.
// createClaimFromDispute requires dispute.status = 'accepted' (see
// validate-claimable-dispute.ts), so the dispute is driven through the
// real create -> approve -> accept lifecycle (same real modules/routes
// P7.C.2 already covers) to reach that state, rather than a raw status
// backdoor.
//
// Seeds its OWN client/app_user/membership (same round-89/round-94
// precedent as P7.C.2): createDisputeFromFindings and
// createClaimFromDispute both validate clientId with zod's strict
// z.uuid(), which the shared DEV_CLIENT_ID fixture fails. No UI surface
// exists for this flow either, so there is no real-browser session to pin
// to any particular tenant -- a disposable tenant sidesteps the issue
// entirely, same as P7.C.2.

let pool: pg.Pool;
let clientId: string;
let userId: string;
let carrierId: string;
let disputeId: string;
let claimId: string;
let auditRunId: string;
let invoiceId: string;

const HEADERS = () => ({ 'x-client-id': clientId, 'x-user-id': userId, 'content-type': 'application/json' });

test.beforeAll(async ({ request }) => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await seedCriteria({ client: pool });

  const clientRow = await pool.query<{ id: string }>(
    `INSERT INTO client (name, slug) VALUES ('E2E Claim Creation Fixture Client', $1) RETURNING id`,
    [`e2e-claim-creation-${Date.now()}`],
  );
  clientId = clientRow.rows[0]!.id;
  const userRow = await pool.query<{ id: string }>(
    `INSERT INTO app_user (email, full_name) VALUES ($1, 'E2E Claim Creation Fixture User') RETURNING id`,
    [`e2e-claim-creation-${Date.now()}@example.test`],
  );
  userId = userRow.rows[0]!.id;
  await pool.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_admin')`, [userId, clientId]);

  const carrier = await pool.query<{ id: string }>(
    `INSERT INTO carrier (name) VALUES ($1) RETURNING id`,
    [`E2E Claim Creation Carrier ${Date.now()}`],
  );
  carrierId = carrier.rows[0]!.id;

  await withTenantTx({ clientIds: [clientId], internal: true }, async (client) => {
    const invoice = await client.query<{ id: string }>(
      `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
       VALUES ($1, $2, '210', $3, 'USD', 'test') RETURNING id`,
      [clientId, carrierId, `INV-CLAIM-${Date.now()}`],
    );
    invoiceId = invoice.rows[0]!.id;
    const run = await client.query<{ id: string }>(
      `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
      [clientId, invoiceId],
    );
    auditRunId = run.rows[0]!.id;
    const vf = await client.query<{ id: string }>(
      `INSERT INTO variance_finding
         (client_id, audit_run_id, criterion_id, rule_version_id, direction, variance_amount, currency, status, evaluated_expr)
       SELECT $1, $2, c.id, rv.id, 'OVERCHARGE', '250.0000', 'USD', 'accepted', '{}'::jsonb
       FROM criterion c JOIN rule r ON r.slug = 'contract-rate_variance'
       JOIN rule_version rv ON rv.rule_id = r.id
       WHERE c.criterion_key = 'CONTRACT.RATE_VARIANCE' ORDER BY rv.recorded_at DESC LIMIT 1 RETURNING id`,
      [clientId, auditRunId],
    );
    const findingId = vf.rows[0]!.id;

    const dispute = await createDisputeFromFindings(client, { clientId, findingIds: [findingId], actorUserId: userId });
    disputeId = dispute.disputeId;
    await approveDispute(client, disputeId, userId);
    await acceptDispute(client, disputeId, userId);
  });

  const claimResponse = await request.post(`/api/disputes/${disputeId}/claim`, { headers: HEADERS(), data: {} });
  if (claimResponse.status() !== 201) {
    throw new Error(`claim-creation-and-view.fullstack.spec: claim creation POST failed with ${claimResponse.status()}`);
  }
  const claimBody = await claimResponse.json() as { claimId: string };
  claimId = claimBody.claimId;
});

test.afterAll(async () => {
  await pool.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
  await pool.query(`DELETE FROM recovery_event WHERE client_id = $1`, [clientId]);
  await pool.query(`DELETE FROM claim WHERE client_id = $1`, [clientId]);
  await pool.query(`DELETE FROM dispute_line WHERE client_id = $1`, [clientId]);
  await pool.query(`DELETE FROM dispute WHERE client_id = $1`, [clientId]);
  await pool.query(`DELETE FROM finding_status_event WHERE client_id = $1`, [clientId]);
  await pool.query(`DELETE FROM variance_finding WHERE client_id = $1`, [clientId]);
  await pool.query(`DELETE FROM workflow_command WHERE client_id = $1`, [clientId]);
  await pool.query(`DELETE FROM workflow_instance WHERE client_id = $1`, [clientId]);
  await pool.query(`DELETE FROM audit_run WHERE client_id = $1`, [clientId]);
  await pool.query(`DELETE FROM invoice WHERE client_id = $1`, [clientId]);
  await pool.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
  await pool.query(`DELETE FROM membership WHERE user_id = $1 AND client_id = $2`, [userId, clientId]);
  await pool.query(`DELETE FROM app_user WHERE id = $1`, [userId]);
  await pool.query(`DELETE FROM client WHERE id = $1`, [clientId]);
  await pool.end();
});

test('AC1: a created claim appears in GET /api/claims with correct linkage back to the originating dispute', async ({ request }) => {
  const list = await request.get('/api/claims', { headers: HEADERS() });
  expect(list.status()).toBe(200);
  const { claims } = await list.json() as { claims: { id: string; disputeId: string; amountClaimed: string; currency: string; status: string }[] };
  const row = claims.find((c) => c.id === claimId);
  expect(row).toBeDefined();
  expect(row!.disputeId).toBe(disputeId);
  expect(row!.amountClaimed).toBe('250.0000');
  expect(row!.currency).toBe('USD');
  expect(row!.status).toBe('open');
});

test('AC2: the claim detail view shows data consistent with the list row, no mismatch', async ({ request }) => {
  const list = await request.get('/api/claims', { headers: HEADERS() });
  const { claims } = await list.json() as { claims: { id: string; disputeId: string; amountClaimed: string; currency: string; status: string; openedAt: string }[] };
  const listRow = claims.find((c) => c.id === claimId)!;

  const detailResponse = await request.get(`/api/claims/${claimId}`, { headers: HEADERS() });
  expect(detailResponse.status()).toBe(200);
  const detail = await detailResponse.json() as {
    id: string; disputeId: string; amountClaimed: string; currency: string; status: string; openedAt: string; cumulativeRecovered: string;
  };

  expect(detail.id).toBe(listRow.id);
  expect(detail.disputeId).toBe(listRow.disputeId);
  expect(detail.amountClaimed).toBe(listRow.amountClaimed);
  expect(detail.currency).toBe(listRow.currency);
  expect(detail.status).toBe(listRow.status);
  expect(detail.openedAt).toBe(listRow.openedAt);
  expect(detail.cumulativeRecovered).toBe('0.0000');
});
