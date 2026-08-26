import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';

describe('SFTP connector checkpoints (DB)', () => {
  let pool: pg.Pool;
  let clientA: string;
  let clientB: string;
  let connectionA: string;
  const tag = `sftp-${Date.now()}`;
  const fingerprint = 'a'.repeat(64);

  beforeAll(async () => {
    pool = getPool();
    const a = await pool.query(`INSERT INTO client (name, slug) VALUES ('SFTP A', $1) RETURNING id`, [`${tag}-a`]);
    const b = await pool.query(`INSERT INTO client (name, slug) VALUES ('SFTP B', $1) RETURNING id`, [`${tag}-b`]);
    clientA = a.rows[0].id;
    clientB = b.rows[0].id;
    const connection = await pool.query(
      `INSERT INTO sftp_connection
        (client_id, name, host, username, remote_path, private_key_secret_ref, host_key_sha256)
       VALUES ($1, 'primary', 'sftp.example.test', 'freight', '/inbound', 'SFTP_KEY_A', $2) RETURNING id`,
      [clientA, 'b'.repeat(64)],
    );
    connectionA = connection.rows[0].id;
    await pool.query(
      `INSERT INTO sftp_intake (client_id, connection_id, remote_path, remote_fingerprint, status)
       VALUES ($1, $2, '/inbound/a.edi', $3, 'stored')`,
      [clientA, connectionA, fingerprint],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM sftp_intake WHERE client_id IN ($1, $2)`, [clientA, clientB]);
    await pool.query(`DELETE FROM sftp_connection WHERE client_id IN ($1, $2)`, [clientA, clientB]);
    await pool.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientA, clientB]);
    await closePool();
  });

  it('RLS hides another tenant connection and checkpoint', async () => {
    const visible = await withTenantTx({ clientIds: [clientB], internal: false }, async (db) => {
      const connections = await db.query(`SELECT id FROM sftp_connection WHERE id = $1`, [connectionA]);
      const intake = await db.query(`SELECT id FROM sftp_intake WHERE connection_id = $1`, [connectionA]);
      return { connections: connections.rowCount, intake: intake.rowCount };
    });
    expect(visible).toEqual({ connections: 0, intake: 0 });
  });

  it('stored remote revisions remain unique across retries', async () => {
    const inserted = await withTenantTx({ clientIds: [clientA], internal: false }, (db) => db.query(
      `INSERT INTO sftp_intake (client_id, connection_id, remote_path, remote_fingerprint, status)
       VALUES ($1, $2, '/inbound/a.edi', $3, 'discovered')
       ON CONFLICT (connection_id, remote_path, remote_fingerprint) DO NOTHING RETURNING id`,
      [clientA, connectionA, fingerprint],
    ));
    expect(inserted.rowCount).toBe(0);
  });

  it('RLS rejects a checkpoint assigned to another tenant connection', async () => {
    await expect(withTenantTx({ clientIds: [clientB], internal: false }, (db) => db.query(
      `INSERT INTO sftp_intake (client_id, connection_id, remote_path, remote_fingerprint, status)
       VALUES ($1, $2, '/inbound/evil.edi', $3, 'discovered')`,
      [clientB, connectionA, 'c'.repeat(64)],
    ))).rejects.toBeDefined();
  });
});
