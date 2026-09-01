import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { claimDueWorkflowCommands, completeWorkflowCommand } from '../../src/modules/workflow/claim-due-workflow-commands.js';
import {
  claimDueOutboxMessages,
  completeOutboxMessage,
  recordOutboxMessage,
  RecordOutboxMessageError,
} from '../../src/modules/workflow/workflow-outbox.js';

/**
 * 86e2zfh49: transactional command/outbox delivery (P4.A.5), the primitive
 * 0053/P4.A.3's own header comment names as workflow_command's consumer
 * ("it is not transactional outbox delivery (P4.A.5) -- those consume this
 * table, they are not built here").
 *
 * Teardown is deepest-child-first (86e30txkx's tracked FK-order defect
 * class): workflow_outbox_message -> workflow_command -> audit_event ->
 * workflow_instance -> client.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('workflow_outbox_message (database)', () => {
  const clientId = randomUUID();
  const workflowInstanceId = randomUUID();

  beforeAll(async () => {
    await getPool().query(
      `INSERT INTO client (id, name, slug) VALUES ($1, 'Workflow Outbox Co', $2)`,
      [clientId, `workflow-outbox-${clientId}`],
    );
    await getPool().query(
      `INSERT INTO workflow_instance (id, client_id, workflow_type, subject_entity, subject_entity_id, current_state)
       VALUES ($1, $2, 'dispute_resolution', 'dispute', $3, 'awaiting_response')`,
      [workflowInstanceId, clientId, randomUUID()],
    );
  });

  afterAll(async () => {
    await getPool().query(`DELETE FROM workflow_outbox_message WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM workflow_command WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
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

  it('records a message, is idempotent on retry, and is claimable once recorded', async () => {
    const commandId = await seedCommand();
    const dedupeKey = `notify:${commandId}`;

    const first = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      recordOutboxMessage(client, { clientId, workflowInstanceId, commandId, dedupeKey, payload: { to: 'carrier@example.com' } }));
    expect(first.created).toBe(true);

    const retry = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      recordOutboxMessage(client, { clientId, workflowInstanceId, commandId, dedupeKey, payload: { to: 'carrier@example.com' } }));
    expect(retry).toEqual({ outboxMessageId: first.outboxMessageId, created: false });

    const claimed = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      claimDueOutboxMessages(client, { clientId }));
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.outboxMessageId).toBe(first.outboxMessageId);
    expect(claimed[0]!.attempts).toBe(1);

    const claimedAgain = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      claimDueOutboxMessages(client, { clientId }));
    expect(claimedAgain).toHaveLength(0);

    const completed = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      completeOutboxMessage(client, { clientId, outboxMessageId: first.outboxMessageId }));
    expect(completed).toEqual({ found: true });
  });

  it(
    'records the outbox message transactionally with the command\'s own completion: ' +
    'a rollback loses both, a commit keeps both -- proving the decision to deliver is exactly-once',
    async () => {
      const commandId = await seedCommand();
      const dedupeKey = `notify:${commandId}:rollback-case`;
      await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
        claimDueWorkflowCommands(client, { clientId }));

      // Simulate a handler that records its delivery intent, then completes
      // the command, then the surrounding transaction fails before commit
      // (e.g. a later step in the same handler throws). Both writes must
      // roll back together -- there must be no orphaned outbox row for a
      // command that was never actually completed.
      await expect(
        withTenantTx({ clientIds: [clientId], internal: false }, async (client) => {
          await recordOutboxMessage(client, { clientId, workflowInstanceId, commandId, dedupeKey });
          await completeWorkflowCommand(client, { clientId, commandId });
          throw new Error('simulated failure after both writes, before commit');
        }),
      ).rejects.toThrow('simulated failure after both writes, before commit');

      const outboxAfterRollback = await getPool().query(
        `SELECT id FROM workflow_outbox_message WHERE client_id = $1 AND dedupe_key = $2`,
        [clientId, dedupeKey],
      );
      expect(outboxAfterRollback.rows).toHaveLength(0);

      const commandAfterRollback = await getPool().query(
        `SELECT status FROM workflow_command WHERE id = $1`,
        [commandId],
      );
      expect(commandAfterRollback.rows[0].status).toBe('claimed');

      // Same sequence, this time committing: both the outbox row and the
      // command completion land together.
      const result = await withTenantTx({ clientIds: [clientId], internal: false }, async (client) => {
        const outbox = await recordOutboxMessage(client, { clientId, workflowInstanceId, commandId, dedupeKey });
        await completeWorkflowCommand(client, { clientId, commandId });
        return outbox;
      });

      const outboxAfterCommit = await getPool().query(
        `SELECT status FROM workflow_outbox_message WHERE id = $1`,
        [result.outboxMessageId],
      );
      expect(outboxAfterCommit.rows[0].status).toBe('pending');

      const commandAfterCommit = await getPool().query(
        `SELECT status FROM workflow_command WHERE id = $1`,
        [commandId],
      );
      expect(commandAfterCommit.rows[0].status).toBe('done');
    },
  );

  it('fails closed for an outbox message referencing an unknown command_id', async () => {
    await expect(
      withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
        recordOutboxMessage(client, {
          clientId,
          workflowInstanceId,
          commandId: '00000000-0000-0000-0000-000000000000',
          dedupeKey: 'notify:unknown-command',
        })),
    ).rejects.toBeInstanceOf(RecordOutboxMessageError);
  });
});
