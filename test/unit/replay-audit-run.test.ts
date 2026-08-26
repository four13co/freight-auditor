import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from '../../src/db/pool.js';
import { replayManifestHash } from '../../src/modules/audit-ledger/replay-manifest.js';
import { replayAuditRun, ReplayIntegrityError, ReplayNotFoundError } from '../../src/modules/audit-ledger/replay-audit-run.js';

const manifest = {
  schemaVersion: 1 as const,
  auditRunId: '10000000-0000-4000-8000-000000000001', clientId: '10000000-0000-4000-8000-000000000002',
  engineSpecVersion: '1.0.0', parser: { transactionSet: '210', version: 'x12-v1' },
  sourceDocuments: [], rubric: { snapshotId: null, contentHash: null, resolverVersion: null },
  ruleVersions: [], contractVersions: [], externalValues: [], crosswalkRows: [], ai: [], resolvedInputs: {},
  invoice: { transactionSet: '210', parserVersion: 'x12-v1', charges: [], footing: { lineSum: '0.0000' }, quarantinedCodes: [] },
  result: {},
};

describe('replay audit run', () => {
  it('returns not found under an absent or RLS-hidden manifest', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(replayAuditRun({ query } as unknown as PoolClient, manifest.auditRunId)).rejects.toBeInstanceOf(ReplayNotFoundError);
  });

  it('fails closed before evaluation when stored content does not match its hash', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ content_hash: '0'.repeat(64), manifest }] });
    await expect(replayAuditRun({ query } as unknown as PoolClient, manifest.auditRunId)).rejects.toBeInstanceOf(ReplayIntegrityError);
    expect(replayManifestHash(manifest)).not.toBe('0'.repeat(64));
  });
});
