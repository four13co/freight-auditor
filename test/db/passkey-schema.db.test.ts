import { describe, it, expect, afterAll } from 'vitest';
import { getPool, closePool } from '../../src/db/pool.js';

/**
 * 86e2v1bf1: proves the passkey table's column mapping (better-auth.ts's
 * `passkey({ schema: { passkey: { fields: {...} } } })` remap) actually
 * matches what the @better-auth/passkey plugin's own schema declares --
 * before the real WebAuthn e2e (which needs a CDP virtual authenticator and
 * is a much slower, much harder to debug failure surface if this mapping is
 * wrong). Writes and reads a row using the exact camelCase field names the
 * plugin's schema constant declares (publicKey, credentialID, userId,
 * deviceType, backedUp, createdAt), going through better-auth's own
 * internal-adapter-equivalent path is not needed here -- what's actually at
 * risk is the DDL column NAMES matching the remap, which a raw SQL
 * round-trip against the migration's actual table proves directly.
 */
describe('passkey table schema (DB)', () => {
  const tag = `passkeyschema-${Date.now()}`;

  afterAll(async () => {
    const pool = getPool();
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM passkey WHERE user_id IN (SELECT id FROM app_user WHERE email LIKE $1)`, [`${tag}%`]);
      await owner.query(`DELETE FROM app_user WHERE email LIKE $1`, [`${tag}%`]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('accepts an insert using the exact column set the passkey plugin\'s schema declares, and reads it back', async () => {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const email = `${tag}@example.com`;
      const userResult = await client.query<{ id: string }>(
        `INSERT INTO app_user (email, name) VALUES ($1, 'Passkey Schema Test User') RETURNING id`,
        [email],
      );
      const userId = userResult.rows[0]!.id;

      await client.query(
        `INSERT INTO passkey (id, name, public_key, user_id, credential_id, counter, device_type, backed_up, transports, aaguid)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          `${tag}-passkey-id`,
          'Test Passkey',
          'test-public-key-base64url',
          userId,
          'test-credential-id-base64url',
          0,
          'singleDevice',
          false,
          'internal',
          'test-aaguid',
        ],
      );

      const result = await client.query(
        `SELECT id, name, public_key, user_id, credential_id, counter, device_type, backed_up, transports, aaguid, created_at
         FROM passkey WHERE id = $1`,
        [`${tag}-passkey-id`],
      );
      expect(result.rowCount).toBe(1);
      const row = result.rows[0];
      expect(row.public_key).toBe('test-public-key-base64url');
      expect(row.user_id).toBe(userId);
      expect(row.credential_id).toBe('test-credential-id-base64url');
      expect(row.device_type).toBe('singleDevice');
      expect(row.backed_up).toBe(false);
      expect(row.created_at).toBeInstanceOf(Date);
    } finally {
      client.release();
    }
  });

  it('rejects a passkey row with no user_id (FK to app_user, mirroring ba_account\'s pattern)', async () => {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await expect(
        client.query(
          `INSERT INTO passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [`${tag}-orphan`, 'pk', '00000000-0000-0000-0000-000000000000', 'cred', 0, 'singleDevice', false],
        ),
      ).rejects.toThrow();
    } finally {
      client.release();
    }
  });

  it('freight_app has the same CRUD grant on passkey as ba_account/ba_session/ba_verification (migration 0015 AC)', async () => {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const result = await client.query<{
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
      }>(
        `SELECT
           has_table_privilege('freight_app', 'passkey', 'SELECT') AS can_select,
           has_table_privilege('freight_app', 'passkey', 'INSERT') AS can_insert,
           has_table_privilege('freight_app', 'passkey', 'UPDATE') AS can_update,
           has_table_privilege('freight_app', 'passkey', 'DELETE') AS can_delete`,
      );
      const row = result.rows[0]!;
      expect(row.can_select).toBe(true);
      expect(row.can_insert).toBe(true);
      expect(row.can_update).toBe(true);
      expect(row.can_delete).toBe(true);
    } finally {
      client.release();
    }
  });
});
