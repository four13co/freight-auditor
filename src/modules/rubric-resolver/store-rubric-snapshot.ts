import type pg from 'pg';
import { canonicalizeResolvedRubricDocument } from './canonicalize-resolved-rubric.js';

export class RubricSnapshotHashConflictError extends Error {
  readonly code = 'RUBRIC_SNAPSHOT_HASH_CONFLICT';
  constructor() {
    super('Rubric snapshot content hash is bound to different canonical content');
    this.name = 'RubricSnapshotHashConflictError';
  }
}

export async function storeRubricSnapshot(
  client: pg.PoolClient,
  tenantId: string | null,
  untrustedDocument: unknown,
): Promise<{ id: string; contentHash: string; created: boolean }> {
  const canonical = canonicalizeResolvedRubricDocument(untrustedDocument);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO rubric_snapshot (tenant_id, content_hash, resolved_doc, resolver_version)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (tenant_id, content_hash) DO NOTHING RETURNING id`,
    [tenantId, canonical.contentHash, canonical.json, canonical.document.resolverVersion],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, contentHash: canonical.contentHash, created: true };

  const existing = (await client.query<{ id: string; resolved_doc: unknown; resolver_version: string }>(
    `SELECT id, resolved_doc, resolver_version FROM rubric_snapshot
     WHERE tenant_id IS NOT DISTINCT FROM $1::uuid AND content_hash = $2`,
    [tenantId, canonical.contentHash],
  )).rows[0];
  if (!existing) throw new RubricSnapshotHashConflictError();
  const stored = canonicalizeResolvedRubricDocument(existing.resolved_doc);
  if (stored.json !== canonical.json || existing.resolver_version !== canonical.document.resolverVersion) {
    throw new RubricSnapshotHashConflictError();
  }
  return { id: existing.id, contentHash: canonical.contentHash, created: false };
}
