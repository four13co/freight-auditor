import { describe, it, expect, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { createMembership } from '../../src/modules/identity/create-membership.js';

/**
 * 86e38rdnm: tenant-admin member assignment -- creates an app_user when the
 * email is new, reuses an existing one otherwise, and reports
 * `created: false` on a repeat (user, tenant) pair rather than throwing.
 */
describe('createMembership (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  let existingUserId: string;
  const tag = `cm-${Date.now()}`;
  const newEmail = `new-${tag}@example.test`;
  const existingEmail = `existing-${tag}@example.test`;
  const createdUserIds: string[] = [];

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM membership WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM app_user WHERE id = ANY($1::uuid[])`, [createdUserIds]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('AC4: creates a new app_user + membership when the email is new', async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const created = await owner.query(`INSERT INTO client (name, slug) VALUES ('CM Client', $1) RETURNING id`, [tag]);
      clientId = created.rows[0].id;

      const existing = await owner.query(`INSERT INTO app_user (email, full_name) VALUES ($1, 'Existing User') RETURNING id`, [existingEmail]);
      existingUserId = existing.rows[0].id;
      createdUserIds.push(existingUserId);
    } finally {
      owner.release();
    }

    const result = await withTenantTx({ internal: true }, (client) =>
      createMembership(client, { clientId, email: newEmail, fullName: 'New User', role: 'client_admin' }),
    );
    expect(result.created).toBe(true);
    if (result.created) {
      expect(result.isNewUser).toBe(true);
      createdUserIds.push(result.userId);
    }
  });

  it('reuses an existing app_user by email rather than creating a duplicate', async () => {
    const result = await withTenantTx({ internal: true }, (client) =>
      createMembership(client, { clientId, email: existingEmail, role: 'analyst' }),
    );
    expect(result).toMatchObject({ created: true, userId: existingUserId, isNewUser: false });
  });

  it('reports created: false for a repeat (user, tenant) pair instead of throwing', async () => {
    const result = await withTenantTx({ internal: true }, (client) =>
      createMembership(client, { clientId, email: existingEmail, role: 'lead' }),
    );
    expect(result).toEqual({ created: false, reason: 'already_member' });
  });
});
