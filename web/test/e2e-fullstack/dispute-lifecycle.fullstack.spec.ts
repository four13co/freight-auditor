import { test, expect } from '@playwright/test';
import pg from 'pg';
import { withTenantTx } from '../../../src/db/tenant-context.js';
import { seedCriteria } from '../../../scripts/seed-criteria.mjs';
import { createDisputeFromFindings } from '../../../src/modules/disputes/create-dispute-from-findings.js';

// 86e33qzm3: full-stack e2e for the carrier-dispute lifecycle
// (dispute-review-routes.ts) -- real Fastify server + real Postgres, real
// HTTP for every step that has a real route, no route mocking, no browser
// (DisputeReview.tsx is unmounted anywhere in the app -- confirmed via grep
// against App.tsx/Dashboard.tsx per this task's own reshape note -- so
// there is genuinely no UI surface to drive for any part of this flow).
//
// Scope-honesty correction on AC1: its own text says a dispute is created
// "via real HTTP." createDisputeFromFindings has NO route anywhere in
// src/server (confirmed via grep across src/server/*.ts) -- the only
// existing caller is test/db/create-dispute-from-findings.db.test.ts. This
// spec calls it in-process instead, the same "seed the non-HTTP
// precondition directly, drive the real transition over real HTTP" pattern
// P7.A.3/P7.A.4/P7.C.1's own reshape note already established -- creation
// itself is fully real (real DB writes, real business logic, no mocking),
// just not reachable over HTTP today.
//
// Seeds its OWN client/app_user/membership rather than reusing the shared
// DEV_CLIENT_ID/DEV_USER_ID fixture (round 89/round 94 precedent):
// createDisputeFromFindings validates clientId with zod's strict z.uuid(),
// which DEV_CLIENT_ID ('11111111-...') fails. Since this task has no real
// browser session pinning it to any particular tenant (no UI surface
// exists), a disposable tenant with DB-generated (gen_random_uuid()) ids
// sidesteps the issue entirely -- unlike 86e33qzkq (P7.C.1), which bounced
// on this exact bug because its AC2 required the real browser, hardcoded
// to DEV_CLIENT_ID.
//
// approve-for-delivery (POST /api/disputes/:id/approve) IS exercised here
// even though no AC names it directly -- it's the only real way to move a
// dispute from draft to a respondable state (sent), which AC3's
// accept/partial-accept both require. If DisputeReview.tsx is ever wired
// into the app, this step should be re-shaped to drive it through the real
// browser instead (per this task's own Rabbit-holes note).

let pool: pg.Pool;
let clientId: string;
let userId: string;
let carrierId: string;
let acceptDisputeId: string;
let partialDisputeId: string;
let acceptAuditRunId: string;
let acceptInvoiceId: string;
let partialAuditRunId: string;
let partialInvoiceId: string;
let acceptFindingId: string;
let partialFindingId: string;

const HEADERS = () => ({ 'x-client-id': clientId, 'x-user-id': userId, 'content-type': 'application/json' });

async function seedFinding(client: pg.PoolClient, invoiceId: string, auditRunId: string): Promise<string> {
  const vf = await client.query<{ id: string }>(
    `INSERT INTO variance_finding
       (client_id, audit_run_id, criterion_id, rule_version_id, direction, variance_amount, currency, status, evaluated_expr)
     SELECT $1, $2, c.id, rv.id, 'OVERCHARGE', '100.0000', 'USD', 'accepted', '{}'::jsonb
     FROM criterion c JOIN rule r ON r.slug = 'contract-rate_variance'
     JOIN rule_version rv ON rv.rule_id = r.id
     WHERE c.criterion_key = 'CONTRACT.RATE_VARIANCE' ORDER BY rv.recorded_at DESC LIMIT 1 RETURNING id`,
    [clientId, auditRunId],
  );
  return vf.rows[0]!.id;
}

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await seedCriteria({ client: pool });

  const clientRow = await pool.query<{ id: string }>(
    `INSERT INTO client (name, slug) VALUES ('E2E Dispute Lifecycle Fixture Client', $1) RETURNING id`,
    [`e2e-dispute-lifecycle-${Date.now()}`],
  );
  clientId = clientRow.rows[0]!.id;
  const userRow = await pool.query<{ id: string }>(
    `INSERT INTO app_user (email, full_name) VALUES ($1, 'E2E Dispute Lifecycle Fixture User') RETURNING id`,
    [`e2e-dispute-lifecycle-${Date.now()}@example.test`],
  );
  userId = userRow.rows[0]!.id;
  await pool.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_admin')`, [userId, clientId]);

  const carrier = await pool.query<{ id: string }>(
    `INSERT INTO carrier (name) VALUES ($1) RETURNING id`,
    [`E2E Dispute Lifecycle Carrier ${Date.now()}`],
  );
  carrierId = carrier.rows[0]!.id;

  await withTenantTx({ clientIds: [clientId], internal: true }, async (client) => {
    const acceptInvoice = await client.query<{ id: string }>(
      `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
       VALUES ($1, $2, '210', $3, 'USD', 'test') RETURNING id`,
      [clientId, carrierId, `INV-DISP-ACCEPT-${Date.now()}`],
    );
    acceptInvoiceId = acceptInvoice.rows[0]!.id;
    const acceptRun = await client.query<{ id: string }>(
      `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
      [clientId, acceptInvoiceId],
    );
    acceptAuditRunId = acceptRun.rows[0]!.id;
    acceptFindingId = await seedFinding(client, acceptInvoiceId, acceptAuditRunId);

    const partialInvoice = await client.query<{ id: string }>(
      `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
       VALUES ($1, $2, '210', $3, 'USD', 'test') RETURNING id`,
      [clientId, carrierId, `INV-DISP-PARTIAL-${Date.now()}`],
    );
    partialInvoiceId = partialInvoice.rows[0]!.id;
    const partialRun = await client.query<{ id: string }>(
      `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
      [clientId, partialInvoiceId],
    );
    partialAuditRunId = partialRun.rows[0]!.id;
    partialFindingId = await seedFinding(client, partialInvoiceId, partialAuditRunId);

    const acceptDispute = await createDisputeFromFindings(client, { clientId, findingIds: [acceptFindingId], actorUserId: userId });
    acceptDisputeId = acceptDispute.disputeId;
    const partialDispute = await createDisputeFromFindings(client, { clientId, findingIds: [partialFindingId], actorUserId: userId });
    partialDisputeId = partialDispute.disputeId;
  });
});

test.afterAll(async () => {
  await pool.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
  await pool.query(`DELETE FROM finding_status_event WHERE client_id = $1`, [clientId]);
  await pool.query(`DELETE FROM dispute_comm WHERE client_id = $1`, [clientId]);
  await pool.query(`DELETE FROM dispute_line WHERE client_id = $1`, [clientId]);
  await pool.query(`DELETE FROM dispute WHERE client_id = $1`, [clientId]);
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

test('AC1: a created dispute is visible over real HTTP in an open (draft) state', async ({ request }) => {
  const detail = await request.get(`/api/disputes/${acceptDisputeId}`, { headers: HEADERS() });
  expect(detail.status()).toBe(200);
  const body = await detail.json() as { id: string; status: string; lines: unknown[] };
  expect(body.status).toBe('draft');
  expect(body.lines).toHaveLength(1);
});

test('AC1b: approving for delivery moves the dispute to sent (real HTTP; no UI mount exists for this step)', async ({ request }) => {
  for (const disputeId of [acceptDisputeId, partialDisputeId]) {
    const approve = await request.post(`/api/disputes/${disputeId}/approve`, { headers: HEADERS(), data: {} });
    expect(approve.status()).toBe(200);
    const body = await approve.json() as { disputeId: string; status: string };
    expect(body.status).toBe('sent');
  }
});

test('AC2: an inbound communication posted over real HTTP appears via the real GET, in order', async ({ request }) => {
  const first = await request.post(`/api/disputes/${acceptDisputeId}/communications`, {
    headers: HEADERS(),
    data: { body: 'Carrier: please review the attached rate sheet.' },
  });
  expect(first.status()).toBe(201);

  const second = await request.post(`/api/disputes/${acceptDisputeId}/communications`, {
    headers: HEADERS(),
    data: { body: 'Analyst: rate sheet confirms the contracted linehaul rate.' },
  });
  expect(second.status()).toBe(201);

  const list = await request.get(`/api/disputes/${acceptDisputeId}/communications`, { headers: HEADERS() });
  expect(list.status()).toBe(200);
  const { communications } = await list.json() as { communications: { body: string; direction: string }[] };
  expect(communications).toHaveLength(2);
  // listDisputeCommunications orders newest-first (ORDER BY recorded_at DESC).
  expect(communications[0]!.body).toBe('Analyst: rate sheet confirms the contracted linehaul rate.');
  expect(communications[1]!.body).toBe('Carrier: please review the attached rate sheet.');
  expect(communications.every((c) => c.direction === 'inbound')).toBe(true);
});

test('AC3a: accepting a sent dispute over real HTTP records status accepted', async ({ request }) => {
  const accept = await request.post(`/api/disputes/${acceptDisputeId}/accept`, { headers: HEADERS(), data: {} });
  expect(accept.status()).toBe(200);
  const body = await accept.json() as { disputeId: string; status: string };
  expect(body.status).toBe('accepted');

  const row = await pool.query<{ status: string }>(`SELECT status FROM dispute WHERE id = $1`, [acceptDisputeId]);
  expect(row.rows[0]!.status).toBe('accepted');
});

test('AC3b: partially accepting a sent dispute over real HTTP records status partial with the accepted amount', async ({ request }) => {
  const partial = await request.post(`/api/disputes/${partialDisputeId}/partial-accept`, {
    headers: HEADERS(),
    data: { acceptedAmount: '40.0000' },
  });
  expect(partial.status()).toBe(200);
  const body = await partial.json() as { disputeId: string; status: string };
  expect(body.status).toBe('partial');

  const row = await pool.query<{ status: string; accepted_amount: string }>(
    `SELECT status, accepted_amount FROM dispute WHERE id = $1`,
    [partialDisputeId],
  );
  expect(row.rows[0]!.status).toBe('partial');
  expect(row.rows[0]!.accepted_amount).toBe('40.0000');
});

test('AC4: closing a resolved dispute over real HTTP marks it closed, and a subsequent close/accept call is rejected', async ({ request }) => {
  const close = await request.post(`/api/disputes/${acceptDisputeId}/close`, { headers: HEADERS(), data: {} });
  expect(close.status()).toBe(200);
  const body = await close.json() as { disputeId: string; status: string };
  expect(body.status).toBe('closed');

  const row = await pool.query<{ status: string }>(`SELECT status FROM dispute WHERE id = $1`, [acceptDisputeId]);
  expect(row.rows[0]!.status).toBe('closed');

  const secondClose = await request.post(`/api/disputes/${acceptDisputeId}/close`, { headers: HEADERS(), data: {} });
  expect(secondClose.status()).toBe(409);
  const closeError = await secondClose.json() as { error: string };
  expect(closeError.error).toContain('not currently in a resolved');

  const acceptAgain = await request.post(`/api/disputes/${acceptDisputeId}/accept`, { headers: HEADERS(), data: {} });
  expect(acceptAgain.status()).toBe(409);
  const acceptError = await acceptAgain.json() as { error: string };
  expect(acceptError.error).toContain('not currently awaiting a carrier response');
});
