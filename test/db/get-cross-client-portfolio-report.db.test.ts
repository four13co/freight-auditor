import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { getCrossClientPortfolioReport } from '../../src/modules/claims/get-cross-client-portfolio-report.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('getCrossClientPortfolioReport (database)', () => {
  const clientAId = randomUUID();
  const clientBId = randomUUID();
  const claimAOpenId = randomUUID();
  const claimARecoveredId = randomUUID();
  const claimBDeniedId = randomUUID();

  beforeAll(async () => {
    await getPool().query(`INSERT INTO client (id, name, slug) VALUES ($1, 'Portfolio Report Client A', $2)`, [clientAId, `portfolio-a-${clientAId}`]);
    await getPool().query(`INSERT INTO client (id, name, slug) VALUES ($1, 'Portfolio Report Client B', $2)`, [clientBId, `portfolio-b-${clientBId}`]);

    await getPool().query(
      `INSERT INTO claim (id, client_id, amount_claimed, currency, status) VALUES ($1, $2, '400.0000', 'USD', 'open')`,
      [claimAOpenId, clientAId],
    );
    await getPool().query(
      `INSERT INTO claim (id, client_id, amount_claimed, currency, status) VALUES ($1, $2, '600.0000', 'USD', 'recovered')`,
      [claimARecoveredId, clientAId],
    );
    await getPool().query(
      `INSERT INTO claim (id, client_id, amount_claimed, currency, status) VALUES ($1, $2, '300.0000', 'USD', 'denied')`,
      [claimBDeniedId, clientBId],
    );
    await getPool().query(
      `INSERT INTO recovery_event (client_id, claim_id, amount_recovered, currency) VALUES ($1, $2, '600.0000', 'USD')`,
      [clientAId, claimARecoveredId],
    );
  });

  afterAll(async () => {
    await getPool().query(`DELETE FROM recovery_event WHERE client_id = ANY($1)`, [[clientAId, clientBId]]);
    await getPool().query(`DELETE FROM claim WHERE client_id = ANY($1)`, [[clientAId, clientBId]]);
    await getPool().query(`DELETE FROM client WHERE id = ANY($1)`, [[clientAId, clientBId]]);
    await closePool();
  });

  it('an internal-scoped transaction sees every client, bucketed separately', async () => {
    const result = await withTenantTx({ internal: true }, (client) => getCrossClientPortfolioReport(client));

    const a = result.find((b) => b.clientId === clientAId);
    const b = result.find((b) => b.clientId === clientBId);
    expect(a).toMatchObject({
      clientName: 'Portfolio Report Client A', currency: 'USD',
      claimed: '1000.0000', recovered: '600.0000', outstanding: '400.0000', writtenOff: '0.0000', denied: '0.0000', reconciles: true,
    });
    expect(b).toMatchObject({
      clientName: 'Portfolio Report Client B', currency: 'USD',
      claimed: '300.0000', recovered: '0.0000', outstanding: '0.0000', writtenOff: '0.0000', denied: '300.0000', reconciles: true,
    });
  });

  it('cross-tenant isolation: a client-scoped (non-internal) transaction sees only its own client, never the other', async () => {
    const result = await withTenantTx({ clientIds: [clientAId], internal: false }, (client) => getCrossClientPortfolioReport(client));
    expect(result.map((b) => b.clientId)).toEqual([clientAId]);
    expect(result[0]).toMatchObject({ claimed: '1000.0000', recovered: '600.0000', outstanding: '400.0000' });
  });

  it('cross-tenant isolation: scoping to client B explicitly still never leaks client A', async () => {
    const result = await withTenantTx({ clientIds: [clientBId], internal: false }, (client) => getCrossClientPortfolioReport(client));
    expect(result.map((b) => b.clientId)).toEqual([clientBId]);
    expect(result[0]).toMatchObject({ claimed: '300.0000', denied: '300.0000' });
  });

  it('fails closed to an empty result under a fully empty (no scope at all) transaction', async () => {
    const result = await withTenantTx({}, (client) => getCrossClientPortfolioReport(client));
    expect(result).toEqual([]);
  });
});
