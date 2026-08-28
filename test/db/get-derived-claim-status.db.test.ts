import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { getDerivedClaimStatus, GetDerivedClaimStatusError } from '../../src/modules/claims/get-derived-claim-status.js';
import { CLAIM_TERMINAL_EVENTS } from '../../src/modules/claims/derive-claim-status.js';

/**
 * 86e2zfj62: deriving claim status from audit_event + recovery_event
 * (P5.A.5), read against real Postgres. Seeds audit_event/recovery_event
 * rows directly rather than calling resolveClaim (P5.A.4/#174, unmerged).
 */
describe('getDerivedClaimStatus (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  const tag = `dcs-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('DCS-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('DCS-B', $1) RETURNING id`, [`${tag}-b`]);
      clientBId = b.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM recovery_event WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM claim WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedClaim(client: pg.PoolClient, opts: { clientId: string; status?: string }): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO claim (client_id, amount_claimed, currency, status) VALUES ($1, '500.0000', 'USD', $2) RETURNING id`,
      [opts.clientId, opts.status ?? 'open'],
    );
    return rows[0]!.id;
  }

  async function seedAuditEvent(client: pg.PoolClient, opts: { clientId: string; claimId: string; event: string }): Promise<void> {
    await client.query(
      `INSERT INTO audit_event (id, client_id, entity, entity_id, event, actor_kind)
       VALUES (gen_random_uuid(), $1, 'claim', $2, $3, 'analyst')`,
      [opts.clientId, opts.claimId, opts.event],
    );
  }

  it('derives open with no events and reports a match against a stored open status', async () => {
    const result = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      return getDerivedClaimStatus(client, clientAId, claimId);
    });

    expect(result.derivedStatus).toBe('open');
    expect(result.matches).toBe(true);
  });

  it('derives recovered from a claim.recovered audit_event and sums the recovery total', async () => {
    const result = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId, status: 'recovered' });
      await client.query(`INSERT INTO recovery_event (client_id, claim_id, amount_recovered, currency) VALUES ($1, $2, '500.0000', 'USD')`, [clientAId, claimId]);
      await seedAuditEvent(client, { clientId: clientAId, claimId, event: CLAIM_TERMINAL_EVENTS.RECOVERED });
      return getDerivedClaimStatus(client, clientAId, claimId);
    });

    expect(result.derivedStatus).toBe('recovered');
    expect(result.cumulativeRecovered).toBe('500.0000');
    expect(result.matches).toBe(true);
  });

  it('distinguishes denied from a zero-recovery written_off claim', async () => {
    const [denied, writtenOff] = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const deniedClaimId = await seedClaim(client, { clientId: clientAId, status: 'denied' });
      await seedAuditEvent(client, { clientId: clientAId, claimId: deniedClaimId, event: CLAIM_TERMINAL_EVENTS.DENIED });

      const writtenOffClaimId = await seedClaim(client, { clientId: clientAId, status: 'written_off' });
      await seedAuditEvent(client, { clientId: clientAId, claimId: writtenOffClaimId, event: CLAIM_TERMINAL_EVENTS.WRITTEN_OFF });

      return Promise.all([
        getDerivedClaimStatus(client, clientAId, deniedClaimId),
        getDerivedClaimStatus(client, clientAId, writtenOffClaimId),
      ]);
    });

    expect(denied.derivedStatus).toBe('denied');
    expect(writtenOff.derivedStatus).toBe('written_off');
  });

  it('reports a mismatch when the stored status disagrees with the derived one', async () => {
    const result = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId, status: 'open' });
      await seedAuditEvent(client, { clientId: clientAId, claimId, event: CLAIM_TERMINAL_EVENTS.RECOVERED });
      return getDerivedClaimStatus(client, clientAId, claimId);
    });

    expect(result.matches).toBe(false);
    expect(result.derivedStatus).toBe('recovered');
    expect(result.storedStatus).toBe('open');
  });

  it('fails not-found for a claim belonging to a different tenant', async () => {
    const claimId = await withTenantTx({ clientIds: [clientAId] }, (client) => seedClaim(client, { clientId: clientAId }));

    await expect(
      withTenantTx({ clientIds: [clientBId] }, (client) => getDerivedClaimStatus(client, clientBId, claimId)),
    ).rejects.toBeInstanceOf(GetDerivedClaimStatusError);
  });

  it('fails not-found for a nonexistent claim id', async () => {
    await expect(
      withTenantTx({ clientIds: [clientAId] }, (client) =>
        getDerivedClaimStatus(client, clientAId, '00000000-0000-0000-0000-000000000000'),
      ),
    ).rejects.toBeInstanceOf(GetDerivedClaimStatusError);
  });
});
