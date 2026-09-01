import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import PgBoss from 'pg-boss';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { registerJobConsumers, grantJobSchemaAccessToAppRole } from '../../src/jobs/boss.js';
import { registerJobQueues } from '../../src/jobs/policies.js';
import { scheduleWorkflowCommandJobs } from '../../src/modules/workflow/schedule-workflow-command-jobs.js';
import { registerWorkflowCommandHandler, type WorkflowCommandHandler } from '../../src/jobs/run-workflow-command-handler.js';
import { deterministicJobId } from '../../src/jobs/enqueue.js';
import { JOB_NAMES } from '../../src/jobs/contracts.js';
import { requireDatabaseUrl } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * P4.A.4's real enqueue-to-processed round trip, mirroring
 * claim-aging-job-pipeline.db.test.ts's own rationale: a mocked test
 * asserting `.work()` was registered proves nothing about whether the real
 * handler ever runs (Review rejected exactly that shortcut for the claims
 * pipeline, PR #211). This exercises the genuine path: a real PgBoss
 * instance against a real (ephemeral, local) Postgres, scheduleWorkflow-
 * CommandJobs claiming + enqueuing through claimDueWorkflowCommands and
 * enqueueInTransaction, then registerJobConsumers's real .work() consumer
 * picking the job up and running the real handleRunWorkflowCommandJob --
 * verified by the workflow_command.status flip and the workflow.command_run
 * audit_event it writes.
 *
 * No concrete command_type exists yet (0053/P4.A.3's own design), so this
 * suite registers a throwaway test-only handler via
 * registerWorkflowCommandHandler for the duration of the run -- the same
 * extension point a future phase's real command type will use.
 *
 * Teardown is deepest-child-first (audit_event and workflow_command both
 * reference workflow_instance/client) -- the recurring FK-order defect
 * class tracked at 86e30txkx (seen repeatedly across this repo's db tests).
 */
describe.skipIf(!DATABASE_URL)('workflow command job pipeline (database)', () => {
  const tag = `workflow-command-pipeline-${Date.now()}`;
  const TEST_COMMAND_TYPE = 'pipeline_test_command';
  let boss: PgBoss;
  let clientId: string;
  let workflowInstanceId: string;
  let reactivateOtherClientsAfter: string[] = [];
  let handledPayloads: Array<{ clientId: string; workflowInstanceId: string; payload: Record<string, unknown> }>;

  beforeAll(async () => {
    const handler: WorkflowCommandHandler = async (_client, ctx) => {
      handledPayloads.push({ clientId: ctx.clientId, workflowInstanceId: ctx.workflowInstanceId, payload: ctx.payload });
    };
    registerWorkflowCommandHandler(TEST_COMMAND_TYPE, handler);

    boss = new PgBoss({ connectionString: requireDatabaseUrl(), schema: 'pgboss' });
    await boss.start();
    await registerJobQueues(boss);
    await grantJobSchemaAccessToAppRole(boss);
    await registerJobConsumers(boss);

    clientId = (await getPool().query(
      `INSERT INTO client (name, slug) VALUES ('Workflow Runner Pipeline Co', $1) RETURNING id`,
      [tag],
    )).rows[0].id;
    workflowInstanceId = (await getPool().query(
      `INSERT INTO workflow_instance (client_id, workflow_type, subject_entity, subject_entity_id, current_state)
       VALUES ($1, 'dispute_resolution', 'dispute', $2, 'awaiting_response') RETURNING id`,
      [clientId, randomUUID()],
    )).rows[0].id;

    // scheduleWorkflowCommandJobs scans every is_active client -- deactivate
    // any other active client already in this shared DB for the duration of
    // this suite so the scan sees only the one this test controls.
    // Non-destructive: flipped back in afterAll.
    const others = await getPool().query<{ id: string }>(
      `SELECT id FROM client WHERE is_active = true AND id != $1`,
      [clientId],
    );
    reactivateOtherClientsAfter = others.rows.map((row) => row.id);
    if (reactivateOtherClientsAfter.length > 0) {
      await getPool().query(`UPDATE client SET is_active = false WHERE id = ANY($1::uuid[])`, [reactivateOtherClientsAfter]);
    }
  });

  beforeEach(() => {
    handledPayloads = [];
  });

  afterEach(async () => {
    await getPool().query(`DELETE FROM workflow_command WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
  });

  afterAll(async () => {
    await boss.stop({ graceful: false, close: true });
    if (reactivateOtherClientsAfter.length > 0) {
      await getPool().query(`UPDATE client SET is_active = true WHERE id = ANY($1::uuid[])`, [reactivateOtherClientsAfter]);
    }
    await getPool().query(`DELETE FROM workflow_instance WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM client WHERE id = $1`, [clientId]);
    await closePool();
  });

  async function seedDueCommand(payload: Record<string, unknown> = {}): Promise<string> {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO workflow_command (client_id, workflow_instance_id, command_type, payload, run_after)
       VALUES ($1, $2, $3, $4::jsonb, now() - interval '1 minute') RETURNING id`,
      [clientId, workflowInstanceId, TEST_COMMAND_TYPE, JSON.stringify(payload)],
    );
    return rows[0]!.id;
  }

  it('claims a due command, enqueues it, and the real worker runs it end to end', async () => {
    const commandId = await seedDueCommand({ note: 'hello' });

    const scanResult = await withTenantTx({ internal: true }, (client) =>
      scheduleWorkflowCommandJobs(client, boss, new Date()));
    expect(scanResult.enqueued).toBe(1);

    // Poll for the real worker (registered above via registerJobConsumers,
    // running its own fetch loop) to have processed the job and the
    // handler to have written its audit_event side effect.
    const deadline = Date.now() + 15_000;
    let found = false;
    while (Date.now() < deadline && !found) {
      const { rows } = await getPool().query(
        `SELECT 1 FROM audit_event WHERE client_id = $1 AND entity = 'workflow_command' AND entity_id = $2 AND event = 'workflow.command_run'`,
        [clientId, commandId],
      );
      found = rows.length > 0;
      if (!found) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(found).toBe(true);

    expect(handledPayloads).toContainEqual(
      expect.objectContaining({ clientId, workflowInstanceId, payload: { note: 'hello' } }),
    );

    const { rows: commandRows } = await getPool().query(
      `SELECT status FROM workflow_command WHERE id = $1`,
      [commandId],
    );
    expect(commandRows[0].status).toBe('done');
  }, 20_000);

  it('does not enqueue a duplicate run job for a command already claimed by an in-flight scan', async () => {
    const commandId = await seedDueCommand();

    const first = await withTenantTx({ internal: true }, (client) =>
      scheduleWorkflowCommandJobs(client, boss, new Date()));
    const second = await withTenantTx({ internal: true }, (client) =>
      scheduleWorkflowCommandJobs(client, boss, new Date()));

    expect(first.enqueued).toBe(1);
    // The second scan finds nothing to claim -- claimDueWorkflowCommands's
    // UPDATE...RETURNING already flipped the row to 'claimed', so it is no
    // longer selected by `status = 'pending'`. This is the primary
    // duplicate guard; the deterministic job id below is defense in depth.
    expect(second.enqueued).toBe(0);

    // attempts is 1 after this command's single claim above (claimDueWorkflowCommands
    // increments attempts at claim time) -- the idempotencyKey folds attempts in so a
    // later reclaim (P4.A.7) gets a fresh job id instead of colliding with this one.
    const expectedJobId = deterministicJobId(JOB_NAMES.RUN_WORKFLOW_COMMAND_V1, clientId, `workflow-command:${commandId}:1`);
    const jobs = await getPool().query(
      `SELECT count(*)::int AS count FROM pgboss.job WHERE name = $1 AND id = $2`,
      ['freight.workflow.run-command.v1', expectedJobId],
    );
    expect(jobs.rows[0].count).toBe(1);
  });
});
