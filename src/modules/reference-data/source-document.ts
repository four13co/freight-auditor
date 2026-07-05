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
 *     ref rather than duplicating it — even across tenants, since sha256 is a
 *     global unique index while the table itself is RLS-scoped by client_id.
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

  // Conflict: an identical document already exists. The UNIQUE(sha256) index is
  // global while source_document is RLS-scoped by client_id, so the existing row
  // may belong to a *different* tenant than the caller's transaction scope — the
  // fallback SELECT under that scope then sees zero rows. Since the content is
  // already known-identical (same sha256/uri/byteSize from the content-addressed
  // store.put() above), only the row `id` needs cross-tenant resolution: widen to
  // an internal-scoped lookup for just this query, then restore the caller's
  // original scope so the rest of their transaction keeps its original isolation.
  const priorInternal = await client.query<{ v: string | null }>(
    `SELECT current_setting('app.is_internal', true) AS v`,
  );
  await client.query(`SELECT set_config('app.is_internal', 'true', true)`);
  let row: { id: string } | undefined;
  try {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM source_document WHERE sha256 = $1`,
      [sha256],
    );
    row = existing.rows[0];
  } finally {
    await client.query(`SELECT set_config('app.is_internal', $1, true)`, [
      priorInternal.rows[0]?.v ?? 'false',
    ]);
  }
  if (!row) {
    // Genuinely unreachable: ON CONFLICT fired, so a row with this sha256
    // exists somewhere — the internal-scoped lookup above sees every tenant.
    throw new Error(`source_document conflict on ${sha256} but row not found`);
  }
  return {
    id: row.id,
    sha256,
    storageUri: uri,
    byteSize,
    created: false,
  };
}
