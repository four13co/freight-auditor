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

  it('accepts canonical PostgreSQL UUIDs without imposing RFC version bits', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: event.id, created: true }] });
    await expect(writeAuditEvent({ query } as unknown as PoolClient, {
      ...event, clientId: '11111111-1111-1111-1111-111111111111',
    })).resolves.toMatchObject({ created: true });
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

  it('coerces a raw Date in detail to an ISO string instead of failing validation', async () => {
    const query = vi.fn().mockImplementation(async (_sql: string, values: unknown[]) => ({ rows: [{ id: values[0], created: true }] }));
    const recordedAt = new Date('2026-08-28T12:00:00.000Z');
    await expect(writeAuditEvent({ query } as unknown as PoolClient, {
      ...event, detail: { recordedAt },
    })).resolves.toMatchObject({ created: true });
    const [, values] = query.mock.calls[0]!;
    expect((values as unknown[])[9]).toEqual({ recordedAt: '2026-08-28T12:00:00.000Z' });
  });

  it('coerces a Date nested inside an array or object within detail', async () => {
    const query = vi.fn().mockImplementation(async (_sql: string, values: unknown[]) => ({ rows: [{ id: values[0], created: true }] }));
    const at = new Date('2026-08-28T12:00:00.000Z');
    await expect(writeAuditEvent({ query } as unknown as PoolClient, {
      ...event, detail: { events: [{ at }] },
    })).resolves.toMatchObject({ created: true });
    const [, values] = query.mock.calls[0]!;
    expect((values as unknown[])[9]).toEqual({ events: [{ at: '2026-08-28T12:00:00.000Z' }] });
  });

  // P6.A.4 (86e2zfjp9): 'client' added alongside analyst/ai/system so a
  // client-portal user's own auditable actions (e.g. a membership role
  // change) aren't misattributed to one of the pre-existing actor kinds.
  it("accepts actorKind 'client' (added for P6.A.4's portal-facing audit events)", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: event.id, created: true }] });
    await expect(writeAuditEvent({ query } as unknown as PoolClient, {
      ...event, actorKind: 'client',
    })).resolves.toMatchObject({ created: true });
    expect(query).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['client']));
  });

  it('still rejects an actorKind outside the known set', async () => {
    const query = vi.fn();
    await expect(writeAuditEvent({ query } as unknown as PoolClient, {
      ...event, actorKind: 'not-a-real-kind' as unknown as 'system',
    })).rejects.toBeInstanceOf(AuditEventValidationError);
    expect(query).not.toHaveBeenCalled();
  });
});
