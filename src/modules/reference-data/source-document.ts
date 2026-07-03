import type pg from 'pg';
import type { ObjectStore } from './object-store.js';

/**
 * Immutable source-document intake (Master Spec §6.3). Stores the raw bytes in
 * the {@link ObjectStore} (content-addressed) and records a `source_document`
 * row pointing at them. Both layers are idempotent on the sha256:
 *
 *   - the object store writes the bytes at most once;
 *   - the row insert uses `ON CONFLICT (sha256) DO NOTHING` and returns the
 *     existing row, so re-ingesting identical bytes returns the same document
 *     ref rather than duplicating it.
 *
 * Must be called inside a tenant transaction (withTenantTx) — the insert is
 * subject to RLS on source_document.
 */
export interface StoreDocumentInput {
  clientId: string | null; // null = shared/global document
  bytes: Buffer;
  contentType?: string;
}

export interface SourceDocumentRef {
  id: string;
  sha256: string;
  storageUri: string;
  byteSize: number;
  /** true when this call created the row; false when an identical one existed. */
  created: boolean;
}

export async function storeSourceDocument(
  client: pg.PoolClient,
  store: ObjectStore,
  input: StoreDocumentInput,
): Promise<SourceDocumentRef> {
  const { sha256, uri, byteSize } = await store.put(input.bytes);

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO source_document (client_id, sha256, content_type, byte_size, storage_uri)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (sha256) DO NOTHING
     RETURNING id`,
    [input.clientId, sha256, input.contentType ?? null, byteSize, uri],
  );

  if (inserted.rows.length === 1) {
    return { id: inserted.rows[0]!.id, sha256, storageUri: uri, byteSize, created: true };
  }

  // Conflict: an identical document already exists — return its ref.
  const existing = await client.query<{ id: string; storage_uri: string; byte_size: string }>(
    `SELECT id, storage_uri, byte_size FROM source_document WHERE sha256 = $1`,
    [sha256],
  );
  const row = existing.rows[0];
  if (!row) {
    // Should be unreachable: ON CONFLICT fired, so a row with this sha256 exists
    // and is visible under the same tenant scope.
    throw new Error(`source_document conflict on ${sha256} but row not found in scope`);
  }
  return {
    id: row.id,
    sha256,
    storageUri: row.storage_uri,
    byteSize: Number(row.byte_size),
    created: false,
  };
}
