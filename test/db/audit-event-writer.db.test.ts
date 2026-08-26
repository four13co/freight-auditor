import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import {
  AuditEventConflictError,
  writeAuditEvent,
} from '../../src/modules/audit-ledger/write-audit-event.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('central audit-event writer (database)', () => {
  const clientId = randomUUID();
  const otherClientId = randomUUID();
  const eventId = randomUUID();
  const input = {
    id: eventId,
    clientId,
    entity: 'source_document',
    entityId: randomUUID(),
    event: 'ingestion.received',
    actorKind: 'system' as const,
    detail: { sha256: 'abc' },
  };

  beforeAll(async () => {
    await getPool().query(
      `INSERT INTO client (id, name, slug) VALUES ($1, 'Ledger A', $2), ($3, 'Ledger B', $4)`,
      [clientId, `ledger-a-${clientId}`, otherClientId, `ledger-b-${otherClientId}`],
    );
  });

  afterAll(async () => {
    await getPool().query(`DELETE FROM audit_event WHERE id = $1`, [eventId]);
    await getPool().query(`DELETE FROM client WHERE id = ANY($1::uuid[])`, [[clientId, otherClientId]]);
    await closePool();
  });

  it('is idempotent for identical evidence and rejects conflicting or cross-tenant reuse', async () => {
    await expect(withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      writeAuditEvent(client, input))).resolves.toEqual({ id: eventId, created: true });
    await expect(withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      writeAuditEvent(client, input))).resolves.toEqual({ id: eventId, created: false });
    await expect(withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      writeAuditEvent(client, { ...input, event: 'ingestion.changed' }))).rejects.toBeInstanceOf(AuditEventConflictError);
    await expect(withTenantTx({ clientIds: [otherClientId], internal: false }, (client) =>
      writeAuditEvent(client, { ...input, clientId: otherClientId }))).rejects.toBeInstanceOf(AuditEventConflictError);
  });
});
