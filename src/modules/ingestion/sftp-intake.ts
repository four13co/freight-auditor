import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { ObjectStore } from '../reference-data/object-store.js';
import { storeSourceDocument } from '../reference-data/source-document.js';

export interface SftpRemoteEntry {
  path: string;
  size: number;
  modifiedAt: string;
  /** Optional server-provided stable revision identifier. */
  etag?: string;
}

export interface SftpClient {
  list(remotePath: string): Promise<readonly SftpRemoteEntry[]>;
  read(path: string): Promise<Buffer>;
}

export interface SftpConnectionConfig {
  id: string;
  clientId: string;
  remotePath: string;
}

export interface SftpPollResult {
  discovered: number;
  stored: number;
  duplicates: number;
  quarantined: number;
}

export function remoteFingerprint(entry: SftpRemoteEntry): string {
  return createHash('sha256')
    .update(entry.path).update('\0')
    .update(String(entry.size)).update('\0')
    .update(entry.modifiedAt).update('\0')
    .update(entry.etag ?? '')
    .digest('hex');
}

function contentTypeFor(path: string): string {
  return path.toLowerCase().endsWith('.edi') || path.toLowerCase().endsWith('.x12')
    ? 'application/edi-x12'
    : 'application/octet-stream';
}

/**
 * Poll one configured directory and durably checkpoint every immutable remote
 * revision. The caller supplies an authenticated, host-key-verified transport;
 * credentials are deliberately absent from this function and its return value.
 */
export async function pollSftpIntake(
  db: pg.PoolClient,
  store: ObjectStore,
  sftp: SftpClient,
  connection: SftpConnectionConfig,
): Promise<SftpPollResult> {
  const entries = [...await sftp.list(connection.remotePath)].sort((a, b) => a.path.localeCompare(b.path));
  const result: SftpPollResult = { discovered: entries.length, stored: 0, duplicates: 0, quarantined: 0 };

  for (const entry of entries) {
    const fingerprint = remoteFingerprint(entry);
    const claim = await db.query<{ id: string }>(
      `INSERT INTO sftp_intake
         (client_id, connection_id, remote_path, remote_fingerprint, status)
       VALUES ($1, $2, $3, $4, 'discovered')
       ON CONFLICT (connection_id, remote_path, remote_fingerprint) DO NOTHING
       RETURNING id`,
      [connection.clientId, connection.id, entry.path, fingerprint],
    );
    const intakeId = claim.rows[0]?.id;
    if (!intakeId) {
      result.duplicates += 1;
      continue;
    }

    try {
      const bytes = await sftp.read(entry.path);
      if (bytes.byteLength !== entry.size) throw new Error('SFTP_SIZE_MISMATCH');
      const document = await storeSourceDocument(db, store, {
        clientId: connection.clientId,
        bytes,
        contentType: contentTypeFor(entry.path),
      });
      if (!document.ownedByCaller) throw new Error('CROSS_TENANT_CONTENT_COLLISION');
      await db.query(
        `UPDATE sftp_intake SET status = 'stored', source_document_id = $1, stored_at = now()
         WHERE id = $2 AND client_id = $3`,
        [document.id, intakeId, connection.clientId],
      );
      result.stored += 1;
    } catch (error) {
      const failureCode = error instanceof Error && error.message === 'SFTP_SIZE_MISMATCH'
        ? 'SIZE_MISMATCH'
        : error instanceof Error && error.message === 'CROSS_TENANT_CONTENT_COLLISION'
          ? 'CONTENT_OWNERSHIP_CONFLICT'
          : 'READ_OR_STORE_FAILED';
      await db.query(
        `UPDATE sftp_intake SET status = 'quarantined', failure_code = $1 WHERE id = $2 AND client_id = $3`,
        [failureCode, intakeId, connection.clientId],
      );
      result.quarantined += 1;
    }
  }
  return result;
}
