import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { scheduleWorkflowCommand } from '../../src/modules/workflow/schedule-workflow-command.js';
import { claimDueWorkflowCommands, completeWorkflowCommand } from '../../src/modules/workflow/claim-due-workflow-commands.js';

/**
 * Rebuild of a PR closed for a test-teardown FK-order bug (86e30txkx's
 * tracked defect class, 4th occurrence): the original afterAll deleted
 * workflow_command -> workflow_instance -> client, but never deleted
 * audit_event -- scheduleWorkflowCommand's writeAuditEvent call writes a
 * row referencing client_id, so deleting client while that row still
 * exists violates audit_event_client_id_fkey. Teardown here is
 * deepest-child-first: workflow_command -> audit_event -> workflow_instance
 * -> client.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('workflow_command (database)', () => {
  const clientId = randomUUID();
  const workflowInstanceId = randomUUID();

  beforeAll(async () => {
    await getPool().query(
      `INSERT INTO client (id, name, slug) VALUES ($1, 'Workflow Command Co', $2)`,
      [clientId, `workflow-command-${clientId}`],
    );
    await getPool().query(
      `INSERT INTO workflow_instance (id, client_id, workflow_type, subject_entity, subject_entity_id, current_state)
       VALUES ($1, $2, 'dispute_resolution', 'dispute', $3, 'awaiting_response')`,
      [workflowInstanceId, clientId, randomUUID()],
    );
  });

  afterAll(async () => {
    await getPool().query(`DELETE FROM workflow_command WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM workflow_instance WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM client WHERE id = $1`, [clientId]);
    await closePool();
  });

  it('schedules a command, is idempotent on retry, and is claimable once due', async () => {
    const runAfter = new Date(Date.now() - 1000);

    const first = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      scheduleWorkflowCommand(client, {
        clientId,
        workflowInstanceId,
        commandType: 'send_reminder',
        payload: { to: 'analyst@example.com' },
        runAfter,
      }));
    expect(first.created).toBe(true);

    const retry = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      scheduleWorkflowCommand(client, {
        clientId,
        workflowInstanceId,
        commandType: 'send_reminder',
        payload: { to: 'analyst@example.com' },
        runAfter,
      }));
    expect(retry).toEqual({ commandId: first.commandId, created: false });

    const claimed = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      claimDueWorkflowCommands(client, { clientId }));
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.commandId).toBe(first.commandId);
    expect(claimed[0]!.attempts).toBe(1);

    const claimedAgain = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      claimDueWorkflowCommands(client, { clientId }));
    expect(claimedAgain).toHaveLength(0);

    const completed = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      completeWorkflowCommand(client, { clientId, commandId: first.commandId }));
    expect(completed).toEqual({ found: true });
  });

  it('two concurrent calls with an identical dedupe key produce exactly one row (86e32tfwq)', async () => {
    const runAfter = new Date(Date.now() - 1000);
    const call = () => withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      scheduleWorkflowCommand(client, {
        clientId,
        workflowInstanceId,
        commandType: 'concurrent_probe',
        payload: {},
        runAfter,
      }));

    const [a, b] = await Promise.all([call(), call()]);
    expect(a.commandId).toBe(b.commandId);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);

    const rows = await getPool().query(
      `SELECT id FROM workflow_command WHERE client_id = $1 AND command_type = 'concurrent_probe'`,
      [clientId],
    );
    expect(rows.rowCount).toBe(1);
  });

  it('does not claim a command whose run_after is in the future', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      scheduleWorkflowCommand(client, {
        clientId,
        workflowInstanceId,
        commandType: 'escalate',
        runAfter: future,
      }));

    const claimed = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      claimDueWorkflowCommands(client, { clientId }));
    expect(claimed.find((c) => c.commandType === 'escalate')).toBeUndefined();
  });
});
