import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { getClientRecoverySummary } from '../../src/modules/claims/get-client-recovery-summary.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('getClientRecoverySummary (database)', () => {
  const clientId = randomUUID();
  const openClaimId = randomUUID();
  const recoveredClaimId = randomUUID();

  beforeAll(async () => {
    await getPool().query(`INSERT INTO client (id, name, slug) VALUES ($1, 'Client Recovery Summary Co', $2)`, [clientId, `client-recovery-summary-${clientId}`]);
    await getPool().query(
      `INSERT INTO claim (id, client_id, amount_claimed, currency, status)
       VALUES ($1, $2, '400.0000', 'USD', 'open'), ($3, $2, '600.0000', 'USD', 'recovered')`,
      [openClaimId, clientId, recoveredClaimId],
    );
    await getPool().query(
      `INSERT INTO recovery_event (client_id, claim_id, amount_recovered, currency) VALUES ($1, $2, '600.0000', 'USD')`,
      [clientId, recoveredClaimId],
    );
  });

  afterAll(async () => {
    await getPool().query(`DELETE FROM recovery_event WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM claim WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM client WHERE id = $1`, [clientId]);
    await closePool();
  });

  it('summarizes the tenant\'s claims into a reconciling USD bucket', async () => {
    const result = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      getClientRecoverySummary(client, clientId));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      currency: 'USD', claimed: '1000.0000', recovered: '600.0000', outstanding: '400.0000',
      writtenOff: '0.0000', denied: '0.0000', reconciles: true,
    });
  });

  it('returns an empty array for a different tenant with no claims (cross-tenant isolation)', async () => {
    const otherClientId = randomUUID();
    await getPool().query(`INSERT INTO client (id, name, slug) VALUES ($1, 'Other Client Co', $2)`, [otherClientId, `other-client-${otherClientId}`]);
    try {
      const result = await withTenantTx({ clientIds: [otherClientId], internal: false }, (client) =>
        getClientRecoverySummary(client, otherClientId));
      expect(result).toEqual([]);
    } finally {
      await getPool().query(`DELETE FROM client WHERE id = $1`, [otherClientId]);
    }
  });
});
