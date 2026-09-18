import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { getCrossAccountPortfolio } from '../../src/modules/claims/get-cross-account-portfolio.js';

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * P5.C.3 (rebuild), against real Postgres. This is the regression proof for
 * exactly the class of bug PR #247 introduced: getCrossAccountPortfolio has
 * no clientId filter at all, so its safety is ENTIRELY the RLS policy
 * (migration 0009) reading the transaction's app.is_internal /
 * app.current_account_ids GUCs. The critical assertion here is the second
 * test -- a normal, single-client (non-internal) transaction must see ONLY
 * its own client's rows through this exact query, proving the function is
 * safe even if a future caller invokes it under the wrong scope.
 */
describe.skipIf(!DATABASE_URL)('getCrossAccountPortfolio (database)', () => {
  const clientAId = randomUUID();
  const clientBId = randomUUID();
  const claimAId = randomUUID();
  const claimBId = randomUUID();

  beforeAll(async () => {
    await getPool().query(`INSERT INTO account (id, name, slug) VALUES ($1, 'Cross Client Portfolio Co A', $2)`, [clientAId, `xcp-a-${clientAId}`]);
    await getPool().query(`INSERT INTO account (id, name, slug) VALUES ($1, 'Cross Client Portfolio Co B', $2)`, [clientBId, `xcp-b-${clientBId}`]);
    await getPool().query(
      `INSERT INTO claim (id, account_id, amount_claimed, currency, status) VALUES ($1, $2, '400.0000', 'USD', 'open')`,
      [claimAId, clientAId],
    );
    await getPool().query(
      `INSERT INTO claim (id, account_id, amount_claimed, currency, status) VALUES ($1, $2, '900.0000', 'CAD', 'recovered')`,
      [claimBId, clientBId],
    );
    await getPool().query(
      `INSERT INTO recovery_event (account_id, claim_id, amount_recovered, currency) VALUES ($1, $2, '900.0000', 'CAD')`,
      [clientBId, claimBId],
    );
  });

  afterAll(async () => {
    await getPool().query(`DELETE FROM recovery_event WHERE account_id = ANY($1)`, [[clientAId, clientBId]]);
    await getPool().query(`DELETE FROM claim WHERE account_id = ANY($1)`, [[clientAId, clientBId]]);
    await getPool().query(`DELETE FROM account WHERE id = ANY($1)`, [[clientAId, clientBId]]);
    await closePool();
  });

  it('an internal-analyst transaction sees every client, bucketed by (clientId, currency)', async () => {
    const result = await withTenantTx({ internal: true }, (client) => getCrossAccountPortfolio(client));

    const bucketA = result.find((b) => b.clientId === clientAId);
    const bucketB = result.find((b) => b.clientId === clientBId);
    expect(bucketA).toMatchObject({ currency: 'USD', claimed: '400.0000', recovered: '0.0000', outstanding: '400.0000', reconciles: true });
    expect(bucketB).toMatchObject({ currency: 'CAD', claimed: '900.0000', recovered: '900.0000', outstanding: '0.0000', reconciles: true });
  });

  it('CRITICAL: a non-internal, single-client transaction sees ONLY its own client -- the exact cross-tenant leak class PR #247 was closed for', async () => {
    const result = await withTenantTx({ clientIds: [clientAId], internal: false }, (client) => getCrossAccountPortfolio(client));

    expect(result.every((b) => b.clientId === clientAId)).toBe(true);
    expect(result.some((b) => b.clientId === clientBId)).toBe(false);
    expect(result.find((b) => b.clientId === clientAId)).toMatchObject({ claimed: '400.0000' });
  });

  it('a non-internal transaction scoped to neither client sees nothing', async () => {
    const otherClientId = randomUUID();
    const result = await withTenantTx({ clientIds: [otherClientId], internal: false }, (client) => getCrossAccountPortfolio(client));
    expect(result).toEqual([]);
  });
});
