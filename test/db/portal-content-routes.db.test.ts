import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { buildApp } from '../../src/server/app.js';
import { listClientInvoices } from '../../src/modules/portal/list-client-invoices.js';
import { getClientAuditRunScorecard } from '../../src/modules/portal/get-client-audit-run-scorecard.js';
import { listClientFindings } from '../../src/modules/portal/list-client-findings.js';
import { getClientDisputeDetail } from '../../src/modules/portal/get-client-dispute-detail.js';
import { listClientDisputeCommunications } from '../../src/modules/portal/list-client-dispute-communications.js';
import { getClaimDetail } from '../../src/modules/claims/get-claim-detail.js';
import { listClientClaimDocuments } from '../../src/modules/portal/list-client-claim-documents.js';
import { listClientAuditEvents } from '../../src/modules/portal/list-client-audit-events.js';

/**
 * P6.B.1: GET /api/portal/invoices and GET /api/portal/scorecard/:auditRunId,
 * exercised at the HTTP layer under a real client_viewer membership. Uses
 * the dev-header identity source (DEV_AUTH_HEADERS=1), same pattern as
 * claim-recovery-endpoint.db.test.ts / client-viewer-auth.db.test.ts.
 *
 * P6.B.2 (findings list + evidence) and P6.B.3 (dispute detail +
 * communications) are seeded into this SAME describe block/fixture rather
 * than a separate one -- both reuse the same
 * clientId/viewerUserId/adminUserId/otherClientId tenancy setup.
 * P6.B.2's variance_finding follows a real FK chain (criterion -> rule ->
 * rule_version, charge_fact, expected_charge), same seeding pattern as
 * build-evidence-packet.db.test.ts's seedDisputeWithFinding helper. P6.B.3's
 * dispute/dispute_comm rows follow dispute-review.db.test.ts's/
 * dispute-comm.db.test.ts's own seeding patterns.
 */
describe('client portal content APIs (DB, e2e)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let clientId: string;
  let viewerUserId: string;
  let adminUserId: string;
  let carrierId: string;
  let invoiceId: string;
  let auditRunId: string;
  let unscoredAuditRunId: string;
  let otherClientId: string;
  let otherAuditRunId: string;
  let otherInvoiceId: string;
  let findingId: string;
  let otherFindingId: string;
  let disputeId: string;
  let otherDisputeId: string;
  let originalFlag: string | undefined;
  const tag = `pcr-${Date.now()}`;

  beforeAll(async () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('PCR', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const uViewer = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-viewer@example.com`]);
      viewerUserId = uViewer.rows[0].id;
      const uAdmin = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-admin@example.com`]);
      adminUserId = uAdmin.rows[0].id;
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer')`, [viewerUserId, clientId]);
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_admin')`, [adminUserId, clientId]);
      const carrier = await owner.query(`INSERT INTO carrier (name) VALUES ('Acme Freight') RETURNING id`);
      carrierId = carrier.rows[0].id;

      const other = await owner.query(`INSERT INTO client (name, slug) VALUES ('PCR-Other', $1) RETURNING id`, [`${tag}-other`]);
      otherClientId = other.rows[0].id;

      await withTenantTx({ clientIds: [clientId, otherClientId], internal: true }, async (c2) => {
        const invoice = await c2.query(
          `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version, status)
           VALUES ($1, $2, '210', 'INV-1', 'USD', 'v1', 'ingested') RETURNING id`,
          [clientId, carrierId],
        );
        invoiceId = invoice.rows[0].id;

        // created_at is explicit (rather than the column default) because
        // `now()` is transaction-stable in Postgres -- both audit_run inserts
        // below run inside this same withTenantTx transaction, so the
        // default would give them IDENTICAL timestamps and make "the LATERAL
        // join picks the newest run" test below non-deterministic.
        const run = await c2.query(
          `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome, created_at)
           VALUES ($1, $2, 'v1', 'SCORED', now() - interval '1 hour') RETURNING id`,
          [clientId, invoiceId],
        );
        auditRunId = run.rows[0].id;
        await c2.query(
          `INSERT INTO scorecard (client_id, audit_run_id, conformed_count, variance_count, unassessable_count, total_overcharge, total_undercharge, currency)
           VALUES ($1, $2, 8, 2, 0, '150.0000', '10.0000', 'USD')`,
          [clientId, auditRunId],
        );

        // A second, later audit_run on the SAME invoice with no scorecard row
        // (REJECTED_REWORK never produces one) -- proves listClientInvoices' LATERAL
        // join picks the newest run (this one, not the SCORED run above), and
        // proves the scorecard route's "no data yet" (empty) case.
        const unscoredRun = await c2.query(
          `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'v1', 'REJECTED_REWORK') RETURNING id`,
          [clientId, invoiceId],
        );
        unscoredAuditRunId = unscoredRun.rows[0].id;

        const otherInvoice = await c2.query(
          `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version, status)
           VALUES ($1, $2, '210', 'INV-OTHER', 'USD', 'v1', 'ingested') RETURNING id`,
          [otherClientId, carrierId],
        );
        otherInvoiceId = otherInvoice.rows[0].id;
        const otherRun = await c2.query(
          `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'v1', 'SCORED') RETURNING id`,
          [otherClientId, otherInvoiceId],
        );
        otherAuditRunId = otherRun.rows[0].id;

        // P6.B.2: one real variance_finding per client, following the same
        // criterion -> rule -> rule_version FK chain as
        // build-evidence-packet.db.test.ts's seedDisputeWithFinding helper.
        const cf = await c2.query(
          `INSERT INTO charge_fact (client_id, invoice_id, code, category, amount, currency)
           VALUES ($1, $2, '400', 'LINEHAUL', '1000.0000', 'USD') RETURNING id`,
          [clientId, invoiceId],
        );
        const chargeFactId = cf.rows[0].id;
        await c2.query(
          `INSERT INTO expected_charge (client_id, audit_run_id, charge_fact_id, category, expected_amount, currency)
           VALUES ($1, $2, $3, 'LINEHAUL', '900.0000', 'USD')`,
          [clientId, auditRunId, chargeFactId],
        );
        const vf = await c2.query<{ id: string }>(
          `INSERT INTO variance_finding
             (client_id, audit_run_id, charge_fact_id, criterion_id, rule_version_id, direction, variance_amount, currency, status, evaluated_expr)
           SELECT $1, $2, $3, c.id, rv.id, 'OVERCHARGE', '100.0000', 'USD', 'open', '{}'::jsonb
           FROM criterion c JOIN rule r ON r.slug = 'contract-rate_variance'
           JOIN rule_version rv ON rv.rule_id = r.id
           WHERE c.criterion_key = 'CONTRACT.RATE_VARIANCE' ORDER BY rv.recorded_at DESC LIMIT 1 RETURNING id`,
          [clientId, auditRunId, chargeFactId],
        );
        findingId = vf.rows[0]!.id;

        const otherCf = await c2.query(
          `INSERT INTO charge_fact (client_id, invoice_id, code, category, amount, currency)
           VALUES ($1, $2, '400', 'LINEHAUL', '500.0000', 'USD') RETURNING id`,
          [otherClientId, otherInvoiceId],
        );
        const otherVf = await c2.query<{ id: string }>(
          `INSERT INTO variance_finding
             (client_id, audit_run_id, charge_fact_id, criterion_id, rule_version_id, direction, variance_amount, currency, status, evaluated_expr)
           SELECT $1, $2, $3, c.id, rv.id, 'OVERCHARGE', '50.0000', 'USD', 'open', '{}'::jsonb
           FROM criterion c JOIN rule r ON r.slug = 'contract-rate_variance'
           JOIN rule_version rv ON rv.rule_id = r.id
           WHERE c.criterion_key = 'CONTRACT.RATE_VARIANCE' ORDER BY rv.recorded_at DESC LIMIT 1 RETURNING id`,
          [otherClientId, otherAuditRunId, otherCf.rows[0].id],
        );
        otherFindingId = otherVf.rows[0]!.id;

        // P6.B.3: one real dispute + communication per client.
        const dispute = await c2.query<{ id: string }>(
          `INSERT INTO dispute (client_id, carrier_id, status, amount_claimed, currency)
           VALUES ($1, $2, 'draft', '500.0000', 'USD') RETURNING id`,
          [clientId, carrierId],
        );
        disputeId = dispute.rows[0]!.id;
        await c2.query(
          `INSERT INTO dispute_line (client_id, dispute_id, amount, currency) VALUES ($1, $2, '500.0000', 'USD')`,
          [clientId, disputeId],
        );
        await c2.query(
          `INSERT INTO dispute_comm (client_id, dispute_id, direction, body, dedupe_key) VALUES ($1, $2, 'outbound', 'Delivery initiated.', $3)`,
          [clientId, disputeId, `${tag}-comm-1`],
        );

        const otherDispute = await c2.query<{ id: string }>(
          `INSERT INTO dispute (client_id, carrier_id, status, amount_claimed, currency)
           VALUES ($1, $2, 'draft', '250.0000', 'USD') RETURNING id`,
          [otherClientId, carrierId],
        );
        otherDisputeId = otherDispute.rows[0]!.id;
        await c2.query(
          `INSERT INTO dispute_comm (client_id, dispute_id, direction, body, dedupe_key) VALUES ($1, $2, 'outbound', 'Other client delivery.', $3)`,
          [otherClientId, otherDisputeId, `${tag}-comm-other`],
        );
      });
    } finally {
      owner.release();
    }
    app = buildApp();
  });

  afterAll(async () => {
    process.env.DEV_AUTH_HEADERS = originalFlag;
    await app.close();
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM dispute_comm WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM dispute_line WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM dispute WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM variance_finding WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM expected_charge WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM charge_fact WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM scorecard WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM audit_run WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM invoice WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM membership WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM app_user WHERE id = ANY($1)`, [[viewerUserId, adminUserId]]);
      await owner.query(`DELETE FROM client WHERE id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('lists invoices for the caller tenant, with the carrier name and newest audit_run id joined in', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/invoices', headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const row = body.invoices.find((i: { id: string }) => i.id === invoiceId);
    expect(row).toBeDefined();
    expect(row.carrierName).toBe('Acme Freight');
    // Two audit_runs exist on this invoice (SCORED then REJECTED_REWORK) -- the
    // LATERAL join must pick the newer one, not the first one created.
    expect(row.auditRunId).toBe(unscoredAuditRunId);
  });

  it('rejects an unauthenticated invoice list request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/portal/invoices' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a client_admin caller on the invoice list route -- sibling capability, out of this task\'s scope', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/invoices', headers: { 'x-client-id': clientId, 'x-user-id': adminUserId },
    });
    expect(res.statusCode).toBe(401);
  });

  it('has no POST/PUT/PATCH/DELETE route registered on the invoice list path at all -- no write surface exists to protect', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({
        method, url: '/api/portal/invoices', headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('rejects an out-of-range limit on the invoice list route', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/invoices?limit=9999', headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(400);
  });

  // AC2: scorecard for one of the caller's own audit runs.
  it('returns the scorecard for a specific audit run belonging to the caller tenant', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/portal/scorecard/${auditRunId}`, headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      auditRunId, invoiceId, invoiceNumber: 'INV-1', outcome: 'SCORED',
      conformedCount: 8, varianceCount: 2, unassessableCount: 0,
      totalOvercharge: '150.0000', totalUndercharge: '10.0000', currency: 'USD',
    });
  });

  // AC4 (scorecard-view half): an audit run that exists but never produced
  // a scorecard row (REJECTED_REWORK) renders as "no data yet", not a 404 --
  // the run itself is real and belongs to this tenant.
  it('returns null scorecard fields for an audit run with no scorecard row yet', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/portal/scorecard/${unscoredAuditRunId}`, headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.outcome).toBe('REJECTED_REWORK');
    expect(body.conformedCount).toBeNull();
  });

  // AC3: a scorecard request for an audit run belonging to a DIFFERENT
  // client is rejected/not-found -- the discriminator this task's own
  // reshape added over the prior (client-wide-summary) build.
  it('returns 404 for an audit run that belongs to a different client', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/portal/scorecard/${otherAuditRunId}`, headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a well-formed but nonexistent audit run id', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/scorecard/00000000-0000-4000-8000-000000000099',
      headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a malformed audit run id with 400', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/scorecard/not-a-uuid', headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unauthenticated scorecard request', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/portal/scorecard/${auditRunId}` });
    expect(res.statusCode).toBe(401);
  });

  // AC1 (findings list): only the caller's own findings are returned, RLS-scoped.
  it('lists findings for the caller tenant only, with invoice/carrier/rule detail joined in -- proving cross-tenant isolation', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/findings', headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const row = body.findings.find((f: { id: string }) => f.id === findingId);
    expect(row).toBeDefined();
    expect(row.carrierName).toBe('Acme Freight');
    expect(row.billed).toBe('1000.0000');
    expect(row.expected).toBe('900.0000');
    expect(row.varianceAmount).toBe('100.0000');
    expect(row.ruleDescription).toBeDefined();
    // The other client's finding must never appear in this caller's list.
    expect(body.findings.some((f: { id: string }) => f.id === otherFindingId)).toBe(false);
  });

  it('rejects an unauthenticated findings list request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/portal/findings' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a client_admin caller on the findings list route -- sibling capability, out of this task\'s scope', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/findings', headers: { 'x-client-id': clientId, 'x-user-id': adminUserId },
    });
    expect(res.statusCode).toBe(401);
  });

  it('has no POST/PUT/PATCH/DELETE route registered on the findings list or evidence paths -- no write surface exists to protect (No-gos: read-only)', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const listRes = await app.inject({
        method, url: '/api/portal/findings', headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
      });
      expect(listRes.statusCode).toBe(404);
      const evidenceRes = await app.inject({
        method, url: `/api/portal/findings/${findingId}/evidence`, headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
      });
      expect(evidenceRes.statusCode).toBe(404);
    }
  });

  it('rejects an out-of-range limit on the findings list route', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/findings?limit=9999', headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('filters the findings list by status', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/findings?status=open', headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().findings.some((f: { id: string }) => f.id === findingId)).toBe(true);
  });

  // AC2: the full defensibility chain (criterion, rule version, clause, rate
  // cell, source document, transport document) for one of the caller's own
  // findings.
  it('returns the full evidence/defensibility chain for a finding belonging to the caller tenant', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/portal/findings/${findingId}/evidence`, headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.finding.id).toBe(findingId);
    expect(body.criterion.key).toBe('CONTRACT.RATE_VARIANCE');
    expect(body.ruleVersion.id).toBeDefined();
    expect(body.contributors.billedChargeFactIds).toEqual([]);
  });

  // AC3: the evidence chain for a finding belonging to a DIFFERENT client is
  // rejected/not-found.
  it('returns 404 for evidence of a finding that belongs to a different client', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/portal/findings/${otherFindingId}/evidence`, headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a well-formed but nonexistent finding id', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/findings/00000000-0000-4000-8000-000000000099/evidence',
      headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a malformed finding id with 400', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/findings/not-a-uuid/evidence', headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unauthenticated evidence request', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/portal/findings/${findingId}/evidence` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a client_admin caller on the evidence route -- sibling capability, out of this task\'s scope', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/portal/findings/${findingId}/evidence`, headers: { 'x-client-id': clientId, 'x-user-id': adminUserId },
    });
    expect(res.statusCode).toBe(401);
  });

  // AC1 (dispute detail): only the caller's own dispute is returned, RLS-scoped.
  it('returns the dispute detail with its lines for the caller tenant', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/portal/disputes/${disputeId}`, headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(disputeId);
    expect(body.status).toBe('draft');
    expect(body.amountClaimed).toBe('500.0000');
    expect(body.lines).toHaveLength(1);
  });

  it('rejects an unauthenticated dispute request', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/portal/disputes/${disputeId}` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a client_admin caller on the dispute detail route -- sibling capability, out of this task\'s scope', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/portal/disputes/${disputeId}`, headers: { 'x-client-id': clientId, 'x-user-id': adminUserId },
    });
    expect(res.statusCode).toBe(401);
  });

  // AC3 (dispute half): a dispute belonging to a DIFFERENT client is rejected/not-found.
  it('returns 404 for a dispute that belongs to a different client', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/portal/disputes/${otherDisputeId}`, headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a well-formed but nonexistent dispute id', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/disputes/00000000-0000-4000-8000-000000000099',
      headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a malformed dispute id with 400', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/disputes/not-a-uuid', headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(400);
  });

  // AC2 (communications): newest-first log for one of the caller's own disputes.
  it('returns the communication log for the caller tenant, newest first', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/portal/disputes/${disputeId}/communications`, headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.communications).toHaveLength(1);
    expect(body.communications[0].body).toBe('Delivery initiated.');
  });

  // AC3 (communications half): communications for a dispute belonging to a
  // DIFFERENT client are rejected/not-found.
  it('returns 404 for communications of a dispute that belongs to a different client', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/portal/disputes/${otherDisputeId}/communications`, headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a malformed dispute id on the communications route with 400', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/disputes/not-a-uuid/communications', headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unauthenticated communications request', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/portal/disputes/${disputeId}/communications` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a client_admin caller on the communications route -- sibling capability, out of this task\'s scope', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/portal/disputes/${disputeId}/communications`, headers: { 'x-client-id': clientId, 'x-user-id': adminUserId },
    });
    expect(res.statusCode).toBe(401);
  });

  it('has no POST/PUT/PATCH/DELETE route registered on the dispute detail or communications paths -- no write surface exists to protect (No-gos: read-only)', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const detailRes = await app.inject({
        method, url: `/api/portal/disputes/${disputeId}`, headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
      });
      expect(detailRes.statusCode).toBe(404);
      const commsRes = await app.inject({
        method, url: `/api/portal/disputes/${disputeId}/communications`, headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
      });
      expect(commsRes.statusCode).toBe(404);
    }
  });
});

/**
 * Direct module coverage of the explicit client_id predicate on
 * listClientInvoices/getClientAuditRunScorecard, independent of RLS -- same
 * shape as claim-recovery-endpoint.db.test.ts's own "explicit predicate"
 * describe block (86e31a9ch/#216 precedent). An internal (cross-client)
 * scope grants RLS-level visibility across every client, so these tests
 * prove the explicit predicate -- not RLS -- is what rejects a mismatched
 * clientId.
 */
describe('portal content query modules: explicit client_id predicate (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let carrierId: string;
  let invoiceId: string;
  let auditRunId: string;
  let chargeFactId: string;
  let findingId: string;
  let disputeId: string;
  let claimId: string;
  const tag = `pcp-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('PCP-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const carrier = await owner.query(`INSERT INTO carrier (name) VALUES ('PCP Carrier') RETURNING id`);
      carrierId = carrier.rows[0].id;

      await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
        const invoice = await c.query(
          `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version, status)
           VALUES ($1, $2, '210', 'INV-A', 'USD', 'v1', 'ingested') RETURNING id`,
          [clientAId, carrierId],
        );
        invoiceId = invoice.rows[0].id;

        const run = await c.query(
          `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'v1', 'SCORED') RETURNING id`,
          [clientAId, invoiceId],
        );
        auditRunId = run.rows[0].id;
        await c.query(
          `INSERT INTO scorecard (client_id, audit_run_id, conformed_count, variance_count, unassessable_count, total_overcharge, total_undercharge, currency)
           VALUES ($1, $2, 4, 1, 0, '50.0000', '5.0000', 'USD')`,
          [clientAId, auditRunId],
        );

        const cf = await c.query(
          `INSERT INTO charge_fact (client_id, invoice_id, code, category, amount, currency)
           VALUES ($1, $2, '400', 'LINEHAUL', '200.0000', 'USD') RETURNING id`,
          [clientAId, invoiceId],
        );
        chargeFactId = cf.rows[0].id;
        const vf = await c.query<{ id: string }>(
          `INSERT INTO variance_finding
             (client_id, audit_run_id, charge_fact_id, criterion_id, rule_version_id, direction, variance_amount, currency, status, evaluated_expr)
           SELECT $1, $2, $3, crit.id, rv.id, 'OVERCHARGE', '20.0000', 'USD', 'open', '{}'::jsonb
           FROM criterion crit JOIN rule r ON r.slug = 'contract-rate_variance'
           JOIN rule_version rv ON rv.rule_id = r.id
           WHERE crit.criterion_key = 'CONTRACT.RATE_VARIANCE' ORDER BY rv.recorded_at DESC LIMIT 1 RETURNING id`,
          [clientAId, auditRunId, chargeFactId],
        );
        findingId = vf.rows[0]!.id;

        const dispute = await c.query<{ id: string }>(
          `INSERT INTO dispute (client_id, carrier_id, status, amount_claimed, currency)
           VALUES ($1, $2, 'draft', '75.0000', 'USD') RETURNING id`,
          [clientAId, carrierId],
        );
        disputeId = dispute.rows[0]!.id;
        await c.query(
          `INSERT INTO dispute_comm (client_id, dispute_id, direction, body, dedupe_key) VALUES ($1, $2, 'outbound', 'PCP comm.', $3)`,
          [clientAId, disputeId, `${tag}-comm`],
        );
        await c.query(
          `INSERT INTO dispute_line (client_id, dispute_id, variance_finding_id, amount, currency) VALUES ($1, $2, $3, '20.0000', 'USD')`,
          [clientAId, disputeId, findingId],
        );

        const claim = await c.query<{ id: string }>(
          `INSERT INTO claim (client_id, dispute_id, amount_claimed, currency, status) VALUES ($1, $2, '20.0000', 'USD', 'open') RETURNING id`,
          [clientAId, disputeId],
        );
        claimId = claim.rows[0]!.id;
      });
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM claim WHERE client_id = $1`, [clientAId]);
      await owner.query(`DELETE FROM dispute_line WHERE client_id = $1`, [clientAId]);
      await owner.query(`DELETE FROM dispute_comm WHERE client_id = $1`, [clientAId]);
      await owner.query(`DELETE FROM dispute WHERE client_id = $1`, [clientAId]);
      await owner.query(`DELETE FROM variance_finding WHERE client_id = $1`, [clientAId]);
      await owner.query(`DELETE FROM charge_fact WHERE client_id = $1`, [clientAId]);
      await owner.query(`DELETE FROM scorecard WHERE client_id = $1`, [clientAId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id = $1`, [clientAId]);
      await owner.query(`DELETE FROM invoice WHERE client_id = $1`, [clientAId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientAId]);
      await owner.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  const otherClientId = '00000000-0000-4000-8000-000000000099';

  it('the explicit predicate rejects a mismatched clientId on listClientInvoices, even under an internal (cross-client) RLS scope', async () => {
    const rows = await withTenantTx({ internal: true }, (c) => listClientInvoices(c, otherClientId));
    expect(rows.some((r) => r.id === invoiceId)).toBe(false);
  });

  it('the explicit predicate rejects a mismatched clientId on getClientAuditRunScorecard, even under an internal (cross-client) RLS scope', async () => {
    const scorecard = await withTenantTx({ internal: true }, (c) => getClientAuditRunScorecard(c, otherClientId, auditRunId));
    expect(scorecard).toBeNull();
  });

  it('the explicit predicate rejects a mismatched clientId on listClientFindings, even under an internal (cross-client) RLS scope', async () => {
    const rows = await withTenantTx({ internal: true }, (c) => listClientFindings(c, otherClientId));
    expect(rows.some((r) => r.id === findingId)).toBe(false);
  });

  it('the explicit predicate rejects a mismatched clientId on getClientDisputeDetail, even under an internal (cross-client) RLS scope', async () => {
    const detail = await withTenantTx({ internal: true }, (c) => getClientDisputeDetail(c, otherClientId, disputeId));
    expect(detail).toBeNull();
  });

  it('the explicit predicate rejects a mismatched clientId on listClientDisputeCommunications, even under an internal (cross-client) RLS scope', async () => {
    const comms = await withTenantTx({ internal: true }, (c) => listClientDisputeCommunications(c, otherClientId, disputeId));
    expect(comms).toEqual([]);
  });

  it('the explicit predicate rejects a mismatched clientId on listClientClaimDocuments, even under an internal (cross-client) RLS scope', async () => {
    const documents = await withTenantTx({ internal: true }, (c) => listClientClaimDocuments(c, otherClientId, claimId));
    expect(documents).toBeNull();
  });

  it('getClaimDetail (reused as-is, P6.B.4) already rejects a mismatched clientId, even under an internal (cross-client) RLS scope', async () => {
    const detail = await withTenantTx({ internal: true }, (c) => getClaimDetail(c, otherClientId, claimId));
    expect(detail).toBeNull();
  });

  it('the explicit predicate still finds the rows under an internal scope when the clientId matches', async () => {
    const rows = await withTenantTx({ internal: true }, (c) => listClientInvoices(c, clientAId));
    expect(rows.some((r) => r.id === invoiceId)).toBe(true);

    const scorecard = await withTenantTx({ internal: true }, (c) => getClientAuditRunScorecard(c, clientAId, auditRunId));
    expect(scorecard).not.toBeNull();
    expect(scorecard!.currency).toBe('USD');
    expect(scorecard!.conformedCount).toBe(4);

    const findings = await withTenantTx({ internal: true }, (c) => listClientFindings(c, clientAId));
    expect(findings.some((f) => f.id === findingId)).toBe(true);

    const detail = await withTenantTx({ internal: true }, (c) => getClientDisputeDetail(c, clientAId, disputeId));
    expect(detail).not.toBeNull();
    expect(detail!.status).toBe('draft');

    const comms = await withTenantTx({ internal: true }, (c) => listClientDisputeCommunications(c, clientAId, disputeId));
    expect(comms).toHaveLength(1);

    const claim = await withTenantTx({ internal: true }, (c) => getClaimDetail(c, clientAId, claimId));
    expect(claim).not.toBeNull();
    expect(claim!.status).toBe('open');

    const documents = await withTenantTx({ internal: true }, (c) => listClientClaimDocuments(c, clientAId, claimId));
    expect(documents).not.toBeNull();
    expect(documents).toEqual([]); // this fixture's finding has no source_document_id
  });
});

/**
 * P6.B.4: GET /api/portal/claims/:id and GET /api/portal/claims/:id/documents,
 * a dedicated fixture (rather than folded into the shared P6.B.1-3 one
 * above) because it needs a fuller evidence chain than the others: a
 * variance_finding WITH a source_document_id, a second dispute_line with NO
 * variance_finding_id at all (proving the good line's document still
 * surfaces per list-client-claim-documents.ts's own header comment), and
 * multiple staggered recovery_event rows (proving cumulativeRecovered sums
 * correctly and the ORDER BY recorded_at ASC is real).
 */
describe('client portal claim + document APIs (P6.B.4, DB, e2e)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let clientId: string;
  let viewerUserId: string;
  let adminUserId: string;
  let carrierId: string;
  let invoiceId: string;
  let auditRunId: string;
  let sourceDocumentId: string;
  let claimId: string;
  let recoveryEventOlderId: string;
  let recoveryEventNewerId: string;
  let claimNoDisputeId: string;
  let otherClientId: string;
  let otherClaimId: string;
  let originalFlag: string | undefined;
  const tag = `pcc-${Date.now()}`;

  beforeAll(async () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c1 = await owner.query(`INSERT INTO client (name, slug) VALUES ('PCC', $1) RETURNING id`, [tag]);
      clientId = c1.rows[0].id;
      const uViewer = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-viewer@example.com`]);
      viewerUserId = uViewer.rows[0].id;
      const uAdmin = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-admin@example.com`]);
      adminUserId = uAdmin.rows[0].id;
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer')`, [viewerUserId, clientId]);
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_admin')`, [adminUserId, clientId]);
      const carrier = await owner.query(`INSERT INTO carrier (name) VALUES ('PCC Carrier') RETURNING id`);
      carrierId = carrier.rows[0].id;

      const other = await owner.query(`INSERT INTO client (name, slug) VALUES ('PCC-Other', $1) RETURNING id`, [`${tag}-other`]);
      otherClientId = other.rows[0].id;

      await withTenantTx({ clientIds: [clientId, otherClientId], internal: true }, async (c) => {
        const invoice = await c.query(
          `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version, status)
           VALUES ($1, $2, '210', 'INV-1', 'USD', 'v1', 'ingested') RETURNING id`,
          [clientId, carrierId],
        );
        invoiceId = invoice.rows[0].id;
        const run = await c.query(
          `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'v1', 'SCORED') RETURNING id`,
          [clientId, invoiceId],
        );
        auditRunId = run.rows[0].id;

        const doc = await c.query<{ id: string }>(
          `INSERT INTO source_document (client_id, sha256, storage_uri) VALUES ($1, $2, $3) RETURNING id`,
          [clientId, tag.padEnd(64, '0').slice(0, 64), `r2://${tag}/doc-1`],
        );
        sourceDocumentId = doc.rows[0]!.id;

        // The finding WITH a source document -- this is the one whose
        // document must surface in the documents view.
        const cfGood = await c.query(
          `INSERT INTO charge_fact (client_id, invoice_id, code, category, amount, currency)
           VALUES ($1, $2, '400', 'LINEHAUL', '1000.0000', 'USD') RETURNING id`,
          [clientId, invoiceId],
        );
        const vfGood = await c.query<{ id: string }>(
          `INSERT INTO variance_finding
             (client_id, audit_run_id, charge_fact_id, criterion_id, rule_version_id, source_document_id, direction, variance_amount, currency, status, evaluated_expr)
           SELECT $1, $2, $3, crit.id, rv.id, $4, 'OVERCHARGE', '100.0000', 'USD', 'open', '{}'::jsonb
           FROM criterion crit JOIN rule r ON r.slug = 'contract-rate_variance'
           JOIN rule_version rv ON rv.rule_id = r.id
           WHERE crit.criterion_key = 'CONTRACT.RATE_VARIANCE' ORDER BY rv.recorded_at DESC LIMIT 1 RETURNING id`,
          [clientId, auditRunId, cfGood.rows[0].id, sourceDocumentId],
        );
        const findingWithDocId = vfGood.rows[0]!.id;

        const dispute = await c.query<{ id: string }>(
          `INSERT INTO dispute (client_id, carrier_id, status, amount_claimed, currency) VALUES ($1, $2, 'accepted', '100.0000', 'USD') RETURNING id`,
          [clientId, carrierId],
        );
        const disputeId = dispute.rows[0]!.id;
        await c.query(
          `INSERT INTO dispute_line (client_id, dispute_id, variance_finding_id, amount, currency) VALUES ($1, $2, $3, '100.0000', 'USD')`,
          [clientId, disputeId, findingWithDocId],
        );
        // A second line with NO variance_finding_id at all -- proves the
        // good line's document still surfaces (list-client-claim-documents.ts's
        // own header comment: a direct join drops this line, not the whole request).
        await c.query(
          `INSERT INTO dispute_line (client_id, dispute_id, amount, currency) VALUES ($1, $2, '25.0000', 'USD')`,
          [clientId, disputeId],
        );

        const claim = await c.query<{ id: string }>(
          `INSERT INTO claim (client_id, dispute_id, amount_claimed, currency, status) VALUES ($1, $2, '100.0000', 'USD', 'open') RETURNING id`,
          [clientId, disputeId],
        );
        claimId = claim.rows[0]!.id;

        // Two recovery_events with explicit staggered recorded_at (now()
        // is transaction-stable inside this one withTenantTx, so relying
        // on the column default would make the ORDER BY assertion
        // non-deterministic -- same trap round 73 hit on audit_run).
        const eventOlder = await c.query<{ id: string }>(
          `INSERT INTO recovery_event (client_id, claim_id, variance_finding_id, amount_recovered, currency, recorded_at)
           VALUES ($1, $2, $3, '30.0000', 'USD', now() - interval '2 hours') RETURNING id`,
          [clientId, claimId, findingWithDocId],
        );
        recoveryEventOlderId = eventOlder.rows[0]!.id;
        const eventNewer = await c.query<{ id: string }>(
          `INSERT INTO recovery_event (client_id, claim_id, variance_finding_id, amount_recovered, currency, recorded_at)
           VALUES ($1, $2, $3, '20.0000', 'USD', now() - interval '1 hour') RETURNING id`,
          [clientId, claimId, findingWithDocId],
        );
        recoveryEventNewerId = eventNewer.rows[0]!.id;

        // A second claim with NO originating dispute at all -- AC4's "no
        // data yet" case for the documents view (empty array, not an error).
        const claimNoDispute = await c.query<{ id: string }>(
          `INSERT INTO claim (client_id, dispute_id, amount_claimed, currency, status) VALUES ($1, NULL, '10.0000', 'USD', 'open') RETURNING id`,
          [clientId],
        );
        claimNoDisputeId = claimNoDispute.rows[0]!.id;

        const otherClaim = await c.query<{ id: string }>(
          `INSERT INTO claim (client_id, dispute_id, amount_claimed, currency, status) VALUES ($1, NULL, '5.0000', 'USD', 'open') RETURNING id`,
          [otherClientId],
        );
        otherClaimId = otherClaim.rows[0]!.id;
      });
    } finally {
      owner.release();
    }
    app = buildApp();
  });

  afterAll(async () => {
    process.env.DEV_AUTH_HEADERS = originalFlag;
    await app.close();
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM recovery_event WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM claim WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM dispute_line WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM dispute WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM variance_finding WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM charge_fact WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM source_document WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM audit_run WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM invoice WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM membership WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM app_user WHERE id = ANY($1)`, [[viewerUserId, adminUserId]]);
      await owner.query(`DELETE FROM client WHERE id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  // AC1: caller's own claim (status, amount claimed, currency, aging deadline)
  // plus recovery-event history and cumulative recovered amount.
  it('returns the claim with its full recovery-event history and cumulative recovered amount', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/portal/claims/${claimId}`, headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(claimId);
    expect(body.status).toBe('open');
    expect(body.amountClaimed).toBe('100.0000');
    expect(body.cumulativeRecovered).toBe('50.0000'); // 30 + 20
    expect(body.recoveryEvents.map((e: { id: string }) => e.id)).toEqual([recoveryEventOlderId, recoveryEventNewerId]);
  });

  it('rejects an unauthenticated claim request', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/portal/claims/${claimId}` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a client_admin caller on the claim detail route -- sibling capability, out of this task\'s scope', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/portal/claims/${claimId}`, headers: { 'x-client-id': clientId, 'x-user-id': adminUserId },
    });
    expect(res.statusCode).toBe(401);
  });

  // AC3 (claim half): a claim belonging to a DIFFERENT client is rejected/not-found.
  it('returns 404 for a claim that belongs to a different client', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/portal/claims/${otherClaimId}`, headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a well-formed but nonexistent claim id', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/claims/00000000-0000-4000-8000-000000000099',
      headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a malformed claim id with 400', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/claims/not-a-uuid', headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(400);
  });

  // AC4 (claim view half): a claim with no recovery events yet renders an
  // explicit empty sub-state, not an error -- proven at the module/response
  // level here; the component-level empty state is covered in
  // ClientClaimView.test.tsx.
  it('returns an empty recoveryEvents array for a claim with no recovery events yet', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/portal/claims/${claimNoDisputeId}`, headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().recoveryEvents).toEqual([]);
  });

  // AC2: source-document references (id, storage reference) resolved via
  // the claim's originating dispute/finding chain.
  it('returns the source-document reference resolved via the claim\'s originating dispute/finding chain, skipping the findingless line', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/portal/claims/${claimId}/documents`, headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.documents).toEqual([{ id: sourceDocumentId, sha256: tag.padEnd(64, '0').slice(0, 64), storageUri: `r2://${tag}/doc-1` }]);
  });

  // AC4 (documents half): a claim with no originating dispute resolves an
  // explicit empty array, not an error.
  it('returns an empty documents array for a claim with no originating dispute', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/portal/claims/${claimNoDisputeId}/documents`, headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ documents: [] });
  });

  it('rejects an unauthenticated documents request', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/portal/claims/${claimId}/documents` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a client_admin caller on the documents route -- sibling capability, out of this task\'s scope', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/portal/claims/${claimId}/documents`, headers: { 'x-client-id': clientId, 'x-user-id': adminUserId },
    });
    expect(res.statusCode).toBe(401);
  });

  // AC3 (documents half): documents for a claim belonging to a DIFFERENT client are rejected/not-found.
  it('returns 404 for documents of a claim that belongs to a different client', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/portal/claims/${otherClaimId}/documents`, headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a malformed claim id on the documents route with 400', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/claims/not-a-uuid/documents', headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('has no POST/PUT/PATCH/DELETE route registered on the claim detail or documents paths -- no write surface exists to protect (No-gos: read-only)', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const detailRes = await app.inject({
        method, url: `/api/portal/claims/${claimId}`, headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
      });
      expect(detailRes.statusCode).toBe(404);
      const docsRes = await app.inject({
        method, url: `/api/portal/claims/${claimId}/documents`, headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
      });
      expect(docsRes.statusCode).toBe(404);
    }
  });
});

/**
 * P6.B.6: GET /api/portal/audit-log, in its own describe block/fixture
 * (not folded into the first block) because it needs a client_id IS NULL
 * ("system-global") audit_event row -- a shape no other portal-content
 * fixture seeds, and the one this route's explicit client_id predicate
 * exists to exclude (see list-client-audit-events.ts's own header comment:
 * RLS alone admits NULL-client rows, so this predicate is load-bearing
 * here, not defense-in-depth).
 */
describe('client portal audit-log API (P6.B.6, DB, e2e)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let clientId: string;
  let viewerUserId: string;
  let adminUserId: string;
  let otherClientId: string;
  let eventAnalystId: string;
  let eventAiId: string;
  let eventSystemId: string;
  let eventClientId: string;
  let otherClientEventId: string;
  let originalFlag: string | undefined;
  const tag = `pca-${Date.now()}`;

  beforeAll(async () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('PCA', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const uViewer = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-viewer@example.com`]);
      viewerUserId = uViewer.rows[0].id;
      const uAdmin = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-admin@example.com`]);
      adminUserId = uAdmin.rows[0].id;
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer')`, [viewerUserId, clientId]);
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_admin')`, [adminUserId, clientId]);

      const other = await owner.query(`INSERT INTO client (name, slug) VALUES ('PCA-Other', $1) RETURNING id`, [`${tag}-other`]);
      otherClientId = other.rows[0].id;

      // Staggered recorded_at (explicit, not the column default -- now() is
      // transaction-stable across these sequential owner.query calls too,
      // same trap documented in the P6.B.3/P6.B.4 fixtures above) so the
      // newest-first ORDER BY assertion is deterministic. All four actor_kind
      // values are represented (AC2).
      const eAnalyst = await owner.query<{ id: string }>(
        `INSERT INTO audit_event (client_id, entity, event, actor_kind, recorded_at)
         VALUES ($1, 'dispute', 'created', 'analyst', now() - interval '4 hours') RETURNING id`,
        [clientId],
      );
      eventAnalystId = eAnalyst.rows[0]!.id;
      const eAi = await owner.query<{ id: string }>(
        `INSERT INTO audit_event (client_id, entity, event, actor_kind, recorded_at)
         VALUES ($1, 'invoice', 'scored', 'ai', now() - interval '3 hours') RETURNING id`,
        [clientId],
      );
      eventAiId = eAi.rows[0]!.id;
      const eSystem = await owner.query<{ id: string }>(
        `INSERT INTO audit_event (client_id, entity, event, actor_kind, recorded_at)
         VALUES ($1, 'claim', 'opened', 'system', now() - interval '2 hours') RETURNING id`,
        [clientId],
      );
      eventSystemId = eSystem.rows[0]!.id;
      const eClient = await owner.query<{ id: string }>(
        `INSERT INTO audit_event (client_id, entity, event, actor_kind, recorded_at)
         VALUES ($1, 'dispute', 'commented', 'client', now() - interval '1 hour') RETURNING id`,
        [clientId],
      );
      eventClientId = eClient.rows[0]!.id;

      const eOther = await owner.query<{ id: string }>(
        `INSERT INTO audit_event (client_id, entity, event, actor_kind, recorded_at)
         VALUES ($1, 'dispute', 'created', 'analyst', now()) RETURNING id`,
        [otherClientId],
      );
      otherClientEventId = eOther.rows[0]!.id;

      // System-global event: client_id IS NULL. RLS's own USING clause
      // admits this row unconditionally (client_id IS NULL OR ...) -- only
      // this route's explicit client_id = $N predicate keeps it out of a
      // client_viewer's result set. This is the discriminating case the
      // rest of this task's cross-tenant test can't exercise (a NULL client
      // is not "a different tenant", it's no tenant).
      await owner.query(
        `INSERT INTO audit_event (client_id, entity, event, actor_kind, recorded_at)
         VALUES (NULL, 'system', 'migration_run', 'system', now())`,
      );
    } finally {
      owner.release();
    }
    app = buildApp();
  });

  afterAll(async () => {
    process.env.DEV_AUTH_HEADERS = originalFlag;
    await app.close();
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id = ANY($1) OR client_id IS NULL`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM membership WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM app_user WHERE id = ANY($1)`, [[viewerUserId, adminUserId]]);
      await owner.query(`DELETE FROM client WHERE id = ANY($1)`, [[clientId, otherClientId]]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  // AC1: client-scoped, newest-first. Also proves the NULL-client
  // system-global event and the other tenant's event are both excluded.
  it('lists only the caller\'s own audit events, newest recorded_at first', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/audit-log', headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json().events.map((e: { id: string }) => e.id);
    expect(ids).toEqual([eventClientId, eventSystemId, eventAiId, eventAnalystId]);
    expect(ids).not.toContain(otherClientEventId);
  });

  // AC2: each event's actorKind is present and distinguishable per row.
  it('surfaces a distinct actorKind for each of analyst/ai/system/client events', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/audit-log', headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    const byId = new Map(res.json().events.map((e: { id: string; actorKind: string }) => [e.id, e.actorKind]));
    expect(byId.get(eventAnalystId)).toBe('analyst');
    expect(byId.get(eventAiId)).toBe('ai');
    expect(byId.get(eventSystemId)).toBe('system');
    expect(byId.get(eventClientId)).toBe('client');
  });

  // AC3: pagination bounds are enforced at the HTTP layer too (unit test on
  // list-client-audit-events.ts itself already covers the module's own
  // default-limit/explicit-limit/offset query-building in isolation).
  it('honors limit/offset for pagination, in newest-first order', async () => {
    const page1 = await app.inject({
      method: 'GET', url: '/api/portal/audit-log?limit=2&offset=0', headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(page1.json().events.map((e: { id: string }) => e.id)).toEqual([eventClientId, eventSystemId]);

    const page2 = await app.inject({
      method: 'GET', url: '/api/portal/audit-log?limit=2&offset=2', headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(page2.json().events.map((e: { id: string }) => e.id)).toEqual([eventAiId, eventAnalystId]);
  });

  it('filters by entity', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/audit-log?entity=claim', headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.json().events.map((e: { id: string }) => e.id)).toEqual([eventSystemId]);
  });

  it('filters by event', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/audit-log?event=scored', headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.json().events.map((e: { id: string }) => e.id)).toEqual([eventAiId]);
  });

  it('filters by date range (from/to)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/portal/audit-log?from=${encodeURIComponent(new Date(Date.now() - 3.5 * 3600_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() - 1.5 * 3600_000).toISOString())}`,
      headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    // Window covers the 'ai' (-3h) and 'system' (-2h) events only.
    expect(res.json().events.map((e: { id: string }) => e.id).sort()).toEqual([eventAiId, eventSystemId].sort());
  });

  // AC4: explicit empty state -- no error, an empty array, when filters
  // match nothing.
  it('returns an empty events array, not an error, when filters match nothing', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/audit-log?entity=nonexistent-entity', headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ events: [] });
  });

  it('rejects an unauthenticated audit-log request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/portal/audit-log' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a client_admin caller on the audit-log route -- sibling capability, out of this task\'s scope', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/audit-log', headers: { 'x-client-id': clientId, 'x-user-id': adminUserId },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a malformed entity query param with 400', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/audit-log?entity=Not_Valid!', headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('has no POST/PUT/PATCH/DELETE route registered on the audit-log path -- no write surface exists to protect (No-gos: read-only)', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({
        method, url: '/api/portal/audit-log', headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
      });
      expect(res.statusCode).toBe(404);
    }
  });
});

/**
 * Module-level proof that listClientAuditEvents' explicit client_id
 * predicate is load-bearing (not defense-in-depth) against a NULL-client
 * "system-global" row -- exercised directly against the module (not just
 * through the route) since this is the one predicate on this whole surface
 * where RLS alone would NOT have caught the leak.
 */
describe('listClientAuditEvents: explicit client_id predicate excludes NULL-client rows (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  const tag = `pcan-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('PCAN', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      await owner.query(
        `INSERT INTO audit_event (client_id, entity, event, actor_kind) VALUES ($1, 'dispute', 'created', 'analyst')`,
        [clientId],
      );
      await owner.query(
        `INSERT INTO audit_event (client_id, entity, event, actor_kind) VALUES (NULL, 'system', 'migration_run', 'system')`,
      );
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id = $1 OR client_id IS NULL`, [clientId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('never returns the NULL-client system-global row for a real clientId, even with RLS scoped to that client only', async () => {
    const rows = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      listClientAuditEvents(client, clientId),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entity).toBe('dispute');
  });
});
