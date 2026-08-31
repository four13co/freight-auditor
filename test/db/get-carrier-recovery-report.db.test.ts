import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { getCarrierRecoveryReport } from '../../src/modules/claims/get-carrier-recovery-report.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('getCarrierRecoveryReport (database)', () => {
  const clientId = randomUUID();
  const carrierId = randomUUID();
  const disputeId = randomUUID();
  const openClaimId = randomUUID();
  const recoveredClaimId = randomUUID();

  beforeAll(async () => {
    await getPool().query(`INSERT INTO client (id, name, slug) VALUES ($1, 'Carrier Report Co', $2)`, [clientId, `carrier-report-${clientId}`]);
    await getPool().query(`INSERT INTO carrier (id, name) VALUES ($1, 'Test Carrier')`, [carrierId]);
    await getPool().query(
      `INSERT INTO dispute (id, client_id, carrier_id, status) VALUES ($1, $2, $3, 'draft')`,
      [disputeId, clientId, carrierId],
    );
    await getPool().query(
      `INSERT INTO claim (id, client_id, dispute_id, amount_claimed, currency, status)
       VALUES ($1, $2, $3, '400.0000', 'USD', 'open'), ($4, $2, $3, '600.0000', 'USD', 'recovered')`,
      [openClaimId, clientId, disputeId, recoveredClaimId],
    );
    await getPool().query(
      `INSERT INTO recovery_event (client_id, claim_id, amount_recovered, currency) VALUES ($1, $2, '600.0000', 'USD')`,
      [clientId, recoveredClaimId],
    );
  });

  afterAll(async () => {
    await getPool().query(`DELETE FROM recovery_event WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM claim WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM dispute WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
    await getPool().query(`DELETE FROM client WHERE id = $1`, [clientId]);
    await closePool();
  });

  it('aggregates claims for the carrier into a claimed/recovered/outstanding bucket', async () => {
    const result = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      getCarrierRecoveryReport(client, { clientId }));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      carrierId, currency: 'USD',
      claimed: '1000.0000', recovered: '600.0000', outstanding: '400.0000', writtenOff: '0.0000', denied: '0.0000',
    });
  });

  it('scopes to one carrier via carrierId and returns nothing for an unrelated carrier', async () => {
    const result = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      getCarrierRecoveryReport(client, { clientId, carrierId: randomUUID() }));
    expect(result).toEqual([]);
  });
});
