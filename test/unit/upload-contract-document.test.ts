import { describe, expect, it, vi } from 'vitest';
import type { ObjectStore } from '../../src/modules/reference-data/object-store.js';
import {
  ContractNotFoundError,
  ContractUploadMetadataSchema,
  uploadContractDocument,
  uploadContractVersionDocument,
} from '../../src/modules/contracts/upload-contract-document.js';

const clientId = '11111111-1111-4111-8111-111111111111';
const carrierId = '22222222-2222-4222-8222-222222222222';
const contractId = '33333333-3333-4333-8333-333333333333';
const versionId = '44444444-4444-4444-8444-444444444444';
const sourceId = '55555555-5555-4555-8555-555555555555';
const store: ObjectStore = {
  put: vi.fn().mockResolvedValue({ sha256: 'a'.repeat(64), uri: 'r2://bucket/a', byteSize: 3 }),
  get: vi.fn(), has: vi.fn(),
};

describe('contract document persistence', () => {
  it('validates strict effective dates', () => {
    expect(ContractUploadMetadataSchema.safeParse({ carrierId, name: 'A', validFrom: '2026-01-02', validTo: '2026-01-01' }).success).toBe(false);
  });

  it('persists source, contract, version, and deterministic audit evidence', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO source_document')) return { rows: [{ id: sourceId }], rowCount: 1 };
      if (sql.includes('SELECT cv.contract_id')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT 1 FROM carrier')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (sql.includes('INSERT INTO contract (')) return { rows: [{ id: contractId }], rowCount: 1 };
      if (sql.includes('INSERT INTO contract_version')) return { rows: [{ id: versionId }], rowCount: 1 };
      if (sql.includes('WITH inserted AS')) return { rows: [{ id: 'event', created: true }], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const result = await uploadContractDocument({ query } as never, store, {
      clientId, actorUserId: null, bytes: Buffer.from('pdf'), contentType: 'application/pdf',
      metadata: { carrierId, name: 'Primary', versionLabel: 'v1', validFrom: '2026-01-01' },
    });
    expect(result).toEqual({ contractId, contractVersionId: versionId, sourceDocumentId: sourceId, sha256: 'a'.repeat(64), created: true });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO audit_event'))).toBe(true);
  });

  it('fails safely when a version targets a missing tenant contract', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO source_document')) return { rows: [{ id: sourceId }], rowCount: 1 };
      if (sql.includes('SELECT cv.contract_id')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT 1 FROM contract')) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await expect(uploadContractVersionDocument({ query } as never, store, {
      clientId, actorUserId: null, contractId, bytes: Buffer.from('pdf'), contentType: 'application/pdf',
      metadata: { validFrom: '2026-01-01' },
    })).rejects.toBeInstanceOf(ContractNotFoundError);
  });
});
