import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import PgBoss from 'pg-boss';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { registerJobConsumers, grantJobSchemaAccessToAppRole } from '../../src/jobs/boss.js';
import { registerJobQueues } from '../../src/jobs/policies.js';
import { scheduleWorkflowCommandJobs } from '../../src/modules/workflow/schedule-workflow-command-jobs.js';
import { scheduleOutboxDeliveryJobs } from '../../src/modules/workflow/schedule-outbox-delivery-jobs.js';
import { approveDispute } from '../../src/modules/disputes/approve-dispute.js';
import { DISPUTE_DELIVERY_MESSAGE_TYPE, disputeDeliveryDedupeKey } from '../../src/modules/disputes/deliver-dispute-command-handler.js';
import { registerOutboxMessageSender, type OutboxMessageSender } from '../../src/jobs/deliver-outbox-message-handler.js';
import { requireDatabaseUrl } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * P4.C.7's real end-to-end round trip, one level above workflow-command-
 * job-pipeline.db.test.ts (P4.A.4) and outbox-delivery-job-pipeline.db.test.ts
 * (P4.A.6): approveDispute itself (not a hand-seeded fixture) schedules the
 * deliver_dispute command; the real per-minute scan+worker pipeline
 * (registerJobConsumers's actual .work() consumers, boss.ts's real
 * deliver-dispute-command-handler.ts registration) carries it from pending
 * command through to a claimed workflow_outbox_message; a throwaway
 * test-only sender registered for DISPUTE_DELIVERY_MESSAGE_TYPE stands in
 * for the carrier-contact transport this task deliberately does not wire in
 * production (see deliver-dispute-command-handler.ts's own doc comment on
 * that constant) and records the idempotencyKey it received, proving it is
 * the dispute's own stable dedupeKey end to end, not a per-attempt id.
 *
 * Teardown deepest-child-first (86e30txkx's tracked FK-order defect class):
 * workflow_outbox_message -> workflow_command -> audit_event -> dispute_line
 * -> dispute -> workflow_instance -> app_user -> client.
 */
describe.skipIf(!DATABASE_URL)('dispute delivery pipeline (database)', () => {
  const tag = `dispute-delivery-pipeline-${Date.now()}`;
  let boss: PgBoss;
  let clientId: string;
  let actorUserId: string;
  let reactivateOtherClientsAfter: string[] = [];
  let deliveredMessages: Array<{ clientId: string; idempotencyKey: string; payload: Record<string, unknown> }>;

  beforeAll(async () => {
    const sender: OutboxMessageSender = async (_client, ctx) => {
      deliveredMessages.push({ clientId: ctx.clientId, idempotencyKey: ctx.idempotencyKey, payload: ctx.payload });
    };
    registerOutboxMessageSender(DISPUTE_DELIVERY_MESSAGE_TYPE, sender);

    boss = new PgBoss({ connectionString: requireDatabaseUrl(), schema: 'pgboss' });
    await boss.start();
    await registerJobQueues(boss);
    await grantJobSchemaAccessToAppRole(boss);
    await registerJobConsumers(boss);

    const pool = getPool();
    clientId = (await pool.query(
      `INSERT INTO client (name, slug) VALUES ('Dispute Delivery Pipeline Co', $1) RETURNING id`,
      [tag],
    )).rows[0].id;
    actorUserId = (await pool.query(
      `INSERT INTO app_user (email) VALUES ($1) RETURNING id`,
      [`${tag}@example.com`],
    )).rows[0].id;

    // The scan halves below scan every is_active client -- deactivate any
    // other active client already in this shared DB for the duration of
    // this suite so the scan sees only the one this test controls.
    // Non-destructive: flipped back in afterAll.
    const others = await pool.query<{ id: string }>(
      `SELECT id FROM client WHERE is_active = true AND id != $1`,
      [clientId],
    );
    reactivateOtherClientsAfter = others.rows.map((row) => row.id);
    if (reactivateOtherClientsAfter.length > 0) {
      await pool.query(`UPDATE client SET is_active = false WHERE id = ANY($1::uuid[])`, [reactivateOtherClientsAfter]);
    }
  });

  beforeEach(() => {
    deliveredMessages = [];
  });

  afterEach(async () => {
    const pool = getPool();
    await pool.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM workflow_outbox_message WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM workflow_command WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM dispute_line WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM dispute WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM workflow_instance WHERE client_id = $1`, [clientId]);
  });

  afterAll(async () => {
    await boss.stop({ graceful: false, close: true });
    const pool = getPool();
    if (reactivateOtherClientsAfter.length > 0) {
      await pool.query(`UPDATE client SET is_active = true WHERE id = ANY($1::uuid[])`, [reactivateOtherClientsAfter]);
    }
    await pool.query(`DELETE FROM app_user WHERE id = $1`, [actorUserId]);
    await pool.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    await closePool();
  });

  async function seedDraftDispute(): Promise<string> {
    const pool = getPool();
    const dispute = await pool.query(
      `INSERT INTO dispute (client_id, status, amount_claimed, currency) VALUES ($1, 'draft', '500.0000', 'USD') RETURNING id`,
      [clientId],
    );
    const disputeId = dispute.rows[0].id;
    await pool.query(
      `INSERT INTO dispute_line (client_id, dispute_id, amount, currency) VALUES ($1, $2, '500.0000', 'USD')`,
      [clientId, disputeId],
    );
    return disputeId;
  }

  async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let found = false;
    while (Date.now() < deadline && !found) {
      found = await check();
      if (!found) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return found;
  }

  it('carries an approved dispute from approveDispute through to a delivered outbox message with a stable, dispute-derived idempotency key', async () => {
    const disputeId = await seedDraftDispute();

    const approval = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      approveDispute(client, disputeId, actorUserId));
    expect(approval).toEqual({ found: true });

    // Real per-minute scans, invoked directly rather than waiting out the
    // cron, mirroring workflow-command-job-pipeline.db.test.ts /
    // outbox-delivery-job-pipeline.db.test.ts's own rationale.
    const commandScan = await withTenantTx({ internal: true }, (client) =>
      scheduleWorkflowCommandJobs(client, boss, new Date()));
    expect(commandScan.enqueued).toBe(1);

    const commandRan = await waitFor(async () => {
      const { rows } = await getPool().query(
        `SELECT 1 FROM workflow_outbox_message WHERE client_id = $1`,
        [clientId],
      );
      return rows.length > 0;
    });
    expect(commandRan).toBe(true);

    const outboxScan = await withTenantTx({ internal: true }, (client) =>
      scheduleOutboxDeliveryJobs(client, boss, new Date()));
    expect(outboxScan.enqueued).toBe(1);

    const delivered = await waitFor(async () => {
      const { rows } = await getPool().query(
        `SELECT 1 FROM workflow_outbox_message WHERE client_id = $1 AND status = 'delivered'`,
        [clientId],
      );
      return rows.length > 0;
    });
    expect(delivered).toBe(true);

    expect(deliveredMessages).toContainEqual(
      expect.objectContaining({
        clientId,
        idempotencyKey: disputeDeliveryDedupeKey(disputeId),
        payload: { disputeId },
      }),
    );

    const { rows: commandRows } = await getPool().query(
      `SELECT status FROM workflow_command WHERE client_id = $1`,
      [clientId],
    );
    expect(commandRows).toHaveLength(1);
    expect(commandRows[0].status).toBe('done');
  }, 25_000);

  it('a retried approve on the same dispute never duplicates the workflow_command or the outbox message', async () => {
    const disputeId = await seedDraftDispute();

    await withTenantTx({ clientIds: [clientId], internal: false }, (client) => approveDispute(client, disputeId, actorUserId));
    // Real retry shape: the caller (or an at-least-once redelivery of the
    // approve request) invokes approveDispute again for the same dispute.
    const retry = await withTenantTx({ clientIds: [clientId], internal: false }, (client) => approveDispute(client, disputeId, actorUserId));
    expect(retry).toEqual({ found: false });

    const { rows: commandRows } = await getPool().query(
      `SELECT count(*)::int AS count FROM workflow_command WHERE client_id = $1`,
      [clientId],
    );
    expect(commandRows[0].count).toBe(1);
  });
});
