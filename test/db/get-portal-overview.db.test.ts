import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { getPortalOverview } from '../../src/modules/portal/get-portal-overview.js';

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * NOTE on tenant isolation: migration 0009's tenant_isolation policy is
 * applied to tables with a client_id (or equivalent) tenant column -- the
 * `client` table itself is the tenant root, not a tenant-scoped leaf, and
 * carries no such policy. So this module's isolation guarantee comes
 * entirely from the caller (portal-routes.ts) always supplying the
 * requester's OWN resolved clientId -- never a client-suppliable parameter --
 * proven at the route layer in test/unit/portal-routes.test.ts, not here.
 * These DB tests cover the query's own correctness, not cross-tenant RLS.
 */
describe.skipIf(!DATABASE_URL)('getPortalOverview (database)', () => {
  const clientId = randomUUID();

  beforeAll(async () => {
    await getPool().query(`INSERT INTO client (id, name, slug) VALUES ($1, 'Portal Shell Co', $2)`, [clientId, `portal-shell-${clientId}`]);
  });

  afterAll(async () => {
    await getPool().query(`DELETE FROM client WHERE id = $1`, [clientId]);
    await closePool();
  });

  it('resolves the client name for the given id inside a tenant-scoped transaction', async () => {
    const result = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      getPortalOverview(client, clientId));
    expect(result).toEqual({ clientName: 'Portal Shell Co' });
  });

  it('returns null for an id that does not exist', async () => {
    const result = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      getPortalOverview(client, randomUUID()));
    expect(result).toBeNull();
  });
});
