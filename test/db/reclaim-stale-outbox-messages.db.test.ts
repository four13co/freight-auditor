import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { claimDueOutboxMessages } from '../../src/modules/workflow/workflow-outbox.js';
import {
  reclaimStaleOutboxMessages,
  reclaimStaleOutboxMessagesForActiveClients,
} from '../../src/modules/workflow/reclaim-stale-outbox-messages.js';

/**
 * P4.A.8: recovers a workflow_outbox_message stranded in 'claimed' by a
 * delivery worker that crashed before completeOutboxMessage ran -- the
 * identical gap reclaim-stale-workflow-commands closed for workflow_command
 * (P4.A.7), which schedule-outbox-delivery-jobs.ts's own docstring named
 * and deferred here.
 *
 * Teardown is deepest-child-first (86e30txkx's tracked FK-order defect
 * class): workflow_outbox_message -> workflow_command -> audit_event ->
 * workflow_instance -> client.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('reclaim stale outbox messages (database)', () => {
  const clientId = randomUUID();
  const workflowInstanceId = randomUUID();
  let commandId: string;
  let reactivateOtherClientsAfter: string[] = [];

  beforeAll(async () => {
    await getPool().query(
      `INSERT INTO client (id, name, slug) VALUES ($1, 'Outbox Recovery Co', $2)`,
      [clientId, `outbox-recovery-${clientId}`],
    );
    await getPool().query(
      `INSERT INTO workflow_instance (id, client_id, workflow_type, subject_entity, subject_entity_id, current_state)
       VALUES ($1, $2, 'dispute_resolution', 'dispute', $3, 'awaiting_response')`,
      [workflowInstanceId, clientId, randomUUID()],
    );
    commandId = (await getPool().query<{ id: string }>(
      `INSERT INTO workflow_command (client_id, workflow_instance_id, command_type, run_after)
       VALUES ($1, $2, 'notify_carrier', now() - interval '1 minute') RETURNING id`,
      [clientId, workflowInstanceId],
    )).rows[0]!.id;

    // reclaimStaleOutboxMessagesForActiveClients scans every is_active client
    // (mirroring scheduleOutboxDeliveryJobs's own scan) -- deactivate any other
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
    await getPool().query(`DELETE FROM workflow_outbox_message WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM workflow_command WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM workflow_instance WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM client WHERE id = $1`, [clientId]);
    if (reactivateOtherClientsAfter.length > 0) {
      await getPool().query(`UPDATE client SET is_active = true WHERE id = ANY($1::uuid[])`, [reactivateOtherClientsAfter]);
    }
    await closePool();
  });

  async function seedClaimedMessage(opts: { attempts: number; claimedMinutesAgo: number }): Promise<string> {
    const dedupeKey = `notify:${randomUUID()}`;
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO workflow_outbox_message (client_id, workflow_instance_id, command_id, dedupe_key, payload, status, attempts, claimed_at)
       VALUES ($1, $2, $3, $4, '{}'::jsonb, 'claimed', $5, now() - ($6 * interval '1 minute'))
       RETURNING id`,
      [clientId, workflowInstanceId, commandId, dedupeKey, opts.attempts, opts.claimedMinutesAgo],
    );
    return rows[0]!.id;
  }

  it('leaves a recently-claimed message alone -- pg-boss retries get first chance', async () => {
    const outboxMessageId = await seedClaimedMessage({ attempts: 1, claimedMinutesAgo: 5 });

    const result = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      reclaimStaleOutboxMessages(client, { clientId, staleAfterMinutes: 30 }));

    expect(result.find((r) => r.outboxMessageId === outboxMessageId)).toBeUndefined();

    const { rows } = await getPool().query(`SELECT status FROM workflow_outbox_message WHERE id = $1`, [outboxMessageId]);
    expect(rows[0].status).toBe('claimed');
  });

  it('reclaims a stale claim back to pending, clearing claimed_at, when attempts is under budget', async () => {
    const outboxMessageId = await seedClaimedMessage({ attempts: 2, claimedMinutesAgo: 45 });

    const result = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      reclaimStaleOutboxMessages(client, { clientId, staleAfterMinutes: 30, maxAttempts: 5 }));

    expect(result).toEqual([
      { outboxMessageId, workflowInstanceId, attempts: 2, outcome: 'reclaimed' },
    ]);

    const { rows } = await getPool().query(
      `SELECT status, claimed_at FROM workflow_outbox_message WHERE id = $1`,
      [outboxMessageId],
    );
    expect(rows[0].status).toBe('pending');
    expect(rows[0].claimed_at).toBeNull();

    // Reclaimed to 'pending' means the normal due-query claims it again, fresh.
    const claimed = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      claimDueOutboxMessages(client, { clientId }));
    expect(claimed.find((c) => c.outboxMessageId === outboxMessageId)?.attempts).toBe(3);
  });

  it('marks a stale claim failed instead of reclaiming it once attempts reaches maxAttempts', async () => {
    const outboxMessageId = await seedClaimedMessage({ attempts: 5, claimedMinutesAgo: 45 });

    const result = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      reclaimStaleOutboxMessages(client, { clientId, staleAfterMinutes: 30, maxAttempts: 5 }));

    expect(result).toEqual([
      { outboxMessageId, workflowInstanceId, attempts: 5, outcome: 'failed' },
    ]);

    const { rows } = await getPool().query(
      `SELECT status, claimed_at FROM workflow_outbox_message WHERE id = $1`,
      [outboxMessageId],
    );
    expect(rows[0].status).toBe('failed');
    expect(rows[0].claimed_at).toBeNull();
  });

  it('reclaimStaleOutboxMessagesForActiveClients writes an audit event per recovered message and tallies outcomes', async () => {
    const reclaimable = await seedClaimedMessage({ attempts: 1, claimedMinutesAgo: 45 });
    const dying = await seedClaimedMessage({ attempts: 5, claimedMinutesAgo: 45 });

    const result = await withTenantTx({ internal: true }, (client) =>
      reclaimStaleOutboxMessagesForActiveClients(client));

    expect(result).toEqual({ reclaimed: 1, failed: 1 });

    const { rows: reclaimedEvents } = await getPool().query(
      `SELECT event FROM audit_event WHERE client_id = $1 AND entity_id = $2`,
      [clientId, reclaimable],
    );
    expect(reclaimedEvents.map((r) => r.event)).toContain('workflow.outbox_message_reclaimed');

    const { rows: failedEvents } = await getPool().query(
      `SELECT event FROM audit_event WHERE client_id = $1 AND entity_id = $2`,
      [clientId, dying],
    );
    expect(failedEvents.map((r) => r.event)).toContain('workflow.outbox_message_failed');
  });
});
