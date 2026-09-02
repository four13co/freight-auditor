import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { handleExportRecordJob, ExportRecordFailedError } from '../../src/jobs/export-record-handler.js';
import { ExportAdapterRegistry } from '../../src/modules/exports/export-adapter.js';
import { StandInExportAdapter } from '../../src/modules/exports/stand-in-export-adapter.js';
import { recordExportAcknowledgement } from '../../src/modules/exports/record-export-acknowledgement.js';

/**
 * 86e2zfjxv (P6.C.2): EXPORT_RECORD_V1 job wiring around the P4.B.8/P4.B.9
 * adapter + persistence primitives, run against the real DB so
 * recordExportAcknowledgement's dedupeKey idempotency (0075's partial
 * unique index) is exercised for real, not mocked.
 */
describe('handleExportRecordJob (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  const tag = `xrec-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('XREC', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM export_acknowledgement WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM claim WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedClaim(client: pg.PoolClient): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO claim (client_id, amount_claimed, currency, status) VALUES ($1, '250.0000', 'USD', 'open') RETURNING id`,
      [clientId],
    );
    return rows[0]!.id;
  }

  function deps(adapter: StandInExportAdapter) {
    return {
      registry: new ExportAdapterRegistry([adapter]),
      recordAcknowledgement: recordExportAcknowledgement,
    };
  }

  it('re-delivery of an ACKNOWLEDGED job does not create a second reconciliation row', async () => {
    const outcome = await withTenantTx({ clientIds: [clientId] }, async (client) => {
      const claimId = await seedClaim(client);
      const adapter = new StandInExportAdapter('TESTERP');
      const payload = {
        schemaVersion: 1 as const,
        clientId,
        idempotencyKey: `dk-${tag}-redelivery`,
        requestedAt: new Date().toISOString(),
        claimId,
        paymentGateDecisionId: null,
        systemCode: 'TESTERP',
        payload: {},
      };

      await handleExportRecordJob(client, payload, deps(adapter));
      await handleExportRecordJob(client, payload, deps(adapter));

      const rows = await client.query(
        `SELECT status FROM export_acknowledgement WHERE client_id = $1 AND dedupe_key = $2`,
        [clientId, `dk-${tag}-redelivery`],
      );
      return { rowCount: rows.rows.length, adapterEffectCount: adapter.effectCount };
    });

    expect(outcome.rowCount).toBe(1);
    expect(outcome.adapterEffectCount).toBe(1);
  });

  it('persists a FAILED reconciliation record and throws so the queue retries', async () => {
    const outcome = await withTenantTx({ clientIds: [clientId] }, async (client) => {
      const claimId = await seedClaim(client);
      const adapter = new StandInExportAdapter('TESTERP');
      const payload = {
        schemaVersion: 1 as const,
        clientId,
        idempotencyKey: `dk-${tag}-fail`,
        requestedAt: new Date().toISOString(),
        claimId,
        paymentGateDecisionId: null,
        systemCode: 'TESTERP',
        payload: { simulateFailure: true },
      };

      let thrown: unknown;
      try {
        await handleExportRecordJob(client, payload, deps(adapter));
      } catch (error) {
        thrown = error;
      }

      const rows = await client.query(
        `SELECT status, reason FROM export_acknowledgement WHERE client_id = $1 AND dedupe_key = $2`,
        [clientId, `dk-${tag}-fail`],
      );
      return { thrown, row: rows.rows[0] };
    });

    expect(outcome.thrown).toBeInstanceOf(ExportRecordFailedError);
    expect(outcome.row.status).toBe('FAILED');
    expect(outcome.row.reason).toBe('SIMULATED_FAILURE');
  });

  it('does not persist a reconciliation record for an unregistered systemCode (NOT_CONFIGURED)', async () => {
    const outcome = await withTenantTx({ clientIds: [clientId] }, async (client) => {
      const claimId = await seedClaim(client);
      const adapter = new StandInExportAdapter('TESTERP');
      const payload = {
        schemaVersion: 1 as const,
        clientId,
        idempotencyKey: `dk-${tag}-notconfigured`,
        requestedAt: new Date().toISOString(),
        claimId,
        paymentGateDecisionId: null,
        systemCode: 'UNREGISTERED_SYSTEM',
        payload: {},
      };

      await expect(handleExportRecordJob(client, payload, deps(adapter))).resolves.toBeUndefined();

      const rows = await client.query(
        `SELECT 1 FROM export_acknowledgement WHERE client_id = $1 AND dedupe_key = $2`,
        [clientId, `dk-${tag}-notconfigured`],
      );
      return rows.rows.length;
    });

    expect(outcome).toBe(0);
  });
});
