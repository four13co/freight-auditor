import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { getPortfolioReconciliation } from '../../src/modules/claims/get-portfolio-reconciliation.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('getPortfolioReconciliation (database)', () => {
  const clientId = randomUUID();
  const openClaimId = randomUUID();
  const recoveredClaimId = randomUUID();
  const deniedClaimId = randomUUID();

  beforeAll(async () => {
    await getPool().query(`INSERT INTO client (id, name, slug) VALUES ($1, 'Portfolio Reconciliation Co', $2)`, [clientId, `portfolio-reconciliation-${clientId}`]);
    await getPool().query(
      `INSERT INTO claim (id, client_id, amount_claimed, currency, status)
       VALUES ($1, $2, '400.0000', 'USD', 'open'),
              ($3, $2, '600.0000', 'USD', 'recovered'),
              ($4, $2, '250.0000', 'USD', 'denied')`,
      [openClaimId, clientId, recoveredClaimId, deniedClaimId],
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

  it('rolls up all of a tenant\'s claims into one reconciling USD bucket', async () => {
    const result = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      getPortfolioReconciliation(client, { clientId }));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      currency: 'USD',
      claimed: '1250.0000',
      recovered: '600.0000',
      outstanding: '400.0000',
      writtenOff: '0.0000',
      denied: '250.0000',
      reconciles: true,
    });
  });

  it('returns an empty array for a tenant with no claims', async () => {
    const otherClientId = randomUUID();
    await getPool().query(`INSERT INTO client (id, name, slug) VALUES ($1, 'Empty Portfolio Co', $2)`, [otherClientId, `empty-portfolio-${otherClientId}`]);
    try {
      const result = await withTenantTx({ clientIds: [otherClientId], internal: false }, (client) =>
        getPortfolioReconciliation(client, { clientId: otherClientId }));
      expect(result).toEqual([]);
    } finally {
      await getPool().query(`DELETE FROM client WHERE id = $1`, [otherClientId]);
    }
  });
});
