import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import PgBoss from 'pg-boss';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { registerJobConsumers, grantJobSchemaAccessToAppRole } from '../../src/jobs/boss.js';
import { registerJobQueues } from '../../src/jobs/policies.js';
import { enqueueInTransaction } from '../../src/jobs/enqueue.js';
import { JOB_NAMES } from '../../src/jobs/contracts.js';
import { requireDatabaseUrl } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * 86e32tfx6: DISCOVER_TRIGGERS_V1's real enqueue-to-processed round trip,
 * mirroring workflow-command-job-pipeline.db.test.ts's own rationale -- a
 * mocked test asserting `.work()` was registered proves nothing about
 * whether the real handler ever runs. This exercises the genuine path: a
 * real PgBoss instance against a real (ephemeral, local) Postgres,
 * enqueueInTransaction sending the job through a tenant-scoped transaction,
 * then registerJobConsumers's real .work() consumer picking it up and
 * running the real handleDiscoverTriggersJob, which fans out to all three
 * audit-run-scoped detectors -- verified by the unknown_charge_code_trigger
 * row and its unknown_charge_code_detected audit_event, which
 * detectUnknownChargeCodeTriggers only writes once it actually runs.
 *
 * Teardown is deepest-child-first (audit_event/unknown_charge_code_trigger/
 * charge_fact/audit_run all reference invoice or client), the recurring
 * FK-order defect class tracked at 86e30txkx.
 */
describe.skipIf(!DATABASE_URL)('discover-triggers job pipeline (database)', () => {
  const tag = `discover-triggers-pipeline-${Date.now()}`;
  let boss: PgBoss;
  let clientId: string;
  let invoiceId: string;
  let auditRunId: string;

  beforeAll(async () => {
    boss = new PgBoss({ connectionString: requireDatabaseUrl(), schema: 'pgboss' });
    await boss.start();
    await registerJobQueues(boss);
    await grantJobSchemaAccessToAppRole(boss);
    await registerJobConsumers(boss);

    clientId = (await getPool().query(
      `INSERT INTO client (name, slug) VALUES ('Discover Triggers Pipeline Co', $1) RETURNING id`,
      [tag],
    )).rows[0].id;
    invoiceId = (await getPool().query(
      `INSERT INTO invoice (client_id, transaction_set, invoice_number, currency, parser_version)
       VALUES ($1, '210', $2, 'USD', 'test') RETURNING id`,
      [clientId, `INV-${tag}`],
    )).rows[0].id;
    auditRunId = (await getPool().query(
      `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
      [clientId, invoiceId],
    )).rows[0].id;
    // category IS NULL deterministically gives detectUnknownChargeCodeTriggers
    // something to find -- same trick rerun-discovery-for-amendment.db.test.ts
    // uses -- so the pipeline test has a real, checkable side effect to poll for.
    await getPool().query(
      `INSERT INTO charge_fact (client_id, invoice_id, code, category, amount, currency) VALUES ($1, $2, 'XYZ', NULL, 10, 'USD')`,
      [clientId, invoiceId],
    );
  });

  afterAll(async () => {
    await boss.stop({ graceful: false, close: true });
    await getPool().query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM unknown_charge_code_trigger WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM charge_fact WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM audit_run WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM invoice WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM client WHERE id = $1`, [clientId]);
    await closePool();
  });

  it('enqueues a real DISCOVER_TRIGGERS_V1 job and the real worker runs all three detectors end to end', async () => {
    const enqueueResult = await withTenantTx({ clientIds: [clientId] }, (client) =>
      enqueueInTransaction(boss, client, clientId, JOB_NAMES.DISCOVER_TRIGGERS_V1, {
        schemaVersion: 1,
        clientId,
        idempotencyKey: `discover-${tag}`,
        requestedAt: new Date().toISOString(),
        auditRunId,
      }));
    expect(enqueueResult.inserted).toBe(true);

    // Poll for the real worker (registered above via registerJobConsumers,
    // running its own fetch loop) to have processed the job and
    // detectUnknownChargeCodeTriggers to have written its audit_event side
    // effect -- proof the handler actually ran, not just that .work() was
    // registered.
    const deadline = Date.now() + 15_000;
    let found = false;
    while (Date.now() < deadline && !found) {
      const { rows } = await getPool().query(
        `SELECT 1 FROM audit_event WHERE client_id = $1 AND entity = 'unknown_charge_code_trigger' AND entity_id = $2 AND event = 'unknown_charge_code_detected'`,
        [clientId, auditRunId],
      );
      found = rows.length > 0;
      if (!found) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(found).toBe(true);

    const { rows: triggerRows } = await getPool().query(
      `SELECT source_code FROM unknown_charge_code_trigger WHERE client_id = $1 AND audit_run_id = $2`,
      [clientId, auditRunId],
    );
    expect(triggerRows).toHaveLength(1);
    expect(triggerRows[0].source_code).toBe('XYZ');

    // The other two audit-run-scoped detectors ran too (zero-result case,
    // since no variance_finding/gate_failure/coverage_marker rows exist for
    // this run) -- their own summary audit_events are the proof they were
    // actually invoked, not skipped.
    const { rows: unassessableEvent } = await getPool().query(
      `SELECT 1 FROM audit_event WHERE client_id = $1 AND entity = 'discovery_trigger' AND entity_id = $2 AND event = 'unassessable_detected'`,
      [clientId, auditRunId],
    );
    expect(unassessableEvent).toHaveLength(1);

    const { rows: suspiciousPassEvent } = await getPool().query(
      `SELECT 1 FROM audit_event WHERE client_id = $1 AND entity = 'suspicious_pass_trigger' AND entity_id = $2`,
      [clientId, auditRunId],
    );
    expect(suspiciousPassEvent.length).toBeGreaterThanOrEqual(1);
  }, 20_000);
});
