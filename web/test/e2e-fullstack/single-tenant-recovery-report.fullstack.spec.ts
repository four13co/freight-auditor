import { test, expect } from '@playwright/test';
import pg from 'pg';
import { withTenantTx } from '../../../src/db/tenant-context.js';
import { assertSeeded } from '../e2e-fullstack-auth/assert-seeded.js';

// 86e33qzn3: full-stack e2e for the single-tenant recovery report
// (recovery-report-routes.ts) -- real Fastify server + real Postgres, real
// HTTP, no route mocking.
//
// Scope-honesty correction on AC1: its own text says "when its recovery
// report is viewed" -- ClientRecoveryReport.tsx's own doc comment states
// it is "Unwired to nav -- same disclosure as its P5.C siblings," confirmed
// via grep across web/src (only self-references and sibling-precedent
// comments, never imported into App.tsx/Dashboard.tsx). Same "no reachable
// UI surface" pattern P7.C.2/P7.C.4 already established for this epic --
// driven directly over real HTTP instead.
//
// getPortfolioReconciliation validates clientId with strict z.uuid() (the
// round-94 bug class), but this task has no real-browser session to pin to
// any particular tenant (no UI mount exists), so two disposable tenants
// with DB-generated (gen_random_uuid()) ids sidestep it entirely -- same
// precedent as P7.C.2/P7.C.3/P7.C.4.
//
// AC2's tenant-isolation assertion is scoped specifically to this report
// surface (per this task's own Rabbit-holes note distinguishing it from
// P7.D.1's general-purpose isolation check): tenant A's session must never
// see tenant B's claim data when calling its OWN /api/portfolio/recovery-
// report, which is exactly what RLS's client_id = ANY(app_current_client_ids())
// branch is supposed to guarantee for a non-internal, single-client scope.

let pool: pg.Pool;
let clientAId: string;
let clientBId: string;
let userAId: string;
let userBId: string;

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  const clientA = await pool.query<{ id: string }>(
    `INSERT INTO client (name, slug) VALUES ('E2E Tenant Recovery Client A', $1) RETURNING id`,
    [`e2e-tenant-recovery-a-${Date.now()}`],
  );
  clientAId = clientA.rows[0]!.id;
  const clientB = await pool.query<{ id: string }>(
    `INSERT INTO client (name, slug) VALUES ('E2E Tenant Recovery Client B', $1) RETURNING id`,
    [`e2e-tenant-recovery-b-${Date.now()}`],
  );
  clientBId = clientB.rows[0]!.id;

  const userA = await pool.query<{ id: string }>(
    `INSERT INTO app_user (email, full_name) VALUES ($1, 'E2E Tenant Recovery User A') RETURNING id`,
    [`e2e-tenant-recovery-a-${Date.now()}@example.test`],
  );
  userAId = userA.rows[0]!.id;
  await pool.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_admin')`, [userAId, clientAId]);

  const userB = await pool.query<{ id: string }>(
    `INSERT INTO app_user (email, full_name) VALUES ($1, 'E2E Tenant Recovery User B') RETURNING id`,
    [`e2e-tenant-recovery-b-${Date.now()}@example.test`],
  );
  userBId = userB.rows[0]!.id;
  await pool.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_admin')`, [userBId, clientBId]);

  await withTenantTx({ clientIds: [clientAId, clientBId], internal: true }, async (client) => {
    // Client A: claimed 400, recovered 150 (same currency) -> outstanding 250.
    const claimA = await client.query<{ id: string }>(
      `INSERT INTO claim (client_id, amount_claimed, currency, status) VALUES ($1, '400.0000', 'USD', 'open') RETURNING id`,
      [clientAId],
    );
    await client.query(
      `INSERT INTO recovery_event (client_id, claim_id, amount_recovered, currency) VALUES ($1, $2, '150.0000', 'USD')`,
      [clientAId, claimA.rows[0]!.id],
    );

    // Client B: a distinctly different, uniquely-identifiable claim -- this
    // must NEVER appear in client A's own report (AC2).
    await client.query(
      `INSERT INTO claim (client_id, amount_claimed, currency, status) VALUES ($1, '999.0000', 'EUR', 'open')`,
      [clientBId],
    );
  });
});

test.afterAll(async () => {
  await pool.query(`DELETE FROM recovery_event WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
  await pool.query(`DELETE FROM claim WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
  await pool.query(`DELETE FROM membership WHERE user_id IN ($1, $2)`, [userAId, userBId]);
  await pool.query(`DELETE FROM app_user WHERE id IN ($1, $2)`, [userAId, userBId]);
  await pool.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
  await pool.end();
});

interface RecoveryReportBucket {
  currency: string | null;
  claimed: string;
  recovered: string;
  outstanding: string;
  writtenOff: string;
  denied: string;
}

test('AC1: a tenant viewing its own recovery report sees real, correctly scoped aggregated figures', async ({ request }) => {
  // assertSeeded: guard against an empty-but-200 response looking like a
  // pass for an aggregation view (same lesson this epic already applied
  // to P7.C.4's portfolio report).
  await assertSeeded(request, {
    check: () => request.get('/api/portfolio/recovery-report', { headers: { 'x-client-id': clientAId, 'x-user-id': userAId } }),
    errorHint: 'expected the recovery-report endpoint to return client A\'s seeded USD bucket',
    validate: async (response) => {
      const { buckets } = await response.json() as { buckets: RecoveryReportBucket[] };
      return buckets.some((b) => b.currency === 'USD');
    },
  });

  const response = await request.get('/api/portfolio/recovery-report', { headers: { 'x-client-id': clientAId, 'x-user-id': userAId } });
  expect(response.status()).toBe(200);
  const { buckets } = await response.json() as { buckets: RecoveryReportBucket[] };

  expect(buckets).toHaveLength(1);
  const [bucket] = buckets;
  expect(bucket!.currency).toBe('USD');
  expect(bucket!.claimed).toBe('400.0000');
  expect(bucket!.recovered).toBe('150.0000');
  expect(bucket!.outstanding).toBe('250.0000');
});

test('AC2: tenant A\'s recovery report never shows tenant B\'s claim data', async ({ request }) => {
  const response = await request.get('/api/portfolio/recovery-report', { headers: { 'x-client-id': clientAId, 'x-user-id': userAId } });
  expect(response.status()).toBe(200);
  const { buckets } = await response.json() as { buckets: RecoveryReportBucket[] };

  // Client B's claim is 999.0000 EUR -- a currency/amount combination that
  // does not exist anywhere in client A's own seeded data, so its presence
  // in ANY bucket would be an unambiguous cross-tenant leak.
  expect(buckets.some((b) => b.currency === 'EUR')).toBe(false);
  expect(buckets.every((b) => b.claimed !== '999.0000')).toBe(true);

  // Confirm client B's report itself DOES show its own data (proves the
  // absence above is real tenant scoping, not a broken/empty endpoint).
  const bResponse = await request.get('/api/portfolio/recovery-report', { headers: { 'x-client-id': clientBId, 'x-user-id': userBId } });
  expect(bResponse.status()).toBe(200);
  const { buckets: bBuckets } = await bResponse.json() as { buckets: RecoveryReportBucket[] };
  expect(bBuckets.some((b) => b.currency === 'EUR' && b.claimed === '999.0000')).toBe(true);
});
