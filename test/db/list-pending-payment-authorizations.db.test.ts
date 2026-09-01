import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { generateHoldDecision } from '../../src/modules/payments/generate-hold-decision.js';
import { authorizePayment } from '../../src/modules/payments/authorize-payment.js';
import { listPendingPaymentAuthorizations } from '../../src/modules/payments/list-pending-payment-authorizations.js';

/**
 * P4.B.6's backing query. Covers: a held audit run appears in the queue; an
 * approved one does not (even though its 'hold' row is never deleted --
 * payment_gate_decision is append-only); RLS isolation between tenants;
 * and FIFO (oldest-hold-first) ordering.
 */
describe('listPendingPaymentAuthorizations (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  let userId: string;
  const tag = `lppa-${Date.now()}`;

  async function makeAuditRun(client: pg.PoolClient, forClientId: string, invoiceNumber: string): Promise<string> {
    const carrier = await client.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Carrier-${invoiceNumber}`]);
    const inv = await client.query(
      `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
       VALUES ($1, $2, '210', $3, 'USD', 'test') RETURNING id`,
      [forClientId, carrier.rows[0].id, invoiceNumber],
    );
    const run = await client.query(
      `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
      [forClientId, inv.rows[0].id],
    );
    return run.rows[0].id;
  }

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('LPPA-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('LPPA-B', $1) RETURNING id`, [`${tag}-b`]);
      clientBId = b.rows[0].id;
      const u = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}@example.com`]);
      userId = u.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM payment_gate_decision WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM invoice WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM app_user WHERE id = $1`, [userId]);
      await owner.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('AC1: a SCORED audit run defaulted to hold appears in the queue', async () => {
    const rows = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const auditRunId = await makeAuditRun(c, clientAId, `INV-${tag}-1`);
      await generateHoldDecision(c, { clientId: clientAId, auditRunId });
      return listPendingPaymentAuthorizations(c);
    });

    const own = rows.filter((r) => r.invoiceNumber === `INV-${tag}-1`);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ invoiceNumber: `INV-${tag}-1`, carrierName: `Carrier-INV-${tag}-1`, currency: 'USD' });
  });

  it('AC2: an audit run the analyst has approved no longer appears, even though its hold row is never deleted', async () => {
    const { rowsBefore, rowsAfter } = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const auditRunId = await makeAuditRun(c, clientAId, `INV-${tag}-2`);
      await generateHoldDecision(c, { clientId: clientAId, auditRunId });
      const before = await listPendingPaymentAuthorizations(c);
      await authorizePayment(c, { clientId: clientAId, auditRunId, action: 'approve', actorUserId: userId });
      const after = await listPendingPaymentAuthorizations(c);
      return { rowsBefore: before, rowsAfter: after };
    });

    expect(rowsBefore.some((r) => r.invoiceNumber === `INV-${tag}-2`)).toBe(true);
    expect(rowsAfter.some((r) => r.invoiceNumber === `INV-${tag}-2`)).toBe(false);

    const stillHasHoldRow = await withTenantTx({ clientIds: [clientAId], internal: true }, (c) =>
      c.query(`SELECT 1 FROM payment_gate_decision WHERE client_id = $1 AND action = 'hold'`, [clientAId]),
    );
    expect((stillHasHoldRow as unknown as pg.QueryResult).rowCount).toBeGreaterThan(0);
  });

  it('AC3 (RLS isolation): client B never sees client A pending decisions', async () => {
    await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const auditRunId = await makeAuditRun(c, clientAId, `INV-${tag}-3`);
      await generateHoldDecision(c, { clientId: clientAId, auditRunId });
    });

    const bRows = await withTenantTx({ clientIds: [clientBId], internal: false }, (c) => listPendingPaymentAuthorizations(c));
    expect(bRows.every((r) => r.invoiceNumber !== `INV-${tag}-3`)).toBe(true);
  });

  it('AC4: orders oldest hold first (FIFO)', async () => {
    const firstRunId = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const runId = await makeAuditRun(c, clientAId, `INV-${tag}-4a`);
      await generateHoldDecision(c, { clientId: clientAId, auditRunId: runId });
      return runId;
    });

    // payment_gate_decision is append-only for freight_app (no UPDATE grant
    // -- authorize-payment.ts's own docstring), so backdating recorded_at to
    // simulate an older hold goes through the owner connection directly,
    // same as this file's beforeAll/afterAll fixture setup.
    const owner = await pool.connect();
    try {
      await owner.query(
        `UPDATE payment_gate_decision SET recorded_at = now() - interval '1 hour' WHERE client_id = $1 AND audit_run_id = $2`,
        [clientAId, firstRunId],
      );
    } finally {
      owner.release();
    }

    const rows = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const secondRunId = await makeAuditRun(c, clientAId, `INV-${tag}-4b`);
      await generateHoldDecision(c, { clientId: clientAId, auditRunId: secondRunId });
      return listPendingPaymentAuthorizations(c);
    });

    const idxA = rows.findIndex((r) => r.invoiceNumber === `INV-${tag}-4a`);
    const idxB = rows.findIndex((r) => r.invoiceNumber === `INV-${tag}-4b`);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeLessThan(idxB);
  });
});
