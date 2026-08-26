import { describe, expect, it } from 'vitest';
import { AuditReplayManifestSchema, canonicalManifestJson, replayManifestHash } from '../../src/modules/audit-ledger/replay-manifest.js';

const manifest = {
  schemaVersion: 1 as const,
  auditRunId: '10000000-0000-4000-8000-000000000001',
  clientId: '10000000-0000-4000-8000-000000000002',
  engineSpecVersion: 'engine-v1',
  parser: { transactionSet: '210', version: 'x12-v1' },
  sourceDocuments: [{ id: '10000000-0000-4000-8000-000000000003', sha256: 'a'.repeat(64) }],
  rubric: { snapshotId: null, contentHash: null, resolverVersion: null },
  ruleVersions: [], contractVersions: [], externalValues: [], crosswalkRows: [], ai: [],
  invoice: { currency: 'USD', amount: '0.10' },
  result: { outcome: 'SCORED', total: '0.10' },
};

describe('audit replay manifest', () => {
  it('requires every mutable dependency class to be explicitly pinned, even when unused', () => {
    expect(AuditReplayManifestSchema.parse(manifest)).toEqual(manifest);
    const incomplete: Partial<typeof manifest> = { ...manifest };
    delete incomplete.externalValues;
    expect(() => AuditReplayManifestSchema.parse(incomplete)).toThrow();
  });

  it('canonicalizes object key order and hashes byte-identically', () => {
    const reordered = { ...manifest, invoice: { amount: '0.10', currency: 'USD' } };
    expect(canonicalManifestJson(reordered)).toBe(canonicalManifestJson(manifest));
    expect(replayManifestHash(reordered)).toBe(replayManifestHash(manifest));
    expect(replayManifestHash(manifest)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects unsupported versions and unknown top-level fields', () => {
    expect(() => AuditReplayManifestSchema.parse({ ...manifest, schemaVersion: 2 })).toThrow();
    expect(() => AuditReplayManifestSchema.parse({ ...manifest, surprise: true })).toThrow();
  });
});
