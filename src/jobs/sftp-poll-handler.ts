import type pg from 'pg';
import type { ObjectStore } from '../modules/reference-data/object-store.js';
import { pollSftpIntake, type SftpClient } from '../modules/ingestion/sftp-intake.js';
import { parseJobPayload, JOB_NAMES } from './contracts.js';

interface ConnectionRow {
  id: string;
  client_id: string;
  remote_path: string;
  enabled: boolean;
}

export class SftpConnectionUnavailableError extends Error {
  readonly code = 'SFTP_CONNECTION_UNAVAILABLE';
  constructor() {
    super('SFTP connection is missing, disabled, or outside the tenant scope');
    this.name = 'SftpConnectionUnavailableError';
  }
}

export async function handleSftpPollJob(
  db: pg.PoolClient,
  store: ObjectStore,
  sftp: SftpClient,
  untrustedPayload: unknown,
) {
  const payload = parseJobPayload(JOB_NAMES.POLL_SFTP_V1, untrustedPayload);
  const query = await db.query<ConnectionRow>(
    `SELECT id, client_id, remote_path, enabled FROM sftp_connection
     WHERE id = $1 AND client_id = $2`,
    [payload.connectionId, payload.clientId],
  );
  const connection = query.rows[0];
  if (!connection?.enabled) throw new SftpConnectionUnavailableError();
  return pollSftpIntake(db, store, sftp, {
    id: connection.id,
    clientId: connection.client_id,
    remotePath: connection.remote_path,
  });
}
