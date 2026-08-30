import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { generateClaimEscalation, GenerateClaimEscalationError, CLAIM_FOLLOW_UP_EVENT } from '../../src/modules/claims/generate-claim-escalation.js';
import { deterministicAuditEventId, writeAuditEvent } from '../../src/modules/audit-ledger/write-audit-event.js';

/**
 * 86e2zfja3 (P5.B.3). Seeds the follow-up audit_event directly rather than
 * calling generateClaimFollowUp, since #184 (P5.B.2) is still
 * open/unmerged -- matching #180's original approach. Teardown order is
 * deepest-child-first (audit_event -> claim -> client).
 */
describe('generateClaimEscalation (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  const tag = `gce-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('GCE-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('GCE-B', $1) RETURNING id`, [`${tag}-b`]);
      clientBId = b.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM claim WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedClaim(client: pg.PoolClient, opts: { clientId: string; status?: string }): Promise<string> {
    const row = await client.query(
      `INSERT INTO claim (client_id, amount_claimed, currency, status) VALUES ($1, '500.0000', 'USD', $2) RETURNING id`,
      [opts.clientId, opts.status ?? 'open'],
    );
    return row.rows[0].id;
  }

  async function seedFollowUp(client: pg.PoolClient, clientId: string, claimId: string): Promise<void> {
    await writeAuditEvent(client, {
      id: deterministicAuditEventId(clientId, claimId, CLAIM_FOLLOW_UP_EVENT),
      clientId, entity: 'claim', entityId: claimId, event: CLAIM_FOLLOW_UP_EVENT, actorKind: 'system',
      detail: null,
    });
  }

  it('AC1: writes a claim.escalated audit event once the grace period since follow-up has elapsed', async () => {
    const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // well past any grace period
    const { result, ledger } = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const claimId = await seedClaim(c, { clientId: clientAId });
      await seedFollowUp(c, clientAId, claimId);
      const result = await generateClaimEscalation(c, clientAId, claimId, farFuture);
      const ledger = await c.query(
        `SELECT event, actor_kind, detail FROM audit_event WHERE entity = 'claim' AND entity_id = $1 AND event = 'claim.escalated'`,
        [claimId],
      );
      return { result, ledger: ledger.rows[0] };
    });

    expect(result.created).toBe(true);
    expect(ledger).toMatchObject({ event: 'claim.escalated', actor_kind: 'system' });
  });

  it('AC2 (idempotent retry): a redelivered job writes no duplicate escalation event', async () => {
    const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const { count } = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const claimId = await seedClaim(c, { clientId: clientAId });
      await seedFollowUp(c, clientAId, claimId);
      const first = await generateClaimEscalation(c, clientAId, claimId, farFuture);
      const second = await generateClaimEscalation(c, clientAId, claimId, farFuture);
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      const count = await c.query(
        `SELECT count(*)::int AS n FROM audit_event WHERE entity = 'claim' AND entity_id = $1 AND event = 'claim.escalated'`,
        [claimId],
      );
      return { count: count.rows[0].n };
    });
    expect(count).toBe(1);
  });

  it('AC5 (cross-tenant fail closed): a claim id outside the caller tenant scope is not found', async () => {
    const claimId = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const id = await seedClaim(c, { clientId: clientAId });
      await seedFollowUp(c, clientAId, id);
      return id;
    });

    await expect(
      withTenantTx({ clientIds: [clientBId], internal: false }, (c) => generateClaimEscalation(c, clientBId, claimId)),
    ).rejects.toBeInstanceOf(GenerateClaimEscalationError);
  });

  it('refuses a claim with no follow-up event yet (escalation cannot skip the follow-up stage)', async () => {
    await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const claimId = await seedClaim(c, { clientId: clientAId });
      await expect(generateClaimEscalation(c, clientAId, claimId)).rejects.toMatchObject({ code: 'NO_FOLLOW_UP_SENT' });
    });
  });

  it('refuses a terminal claim even with an elapsed grace period', async () => {
    const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const claimId = await seedClaim(c, { clientId: clientAId, status: 'recovered' });
      await seedFollowUp(c, clientAId, claimId);
      await expect(generateClaimEscalation(c, clientAId, claimId, farFuture)).rejects.toMatchObject({ code: 'CLAIM_TERMINAL' });
    });
  });
});
