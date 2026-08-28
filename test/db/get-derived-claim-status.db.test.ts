import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { getDerivedClaimStatus, GetDerivedClaimStatusError } from '../../src/modules/claims/get-derived-claim-status.js';
import { deterministicAuditEventId, writeAuditEvent } from '../../src/modules/audit-ledger/write-audit-event.js';

/**
 * 86e2zfj62 (P5.A.5). Seeds claim/audit_event/recovery_event rows directly
 * rather than calling resolveClaim, since #174 (resolve-claim.ts) is still
 * open/unmerged -- matching #175's original disclosure. Teardown order is
 * deepest-child-first (audit_event, recovery_event -> claim -> client).
 */
describe('getDerivedClaimStatus (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  const tag = `gdcs-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('GDCS-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('GDCS-B', $1) RETURNING id`, [`${tag}-b`]);
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
    const row = await client.query(
      `INSERT INTO claim (client_id, amount_claimed, currency, status) VALUES ($1, '500.0000', 'USD', $2) RETURNING id`,
      [opts.clientId, opts.status ?? 'open'],
    );
    return row.rows[0].id;
  }

  it('AC1: derives "open" for a freshly seeded claim with no events', async () => {
    const result = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const claimId = await seedClaim(c, { clientId: clientAId });
      return getDerivedClaimStatus(c, clientAId, claimId);
    });
    expect(result).toEqual({ derivedStatus: 'open', cumulativeRecovered: '0.0000', matches: true });
  });

  it('AC2 (2+ terminal events -- the exact scenario the closed prior PR could not handle): the latest wins, read back correctly as real Date values from Postgres', async () => {
    const result = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const claimId = await seedClaim(c, { clientId: clientAId, status: 'written_off' });
      await writeAuditEvent(c, {
        id: deterministicAuditEventId(clientAId, claimId, 'claim.denied'),
        clientId: clientAId, entity: 'claim', entityId: claimId, event: 'claim.denied', actorKind: 'analyst',
        detail: { note: 'first attempt' },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await writeAuditEvent(c, {
        id: deterministicAuditEventId(clientAId, claimId, 'claim.written_off'),
        clientId: clientAId, entity: 'claim', entityId: claimId, event: 'claim.written_off', actorKind: 'analyst',
        detail: { note: 'reconsidered' },
      });
      return getDerivedClaimStatus(c, clientAId, claimId);
    });
    expect(result.derivedStatus).toBe('written_off');
    expect(result.matches).toBe(true);
  });

  it('AC5 (cross-tenant fail closed): a claim id outside the caller tenant scope is not found', async () => {
    const claimId = await withTenantTx({ clientIds: [clientAId], internal: true }, (c) =>
      seedClaim(c, { clientId: clientAId }),
    );

    await expect(
      withTenantTx({ clientIds: [clientBId], internal: false }, (c) => getDerivedClaimStatus(c, clientBId, claimId)),
    ).rejects.toBeInstanceOf(GetDerivedClaimStatusError);
  });

  it('AC (mismatch reporting): a stored status that disagrees with the ledger is reported, not corrected', async () => {
    const result = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const claimId = await seedClaim(c, { clientId: clientAId, status: 'open' });
      await writeAuditEvent(c, {
        id: deterministicAuditEventId(clientAId, claimId, 'claim.recovered'),
        clientId: clientAId, entity: 'claim', entityId: claimId, event: 'claim.recovered', actorKind: 'analyst',
        detail: null,
      });
      const derived = await getDerivedClaimStatus(c, clientAId, claimId);
      const stillStored = await c.query(`SELECT status FROM claim WHERE id = $1`, [claimId]);
      return { derived, storedStatus: stillStored.rows[0].status };
    });
    expect(result.derived.matches).toBe(false);
    expect(result.derived.derivedStatus).toBe('recovered');
    expect(result.storedStatus).toBe('open');
  });
});
