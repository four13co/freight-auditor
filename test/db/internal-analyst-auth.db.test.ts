import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { resolveInternalAnalystContext } from '../../src/modules/findings/internal-analyst-auth.js';

/**
 * P5.C.3 (rebuild), against real Postgres: proves the app_user.is_internal
 * lookup itself -- app_user carries no RLS (it is not in migration 0009's
 * tenant-table list), so this can be run under a plain internal-scoped
 * transaction without needing a membership row at all, unlike
 * tenant-auth.db.test.ts's membership-gated dev-header path.
 *
 * DEV_AUTH_HEADERS is set for this whole suite (see
 * test/unit/internal-analyst-auth.test.ts for the DEV_AUTH_HEADERS-unset
 * unit coverage of the session path, mocked getSession -- a full real
 * sign-up/sign-in round-trip isn't repeated here since resolveInternalAnalystContext
 * reuses getAuth()/toFetchHeaders() unmodified from tenant-auth.ts, already
 * proven end-to-end by tenant-auth-session.db.test.ts).
 */
describe('resolveInternalAnalystContext (DB)', () => {
  let pool: pg.Pool;
  let internalUserId: string;
  let nonInternalUserId: string;
  let inactiveInternalUserId: string;
  let originalFlag: string | undefined;
  const tag = `iaa-${Date.now()}`;

  beforeAll(async () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
    pool = getPool();
    const owner = await pool.connect();
    try {
      const u1 = await owner.query(
        `INSERT INTO app_user (email, is_internal) VALUES ($1, true) RETURNING id`,
        [`${tag}-internal@example.com`],
      );
      internalUserId = u1.rows[0].id;

      const u2 = await owner.query(
        `INSERT INTO app_user (email, is_internal) VALUES ($1, false) RETURNING id`,
        [`${tag}-client@example.com`],
      );
      nonInternalUserId = u2.rows[0].id;

      const u3 = await owner.query(
        `INSERT INTO app_user (email, is_internal, is_active) VALUES ($1, true, false) RETURNING id`,
        [`${tag}-inactive-internal@example.com`],
      );
      inactiveInternalUserId = u3.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    if (originalFlag === undefined) delete process.env.DEV_AUTH_HEADERS;
    else process.env.DEV_AUTH_HEADERS = originalFlag;
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM app_user WHERE id = ANY($1)`, [[internalUserId, nonInternalUserId, inactiveInternalUserId]]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('grants { internal: true } for an active app_user with is_internal = true', async () => {
    const ctx = await resolveInternalAnalystContext({ headers: { 'x-user-id': internalUserId } } as never);
    expect(ctx).toEqual({ internal: true });
  });

  it('rejects an active app_user with is_internal = false', async () => {
    const ctx = await resolveInternalAnalystContext({ headers: { 'x-user-id': nonInternalUserId } } as never);
    expect(ctx).toBeNull();
  });

  it('rejects an inactive app_user even when is_internal = true', async () => {
    const ctx = await resolveInternalAnalystContext({ headers: { 'x-user-id': inactiveInternalUserId } } as never);
    expect(ctx).toBeNull();
  });

  it('rejects a user id with no matching app_user row', async () => {
    const ctx = await resolveInternalAnalystContext({ headers: { 'x-user-id': '00000000-0000-0000-0000-000000000000' } } as never);
    expect(ctx).toBeNull();
  });
});
