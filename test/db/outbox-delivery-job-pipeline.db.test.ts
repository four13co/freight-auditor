import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import PgBoss from 'pg-boss';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { registerJobConsumers, grantJobSchemaAccessToAppRole } from '../../src/jobs/boss.js';
import { registerJobQueues } from '../../src/jobs/policies.js';
import { scheduleOutboxDeliveryJobs } from '../../src/modules/workflow/schedule-outbox-delivery-jobs.js';
import { recordOutboxMessage } from '../../src/modules/workflow/workflow-outbox.js';
import { registerOutboxMessageSender, type OutboxMessageSender } from '../../src/jobs/deliver-outbox-message-handler.js';
import { deterministicJobId } from '../../src/jobs/enqueue.js';
import { JOB_NAMES } from '../../src/jobs/contracts.js';
import { requireDatabaseUrl } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * P4.A.6's real enqueue-to-delivered round trip, mirroring
 * workflow-command-job-pipeline.db.test.ts (P4.A.4) one level down the
 * pipeline: a real PgBoss instance against a real (ephemeral, local)
 * Postgres, scheduleOutboxDeliveryJobs claiming + enqueuing through
 * claimDueOutboxMessages and enqueueInTransaction, then
 * registerJobConsumers's real .work() consumer picking the job up and
 * running the real handleDeliverOutboxMessageJob -- verified by the
 * workflow_outbox_message.status flip and the workflow.outbox_message_sent
 * audit_event it writes.
 *
 * No concrete message_type exists yet (0065/P4.A.6's own design, same as
 * command_type's "concrete types land with their owning phase"), so this
 * suite registers a throwaway test-only sender via registerOutboxMessageSender
 * for the duration of the run -- the same extension point a future phase's
 * real external effect will use. The sender it registers records the
 * idempotencyKey it was called with, proving that value is stable (the
 * message's own dedupeKey) across the real pipeline, not just in the unit
 * test's mocks.
 *
 * Teardown is deepest-child-first (86e30txkx's tracked FK-order defect
 * class): workflow_outbox_message -> workflow_command -> audit_event ->
 * workflow_instance -> client.
 */
describe.skipIf(!DATABASE_URL)('outbox delivery job pipeline (database)', () => {
  const tag = `outbox-delivery-pipeline-${Date.now()}`;
  const TEST_MESSAGE_TYPE = 'pipeline_test_message';
  let boss: PgBoss;
  let clientId: string;
  let workflowInstanceId: string;
  let reactivateOtherClientsAfter: string[] = [];
  let sentMessages: Array<{ clientId: string; idempotencyKey: string; payload: Record<string, unknown> }>;

  beforeAll(async () => {
    const sender: OutboxMessageSender = async (_client, ctx) => {
      sentMessages.push({ clientId: ctx.clientId, idempotencyKey: ctx.idempotencyKey, payload: ctx.payload });
    };
    registerOutboxMessageSender(TEST_MESSAGE_TYPE, sender);

    boss = new PgBoss({ connectionString: requireDatabaseUrl(), schema: 'pgboss' });
    await boss.start();
    await registerJobQueues(boss);
    await grantJobSchemaAccessToAppRole(boss);
    await registerJobConsumers(boss);

    clientId = (await getPool().query(
      `INSERT INTO client (name, slug) VALUES ('Outbox Delivery Pipeline Co', $1) RETURNING id`,
      [tag],
    )).rows[0].id;
    workflowInstanceId = (await getPool().query(
      `INSERT INTO workflow_instance (client_id, workflow_type, subject_entity, subject_entity_id, current_state)
       VALUES ($1, 'dispute_resolution', 'dispute', $2, 'awaiting_response') RETURNING id`,
      [clientId, randomUUID()],
    )).rows[0].id;

    // scheduleOutboxDeliveryJobs scans every is_active client -- deactivate
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
    sentMessages = [];
  });

  afterEach(async () => {
    await getPool().query(`DELETE FROM workflow_outbox_message WHERE client_id = $1`, [clientId]);
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

  async function seedCommand(): Promise<string> {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO workflow_command (client_id, workflow_instance_id, command_type, run_after)
       VALUES ($1, $2, 'notify_carrier', now() - interval '1 minute') RETURNING id`,
      [clientId, workflowInstanceId],
    );
    return rows[0]!.id;
  }

  async function seedDueMessage(commandId: string, dedupeKey: string, payload: Record<string, unknown> = {}): Promise<string> {
    const result = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      recordOutboxMessage(client, {
        clientId,
        workflowInstanceId,
        commandId,
        dedupeKey,
        payload,
        messageType: TEST_MESSAGE_TYPE,
      }));
    return result.outboxMessageId;
  }

  it('claims a due message, enqueues it, and the real worker delivers it end to end with the dedupeKey as idempotencyKey', async () => {
    const commandId = await seedCommand();
    const dedupeKey = `notify:${commandId}`;
    const outboxMessageId = await seedDueMessage(commandId, dedupeKey, { note: 'hello' });

    const scanResult = await withTenantTx({ internal: true }, (client) =>
      scheduleOutboxDeliveryJobs(client, boss, new Date()));
    expect(scanResult.enqueued).toBe(1);

    const deadline = Date.now() + 15_000;
    let found = false;
    while (Date.now() < deadline && !found) {
      const { rows } = await getPool().query(
        `SELECT 1 FROM audit_event WHERE client_id = $1 AND entity = 'workflow_outbox_message' AND entity_id = $2 AND event = 'workflow.outbox_message_sent'`,
        [clientId, outboxMessageId],
      );
      found = rows.length > 0;
      if (!found) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(found).toBe(true);

    expect(sentMessages).toContainEqual(
      expect.objectContaining({ clientId, idempotencyKey: dedupeKey, payload: { note: 'hello' } }),
    );

    const { rows: messageRows } = await getPool().query(
      `SELECT status FROM workflow_outbox_message WHERE id = $1`,
      [outboxMessageId],
    );
    expect(messageRows[0].status).toBe('delivered');
  }, 20_000);

  it('does not enqueue a duplicate delivery job for a message already claimed by an in-flight scan', async () => {
    const commandId = await seedCommand();
    const dedupeKey = `notify:${commandId}`;
    await seedDueMessage(commandId, dedupeKey);

    const first = await withTenantTx({ internal: true }, (client) =>
      scheduleOutboxDeliveryJobs(client, boss, new Date()));
    const second = await withTenantTx({ internal: true }, (client) =>
      scheduleOutboxDeliveryJobs(client, boss, new Date()));

    expect(first.enqueued).toBe(1);
    // The second scan finds nothing to claim -- claimDueOutboxMessages's
    // UPDATE...RETURNING already flipped the row to 'claimed', so it is no
    // longer selected by `status = 'pending'`. This is the primary
    // duplicate guard; the deterministic job id below is defense in depth.
    expect(second.enqueued).toBe(0);

    const expectedJobId = deterministicJobId(JOB_NAMES.DELIVER_OUTBOX_MESSAGE_V1, clientId, dedupeKey);
    const jobs = await getPool().query(
      `SELECT count(*)::int AS count FROM pgboss.job WHERE name = $1 AND id = $2`,
      ['freight.workflow.deliver-outbox-message.v1', expectedJobId],
    );
    expect(jobs.rows[0].count).toBe(1);
  });
});
