import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from '../../src/db/pool.js';
import { AuditReplayManifestSchema, replayManifestHash } from '../../src/modules/audit-ledger/replay-manifest.js';
import { replayAuditRun, ReplayIntegrityError, ReplayNotFoundError, ReplayUnavailableError } from '../../src/modules/audit-ledger/replay-audit-run.js';
import { evaluateInvoice } from '../../src/modules/evaluator/evaluate-invoice.js';
import type { ParsedInvoice } from '../../src/modules/ingestion/charge-fact.js';

const invoice: ParsedInvoice = {
  transactionSet: '210', parserVersion: 'x12-v1', charges: [],
  footing: { lineSum: '0.0000' }, quarantinedCodes: [],
};

const manifest = AuditReplayManifestSchema.parse({
  schemaVersion: 1 as const,
  auditRunId: '10000000-0000-4000-8000-000000000001', clientId: '10000000-0000-4000-8000-000000000002',
  engineSpecVersion: 'engine-v1', parser: { transactionSet: '210', version: 'x12-v1' },
  sourceDocuments: [], rubric: { snapshotId: null, contentHash: null, resolverVersion: null },
  ruleVersions: [], contractVersions: [], externalValues: [], crosswalkRows: [], ai: [], resolvedInputs: {},
  invoice,
  result: evaluateInvoice(invoice),
});

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

  it('requires and reports byte-identical canonical result bytes', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ content_hash: replayManifestHash(manifest), manifest }] })
      .mockResolvedValueOnce({ rows: [{ id: 'event', created: true }] });
    const result = await replayAuditRun({ query } as unknown as PoolClient, manifest.auditRunId);
    expect(result).toMatchObject({
      byteIdentical: true,
      matchesOriginal: true,
      resultHash: result.originalResultHash,
    });
  });

  it('fails closed when valid pinned inputs reproduce different bytes', async () => {
    const divergent = {
      ...manifest,
      result: { ...(manifest.result as Record<string, unknown>), outcome: 'SCORED' },
    };
    const query = vi.fn().mockResolvedValue({ rows: [{ content_hash: replayManifestHash(divergent), manifest: divergent }] });
    await expect(replayAuditRun({ query } as unknown as PoolClient, manifest.auditRunId)).rejects.toBeInstanceOf(ReplayIntegrityError);
  });

  it('rejects a stored manifest that fails schema validation', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ content_hash: '0'.repeat(64), manifest: { nope: true } }] });
    await expect(replayAuditRun({ query } as unknown as PoolClient, manifest.auditRunId)).rejects.toBeInstanceOf(ReplayIntegrityError);
  });

  it('rejects unavailable engine versions and custom rubric snapshots explicitly', async () => {
    const oldEngine = { ...manifest, engineSpecVersion: 'engine-v0' };
    let query = vi.fn().mockResolvedValue({ rows: [{ content_hash: replayManifestHash(oldEngine), manifest: oldEngine }] });
    await expect(replayAuditRun({ query } as unknown as PoolClient, manifest.auditRunId)).rejects.toBeInstanceOf(ReplayUnavailableError);

    const customRubric = { ...manifest, rubric: { ...manifest.rubric, snapshotId: '11111111-1111-1111-1111-111111111111' } };
    query = vi.fn().mockResolvedValue({ rows: [{ content_hash: replayManifestHash(customRubric), manifest: customRubric }] });
    await expect(replayAuditRun({ query } as unknown as PoolClient, manifest.auditRunId)).rejects.toBeInstanceOf(ReplayUnavailableError);
  });

  it('fails closed when source, rule, or contract content pins do not match storage', async () => {
    const id = '11111111-1111-1111-1111-111111111111';
    const hash = 'a'.repeat(64);
    const cases = [
      { patched: { ...manifest, sourceDocuments: [{ id, sha256: hash }] }, stored: { sha256: 'b'.repeat(64) } },
      { patched: { ...manifest, ruleVersions: [{ id, contentHash: hash }] }, stored: { ast_hash: 'b'.repeat(64) } },
      { patched: { ...manifest, contractVersions: [{ id, contentHash: hash }] }, stored: { sha256: 'b'.repeat(64) } },
    ];
    for (const { patched, stored } of cases) {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [{ content_hash: replayManifestHash(patched), manifest: patched }] })
        .mockResolvedValueOnce({ rows: [stored] });
      await expect(replayAuditRun({ query } as unknown as PoolClient, manifest.auditRunId)).rejects.toBeInstanceOf(ReplayIntegrityError);
    }
  });
});
