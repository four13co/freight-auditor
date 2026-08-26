import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { buildApp } from '../../src/server/app.js';
import { parse210 } from '../../src/modules/ingestion/parse-210.js';
import { evaluateInvoice } from '../../src/modules/evaluator/evaluate-invoice.js';
import { persistAuditRun } from '../../src/modules/evaluator/persist.js';
import { CONTRACT_RUBRIC } from '../../src/modules/rubric-resolver/contract-rubric.js';
import { GOLDEN_210, testCategorize } from '../fixtures/edi-golden.js';

/**
 * 86e2u7j0d AC1-3, exercised at the HTTP layer (GET /api/findings).
 *
 * AC2's original contract ("no x-client-id -> 200, empty tenant scope") is
 * superseded by 86e2u7j2y AC3 ("missing header(s) -> 401") -- membership
 * validation now gates this route, so an unscoped/unauthenticated request is
 * rejected outright rather than silently scoped to nothing. Updated in place
 * per that item landing, not left asserting a contract this endpoint no
 * longer has.
 *
 * 86e2v1bbr gated the dev-header path behind DEV_AUTH_HEADERS (unset = a
 * verified better-auth session is required instead) -- this suite is about
 * the findings endpoint's own behavior, not auth, so it sets the flag for
 * its own lifetime to keep using dev headers as its (now explicit) identity
 * source, unchanged from before.
 */
describe('GET /api/findings (DB, e2e)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let clientId: string;
  let userId: string;
  let originalFlag: string | undefined;
  const tag = `fe-${Date.now()}`;

  beforeAll(async () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('FE', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const u = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}@example.com`]);
      userId = u.rows[0].id;
      await owner.query(
        `INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer')`,
        [userId, clientId],
      );
      const carrier = await owner.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Carrier-${tag}`]);
      await withTenantTx({ clientIds: [clientId], internal: true }, async (c2) => {
        const inv = await c2.query(
          `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
           VALUES ($1, $2, '210', $3, 'USD', 'test') RETURNING id`,
          [clientId, carrier.rows[0].id, `INV-${tag}`],
        );
        const run = await c2.query(
          `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
          [clientId, inv.rows[0].id],
        );
        const cf = await c2.query(
          `INSERT INTO charge_fact (client_id, invoice_id, code, category, amount, currency) VALUES ($1, $2, '400', 'LINEHAUL', '1000.0000', 'USD') RETURNING id`,
          [clientId, inv.rows[0].id],
        );
        await c2.query(
          `INSERT INTO variance_finding (client_id, audit_run_id, charge_fact_id, direction, variance_amount, currency, status)
           VALUES ($1, $2, $3, 'OVERCHARGE', '100.0000', 'USD', 'open')`,
          [clientId, run.rows[0].id, cf.rows[0].id],
        );
      });
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
      // variance_finding + charge_finding + scorecard before audit_run
      // (86e2v17p5's real-pipeline test below calls the full persistAuditRun,
      // which writes all three -- this file's cleanup previously only ever
      // hand-seeded variance_finding/charge_fact directly).
      await owner.query(`DELETE FROM variance_finding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM scorecard WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_finding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_fact WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM invoice WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM carrier WHERE name = $1`, [`Carrier-${tag}`]);
      await owner.query(`DELETE FROM membership WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM app_user WHERE id = $1`, [userId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('AC1: returns seeded rows for the client+user in the request headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/findings',
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]).toMatchObject({ carrierName: `Carrier-${tag}`, billed: '1000.0000', status: 'open' });
  });

  it('AC2 (superseded by 86e2u7j2y AC3): a request with no x-client-id header is rejected, not silently scoped to zero', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/findings' });
    expect(res.statusCode).toBe(401);
  });

  it('AC3: status query param filters results', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/findings?status=closed',
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().findings).toHaveLength(0);
  });

  /**
   * Review finding: app.ts read `query.minAmount` (camelCase) but the item's
   * own AC names the param `min-amount` (kebab-case), and Fastify returns
   * querystring keys literally as sent -- so the filter was silently dead for
   * every real caller. These exercise the actual URL string, not a JS object,
   * so a regression back to reading the wrong key fails loudly here.
   */
  it('AC3: min-amount query param excludes findings below the threshold', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/findings?min-amount=150',
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().findings).toHaveLength(0); // seeded finding's variance_amount is 100.0000
  });

  it('AC3: min-amount query param includes findings at or above the threshold', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/findings?min-amount=100',
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().findings).toHaveLength(1);
  });

  /**
   * 86e2v17p5 AC2: a real parse210 -> evaluateInvoice -> persistAuditRun run
   * (not a hand-seeded row) produces a variance_finding that GET
   * /api/findings actually returns, with the correct direction/amount --
   * proving the full real-EDI-to-dashboard path, not just that a row exists.
   */
  it('86e2v17p5: a real pipeline-derived VARIANCE finding is visible via GET /api/findings with matching direction/amount', async () => {
    const inv = parse210(GOLDEN_210, testCategorize); // billed LINEHAUL = 1000.00
    const result = evaluateInvoice(inv, CONTRACT_RUBRIC, {
      linehaulRate: { amount: '900.0000', currency: 'USD', clauseId: null },
    });
    await withTenantTx({ clientIds: [clientId], internal: true }, (c) =>
      persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null }),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/findings',
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(res.statusCode).toBe(200);
    const findings = res.json().findings as Array<{ invoiceNumber: string; direction: string; varianceAmount: string }>;
    const derived = findings.find((f) => f.invoiceNumber === inv.invoiceNumber);
    expect(derived).toMatchObject({ direction: 'OVERCHARGE', varianceAmount: '100.0000' });
  });
});
