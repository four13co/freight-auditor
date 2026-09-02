import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { buildApp } from '../../src/server/app.js';
import { listClientInvoices } from '../../src/modules/portal/list-client-invoices.js';
import { getClientAuditRunScorecard } from '../../src/modules/portal/get-client-audit-run-scorecard.js';
import { listClientFindings } from '../../src/modules/portal/list-client-findings.js';

/**
 * P6.B.1: GET /api/portal/invoices and GET /api/portal/scorecard/:auditRunId,
 * exercised at the HTTP layer under a real client_viewer membership. Uses
 * the dev-header identity source (DEV_AUTH_HEADERS=1), same pattern as
 * claim-recovery-endpoint.db.test.ts / client-viewer-auth.db.test.ts.
 *
 * P6.B.2 (findings list + evidence) is seeded into this SAME describe
 * block/fixture rather than a separate one -- it reuses the same
 * clientId/viewerUserId/adminUserId/otherClientId tenancy setup, following
 * a real variance_finding's own FK chain (criterion -> rule -> rule_version,
 * charge_fact, expected_charge), same seeding pattern as
 * build-evidence-packet.db.test.ts's seedDisputeWithFinding helper.
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
      });
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
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

  it('the explicit predicate still finds the rows under an internal scope when the clientId matches', async () => {
    const rows = await withTenantTx({ internal: true }, (c) => listClientInvoices(c, clientAId));
    expect(rows.some((r) => r.id === invoiceId)).toBe(true);

    const scorecard = await withTenantTx({ internal: true }, (c) => getClientAuditRunScorecard(c, clientAId, auditRunId));
    expect(scorecard).not.toBeNull();
    expect(scorecard!.currency).toBe('USD');
    expect(scorecard!.conformedCount).toBe(4);

    const findings = await withTenantTx({ internal: true }, (c) => listClientFindings(c, clientAId));
    expect(findings.some((f) => f.id === findingId)).toBe(true);
  });
});
