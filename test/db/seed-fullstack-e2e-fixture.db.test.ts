import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { seedDevTenant, DEV_CLIENT_ID, DEV_USER_ID } from '../../scripts/seed-dev-tenant.mjs';
import {
  seedFullstackE2eFixture,
  assertVarianceFindingDerived,
  FIXTURE_INVOICE_NUMBER,
  FIXTURE_CARRIER_NAME,
} from '../../scripts/seed-fullstack-e2e-fixture.mjs';
import { buildApp } from '../../src/server/app.js';

/**
 * 86e2v2hyu: seedFullstackE2eFixture now runs the REAL pipeline (parse210 ->
 * lookupContractRate -> evaluateInvoice(CONTRACT_RUBRIC) -> persistAuditRun)
 * instead of hand-inserting a variance_finding row. FIXTURE_INVOICE_NUMBER/
 * FIXTURE_CARRIER_NAME must be preserved exactly -- web/test/e2e-fullstack/
 * dashboard.fullstack.spec.ts asserts on them verbatim and must pass
 * unmodified (this item's own explicit rabbit hole).
 */
describe('seedFullstackE2eFixture (DB)', () => {
  const pool = getPool();

  beforeAll(async () => {
    await seedDevTenant({ pool });
  });

  afterAll(async () => {
    await closePool();
  });

  // Uses the raw owner pool (not withTenantTx's freight_app-scoped client) --
  // charge_finding/gate_failure are append-only under freight_app's grants
  // (migration 0010), so only the owning role can clean them up between tests.
  async function cleanupFixtureRows() {
    await pool.query(`DELETE FROM variance_finding WHERE client_id = $1`, [DEV_CLIENT_ID]);
    await pool.query(`DELETE FROM scorecard WHERE client_id = $1`, [DEV_CLIENT_ID]);
    await pool.query(`DELETE FROM charge_finding WHERE client_id = $1`, [DEV_CLIENT_ID]);
    await pool.query(`DELETE FROM gate_failure WHERE client_id = $1`, [DEV_CLIENT_ID]);
    await pool.query(`DELETE FROM audit_run WHERE client_id = $1`, [DEV_CLIENT_ID]);
    await pool.query(`DELETE FROM charge_fact WHERE client_id = $1`, [DEV_CLIENT_ID]);
    await pool.query(`DELETE FROM source_document WHERE client_id = $1`, [DEV_CLIENT_ID]);
    await pool.query(`DELETE FROM invoice WHERE client_id = $1 AND invoice_number LIKE $2`, [
      DEV_CLIENT_ID,
      `${FIXTURE_INVOICE_NUMBER}%`,
    ]);
    await pool.query(`DELETE FROM contract_rate WHERE client_id = $1`, [DEV_CLIENT_ID]);
    await pool.query(`DELETE FROM contract_version WHERE client_id = $1`, [DEV_CLIENT_ID]);
    await pool.query(`DELETE FROM contract WHERE client_id = $1`, [DEV_CLIENT_ID]);
    await pool.query(`DELETE FROM carrier WHERE name = $1`, [FIXTURE_CARRIER_NAME]);
  }

  it('AC1: produces a real finding via GET /api/findings -- invoiceNumber, carrierName, varianceAmount, direction, non-null charge_fact_id', async () => {
    await cleanupFixtureRows();
    try {
      await seedFullstackE2eFixture({ pool });

      const app = buildApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/findings',
          headers: { 'x-client-id': DEV_CLIENT_ID, 'x-user-id': DEV_USER_ID },
        });
        expect(res.statusCode).toBe(200);
        const findings = res.json().findings as Array<{
          invoiceNumber: string | null;
          carrierName: string | null;
          varianceAmount: string | null;
          direction: string | null;
        }>;
        const row = findings.find((f) => f.invoiceNumber === FIXTURE_INVOICE_NUMBER);
        expect(row).toMatchObject({
          invoiceNumber: FIXTURE_INVOICE_NUMBER,
          carrierName: FIXTURE_CARRIER_NAME,
          varianceAmount: '100.0000',
          direction: 'OVERCHARGE',
        });

        const chargeFactCheck = await withTenantTx({ clientIds: [DEV_CLIENT_ID], internal: true }, async (c) => {
          const vf = await c.query(
            `SELECT charge_fact_id FROM variance_finding
             JOIN audit_run ON audit_run.id = variance_finding.audit_run_id
             JOIN invoice ON invoice.id = audit_run.invoice_id
             WHERE invoice.invoice_number = $1`,
            [FIXTURE_INVOICE_NUMBER],
          );
          return vf.rows[0]?.charge_fact_id;
        });
        expect(chargeFactCheck).not.toBeNull();
      } finally {
        await app.close();
      }
    } finally {
      await cleanupFixtureRows();
    }
  });

  it('AC3: running the seed twice does not duplicate carrier/contract/contract_rate/invoice/finding rows', async () => {
    await cleanupFixtureRows();
    try {
      await seedFullstackE2eFixture({ pool });
      await seedFullstackE2eFixture({ pool }); // second run must not throw or duplicate

      const counts = await withTenantTx({ clientIds: [DEV_CLIENT_ID], internal: true }, async (c) => {
        const invoice = await c.query(`SELECT count(*)::int AS n FROM invoice WHERE invoice_number = $1`, [
          FIXTURE_INVOICE_NUMBER,
        ]);
        const finding = await c.query(
          `SELECT count(*)::int AS n FROM variance_finding
           JOIN audit_run ON audit_run.id = variance_finding.audit_run_id
           JOIN invoice ON invoice.id = audit_run.invoice_id
           WHERE invoice.invoice_number = $1`,
          [FIXTURE_INVOICE_NUMBER],
        );
        const contract = await c.query(`SELECT count(*)::int AS n FROM contract WHERE client_id = $1`, [
          DEV_CLIENT_ID,
        ]);
        return { invoice: invoice.rows[0].n, finding: finding.rows[0].n, contract: contract.rows[0].n };
      });
      const carrierCount = await pool.query(`SELECT count(*)::int AS n FROM carrier WHERE name = $1`, [
        FIXTURE_CARRIER_NAME,
      ]);

      expect(counts.invoice).toBe(1);
      expect(counts.finding).toBe(1);
      expect(counts.contract).toBe(1);
      expect(carrierCount.rows[0].n).toBe(1);
    } finally {
      await cleanupFixtureRows();
    }
  });

  it('AC4: assertVarianceFindingDerived throws loudly when an audit_run has zero variance_finding rows (86e2v17p5 not landed / regressed)', async () => {
    await cleanupFixtureRows();
    try {
      const auditRunId = await withTenantTx({ clientIds: [DEV_CLIENT_ID], internal: true }, async (c) => {
        const inv = await c.query(
          `INSERT INTO invoice (client_id, transaction_set, invoice_number, currency, parser_version)
           VALUES ($1, '210', $2, 'USD', 'test') RETURNING id`,
          [DEV_CLIENT_ID, `${FIXTURE_INVOICE_NUMBER}-guard-check`],
        );
        const run = await c.query(
          `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
          [DEV_CLIENT_ID, inv.rows[0].id],
        );
        return run.rows[0].id as string;
      });

      await withTenantTx({ clientIds: [DEV_CLIENT_ID], internal: true }, async (c) => {
        await expect(assertVarianceFindingDerived(c, auditRunId)).rejects.toThrow(/86e2v17p5/);
      });
    } finally {
      await cleanupFixtureRows();
    }
  });

  it('AC4: a guard failure rolls back everything the seed transaction wrote -- "fails loudly rather than silently seeding" means nothing is left behind', async () => {
    await cleanupFixtureRows();
    try {
      // Reproduces the real seed's transaction shape (invoice + audit_run
      // inserted, THEN the guard checked, all inside one withTenantTx) --
      // proving the guard's placement inside the same transaction as the
      // writes is what makes a failure atomic, not just that the function
      // throws in isolation.
      const invoiceNumber = `${FIXTURE_INVOICE_NUMBER}-rollback-check`;
      await expect(
        withTenantTx({ clientIds: [DEV_CLIENT_ID], internal: true }, async (c) => {
          const inv = await c.query(
            `INSERT INTO invoice (client_id, transaction_set, invoice_number, currency, parser_version)
             VALUES ($1, '210', $2, 'USD', 'test') RETURNING id`,
            [DEV_CLIENT_ID, invoiceNumber],
          );
          const run = await c.query(
            `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
            [DEV_CLIENT_ID, inv.rows[0].id],
          );
          await assertVarianceFindingDerived(c, run.rows[0].id); // throws: no variance_finding was written
        }),
      ).rejects.toThrow(/86e2v17p5/);

      const leftBehind = await pool.query(`SELECT count(*)::int AS n FROM invoice WHERE invoice_number = $1`, [
        invoiceNumber,
      ]);
      expect(leftBehind.rows[0].n).toBe(0);
    } finally {
      await cleanupFixtureRows();
    }
  });

  it('AC4 (positive case): assertVarianceFindingDerived does not throw when the real seed produced its finding', async () => {
    await cleanupFixtureRows();
    try {
      await seedFullstackE2eFixture({ pool });
      const auditRunId = await withTenantTx({ clientIds: [DEV_CLIENT_ID], internal: true }, async (c) => {
        const run = await c.query(
          `SELECT audit_run.id FROM audit_run
           JOIN invoice ON invoice.id = audit_run.invoice_id
           WHERE invoice.invoice_number = $1`,
          [FIXTURE_INVOICE_NUMBER],
        );
        return run.rows[0].id as string;
      });
      await withTenantTx({ clientIds: [DEV_CLIENT_ID], internal: true }, async (c) => {
        await expect(assertVarianceFindingDerived(c, auditRunId)).resolves.toBeUndefined();
      });
    } finally {
      await cleanupFixtureRows();
    }
  });
});
