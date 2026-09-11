import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { writeAuditEvent } from '../../src/modules/audit-ledger/write-audit-event.js';
import { listInternalAuditEvents } from '../../src/modules/audit-ledger/list-internal-audit-events.js';

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * 86e37r2rv, against real Postgres. Same regression shape as
 * get-cross-client-portfolio.db.test.ts (P5.C.3 / PR #247): listInternalAuditEvents
 * has no client_id filter at all, so its cross-client visibility -- and its
 * safety -- is entirely the tenant_isolation RLS policy (migration 0009)
 * reading the transaction's app.is_internal / app.current_client_ids GUCs.
 * The second test is the critical assertion: a normal, single-client
 * (non-internal) transaction running this exact query must see ONLY its own
 * client's events.
 */
describe.skipIf(!DATABASE_URL)('listInternalAuditEvents (database)', () => {
  const clientAId = randomUUID();
  const clientBId = randomUUID();
  const eventAId = randomUUID();
  const eventBId = randomUUID();

  beforeAll(async () => {
    await getPool().query(`INSERT INTO client (id, name, slug) VALUES ($1, 'Internal Audit Co A', $2)`, [clientAId, `iac-a-${clientAId}`]);
    await getPool().query(`INSERT INTO client (id, name, slug) VALUES ($1, 'Internal Audit Co B', $2)`, [clientBId, `iac-b-${clientBId}`]);
    await withTenantTx({ clientIds: [clientAId], internal: false }, (client) => writeAuditEvent(client, {
      id: eventAId, clientId: clientAId, entity: 'dispute', entityId: null, event: 'created', actorKind: 'analyst',
    }));
    await withTenantTx({ clientIds: [clientBId], internal: false }, (client) => writeAuditEvent(client, {
      id: eventBId, clientId: clientBId, entity: 'claim', entityId: null, event: 'opened', actorKind: 'system',
    }));
  });

  afterAll(async () => {
    await getPool().query(`DELETE FROM audit_event WHERE id = ANY($1::uuid[])`, [[eventAId, eventBId]]);
    await getPool().query(`DELETE FROM client WHERE id = ANY($1::uuid[])`, [[clientAId, clientBId]]);
    await closePool();
  });

  it('an internal-analyst transaction sees every client\'s audit events', async () => {
    const result = await withTenantTx({ internal: true }, (client) => listInternalAuditEvents(client));

    const ids = result.map((r) => r.id);
    expect(ids).toContain(eventAId);
    expect(ids).toContain(eventBId);
  });

  it("CRITICAL: a non-internal, single-client transaction sees ONLY its own client's events -- the exact cross-tenant leak class PR #247 was closed for", async () => {
    const result = await withTenantTx({ clientIds: [clientAId], internal: false }, (client) => listInternalAuditEvents(client));

    const ids = result.map((r) => r.id);
    expect(ids).toContain(eventAId);
    expect(ids).not.toContain(eventBId);
  });
});
