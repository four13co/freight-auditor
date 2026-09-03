import { describe, it, expect, afterAll } from 'vitest';
import { z } from 'zod';
import { getPool, closePool } from '../../src/db/pool.js';
import { seedDevTenant, DEV_CLIENT_ID, DEV_USER_ID } from '../../scripts/seed-dev-tenant.mjs';

/**
 * 86e2urebj: the dashboard's dev-mode auth headers (web/src/lib/api.ts)
 * claim DEV_CLIENT_ID/DEV_USER_ID -- this script is what makes that claimed
 * pair pass tenant-auth.ts's real membership check, not just its shape
 * check. Without it, both headers present still 401s (verified locally
 * during development: reproduced the 401, ran this script, reproduced 200).
 */
describe('seedDevTenant (DB)', () => {
  afterAll(async () => {
    await closePool();
  });

  /**
   * Finds every FK column (in any table) referencing table(id) and deletes
   * rows matching id, RECURSIVELY -- 86e33u1u5: a first version of this only
   * walked one level (direct references to `table`), which failed with a
   * real FK violation once a directly-referencing row itself had its own
   * dependents (e.g. deleting a `contract` row referencing DEV_CLIENT_ID
   * while a `contract_version` row still referenced that contract's own id
   * -- a table one level further removed from client(id), never queried).
   * Before deleting each directly-referencing row, this now recurses onto
   * that row's own id first, clearing anything that references IT, however
   * deep the chain goes -- the test-side mirror of what production's
   * reconcileSentinelId discovers generically via information_schema, used
   * here to tear down whatever ambient fixture footprint another db test
   * file in this same run (e.g. dashboard-auth-headers.db.test.ts's own
   * beforeAll) already built under DEV_CLIENT_ID/DEV_USER_ID before this
   * test needs a clean "only the OLD sentinel exists" starting point. This
   * suite's files share one never-rolled-back pool/DB (by design, per this
   * file's own pre-existing tests), so nothing else guarantees that.
   *
   * Assumes every table's primary key column is literally named `id` --
   * true throughout this schema's migrations (`id uuid PRIMARY KEY DEFAULT
   * gen_random_uuid()`). depth guards against a genuine reference cycle
   * (never expected in this schema, which is a strict tenant-hierarchy DAG)
   * turning into an infinite loop -- a real cycle throws loudly here rather
   * than hanging the test run.
   */
  async function deleteReferencingRows(pool: import('pg').Pool, table: string, id: string, depth = 0) {
    if (depth > 20) {
      throw new Error(`deleteReferencingRows: recursion depth exceeded at "${table}" id=${id} -- likely a reference cycle`);
    }
    const { rows: fks } = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT tc.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
          AND ccu.table_name = $1 AND ccu.column_name = 'id'`,
      [table],
    );
    for (const { table_name, column_name } of fks) {
      const { rows: referencing } = await pool.query<{ id: string }>(
        `SELECT id FROM "${table_name}" WHERE "${column_name}" = $1`,
        [id],
      );
      for (const { id: referencingId } of referencing) {
        await deleteReferencingRows(pool, table_name, referencingId, depth + 1);
      }
      await pool.query(`DELETE FROM "${table_name}" WHERE "${column_name}" = $1`, [id]);
    }
  }

  /**
   * 86e33trjc: this repo's own Deploy to CapRover failed the migrate-database
   * step on the last 2 consecutive Development merges (PR #319, PR #320)
   * because the persistent dev Neon database already had 'dev-dashboard'
   * client/app_user rows under the pre-86e33t12f OLD sentinel ids --
   * ON CONFLICT (id) DO NOTHING doesn't suppress the resulting collision on
   * the separate client_slug_key/app_user_email_key UNIQUE constraints.
   * Tears down whatever the NEW ids currently reference first (see
   * deleteReferencingRows above), so this test gets a clean "only the OLD
   * sentinel exists" starting point regardless of file execution order --
   * seedDevTenant()'s own call at the end fully restores the ambient
   * DEV_CLIENT_ID/DEV_USER_ID fixture other test files in this run rely on.
   */
  it('reconciles a pre-86e33t12f OLD-sentinel row (with a referencing child row) to the new RFC4122 ids, in place', async () => {
    const pool = getPool();

    // 86e33t12f's own before-values (PR #319's diff).
    const OLD_DEV_CLIENT_ID = '11111111-1111-1111-1111-111111111111';
    const OLD_DEV_USER_ID = '22222222-2222-2222-2222-222222222222';

    await deleteReferencingRows(pool, 'client', DEV_CLIENT_ID);
    await deleteReferencingRows(pool, 'app_user', DEV_USER_ID);
    await pool.query(`DELETE FROM client WHERE id = $1`, [DEV_CLIENT_ID]);
    await pool.query(`DELETE FROM app_user WHERE id = $1`, [DEV_USER_ID]);

    // is_active=false and a created_at far in the past on the old rows --
    // reconciliation must carry these across (a straight-line "delete and
    // reinsert with hardcoded literals" would silently reactivate the
    // fixture and reset its age; this is the case that would expose that).
    const OLD_CREATED_AT = '2025-01-01T00:00:00Z';
    await pool.query(
      `INSERT INTO client (id, name, slug, is_active, created_at) VALUES ($1, 'Dev Dashboard Client', 'dev-dashboard', false, $2)`,
      [OLD_DEV_CLIENT_ID, OLD_CREATED_AT],
    );
    await pool.query(
      `INSERT INTO app_user (id, email, full_name, is_internal, is_active, created_at) VALUES ($1, 'dev-dashboard@example.com', 'Dev Dashboard User', true, false, $2)`,
      [OLD_DEV_USER_ID, OLD_CREATED_AT],
    );
    // A representative referencing row, proving the FK-repoint walk (not
    // just the two parent rows) actually runs -- audit_event carries both a
    // client_id and an actor_user_id FK on the same row.
    const event = await pool.query(
      `INSERT INTO audit_event (client_id, entity, event, actor_kind, actor_user_id)
       VALUES ($1, 'test_fixture', 'seed_reconcile_test', 'analyst', $2)
       RETURNING id`,
      [OLD_DEV_CLIENT_ID, OLD_DEV_USER_ID],
    );
    const eventId = event.rows[0].id;

    await seedDevTenant({ pool });

    const oldClient = await pool.query(`SELECT 1 FROM client WHERE id = $1`, [OLD_DEV_CLIENT_ID]);
    expect(oldClient.rowCount).toBe(0);
    const oldUser = await pool.query(`SELECT 1 FROM app_user WHERE id = $1`, [OLD_DEV_USER_ID]);
    expect(oldUser.rowCount).toBe(0);

    const newClient = await pool.query(
      `SELECT slug, is_active, created_at FROM client WHERE id = $1`,
      [DEV_CLIENT_ID],
    );
    expect(newClient.rows[0]).toMatchObject({ slug: 'dev-dashboard', is_active: false });
    expect(newClient.rows[0].created_at.toISOString()).toBe(new Date(OLD_CREATED_AT).toISOString());

    const newUser = await pool.query(
      `SELECT email, is_active, created_at FROM app_user WHERE id = $1`,
      [DEV_USER_ID],
    );
    expect(newUser.rows[0]).toMatchObject({ email: 'dev-dashboard@example.com', is_active: false });
    expect(newUser.rows[0].created_at.toISOString()).toBe(new Date(OLD_CREATED_AT).toISOString());

    const repointedEvent = await pool.query(
      `SELECT client_id, actor_user_id FROM audit_event WHERE id = $1`,
      [eventId],
    );
    expect(repointedEvent.rows[0]).toMatchObject({ client_id: DEV_CLIENT_ID, actor_user_id: DEV_USER_ID });

    await pool.query(`DELETE FROM audit_event WHERE id = $1`, [eventId]);
    // Restore is_active=true -- every other file sharing this run's DB
    // (e.g. dashboard-auth-headers.db.test.ts) expects an active dev tenant;
    // is_active=false above was this test's own probe value, not the real
    // ambient fixture state other tests depend on.
    await pool.query(`UPDATE client SET is_active = true WHERE id = $1`, [DEV_CLIENT_ID]);
    await pool.query(`UPDATE app_user SET is_active = true WHERE id = $1`, [DEV_USER_ID]);
  });

  /**
   * 86e33u1u5: the regression proof for the transitive-FK fix above.
   * `contract` references client(id) directly; `contract_version`
   * references `contract(id)` -- one level further removed from client, and
   * exactly the shape that made the pre-fix, one-level-only version of
   * deleteReferencingRows fail with a real FK violation
   * (contract_version_contract_id_fkey) once a directly-referencing row had
   * its own dependents.
   */
  it('deleteReferencingRows handles a transitive dependent (contract -> contract_version) without an FK violation', async () => {
    const pool = getPool();
    const tag = `dfr-${Date.now()}`;

    const client = await pool.query<{ id: string }>(
      `INSERT INTO client (name, slug) VALUES ('DFR Transitive Test Client', $1) RETURNING id`,
      [tag],
    );
    const clientId = client.rows[0]!.id;
    const carrier = await pool.query<{ id: string }>(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Carrier-${tag}`]);
    const contract = await pool.query<{ id: string }>(
      `INSERT INTO contract (client_id, carrier_id, name) VALUES ($1, $2, 'DFR Test Contract') RETURNING id`,
      [clientId, carrier.rows[0]!.id],
    );
    const contractId = contract.rows[0]!.id;
    await pool.query(
      `INSERT INTO contract_version (client_id, contract_id, version_label, valid_from) VALUES ($1, $2, 'v1', '2026-01-01')`,
      [clientId, contractId],
    );

    // A thrown FK violation here fails the test directly -- no need for an
    // explicit not.toThrow() wrapper on an async call.
    await deleteReferencingRows(pool, 'client', clientId);

    const remainingContract = await pool.query(`SELECT 1 FROM contract WHERE id = $1`, [contractId]);
    expect(remainingContract.rowCount).toBe(0);
    const remainingVersion = await pool.query(`SELECT 1 FROM contract_version WHERE contract_id = $1`, [contractId]);
    expect(remainingVersion.rowCount).toBe(0);

    // deleteReferencingRows only clears what REFERENCES the given id, by
    // contract -- the client row itself is the caller's own responsibility
    // (mirrors the reconciliation test above, which deletes it separately).
    const remainingClient = await pool.query(`SELECT 1 FROM client WHERE id = $1`, [clientId]);
    expect(remainingClient.rowCount).toBe(1);
    await pool.query(`DELETE FROM carrier WHERE id = $1`, [carrier.rows[0]!.id]);
    await pool.query(`DELETE FROM client WHERE id = $1`, [clientId]);
  });

  it('creates a client + app_user + membership row for the fixed dev IDs', async () => {
    const pool = getPool();
    await seedDevTenant({ pool });

    const membership = await pool.query(
      `SELECT 1 FROM membership WHERE user_id = $1 AND client_id = $2`,
      [DEV_USER_ID, DEV_CLIENT_ID],
    );
    expect(membership.rowCount).toBe(1);

    const client = await pool.query(`SELECT 1 FROM client WHERE id = $1`, [DEV_CLIENT_ID]);
    expect(client.rowCount).toBe(1);

    const user = await pool.query(`SELECT 1 FROM app_user WHERE id = $1`, [DEV_USER_ID]);
    expect(user.rowCount).toBe(1);
  });

  it('is idempotent: running it twice does not error or duplicate rows', async () => {
    const pool = getPool();
    await seedDevTenant({ pool });
    await seedDevTenant({ pool }); // second run must not throw

    const membership = await pool.query(
      `SELECT count(*) FROM membership WHERE user_id = $1 AND client_id = $2`,
      [DEV_USER_ID, DEV_CLIENT_ID],
    );
    expect(Number(membership.rows[0].count)).toBe(1);
  });

  /**
   * 86e33t12f: the original sentinel values (…-1111-1111-1111-…,
   * …-2222-2222-2222-…) fail zod's strict z.uuid() (RFC4122 variant nibble
   * must be [89ab]; the old placeholders used a bare repeated digit). Any
   * module that validates a dev-auth clientId/actorUserId this strictly --
   * confirmed live in authorize-payment.ts and persist-contract-extraction.ts
   * -- 500s under standard dev auth. Decided (Bridge, 2026-09-03) to fix the
   * fixture values themselves rather than relax validation per-module.
   */
  it('DEV_CLIENT_ID and DEV_USER_ID are RFC4122-compliant (pass strict zod z.uuid())', () => {
    const uuid = z.string().uuid();
    expect(uuid.safeParse(DEV_CLIENT_ID).success).toBe(true);
    expect(uuid.safeParse(DEV_USER_ID).success).toBe(true);
  });
});
