import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { updateUserProfile } from '../../src/modules/identity/update-user-profile.js';

/**
 * 86e38pz8e: PATCH /api/profile's backing write, against real Postgres.
 * app_user carries no RLS (it's a global identity table, not tenant-scoped)
 * -- the interesting boundary this proves is "only the targeted row
 * changes," not tenant isolation (which doesn't apply here).
 */
describe('updateUserProfile (DB)', () => {
  let pool: pg.Pool;
  let userAId: string;
  let userBId: string;
  const tag = `uup-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(
        `INSERT INTO app_user (email, name, image) VALUES ($1, 'Original Name', 'https://cdn.example.com/original.png') RETURNING id`,
        [`${tag}-a@example.com`],
      );
      userAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO app_user (email, name) VALUES ($1, 'Untouched') RETURNING id`, [`${tag}-b@example.com`]);
      userBId = b.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM app_user WHERE id IN ($1, $2)`, [userAId, userBId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('AC3: updates only the name, leaving image untouched', async () => {
    const client = await pool.connect();
    try {
      const result = await updateUserProfile(client, userAId, { name: 'Updated Name' });
      expect(result).toMatchObject({ id: userAId, name: 'Updated Name', image: 'https://cdn.example.com/original.png' });
    } finally {
      client.release();
    }
  });

  it('updates only the image, leaving name untouched', async () => {
    const client = await pool.connect();
    try {
      const result = await updateUserProfile(client, userAId, { image: 'https://cdn.example.com/new.png' });
      expect(result).toMatchObject({ id: userAId, image: 'https://cdn.example.com/new.png' });
    } finally {
      client.release();
    }
  });

  it('clears the image with an explicit null', async () => {
    const client = await pool.connect();
    try {
      const result = await updateUserProfile(client, userAId, { image: null });
      expect(result).toMatchObject({ id: userAId, image: null });
    } finally {
      client.release();
    }
  });

  it('never touches a different user\'s row', async () => {
    const client = await pool.connect();
    try {
      await updateUserProfile(client, userAId, { name: 'Only A' });
      const bRow = await pool.query(`SELECT name FROM app_user WHERE id = $1`, [userBId]);
      expect(bRow.rows[0].name).toBe('Untouched');
    } finally {
      client.release();
    }
  });

  it('returns null for a user id that does not exist', async () => {
    const client = await pool.connect();
    try {
      const result = await updateUserProfile(client, '00000000-0000-4000-8000-000000000000', { name: 'Ghost' });
      expect(result).toBeNull();
    } finally {
      client.release();
    }
  });
});
