import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from '../../src/db/pool.js';
import {
  AuditEventConflictError,
  AuditEventValidationError,
  writeAuditEvent,
} from '../../src/modules/audit-ledger/write-audit-event.js';

const event = {
  id: '10000000-0000-4000-8000-000000000001',
  clientId: '10000000-0000-4000-8000-000000000002',
  entity: 'source_document',
  entityId: '10000000-0000-4000-8000-000000000003',
  event: 'ingestion.received',
  actorKind: 'system' as const,
  detail: { sha256: 'abc', count: 1 },
};

describe('central audit-event writer', () => {
  it('inserts through the caller transaction and returns created evidence', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: event.id, created: true }] });
    await expect(writeAuditEvent({ query } as unknown as PoolClient, event)).resolves.toEqual({ id: event.id, created: true });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (id) DO NOTHING'), expect.arrayContaining([event.id, event.clientId]));
  });

  it('returns the existing event for a byte-equivalent retry', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: event.id, created: false }] });
    await expect(writeAuditEvent({ query } as unknown as PoolClient, event)).resolves.toEqual({ id: event.id, created: false });
  });

  it('fails closed when an id is bound to different evidence', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(writeAuditEvent({ query } as unknown as PoolClient, event)).rejects.toBeInstanceOf(AuditEventConflictError);
  });

  it('rejects malformed JSON before database access', async () => {
    const query = vi.fn();
    await expect(writeAuditEvent({ query } as unknown as PoolClient, {
      ...event, detail: { invalid: undefined },
    })).rejects.toBeInstanceOf(AuditEventValidationError);
    expect(query).not.toHaveBeenCalled();
  });
});
