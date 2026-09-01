import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { approveDispute } from '../../src/modules/disputes/approve-dispute.js';
import { DELIVER_DISPUTE_COMMAND_TYPE } from '../../src/modules/disputes/deliver-dispute-command-handler.js';

const DISPUTE_ID = '70000000-0000-4000-8000-000000000001';
const CLIENT_ID = '70000000-0000-4000-8000-000000000004';
const ACTOR_USER_ID = '70000000-0000-4000-8000-000000000005';
const WORKFLOW_INSTANCE_ID = '70000000-0000-4000-8000-000000000006';
const NOW = new Date('2026-09-01T00:00:00.000Z');

/**
 * Covers approveDispute's full transaction, including the P4.C.7 addition
 * (workflow_instance + deliver_dispute workflow_command creation) on top of
 * the pre-existing draft -> sent + audit-event behavior (P4.C.6) -- every
 * assertion the original suite made still runs unchanged below, extended
 * rather than replaced, per this repo's own never-repurpose-a-test rule.
 */
function mockClient(opts: { updateRows?: unknown[] }) {
  const { updateRows = [] } = opts;
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.startsWith('UPDATE dispute')) return Promise.resolve({ rows: updateRows });
    if (sql.includes('INSERT INTO audit_event')) return Promise.resolve({ rows: [{ id: 'audit-event-id', created: true }] });
    // createWorkflowInstance: idempotent-read-then-insert.
    if (sql.startsWith('SELECT id, client_id, workflow_type')) return Promise.resolve({ rows: [] });
    if (sql.startsWith('INSERT INTO workflow_instance')) {
      return Promise.resolve({
        rows: [{
          id: WORKFLOW_INSTANCE_ID, client_id: CLIENT_ID, workflow_type: 'dispute_delivery',
          subject_entity: 'dispute', subject_entity_id: DISPUTE_ID, current_state: 'pending_delivery',
          created_at: NOW, updated_at: NOW,
        }],
      });
    }
    // scheduleWorkflowCommand: instance-exists guard, then idempotent-read-then-insert.
    if (sql.startsWith('SELECT 1 FROM workflow_instance')) return Promise.resolve({ rowCount: 1, rows: [{}] });
    if (sql.startsWith('SELECT id FROM workflow_command')) return Promise.resolve({ rows: [] });
    if (sql.startsWith('INSERT INTO workflow_command')) return Promise.resolve({ rows: [{ id: '70000000-0000-4000-8000-000000000007' }] });
    throw new Error(`unexpected query: ${sql}`);
  });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('approveDispute', () => {
  it('transitions a draft dispute to sent and writes an audit event', async () => {
    const { client, query } = mockClient({ updateRows: [{ id: DISPUTE_ID, client_id: CLIENT_ID }] });
    const result = await approveDispute(client, DISPUTE_ID, ACTOR_USER_ID, NOW);
    expect(result).toEqual({ found: true });

    const updateCall = query.mock.calls.find((c: unknown[]) => (c[0] as string).startsWith('UPDATE dispute')) as [string, unknown[]];
    expect(updateCall[0]).toContain("status = 'draft'");
    expect(updateCall[1]).toEqual([DISPUTE_ID]);

    const auditCall = query.mock.calls.find((c: unknown[]) => (c[0] as string).includes('INSERT INTO audit_event')) as [string, unknown[]];
    expect(auditCall[1][4]).toBe('dispute.approved');
  });

  it('reports found: false for a dispute that is not currently draft (already approved or unknown)', async () => {
    const { client } = mockClient({ updateRows: [] });
    const result = await approveDispute(client, DISPUTE_ID, ACTOR_USER_ID, NOW);
    expect(result).toEqual({ found: false });
  });

  it('is idempotent: approving an already-sent dispute a second time reports found: false rather than re-sending', async () => {
    // Simulates the second call in a real sequence -- the first UPDATE already
    // flipped status to 'sent', so a second WHERE status='draft' UPDATE matches nothing.
    const { client } = mockClient({ updateRows: [] });
    const result = await approveDispute(client, DISPUTE_ID, ACTOR_USER_ID, NOW);
    expect(result.found).toBe(false);
  });

  it('creates a dispute_delivery workflow_instance for the approved dispute (P4.C.7)', async () => {
    const { client, query } = mockClient({ updateRows: [{ id: DISPUTE_ID, client_id: CLIENT_ID }] });
    await approveDispute(client, DISPUTE_ID, ACTOR_USER_ID, NOW);

    const insertInstanceCall = query.mock.calls.find((c: unknown[]) => (c[0] as string).startsWith('INSERT INTO workflow_instance')) as [string, unknown[]];
    expect(insertInstanceCall).toBeDefined();
    expect(insertInstanceCall[1]).toEqual([CLIENT_ID, 'dispute_delivery', 'dispute', DISPUTE_ID, 'pending_delivery']);
  });

  it('schedules a deliver_dispute command against the new instance, due immediately (P4.C.7)', async () => {
    const { client, query } = mockClient({ updateRows: [{ id: DISPUTE_ID, client_id: CLIENT_ID }] });
    await approveDispute(client, DISPUTE_ID, ACTOR_USER_ID, NOW);

    const insertCommandCall = query.mock.calls.find((c: unknown[]) => (c[0] as string).startsWith('INSERT INTO workflow_command')) as [string, unknown[]];
    expect(insertCommandCall).toBeDefined();
    const [clientId, workflowInstanceId, commandType, payload, runAfter] = insertCommandCall[1] as [string, string, string, string, string];
    expect(clientId).toBe(CLIENT_ID);
    expect(workflowInstanceId).toBe(WORKFLOW_INSTANCE_ID);
    expect(commandType).toBe(DELIVER_DISPUTE_COMMAND_TYPE);
    expect(JSON.parse(payload)).toEqual({ disputeId: DISPUTE_ID });
    expect(runAfter).toBe(NOW.toISOString());
  });

  it('does not create a workflow_instance or command when the dispute was not found (not currently draft)', async () => {
    const { client, query } = mockClient({ updateRows: [] });
    await approveDispute(client, DISPUTE_ID, ACTOR_USER_ID, NOW);

    expect(query.mock.calls.some((c: unknown[]) => (c[0] as string).startsWith('INSERT INTO workflow_instance'))).toBe(false);
    expect(query.mock.calls.some((c: unknown[]) => (c[0] as string).startsWith('INSERT INTO workflow_command'))).toBe(false);
  });
});
