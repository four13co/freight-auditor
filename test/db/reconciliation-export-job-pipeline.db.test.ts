import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import PgBoss from 'pg-boss';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { registerJobConsumers, grantJobSchemaAccessToAppRole } from '../../src/jobs/boss.js';
import { registerJobQueues } from '../../src/jobs/policies.js';
import { scheduleReconciliationExportJobs } from '../../src/modules/claims/schedule-reconciliation-export-jobs.js';
import { requestReconciliationExport, getReconciliationExport } from '../../src/modules/claims/reconciliation-export.js';
import { deterministicJobId } from '../../src/jobs/enqueue.js';
import { JOB_NAMES } from '../../src/jobs/contracts.js';
import { requireDatabaseUrl } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * P5.C.5's real request-to-completed round trip, mirroring
 * outbox-delivery-job-pipeline.db.test.ts (P4.A.6) one level down the
 * pipeline: a real PgBoss instance against a real (ephemeral, local)
 * Postgres, scheduleReconciliationExportJobs claiming + enqueuing through
 * claimDueReconciliationExports and enqueueInTransaction, then
 * registerJobConsumers's real .work() consumer picking the job up and
 * running the real handleExportReconciliationJob (which itself calls the
 * real getPortfolioReconciliation, P5.C.4) -- verified by the
 * reconciliation_export.status flip to 'completed' with the real computed
 * result attached.
 *
 * Teardown is deepest-child-first: reconciliation_export -> recovery_event
 * -> claim -> client.
 */
describe.skipIf(!DATABASE_URL)('reconciliation export job pipeline (database)', () => {
  const tag = `reconciliation-export-pipeline-${Date.now()}`;
  let boss: PgBoss;
  let clientId: string;
  let reactivateOtherClientsAfter: string[] = [];

  beforeAll(async () => {
    boss = new PgBoss({ connectionString: requireDatabaseUrl(), schema: 'pgboss' });
    await boss.start();
    await registerJobQueues(boss);
    await grantJobSchemaAccessToAppRole(boss);
    await registerJobConsumers(boss);

    clientId = (await getPool().query(
      `INSERT INTO client (name, slug) VALUES ('Reconciliation Export Pipeline Co', $1) RETURNING id`,
      [tag],
    )).rows[0].id;

    // scheduleReconciliationExportJobs scans every is_active client -- deactivate
    // any other active client already in this shared DB for the duration of
    // this suite so the scan sees only the one this test controls.
    const others = await getPool().query<{ id: string }>(
      `SELECT id FROM client WHERE is_active = true AND id != $1`,
      [clientId],
    );
    reactivateOtherClientsAfter = others.rows.map((row) => row.id);
    if (reactivateOtherClientsAfter.length > 0) {
      await getPool().query(`UPDATE client SET is_active = false WHERE id = ANY($1::uuid[])`, [reactivateOtherClientsAfter]);
    }
  });

  afterEach(async () => {
    await getPool().query(`DELETE FROM reconciliation_export WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM recovery_event WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM claim WHERE client_id = $1`, [clientId]);
  });

  afterAll(async () => {
    await boss.stop({ graceful: false, close: true });
    if (reactivateOtherClientsAfter.length > 0) {
      await getPool().query(`UPDATE client SET is_active = true WHERE id = ANY($1::uuid[])`, [reactivateOtherClientsAfter]);
    }
    await getPool().query(`DELETE FROM client WHERE id = $1`, [clientId]);
    await closePool();
  });

  async function seedReconcilingClaim(): Promise<void> {
    const claimId = randomUUID();
    await getPool().query(
      `INSERT INTO claim (id, client_id, amount_claimed, currency, status) VALUES ($1, $2, '500.0000', 'USD', 'recovered')`,
      [claimId, clientId],
    );
    await getPool().query(
      `INSERT INTO recovery_event (client_id, claim_id, amount_recovered, currency) VALUES ($1, $2, '500.0000', 'USD')`,
      [clientId, claimId],
    );
  }

  it('claims a pending export, enqueues it, and the real worker completes it with the real computed reconciliation', async () => {
    await seedReconcilingClaim();
    const requested = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      requestReconciliationExport(client, { clientId, idempotencyKey: 'pipeline-req-1' }));

    const scanResult = await withTenantTx({ internal: true }, (client) =>
      scheduleReconciliationExportJobs(client, boss, new Date()));
    expect(scanResult.enqueued).toBe(1);

    const deadline = Date.now() + 15_000;
    let row = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      getReconciliationExport(client, { clientId, exportId: requested.exportId }));
    while (Date.now() < deadline && row?.status === 'claimed') {
      await new Promise((resolve) => setTimeout(resolve, 250));
      row = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
        getReconciliationExport(client, { clientId, exportId: requested.exportId }));
    }

    expect(row?.status).toBe('completed');
    expect(row?.result).toEqual([
      expect.objectContaining({ currency: 'USD', claimed: '500.0000', recovered: '500.0000', outstanding: '0.0000', reconciles: true }),
    ]);
  }, 20_000);

  it('does not enqueue a duplicate export job for a row already claimed by an in-flight scan', async () => {
    await seedReconcilingClaim();
    await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      requestReconciliationExport(client, { clientId, idempotencyKey: 'pipeline-req-dup' }));

    const first = await withTenantTx({ internal: true }, (client) =>
      scheduleReconciliationExportJobs(client, boss, new Date()));
    const second = await withTenantTx({ internal: true }, (client) =>
      scheduleReconciliationExportJobs(client, boss, new Date()));

    expect(first.enqueued).toBe(1);
    expect(second.enqueued).toBe(0);

    const expectedJobId = deterministicJobId(JOB_NAMES.EXPORT_RECONCILIATION_V1, clientId, 'pipeline-req-dup');
    const jobs = await getPool().query(
      `SELECT count(*)::int AS count FROM pgboss.job WHERE name = $1 AND id = $2`,
      ['freight.claims.export-reconciliation.v1', expectedJobId],
    );
    expect(jobs.rows[0].count).toBe(1);
  });
});
