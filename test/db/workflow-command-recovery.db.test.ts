import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { claimDueWorkflowCommands } from '../../src/modules/workflow/claim-due-workflow-commands.js';
import {
  reclaimStaleWorkflowCommands,
  reclaimStaleWorkflowCommandsForActiveClients,
} from '../../src/modules/workflow/reclaim-stale-workflow-commands.js';

/**
 * P4.A.7: recovers a workflow_command stranded in 'claimed' by a worker
 * process that crashed before completeWorkflowCommand ran -- the exact gap
 * schedule-workflow-command-jobs.ts's own docstring names and defers here.
 *
 * Teardown is deepest-child-first (86e30txkx's tracked FK-order defect
 * class): workflow_command -> audit_event -> workflow_instance -> client.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('reclaim stale workflow commands (database)', () => {
  const clientId = randomUUID();
  const workflowInstanceId = randomUUID();
  let reactivateOtherClientsAfter: string[] = [];

  beforeAll(async () => {
    await getPool().query(
      `INSERT INTO client (id, name, slug) VALUES ($1, 'Workflow Recovery Co', $2)`,
      [clientId, `workflow-recovery-${clientId}`],
    );
    await getPool().query(
      `INSERT INTO workflow_instance (id, client_id, workflow_type, subject_entity, subject_entity_id, current_state)
       VALUES ($1, $2, 'dispute_resolution', 'dispute', $3, 'awaiting_response')`,
      [workflowInstanceId, clientId, randomUUID()],
    );

    // reclaimStaleWorkflowCommandsForActiveClients scans every is_active client
    // (mirroring scheduleWorkflowCommandJobs's own scan) -- deactivate any other
    // active client already in this shared DB for the duration of this suite so
    // it only ever sees the one this test controls. Non-destructive: flipped
    // back in afterAll.
    const others = await getPool().query<{ id: string }>(
      `SELECT id FROM client WHERE is_active = true AND id != $1`,
      [clientId],
    );
    reactivateOtherClientsAfter = others.rows.map((row) => row.id);
    if (reactivateOtherClientsAfter.length > 0) {
      await getPool().query(`UPDATE client SET is_active = false WHERE id = ANY($1::uuid[])`, [reactivateOtherClientsAfter]);
    }
  });

  afterAll(async () => {
    await getPool().query(`DELETE FROM workflow_command WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM workflow_instance WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM client WHERE id = $1`, [clientId]);
    if (reactivateOtherClientsAfter.length > 0) {
      await getPool().query(`UPDATE client SET is_active = true WHERE id = ANY($1::uuid[])`, [reactivateOtherClientsAfter]);
    }
    await closePool();
  });

  async function seedClaimedCommand(opts: { attempts: number; claimedMinutesAgo: number }): Promise<string> {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO workflow_command (client_id, workflow_instance_id, command_type, payload, run_after, status, attempts, claimed_at)
       VALUES ($1, $2, 'send_reminder', '{}'::jsonb, now() - interval '1 hour', 'claimed', $3, now() - ($4 * interval '1 minute'))
       RETURNING id`,
      [clientId, workflowInstanceId, opts.attempts, opts.claimedMinutesAgo],
    );
    return rows[0]!.id;
  }

  it('leaves a recently-claimed command alone -- pg-boss retries get first chance', async () => {
    const commandId = await seedClaimedCommand({ attempts: 1, claimedMinutesAgo: 5 });

    const result = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      reclaimStaleWorkflowCommands(client, { clientId, staleAfterMinutes: 30 }));

    expect(result.find((r) => r.commandId === commandId)).toBeUndefined();

    const { rows } = await getPool().query(`SELECT status FROM workflow_command WHERE id = $1`, [commandId]);
    expect(rows[0].status).toBe('claimed');
  });

  it('reclaims a stale claim back to pending, clearing claimed_at, when attempts is under budget', async () => {
    const commandId = await seedClaimedCommand({ attempts: 2, claimedMinutesAgo: 45 });

    const result = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      reclaimStaleWorkflowCommands(client, { clientId, staleAfterMinutes: 30, maxAttempts: 5 }));

    expect(result).toEqual([
      { commandId, workflowInstanceId, attempts: 2, outcome: 'reclaimed' },
    ]);

    const { rows } = await getPool().query(
      `SELECT status, claimed_at FROM workflow_command WHERE id = $1`,
      [commandId],
    );
    expect(rows[0].status).toBe('pending');
    expect(rows[0].claimed_at).toBeNull();

    // Reclaimed to 'pending' means the normal due-query claims it again, fresh.
    const claimed = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      claimDueWorkflowCommands(client, { clientId }));
    expect(claimed.find((c) => c.commandId === commandId)?.attempts).toBe(3);
  });

  it('marks a stale claim failed instead of reclaiming it once attempts reaches maxAttempts', async () => {
    const commandId = await seedClaimedCommand({ attempts: 5, claimedMinutesAgo: 45 });

    const result = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      reclaimStaleWorkflowCommands(client, { clientId, staleAfterMinutes: 30, maxAttempts: 5 }));

    expect(result).toEqual([
      { commandId, workflowInstanceId, attempts: 5, outcome: 'failed' },
    ]);

    const { rows } = await getPool().query(
      `SELECT status, claimed_at FROM workflow_command WHERE id = $1`,
      [commandId],
    );
    expect(rows[0].status).toBe('failed');
    expect(rows[0].claimed_at).toBeNull();
  });

  it('reclaimStaleWorkflowCommandsForActiveClients writes an audit event per recovered command and tallies outcomes', async () => {
    const reclaimable = await seedClaimedCommand({ attempts: 1, claimedMinutesAgo: 45 });
    const dying = await seedClaimedCommand({ attempts: 5, claimedMinutesAgo: 45 });

    const result = await withTenantTx({ internal: true }, (client) =>
      reclaimStaleWorkflowCommandsForActiveClients(client));

    expect(result).toEqual({ reclaimed: 1, failed: 1 });

    const { rows: reclaimedEvents } = await getPool().query(
      `SELECT event FROM audit_event WHERE client_id = $1 AND entity_id = $2`,
      [clientId, reclaimable],
    );
    expect(reclaimedEvents.map((r) => r.event)).toContain('workflow.command_reclaimed');

    const { rows: failedEvents } = await getPool().query(
      `SELECT event FROM audit_event WHERE client_id = $1 AND entity_id = $2`,
      [clientId, dying],
    );
    expect(failedEvents.map((r) => r.event)).toContain('workflow.command_failed');
  });
});
