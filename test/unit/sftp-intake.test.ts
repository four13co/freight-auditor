import { describe, expect, it, vi } from 'vitest';
import { pollSftpIntake, remoteFingerprint, type SftpRemoteEntry } from '../../src/modules/ingestion/sftp-intake.js';
import type { ObjectStore } from '../../src/modules/reference-data/object-store.js';
import { sha256Hex } from '../../src/modules/reference-data/object-store.js';

describe('SFTP immutable intake', () => {
  const entry: SftpRemoteEntry = {
    path: '/inbound/invoice-1.edi',
    size: 42,
    modifiedAt: '2026-08-25T12:00:00.000Z',
    etag: 'revision-1',
  };

  it('derives a stable checkpoint without exposing remote metadata', () => {
    const first = remoteFingerprint(entry);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(remoteFingerprint({ ...entry })).toBe(first);
    expect(first).not.toContain(entry.path);
  });

  it('changes the checkpoint when a path is replaced in place', () => {
    expect(remoteFingerprint({ ...entry, etag: 'revision-2' })).not.toBe(remoteFingerprint(entry));
    expect(remoteFingerprint({ ...entry, size: 43 })).not.toBe(remoteFingerprint(entry));
  });

  it('keeps the transport contract read-only', async () => {
    const sftp = { list: vi.fn().mockResolvedValue([entry]), read: vi.fn() };
    await expect(sftp.list('/inbound')).resolves.toEqual([entry]);
    expect(Object.keys(sftp).sort()).toEqual(['list', 'read']);
  });

  it('stores a claimed file once and checkpoints its source document', async () => {
    const bytes = Buffer.from('ST*210*1~SE*2*1~');
    const remote = { ...entry, size: bytes.byteLength };
    const queries: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('INSERT INTO sftp_intake')) return { rows: [{ id: 'intake-1' }] };
        if (sql.includes('INSERT INTO source_document')) return { rows: [{ id: 'document-1' }] };
        return { rows: [] };
      }),
    };
    const store: ObjectStore = {
      put: vi.fn(async (value: Buffer) => ({ sha256: sha256Hex(value), uri: 'r2://bucket/key', byteSize: value.byteLength })),
      get: vi.fn(),
      has: vi.fn(),
    };
    const result = await pollSftpIntake(db as never, store, {
      list: vi.fn().mockResolvedValue([remote]),
      read: vi.fn().mockResolvedValue(bytes),
    }, { id: 'connection-1', clientId: 'client-1', remotePath: '/inbound' });

    expect(result).toEqual({ discovered: 1, stored: 1, duplicates: 0, quarantined: 0 });
    expect(queries.some((sql) => sql.includes("status = 'stored'"))).toBe(true);
  });

  it('does not re-read a previously checkpointed remote revision', async () => {
    const read = vi.fn();
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const result = await pollSftpIntake(db as never, {} as ObjectStore, {
      list: vi.fn().mockResolvedValue([entry]), read,
    }, { id: 'connection-1', clientId: 'client-1', remotePath: '/inbound' });
    expect(result.duplicates).toBe(1);
    expect(read).not.toHaveBeenCalled();
  });

  it('quarantines a truncated remote read with a stable code', async () => {
    const updates: unknown[][] = [];
    const db = { query: vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('INSERT INTO sftp_intake')) return { rows: [{ id: 'intake-1' }] };
      if (sql.includes('UPDATE sftp_intake')) updates.push(values ?? []);
      return { rows: [] };
    }) };
    const result = await pollSftpIntake(db as never, {} as ObjectStore, {
      list: vi.fn().mockResolvedValue([entry]), read: vi.fn().mockResolvedValue(Buffer.from('short')),
    }, { id: 'connection-1', clientId: 'client-1', remotePath: '/inbound' });
    expect(result.quarantined).toBe(1);
    expect(updates[0]?.[0]).toBe('SIZE_MISMATCH');
  });
});
