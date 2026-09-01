import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { recordDisputeCommunication, RecordDisputeCommunicationError } from '../../src/modules/disputes/record-dispute-communication.js';
import { listDisputeCommunications } from '../../src/modules/disputes/list-dispute-communications.js';

/**
 * P4.C.8 DB-level proof: dispute_comm (0008) had no writer anywhere in this
 * repo before this task, so this is the first real exercise of its RLS
 * policy (0009) and append-only grant (0010 -- SELECT+INSERT only, no
 * UPDATE/DELETE) against a live database, plus the new dedupe_key unique
 * constraint (0067).
 *
 * Teardown deepest-child-first (86e30txkx's tracked FK-order defect class):
 * dispute_comm -> dispute -> client.
 */
describe('dispute communications log (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  let disputeAId: string;
  let disputeBId: string;
  const tag = `dc-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('DC-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('DC-B', $1) RETURNING id`, [`${tag}-b`]);
      clientBId = b.rows[0].id;

      const disputeA = await owner.query(
        `INSERT INTO dispute (client_id, status, amount_claimed, currency) VALUES ($1, 'draft', '500.0000', 'USD') RETURNING id`,
        [clientAId],
      );
      disputeAId = disputeA.rows[0].id;
      const disputeB = await owner.query(
        `INSERT INTO dispute (client_id, status, amount_claimed, currency) VALUES ($1, 'draft', '250.0000', 'USD') RETURNING id`,
        [clientBId],
      );
      disputeBId = disputeB.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM dispute_comm WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM dispute WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('records an inbound communication and derives client_id from the dispute row', async () => {
    const result = await withTenantTx({ clientIds: [clientAId], internal: false }, (client) =>
      recordDisputeCommunication(client, {
        disputeId: disputeAId,
        direction: 'inbound',
        body: 'Carrier called to dispute the amount.',
        dedupeKey: `${tag}-inbound-1`,
      }));
    expect(result.created).toBe(true);

    const { rows } = await pool.query(
      `SELECT client_id, dispute_id, direction, body FROM dispute_comm WHERE id = $1`,
      [result.disputeCommId],
    );
    expect(rows[0]).toMatchObject({
      client_id: clientAId, dispute_id: disputeAId, direction: 'inbound', body: 'Carrier called to dispute the amount.',
    });
  });

  it('is idempotent per (client, dedupeKey): a retried call returns the existing row, not a duplicate', async () => {
    const dedupeKey = `${tag}-inbound-retry`;
    const first = await withTenantTx({ clientIds: [clientAId], internal: false }, (client) =>
      recordDisputeCommunication(client, { disputeId: disputeAId, direction: 'inbound', body: 'First attempt.', dedupeKey }));
    const second = await withTenantTx({ clientIds: [clientAId], internal: false }, (client) =>
      recordDisputeCommunication(client, { disputeId: disputeAId, direction: 'inbound', body: 'Retried attempt.', dedupeKey }));

    expect(first.created).toBe(true);
    expect(second).toEqual({ disputeCommId: first.disputeCommId, created: false });

    const { rows } = await pool.query(`SELECT count(*)::int AS count FROM dispute_comm WHERE dispute_id = $1 AND dedupe_key = $2`, [disputeAId, dedupeKey]);
    expect(rows[0].count).toBe(1);
  });

  it('records both directions for the same dispute as separate rows', async () => {
    await withTenantTx({ clientIds: [clientAId], internal: false }, (client) =>
      recordDisputeCommunication(client, { disputeId: disputeAId, direction: 'outbound', body: 'Delivery initiated.', dedupeKey: `${tag}-outbound-1` }));
    await withTenantTx({ clientIds: [clientAId], internal: false }, (client) =>
      recordDisputeCommunication(client, { disputeId: disputeAId, direction: 'inbound', body: 'Carrier replied.', dedupeKey: `${tag}-inbound-2` }));

    const communications = await withTenantTx({ clientIds: [clientAId], internal: false }, (client) => listDisputeCommunications(client, disputeAId));
    const directions = communications.map((c) => c.direction);
    expect(directions).toContain('outbound');
    expect(directions).toContain('inbound');
  });

  it('lists a dispute\'s communications newest first', async () => {
    const dedupeKey1 = `${tag}-order-1`;
    const dedupeKey2 = `${tag}-order-2`;
    await withTenantTx({ clientIds: [clientBId], internal: false }, (client) =>
      recordDisputeCommunication(client, { disputeId: disputeBId, direction: 'inbound', body: 'Older message.', dedupeKey: dedupeKey1 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await withTenantTx({ clientIds: [clientBId], internal: false }, (client) =>
      recordDisputeCommunication(client, { disputeId: disputeBId, direction: 'outbound', body: 'Newer message.', dedupeKey: dedupeKey2 }));

    const communications = await withTenantTx({ clientIds: [clientBId], internal: false }, (client) => listDisputeCommunications(client, disputeBId));
    expect(communications).toHaveLength(2);
    expect(communications[0]?.body).toBe('Newer message.');
    expect(communications[1]?.body).toBe('Older message.');
  });

  it('is tenant-isolated: recording against another tenant\'s dispute id is not found, not a cross-tenant write', async () => {
    await expect(
      withTenantTx({ clientIds: [clientBId], internal: false }, (client) =>
        recordDisputeCommunication(client, { disputeId: disputeAId, direction: 'inbound', body: 'Should not land.', dedupeKey: `${tag}-cross-tenant` })),
    ).rejects.toBeInstanceOf(RecordDisputeCommunicationError);
  });

  it('is tenant-isolated on read: listing another tenant\'s dispute returns nothing', async () => {
    const communications = await withTenantTx({ clientIds: [clientBId], internal: false }, (client) => listDisputeCommunications(client, disputeAId));
    expect(communications).toEqual([]);
  });

  it('append-only: freight_app cannot UPDATE or DELETE an existing dispute_comm row', async () => {
    const result = await withTenantTx({ clientIds: [clientAId], internal: false }, (client) =>
      recordDisputeCommunication(client, { disputeId: disputeAId, direction: 'inbound', body: 'Immutable.', dedupeKey: `${tag}-immutable` }));

    await expect(
      withTenantTx({ clientIds: [clientAId], internal: false }, (client) =>
        client.query(`UPDATE dispute_comm SET body = 'edited' WHERE id = $1`, [result.disputeCommId])),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      withTenantTx({ clientIds: [clientAId], internal: false }, (client) =>
        client.query(`DELETE FROM dispute_comm WHERE id = $1`, [result.disputeCommId])),
    ).rejects.toThrow(/permission denied/i);
  });
});
